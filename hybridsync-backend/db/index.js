// Supabase (Postgres) data layer — same async API as the in-memory version.
// Schema: run db/schema.sql once in the Supabase SQL editor before first start.
//
// Tables:
//   users        — id, display_name, team_id, role, week (JSONB)
//   teams        — id, name, anchor_days (TEXT[]), manager_id
//   team_members — user_id, team_id (PK)  — multi-team membership
//   overrides    — user_id, date_key, status
//   dependencies — user_id, peer_id, score

const { createClient } = require('@supabase/supabase-js');
const { STATUS, DEFAULT_WEEK, teams, seedUsers, seedDependencies } = require('../data/seed');
const { dayLabel, todayKey } = require('../utils/dates');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY,
);

// ---------------------------------------------------------------------------
// Row <-> JS mappers
// ---------------------------------------------------------------------------

function toUser(row, teamIds = []) {
  return {
    id:                   row.id,
    displayName:          row.display_name,
    teamId:               row.team_id            || null, // primary/legacy team
    teamIds:              teamIds,                         // all teams from team_members
    role:                 row.role,
    week:                 row.week               || {},
    workspaceId:          row.workspace_id       || null,
    googleChannelExpiry:  row.google_channel_expiry || null,
  };
}

function toTeam(row) {
  return {
    id:          row.id,
    name:        row.name,
    anchorDays:  row.anchor_days || [],
    managerId:   row.manager_id  || null,
    workspaceId: row.workspace_id || null,
  };
}

// Resolves the workspace_id to use for a write. If an explicit value is given,
// use it. Otherwise, fall back to the only installed workspace — this keeps
// existing call sites working during the multi-tenancy migration. Once every
// caller passes workspaceId explicitly, the fallback becomes an error path that
// only fires if the app is misconfigured (no install) or trying to write
// without context in a multi-workspace deployment.
async function _resolveWorkspaceId(explicit) {
  if (explicit) return explicit;
  const { data, error } = await supabase.from('workspaces').select('id');
  if (error) throw new Error(`_resolveWorkspaceId: ${error.message}`);
  if (!data || data.length === 0) {
    throw new Error('No workspace installed — finish OAuth install via /slack/install first.');
  }
  if (data.length > 1) {
    throw new Error('Multiple workspaces installed — workspace_id must be passed explicitly.');
  }
  return data[0].id;
}

// Looks up the workspace_id for an existing user. Used by writes that
// implicitly inherit workspace context from the user row (overrides,
// dependencies). Throws if the user has no workspace_id, which would mean a
// data-integrity bug — the schema enforces NOT NULL.
async function _workspaceIdForUser(userId) {
  const { data, error } = await supabase
    .from('users').select('workspace_id').eq('id', userId).maybeSingle();
  if (error) throw new Error(`_workspaceIdForUser: ${error.message}`);
  if (!data?.workspace_id) {
    throw new Error(`User ${userId} has no workspace_id — install the app for this user's workspace first.`);
  }
  return data.workspace_id;
}

// ---------------------------------------------------------------------------
// One-time seed  (runs on startup; skipped if data already exists)
// ---------------------------------------------------------------------------

async function seedIfEmpty() {
  const { data } = await supabase.from('users').select('id').limit(1);
  if (data && data.length > 0) {
    console.log('[DB] Supabase already seeded — skipping.');
    return;
  }

  // Need a workspace to anchor seed data to. If none installed, skip — users
  // will be created on demand via Slack events once OAuth completes.
  const { data: ws } = await supabase.from('workspaces').select('id').limit(1);
  if (!ws || ws.length === 0) {
    console.log('[DB] No workspace installed yet — skipping seed.');
    return;
  }
  const workspaceId = ws[0].id;

  console.log('[DB] Seeding Supabase with initial data…');

  // Teams (may be empty — created dynamically via /api/sync-teams)
  const teamRows = Object.values(teams).map(t => ({
    id:           t.id,
    name:         t.name,
    anchor_days:  t.anchorDays || [],
    manager_id:   t.managerId  || null,
    workspace_id: workspaceId,
  }));
  if (teamRows.length) {
    const { error } = await supabase.from('teams').insert(teamRows);
    if (error) throw new Error(`seed teams: ${error.message}`);
  }

  // Users
  const { error: uErr } = await supabase.from('users').insert(
    seedUsers.map(u => ({
      id:           u.id,
      display_name: u.displayName,
      team_id:      u.teamId || null,
      role:         u.role,
      week:         u.week,
      workspace_id: workspaceId,
    }))
  );
  if (uErr) throw new Error(`seed users: ${uErr.message}`);

  // Dependencies
  const depRows = [];
  for (const [userId, edges] of Object.entries(seedDependencies)) {
    for (const { peerId, score } of edges) {
      depRows.push({ user_id: userId, peer_id: peerId, score, workspace_id: workspaceId });
    }
  }
  const { error: dErr } = await supabase.from('dependencies').insert(depRows);
  if (dErr) throw new Error(`seed dependencies: ${dErr.message}`);

  console.log('[DB] Seed complete.');
}

