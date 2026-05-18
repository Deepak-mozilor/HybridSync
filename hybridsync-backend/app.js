require('dotenv').config();
const { App } = require('@slack/bolt');
const db = require('./db');
const slackStatus = require('./services/slackStatus');

// Sync Slack profile status whenever any HybridSync status is saved
db.onStatusChange(slackStatus.syncToProfile);

const streamListener    = require('./listeners/stream');
const appHomeListener   = require('./listeners/appHome');
const chatbotListener   = require('./listeners/chatbot');
const overrideActions   = require('./actions/override');
const negotiationActions = require('./actions/negotiation');
const manageDepsActions  = require('./actions/manageDeps');
const batch             = require('./ai/batch');
const apiServer         = require('./server');

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

(async () => {
  await app.start();
  console.log('⚡️ HybridSync Bolt app is running in Socket Mode.');

  // Phase 3 — Start scheduled AI batch jobs (pass client for live Slack reads)
  batch.start(app.client);

  // Phase 4 — REST API for the React admin dashboard
  apiServer.start(3001, app.client);
})();
