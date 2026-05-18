// Syncs Slack channels → HybridSync teams.
// Each channel the bot is a member of becomes a team.
// Channel name → team name. Existing anchorDays are preserved.

const db = require('../db');

async function syncTeamsFromChannels(slackClient) {
  const listResp = await slackClient.conversations.list({
    types:            'public_channel',
    exclude_archived: true,
    limit:            200,
  });

  const results = [];

  for (const ch of listResp.channels.filter(c => c.is_member)) {
    // Preserve anchorDays and managerId already stored for this channel
    const existing = await db.getTeam(ch.id);
    await db.upsertTeam({
      id:        ch.id,
      name:      ch.name,
      anchorDays: existing?.anchorDays || [],
      managerId:  existing?.managerId  || null,
    });

    // Assign all current channel members to this team
    let memberCount = 0;
    try {
      const membersResp = await slackClient.conversations.members({ channel: ch.id, limit: 200 });
      for (const userId of membersResp.members) {
        const user = await db.getUser(userId);
        if (user) {
          await db.updateUserTeam(userId, ch.id);
          memberCount++;
        }
      }
    } catch (e) {
      console.warn(`[TeamSync] Could not fetch members for #${ch.name}:`, e.message);
    }

    console.log(`[TeamSync] #${ch.name} → ${memberCount} members assigned`);
    results.push({ channel: ch.name, channelId: ch.id, members: memberCount });
  }

  return results;
}

// Auto-assign a single user to the team for the channel they just messaged in.
// Creates the team if it doesn't exist yet.
async function assignUserToChannel(slackClient, userId, channelId) {
  try {
    const chResp = await slackClient.conversations.info({ channel: channelId });
    const ch     = chResp.channel;
    if (!ch || ch.is_im || ch.is_mpim) return; // skip DMs

    const existing = await db.getTeam(ch.id);
    await db.upsertTeam({
      id:        ch.id,
      name:      ch.name,
      anchorDays: existing?.anchorDays || [],
      managerId:  existing?.managerId  || null,
    });
    await db.updateUserTeam(userId, ch.id);
  } catch (e) {
    // Non-fatal — user keeps their current team
    console.warn('[TeamSync] assignUserToChannel failed:', e.message);
  }
}

module.exports = { syncTeamsFromChannels, assignUserToChannel };
