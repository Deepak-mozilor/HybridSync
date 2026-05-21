require('dotenv').config();
const { App } = require('@slack/bolt');
const { WebClient } = require('@slack/web-api');
const db = require('./db');
const slackStatus = require('./services/slackStatus');

// Sync Slack profile status whenever any HybridSync status is saved
db.onStatusChange(slackStatus.syncToProfile);

const streamListener      = require('./listeners/stream');
const appHomeListener     = require('./listeners/appHome');
const chatbotListener     = require('./listeners/chatbot');
const slackStatusListener = require('./listeners/slackStatusSync');
const overrideActions   = require('./actions/override');
const negotiationActions = require('./actions/negotiation');
const manageDepsActions  = require('./actions/manageDeps');
const batch             = require('./ai/batch');
const apiServer         = require('./server');
const { getUserEmail }  = require('./services/googleCalendar');

const FRONTEND_URL = process.env.FRONTEND_URL || 'https://hybrid-sync.vercel.app';

const app = new App({
  socketMode:   true,
  appToken:     process.env.SLACK_APP_TOKEN,
  clientId:     process.env.SLACK_CLIENT_ID,
  clientSecret: process.env.SLACK_CLIENT_SECRET,
  stateSecret:  process.env.SLACK_STATE_SECRET,
  logLevel:     'info',
  scopes: [
    'channels:history', 'channels:read',
    'chat:write',
    'im:history', 'im:write',
    'users:read', 'users:read.email',
    'team:read',
    'app_mentions:read',
    'groups:history', 'groups:read',
    'reactions:write',
  ],
  installationStore: {
    storeInstallation: async (installation) => {
      await db.upsertWorkspace(installation);
    },
    fetchInstallation: async (installQuery) => {
      const ws = await db.getWorkspace(installQuery.teamId);
      if (!ws) throw new Error(`No installation for team ${installQuery.teamId}`);
      return ws.installation;
    },
    deleteInstallation: async (installQuery) => {
      await db.deleteWorkspace(installQuery.teamId);
    },
  },
  installerOptions: {
    directInstall: true,
    callbackOptions: {
      success: async (installation, _options, _req, res) => {
        // storeInstallation has already run. Promote installer to admin, then redirect.
        await db.setUserRole(installation.user.id, 'admin');
        res.writeHead(302, { Location: `${FRONTEND_URL}?installed=true` });
        res.end();
      },
      failure: async (error, _options, _req, res) => {
        res.writeHead(302, {
          Location: `${FRONTEND_URL}?install_error=${encodeURIComponent(error.message)}`,
        });
        res.end();
      },
    },
  },
});

// One-time migration for the legacy single-workspace install (HR_SLACK_IDS +
// static SLACK_BOT_TOKEN). Idempotent: short-circuits once the workspace row
// exists, so it's safe to leave in place permanently.
async function bootstrapLegacyInstall() {
  if (!process.env.SLACK_BOT_TOKEN) return;
  const client = new WebClient(process.env.SLACK_BOT_TOKEN);
  const auth   = await client.auth.test().catch(() => null);
  if (!auth?.team_id) return;
  if (await db.getWorkspace(auth.team_id)) return; // already bootstrapped

  const installation = {
    team: { id: auth.team_id, name: auth.team },
    bot:  { token: process.env.SLACK_BOT_TOKEN, userId: auth.user_id, id: auth.bot_id },
    user: { id: auth.user_id },
    isEnterpriseInstall: false,
    tokenType: 'bot',
  };
  await db.upsertWorkspace(installation);

  const hrIds = (process.env.HR_SLACK_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
  for (const id of hrIds) await db.setUserRole(id, 'admin');

  console.log(`[Bootstrap] Migrated legacy workspace ${auth.team_id} with ${hrIds.length} admin(s)`);
}

// Phase 2A — The Stream (deterministic, NO AI)
streamListener.register(app);

// Slack native status → HybridSync sync (reverse direction)
slackStatusListener.register(app);

// Phase 2B — Employee App Home UI
appHomeListener.register(app);

// Phase 5 — AI Chatbot (DM-based schedule assistant)
chatbotListener.register(app);

// Phase 2C — Override modal (button → modal → persist)
overrideActions.register(app);

// Phase 3 — Negotiation DM button responses
negotiationActions.register(app);

// Phase 4B — Manage Dependencies modal
manageDepsActions.register(app);

async function backfillGoogleEmails() {
  const users = await db.getAllGoogleConnectedUsers().catch(() => []);
  for (const user of users) {
    const existingEmail = await db.getGoogleEmail(user.id).catch(() => null);
    if (existingEmail) continue;
    const tokens = await db.getGoogleTokens(user.id).catch(() => null);
    if (!tokens) continue;
    const email = await getUserEmail(tokens).catch(() => null);
    if (email) {
      await db.saveGoogleEmail(user.id, email).catch(() => {});
      console.log(`[Backfill] Saved Google email for ${user.id}: ${email}`);
    }
  }
}

(async () => {
  await bootstrapLegacyInstall().catch(e => console.error('[Bootstrap] Error:', e.message));
  await app.start();
  console.log('⚡️ HybridSync Bolt app is running in Socket Mode.');

  // Backfill Google emails for users who connected before email-saving was added
  backfillGoogleEmails().catch(e => console.error('[Backfill] Error:', e.message));

  // Phase 3 — Start scheduled AI batch jobs (pass client for live Slack reads)
  batch.start(app.client);

  // Phase 4 — REST API for the React admin dashboard
  apiServer.start(process.env.PORT || 3001, app.client);
})();
