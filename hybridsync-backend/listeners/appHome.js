const db            = require('../db');
const { publishHome } = require('../views/appHome');

async function resolveDisplayName(client, userId) {
  try {
    const res = await client.users.info({ user: userId });
    return res.user?.profile?.display_name_normalized
        || res.user?.profile?.real_name_normalized
        || res.user?.real_name
        || userId;
  } catch {
    return userId;
  }
}

function register(app) {
  app.event('app_home_opened', ({ event, context, client, logger }) => {
    if (event.tab !== 'home') return;
    // Fire-and-forget: return immediately so Bolt can dispatch concurrent
    // block_actions events (e.g., button clicks) without waiting for Firestore.
    (async () => {
      try {
        const workspaceId = context.teamId || event.team;
        const displayName = await resolveDisplayName(client, event.user);
        await db.ensureUser(event.user, { displayName, workspaceId });
        await publishHome(client, event.user, workspaceId);
        console.log(`[UI] Published App Home for ${displayName} (${event.user})`);
      } catch (err) {
        logger.error('Error publishing App Home:', err);
      }
    })();
  });
}

module.exports = { register, resolveDisplayName };
