// Syncs Slack channels → HybridSync teams.
// Each channel the bot is a member of becomes a team.
// Channel name → team name. Existing anchorDays are preserved.
// Multi-team: writes to team_members (additive). users.team_id is kept as
// a "primary team" pointer set to the first team a user joins.

const db = require('../db');

async function syncTeamsFromChannels(slackClient, workspaceId) {
  if (!workspaceId) {
    const auth = await slackClient.auth.test().catch(() => null);
    workspaceId = auth?.team_id || null;
  }
  if (!workspaceId) throw new Error('syncTeamsFromChannels: workspaceId could not be determined');
  // One bulk users.list at the top — reused across every channel iteration
  // instead of an N-call users.info loop. Filter out bots/deleted/Slackbot.
  const nameByUserId = {};
  let cursor;
  do {
    const resp = await slackClient.users.list({ limit: 1000, ...(cursor ? { cursor } : {}) });
    for (const m of resp.members || []) {
      if (m.deleted || m.is_bot || m.id === 'USLACKBOT') continue;
      nameByUserId[m.id] = m.profile?.real_name || m.profile?.display_name || m.name || m.id;
    }
    cursor = resp.response_metadata?.next_cursor;
  } while (cursor);

  const listResp = await slackClient.conversations.list({
    types:            'public_channel',
    exclude_archived: true,
    limit:            200,
  });

  const results = [];
  const memberChannels = listResp.channels.filter(c => c.is_member);

  // Authoritative {userId -> Set<teamId>} from Slack so we can reconcile stale rows.
  const observed = {};

  for (const ch of memberChannels) {
    // Preserve anchorDays and managerId already stored for this channel.
    // For unset managers, default to the channel creator — manual reassignments
    // in the dashboard always win because existing.managerId is checked first.
    const existing = await db.getTeam(ch.id);
    await db.upsertTeam({
      id:          ch.id,
      name:        ch.name,
      anchorDays:  existing?.anchorDays || [],
      managerId:   existing?.managerId  || ch.creator || null,
      workspaceId,
    });

    let memberCount = 0;
    try {
      const membersResp = await slackClient.conversations.members({ channel: ch.id, limit: 200 });
      for (const userId of membersResp.members) {
        const displayName = nameByUserId[userId];
        if (!displayName) continue; // bot, deleted, or not a workspace human
        const user = await db.ensureUser(userId, { displayName, workspaceId });
        await db.addUserToTeam(userId, ch.id);
        if (!user.teamId) await db.updateUserTeam(userId, ch.id); // set primary if unset
        if (!observed[userId]) observed[userId] = new Set();
        observed[userId].add(ch.id);
        memberCount++;
      }
    } catch (e) {
      console.warn(`[TeamSync] Could not fetch members for #${ch.name}:`, e.message);
    }

    console.log(`[TeamSync] #${ch.name} → ${memberCount} members assigned`);
    results.push({ channel: ch.name, channelId: ch.id, members: memberCount });
  }

  // Catch-up cleanup: any team in DB the bot is no longer a member of → delete.
  // Covers cases where the bot was kicked while offline and we missed the live event.
  const seenChannels = new Set(memberChannels.map(c => c.id));
  const dbTeams = await db.getAllTeams(workspaceId);
  for (const t of dbTeams) {
    if (!seenChannels.has(t.id)) {
      await db.deleteTeam(t.id);
      console.log(`[TeamSync] removed orphan team #${t.name} (${t.id})`);
    }
  }

  // Reconcile per-user memberships: drop rows for channels the user is no longer in
  // (only among channels we just inspected).
  for (const [userId, currentSet] of Object.entries(observed)) {
    const stored = await db.getUserTeams(userId);
    for (const teamId of stored) {
      if (seenChannels.has(teamId) && !currentSet.has(teamId)) {
        await db.removeUserFromTeam(userId, teamId);
      }
    }
  }

  return results;
}

// Auto-assign a single user to the team for the channel they just messaged in.
// Creates the team if it doesn't exist yet. Adds membership (does not overwrite).
async function assignUserToChannel(slackClient, userId, channelId, workspaceId) {
  try {
    const chResp = await slackClient.conversations.info({ channel: channelId });
    const ch     = chResp.channel;
    if (!ch || ch.is_im || ch.is_mpim) return; // skip DMs

    const existing = await db.getTeam(ch.id);
    await db.upsertTeam({
      id:          ch.id,
      name:        ch.name,
      anchorDays:  existing?.anchorDays || [],
      managerId:   existing?.managerId  || ch.creator || null,
      workspaceId,
    });
    await db.addUserToTeam(userId, ch.id);
    const user = await db.getUser(userId);
    if (user && !user.teamId) await db.updateUserTeam(userId, ch.id);
  } catch (e) {
    console.warn('[TeamSync] assignUserToChannel failed:', e.message);
  }
}

module.exports = { syncTeamsFromChannels, assignUserToChannel };