seedIfEmpty().catch(e => console.error('[DB] Seed error:', e.message));

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

async function ensureUser(userId, { displayName, workspaceId } = {}) {
  const { data } = await supabase
    .from('users').select('*').eq('id', userId).maybeSingle();

  if (data) {
    if (displayName) {
      await supabase.from('users').update({ display_name: displayName }).eq('id', userId);
    }
    const teamIds = await getUserTeams(userId);
    return toUser({ ...data, display_name: displayName || data.display_name }, teamIds);
  }

  // New user — needs a workspace_id (NOT NULL). Falls back to the only
  // installed workspace if not provided.
  const ws = await _resolveWorkspaceId(workspaceId);
  const row = {
    id:           userId,
    display_name: displayName || userId,
    team_id:      null,
    role:         'employee',
    week:         { ...DEFAULT_WEEK },
    workspace_id: ws,
  };
  const { error } = await supabase.from('users').insert(row);
  if (error) throw new Error(`ensureUser insert: ${error.message}`);

  return toUser(row, []);
}

async function getUser(userId) {
  const { data } = await supabase
    .from('users').select('*').eq('id', userId).maybeSingle();
  if (!data) return null;
  const teamIds = await getUserTeams(userId);
  return toUser(data, teamIds);
}

async function getAllUsers(workspaceId) {
  const usersQ   = supabase.from('users').select('*');
  const membersQ = supabase.from('team_members').select('user_id, team_id');
  if (workspaceId) {
    usersQ.eq('workspace_id', workspaceId);
    membersQ.eq('workspace_id', workspaceId);
  }
  const [usersRes, membersRes] = await Promise.all([usersQ, membersQ]);
  if (usersRes.error) throw new Error(`getAllUsers: ${usersRes.error.message}`);
  if (membersRes.error) throw new Error(`getAllUsers (memberships): ${membersRes.error.message}`);

  const teamsByUser = {};
  for (const m of membersRes.data || []) {
    if (!teamsByUser[m.user_id]) teamsByUser[m.user_id] = [];
    teamsByUser[m.user_id].push(m.team_id);
  }
  return (usersRes.data || []).map(row => toUser(row, teamsByUser[row.id] || []));
}

// ---------------------------------------------------------------------------
// Schedule
// ---------------------------------------------------------------------------

async function getStatusForDate(userId, dateKey) {
  // Check override first
  const { data: over } = await supabase
    .from('overrides')
    .select('status')
    .eq('user_id', userId)
    .eq('date_key', dateKey)
    .maybeSingle();
  if (over) return over.status;

  // Fall back to weekly default
  const { data: user } = await supabase
    .from('users').select('week').eq('id', userId).maybeSingle();
  if (!user) return null;
  return (user.week || {})[dayLabel(dateKey)] || null;
}

async function getScheduleForDates(userId, dateKeys) {
  // Fetch week defaults and all matching overrides in parallel
  const [userRes, overRes] = await Promise.all([
    supabase.from('users').select('week').eq('id', userId).maybeSingle(),
    supabase.from('overrides')
      .select('date_key, status')
      .eq('user_id', userId)
      .in('date_key', dateKeys),
  ]);

  const week    = userRes.data?.week || {};
  const overMap = Object.fromEntries((overRes.data || []).map(o => [o.date_key, o.status]));

  return dateKeys.map(dateKey => ({
    dateKey,
    day:    dayLabel(dateKey),
    status: overMap[dateKey] ?? (week[dayLabel(dateKey)] || null),
  }));
}

