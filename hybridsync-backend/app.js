require('dotenv').config();
const { App } = require('@slack/bolt');
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

// TODO(Firebase swap): change db/index.js to a firebase-admin Firestore
// implementation. All consumers already use its async API — one file change.

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  appToken: process.env.SLACK_APP_TOKEN,
  socketMode: true,
  logLevel: 'info',
});

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
  await app.start();
  console.log('⚡️ HybridSync Bolt app is running in Socket Mode.');

  // Backfill Google emails for users who connected before email-saving was added
  backfillGoogleEmails().catch(e => console.error('[Backfill] Error:', e.message));

  // Phase 3 — Start scheduled AI batch jobs (pass client for live Slack reads)
  batch.start(app.client);

  // Phase 4 — REST API for the React admin dashboard
  apiServer.start(process.env.PORT || 3001, app.client);
})();
