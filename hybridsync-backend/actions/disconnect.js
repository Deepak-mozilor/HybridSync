// "Disconnect" buttons in App Home. Wipes the corresponding tokens from the
// DB and best-effort revokes the token at the upstream provider so a leaked
// row can't be reused.
//
// Both handlers are resilient to upstream-revoke failures — we always clear
// the DB row even if Google/Slack returns an error, because the user has
// already pressed the button and expects the connection to be gone.

const db        = require('../db');
const Sentry    = require('../instrument');
const { publishHome } = require('../views/appHome');

async function revokeGoogleToken(token) {
  if (!token) return;
  try {
    await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(token)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });
  } catch (e) {
    console.warn('[Disconnect] Google revoke failed:', e.message);
    Sentry.captureException(e, { tags: { op: 'google_revoke' } });
  }
}

async function revokeSlackToken(token) {
  if (!token) return;
  try {
    await fetch('https://slack.com/api/auth.revoke', {
      method:  'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
  } catch (e) {
    console.warn('[Disconnect] Slack revoke failed:', e.message);
    Sentry.captureException(e, { tags: { op: 'slack_revoke' } });
  }
}

function register(app) {
  app.action('disconnect_google', async ({ ack, body, client, logger }) => {
    await ack();
    const userId      = body.user.id;
    const workspaceId = body.team?.id;
    try {
      const tokens = await db.getGoogleTokens(userId);
      const accessToken = tokens?.access_token || tokens?.refresh_token;

      // Best-effort upstream revoke; never block on it.
      revokeGoogleToken(accessToken).catch(() => {});

      // We intentionally do NOT call Google's channels.stop here — the API
      // requires both channel_id AND resource_id, and we only store the
      // channel_id. Existing push channels expire on their own within 7 days.
      // Once google_channel_id is cleared, any webhook ping for that channel
      // will look up "no user" and be silently dropped by /api/google/webhook.

      await db.clearGoogleConnection(userId);
      console.log(`[Disconnect] ${userId} disconnected Google Calendar`);

      await client.chat.postMessage({
        channel: userId,
        text: '🔌 Google Calendar disconnected. HybridSync no longer has access to your meeting data.',
      });

      await publishHome(client, userId, workspaceId);
    } catch (err) {
      logger.error('[Disconnect] disconnect_google error:', err);
      Sentry.captureException(err, { tags: { op: 'disconnect_google' } });
      await client.chat.postMessage({
        channel: userId,
        text: '⚠️ Disconnect failed — please try again in a moment.',
      }).catch(() => {});
    }
  });

  app.action('disconnect_slack_status', async ({ ack, body, client, logger }) => {
    await ack();
    const userId      = body.user.id;
    const workspaceId = body.team?.id;
    try {
      const token = await db.getUserToken(userId);
      revokeSlackToken(token).catch(() => {});

      await db.clearSlackUserToken(userId);
      console.log(`[Disconnect] ${userId} disconnected Slack status sync`);

      await client.chat.postMessage({
        channel: userId,
        text: '🔌 Slack Status Sync disconnected. HybridSync will no longer update your Slack profile emoji.',
      });

      await publishHome(client, userId, workspaceId);
    } catch (err) {
      logger.error('[Disconnect] disconnect_slack_status error:', err);
      Sentry.captureException(err, { tags: { op: 'disconnect_slack_status' } });
      await client.chat.postMessage({
        channel: userId,
        text: '⚠️ Disconnect failed — please try again in a moment.',
      }).catch(() => {});
    }
  });
}

module.exports = { register };