// Bulk version of getScheduleForDates — one round trip for many users.
// Returns Map<userId, Array<{dateKey, day, status}>>. Missing users yield an
// array of nulls so callers can rely on every requested id being present.
async function getSchedulesForUsers(userIds, dateKeys) {
  if (!userIds || userIds.length === 0 || !dateKeys || dateKeys.length === 0) {
    return new Map();
  }
  const [usersRes, overRes] = await Promise.all([
    supabase.from('users').select('id, week').in('id', userIds),
    supabase.from('overrides')
      .select('user_id, date_key, status')
      .in('user_id', userIds)
      .in('date_key', dateKeys),
  ]);

  const weekById = Object.fromEntries((usersRes.data || []).map(u => [u.id, u.week || {}]));
  const overByUser = new Map();
  for (const o of overRes.data || []) {
    let m = overByUser.get(o.user_id);
    if (!m) { m = {}; overByUser.set(o.user_id, m); }
    m[o.date_key] = o.status;
  }

  const out = new Map();
  for (const userId of userIds) {
    const week    = weekById[userId] || {};
    const overMap = overByUser.get(userId) || {};
    out.set(userId, dateKeys.map(dateKey => ({
      dateKey,
      day:    dayLabel(dateKey),
      status: overMap[dateKey] ?? (week[dayLabel(dateKey)] || null),
    })));
  }
  return out;
}

let _afterSetStatus = null;
function onStatusChange(fn) { _afterSetStatus = fn; }

async function setStatus(userId, dateKey, status) {
  if (!Object.values(STATUS).includes(status)) {
    throw new Error(`Invalid status: ${status}`);
  }

  const today = todayKey();
  if (dateKey < today) {
    throw new Error(`Cannot set status for past dates (${dateKey} is before today ${today})`);
  }
  if (status === STATUS.SICK) {
    const maxSickDate = new Date(today);
    maxSickDate.setDate(maxSickDate.getDate() + 7);
    const maxKey = maxSickDate.toISOString().slice(0, 10);
    if (dateKey > maxKey) {
      throw new Error(`Sick status can only be set up to 7 days in advance (max ${maxKey})`);
    }
  }

  const workspaceId = await _workspaceIdForUser(userId);
  const { error } = await supabase
    .from('overrides')
    .upsert(
      { user_id: userId, date_key: dateKey, status, workspace_id: workspaceId },
      { onConflict: 'user_id,date_key' },
    );
  if (error) throw new Error(`setStatus: ${error.message}`);
  if (_afterSetStatus) _afterSetStatus(userId, status, dateKey).catch(() => {});
  return { userId, dateKey, status };
}

async function saveUserToken(userId, token) {
  const { error } = await supabase
    .from('users')
    .update({ slack_user_token: token })
    .eq('id', userId);
  if (error) throw new Error(`saveUserToken: ${error.message}`);
}

async function getUserToken(userId) {
  const { data } = await supabase
    .from('users')
    .select('slack_user_token')
    .eq('id', userId)
    .maybeSingle();
  return data?.slack_user_token || null;
}

// Bulk variant — Map<userId, token> for every id that has a non-null token.
// Ids without a token are simply absent from the Map.
async function getUserTokens(userIds) {
  if (!userIds || userIds.length === 0) return new Map();
  const { data, error } = await supabase
    .from('users')
    .select('id, slack_user_token')
    .in('id', userIds)
    .not('slack_user_token', 'is', null);
  if (error) throw new Error(`getUserTokens: ${error.message}`);
  return new Map((data || []).map(u => [u.id, u.slack_user_token]));
}

async function saveGoogleTokens(userId, tokens) {
  const { error } = await supabase
    .from('users')
    .update({ google_tokens: tokens })
    .eq('id', userId);
  if (error) throw new Error(`saveGoogleTokens: ${error.message}`);
}

async function getGoogleTokens(userId) {
  const { data } = await supabase
    .from('users')
    .select('google_tokens')
    .eq('id', userId)
    .maybeSingle();
  return data?.google_tokens || null;
}

async function saveGoogleEmail(userId, email) {
  const { error } = await supabase
    .from('users')
    .update({ google_email: email })
    .eq('id', userId);
  if (error) throw new Error(`saveGoogleEmail: ${error.message}`);
}

async function getGoogleEmail(userId) {
  const { data } = await supabase
    .from('users')
    .select('google_email')
    .eq('id', userId)
    .maybeSingle();
  return data?.google_email || null;
}

// Bulk variant — Map<userId, email> for every user in the workspace that has a
// linked Google account. Replaces looping getGoogleEmail per user.
async function getGoogleEmailsForWorkspace(workspaceId) {
  let q = supabase.from('users').select('id, google_email').not('google_email', 'is', null);
  if (workspaceId) q = q.eq('workspace_id', workspaceId);
  const { data, error } = await q;
  if (error) throw new Error(`getGoogleEmailsForWorkspace: ${error.message}`);
  return new Map((data || []).map(u => [u.id, u.google_email]));
}

async function clearGoogleConnection(userId) {
  const { error } = await supabase
    .from('users')
    .update({
      google_tokens:         null,
      google_email:          null,
      google_channel_id:     null,
      google_channel_expiry: null,
    })
    .eq('id', userId);
  if (error) throw new Error(`clearGoogleConnection: ${error.message}`);
}

async function clearSlackUserToken(userId) {
  const { error } = await supabase
    .from('users')
    .update({ slack_user_token: null })
    .eq('id', userId);
  if (error) throw new Error(`clearSlackUserToken: ${error.message}`);
}

async function saveGoogleChannel(userId, channelId, expiry) {
  const { error } = await supabase
    .from('users')
    .update({ google_channel_id: channelId, google_channel_expiry: expiry })
    .eq('id', userId);
  if (error) throw new Error(`saveGoogleChannel: ${error.message}`);
}

async function getUserByChannelId(channelId) {
  const { data } = await supabase
    .from('users')
    .select('*')
    .eq('google_channel_id', channelId)
    .maybeSingle();
  return data ? toUser(data) : null;
}

async function getAllGoogleConnectedUsers() {
  const { data, error } = await supabase
    .from('users')
    .select('*')
    .not('google_tokens', 'is', null);
  if (error) throw new Error(`getAllGoogleConnectedUsers: ${error.message}`);
  return (data || []).map(toUser);
}

// ---------------------------------------------------------------------------
// Teams
// ---------------------------------------------------------------------------

async function getTeam(teamId) {
  const { data } = await supabase
    .from('teams').select('*').eq('id', teamId).maybeSingle();
  return data ? toTeam(data) : null;
}

async function getAllTeams(workspaceId) {
  const q = supabase.from('teams').select('*');
  if (workspaceId) q.eq('workspace_id', workspaceId);
  const { data, error } = await q;
  if (error) throw new Error(`getAllTeams: ${error.message}`);
  return (data || []).map(toTeam);
}

async function getTeamsManagedBy(userId, workspaceId) {
  const q = supabase.from('teams').select('*').eq('manager_id', userId);
  if (workspaceId) q.eq('workspace_id', workspaceId);
  const { data, error } = await q;
  if (error) throw new Error(`getTeamsManagedBy: ${error.message}`);
  return (data || []).map(toTeam);
}

async function deleteTeam(teamId) {
  // Cascade: clear all memberships, clear any users whose primary team pointed here,
  // then remove the team row itself.
  await supabase.from('team_members').delete().eq('team_id', teamId);
  await supabase.from('users').update({ team_id: null }).eq('team_id', teamId);
  const { error } = await supabase.from('teams').delete().eq('id', teamId);
  if (error) throw new Error(`deleteTeam: ${error.message}`);
}

async function upsertTeam(teamData) {
  const workspaceId = await _resolveWorkspaceId(teamData.workspaceId);
  const row = {
    id:           teamData.id,
    name:         teamData.name,
    anchor_days:  teamData.anchorDays || [],
    manager_id:   teamData.managerId  || null,
    workspace_id: workspaceId,
  };
  const { data, error } = await supabase
    .from('teams')
    .upsert(row, { onConflict: 'id' })
    .select()
    .single();
  if (error) throw new Error(`upsertTeam: ${error.message}`);
  return toTeam(data);
}

async function updateUserTeam(userId, teamId) {
  // Sets users.team_id (legacy "primary team" pointer). team_members is the
  // source of truth for multi-team membership — use addUserToTeam for that.
  const { error } = await supabase
    .from('users').update({ team_id: teamId }).eq('id', userId);
  if (error) throw new Error(`updateUserTeam: ${error.message}`);
}

async function addUserToTeam(userId, teamId) {
  // Inherit workspace_id from the team row to keep tenant isolation enforceable.
  const { data: teamRow, error: tErr } = await supabase
    .from('teams').select('workspace_id').eq('id', teamId).maybeSingle();
  if (tErr) throw new Error(`addUserToTeam (team lookup): ${tErr.message}`);
  if (!teamRow?.workspace_id) throw new Error(`addUserToTeam: team ${teamId} has no workspace_id`);

  const { error } = await supabase
    .from('team_members')
    .upsert(
      { user_id: userId, team_id: teamId, workspace_id: teamRow.workspace_id },
      { onConflict: 'user_id,team_id' },
    );
  if (error) throw new Error(`addUserToTeam: ${error.message}`);
}

async function removeUserFromTeam(userId, teamId) {
  const { error } = await supabase
    .from('team_members')
    .delete()
    .eq('user_id', userId)
    .eq('team_id', teamId);
  if (error) throw new Error(`removeUserFromTeam: ${error.message}`);
}

async function getUserTeams(userId) {
  const { data, error } = await supabase
    .from('team_members').select('team_id').eq('user_id', userId);
  if (error) throw new Error(`getUserTeams: ${error.message}`);
  return (data || []).map(r => r.team_id);
}

// Bulk variant — Map<userId, Set<teamId>> for many users in one query.
// Ids with no memberships are absent from the Map.
async function getUserTeamsMap(userIds) {
  if (!userIds || userIds.length === 0) return new Map();
  const { data, error } = await supabase
    .from('team_members').select('user_id, team_id').in('user_id', userIds);
  if (error) throw new Error(`getUserTeamsMap: ${error.message}`);
  const out = new Map();
  for (const r of data || []) {
    let set = out.get(r.user_id);
    if (!set) { set = new Set(); out.set(r.user_id, set); }
    set.add(r.team_id);
  }
  return out;
}

async function isTeamManager(userId) {
  const { data, error } = await supabase
    .from('teams').select('id').eq('manager_id', userId).limit(1);
  if (error) throw new Error(`isTeamManager: ${error.message}`);
  return (data || []).length > 0;
}

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

async function findUserByName(query, workspaceId) {
  const q = supabase.from('users').select('*').ilike('display_name', `%${query}%`);
  if (workspaceId) q.eq('workspace_id', workspaceId);
  const { data, error } = await q;
  if (error) throw new Error(`findUserByName: ${error.message}`);
  return (data || []).map(row => toUser(row));
}

async function getDependencyGraph(userId) {
  const { data, error } = await supabase
    .from('dependencies')
    .select('peer_id, score, is_manual')
    .eq('user_id', userId);
  if (error) throw new Error(`getDependencyGraph: ${error.message}`);
  return (data || []).map(r => ({ peerId: r.peer_id, score: r.score, isManual: r.is_manual }));
}

// Bulk fetch every directional edge in a workspace in one query.
// Replaces the N+1 pattern of looping getDependencyGraph(userId) per user.
async function getWorkspaceDependencies(workspaceId) {
  if (!workspaceId) throw new Error('getWorkspaceDependencies: workspaceId is required');
  const { data, error } = await supabase
    .from('dependencies')
    .select('user_id, peer_id, score, is_manual')
    .eq('workspace_id', workspaceId);
  if (error) throw new Error(`getWorkspaceDependencies: ${error.message}`);
  return (data || []).map(r => ({
    userId:   r.user_id,
    peerId:   r.peer_id,
    score:    r.score,
    isManual: r.is_manual,
  }));
}

async function getAllManualDependencies(workspaceId) {
  const q = supabase
    .from('dependencies')
    .select('user_id, peer_id, score')
    .eq('is_manual', true);
  if (workspaceId) q.eq('workspace_id', workspaceId);
  const { data, error } = await q;
  if (error) throw new Error(`getAllManualDependencies: ${error.message}`);
  return data || [];
}

async function _updateDependencies(userId, edges) {
  // Replace all edges for this user atomically. workspace_id is inherited from
  // the user row so dependency rows stay consistent with their owner.
  // If the user isn't in the DB (e.g., AI returned a Slack ID we never
  // registered) we skip silently — the caller should pre-filter, but this
  // backstop prevents one stray row from killing the whole batch.
  const { data: userRow } = await supabase
    .from('users').select('workspace_id').eq('id', userId).maybeSingle();
  if (!userRow?.workspace_id) {
    console.warn(`[_updateDependencies] Skipping unknown user ${userId}`);
    return;
  }
  await supabase.from('dependencies').delete().eq('user_id', userId);
  if (edges.length === 0) return;
  const { error } = await supabase.from('dependencies').insert(
    edges.map(e => ({
      user_id:      userId,
      peer_id:      e.peerId,
      score:        e.score,
      is_manual:    e.isManual || false,
      workspace_id: userRow.workspace_id,
    }))
  );
  if (error) throw new Error(`_updateDependencies: ${error.message}`);
}

// ---------------------------------------------------------------------------
// Workspaces (Slack OAuth installations) + user role
// ---------------------------------------------------------------------------

async function upsertWorkspace(installation) {
  const row = {
    id:                installation.team.id,
    name:              installation.team.name,
    bot_token:         installation.bot.token,
    bot_user_id:       installation.bot.userId,
    installer_user_id: installation.user.id,
    installation,
  };
  const { error } = await supabase
    .from('workspaces')
    .upsert(row, { onConflict: 'id' });
  if (error) throw new Error(`upsertWorkspace: ${error.message}`);
}

async function getWorkspace(teamId) {
  const { data } = await supabase
    .from('workspaces').select('*').eq('id', teamId).maybeSingle();
  return data || null;
}

async function deleteWorkspace(teamId) {
  const { error } = await supabase
    .from('workspaces').delete().eq('id', teamId);
  if (error) throw new Error(`deleteWorkspace: ${error.message}`);
}

async function getAllWorkspaces() {
  const { data, error } = await supabase
    .from('workspaces').select('*');
  if (error) throw new Error(`getAllWorkspaces: ${error.message}`);
  return data || [];
}

async function setUserRole(userId, role, workspaceId) {
  // Ensure the row exists (display_name is NOT NULL), then set role.
  await ensureUser(userId, { workspaceId });
  const { error } = await supabase
    .from('users').update({ role }).eq('id', userId);
  if (error) throw new Error(`setUserRole: ${error.message}`);
}

async function getUserRole(userId) {
  const { data } = await supabase
    .from('users').select('role').eq('id', userId).maybeSingle();
  return data?.role || null;
}

// ---------------------------------------------------------------------------

module.exports = {
  STATUS,
  ensureUser,
  getUser,
  getAllUsers,
  getStatusForDate,
  getScheduleForDates,
  getSchedulesForUsers,
  setStatus,
  onStatusChange,
  saveUserToken,
  getUserToken,
  getUserTokens,
  saveGoogleTokens,
  getGoogleTokens,
  saveGoogleEmail,
  getGoogleEmail,
  getGoogleEmailsForWorkspace,
  saveGoogleChannel,
  clearGoogleConnection,
  clearSlackUserToken,
  getUserByChannelId,
  getAllGoogleConnectedUsers,
  getTeam,
  getAllTeams,
  getTeamsManagedBy,
  upsertTeam,
  deleteTeam,
  updateUserTeam,
  addUserToTeam,
  removeUserFromTeam,
  getUserTeams,
  getUserTeamsMap,
  isTeamManager,
  findUserByName,
  getDependencyGraph,
  getWorkspaceDependencies,
  getAllManualDependencies,
  _updateDependencies,
  upsertWorkspace,
  getWorkspace,
  getAllWorkspaces,
  deleteWorkspace,
  setUserRole,
  getUserRole,
};
