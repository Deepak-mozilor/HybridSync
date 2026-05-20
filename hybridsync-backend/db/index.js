// Supabase (Postgres) data layer — same async API as the in-memory version.
// Schema: run db/schema.sql once in the Supabase SQL editor before first start.
//
// Tables:
//   users        — id, display_name, team_id, role, week (JSONB)
//   teams        — id, name, anchor_days (TEXT[]), manager_id
//   overrides    — user_id, date_key, status
//   dependencies — user_id, peer_id, score

const { createClient } = require('@supabase/supabase-js');
const { STATUS, DEFAULT_WEEK, teams, seedUsers, seedDependencies } = require('../data/seed');
const { dayLabel } = require('../utils/dates');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY,
);

// ---------------------------------------------------------------------------
// Row <-> JS mappers
// ---------------------------------------------------------------------------

function toUser(row) {
  return {
    id:                   row.id,
    displayName:          row.display_name,
    teamId:               row.team_id            || null,
    role:                 row.role,
    week:                 row.week               || {},
    googleChannelExpiry:  row.google_channel_expiry || null,
  };
}

function toTeam(row) {
  return {
    id:         row.id,
    name:       row.name,
    anchorDays: row.anchor_days || [],
    managerId:  row.manager_id  || null,
  };
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

  console.log('[DB] Seeding Supabase with initial data…');

  // Teams (may be empty — created dynamically via /api/sync-teams)
  const teamRows = Object.values(teams).map(t => ({
    id:          t.id,
    name:        t.name,
    anchor_days: t.anchorDays || [],
    manager_id:  t.managerId  || null,
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
    }))
  );
  if (uErr) throw new Error(`seed users: ${uErr.message}`);

  // Dependencies
  const depRows = [];
  for (const [userId, edges] of Object.entries(seedDependencies)) {
    for (const { peerId, score } of edges) {
      depRows.push({ user_id: userId, peer_id: peerId, score });
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

async function ensureUser(userId, { displayName } = {}) {
  const { data } = await supabase
    .from('users').select('*').eq('id', userId).maybeSingle();

  if (data) {
    if (displayName) {
      await supabase.from('users').update({ display_name: displayName }).eq('id', userId);
    }
    return toUser({ ...data, display_name: displayName || data.display_name });
  }

  // New user
  const row = {
    id:           userId,
    display_name: displayName || userId,
    team_id:      null,
    role:         'employee',
    week:         { ...DEFAULT_WEEK },
  };
  const { error } = await supabase.from('users').insert(row);
  if (error) throw new Error(`ensureUser insert: ${error.message}`);

  return toUser(row);
}

async function getUser(userId) {
  const { data } = await supabase
    .from('users').select('*').eq('id', userId).maybeSingle();
  return data ? toUser(data) : null;
}

async function getAllUsers() {
  const { data, error } = await supabase.from('users').select('*');
  if (error) throw new Error(`getAllUsers: ${error.message}`);
  return (data || []).map(toUser);
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

let _afterSetStatus = null;
function onStatusChange(fn) { _afterSetStatus = fn; }

async function setStatus(userId, dateKey, status) {
  if (!Object.values(STATUS).includes(status)) {
    throw new Error(`Invalid status: ${status}`);
  }
  const { error } = await supabase
    .from('overrides')
    .upsert({ user_id: userId, date_key: dateKey, status }, { onConflict: 'user_id,date_key' });
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

async function upsertTeam(teamData) {
  const row = {
    id:          teamData.id,
    name:        teamData.name,
    anchor_days: teamData.anchorDays || [],
    manager_id:  teamData.managerId  || null,
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
  const { error } = await supabase
    .from('users').update({ team_id: teamId }).eq('id', userId);
  if (error) throw new Error(`updateUserTeam: ${error.message}`);
}

async function getTeammates(userId) {
  const { data: user } = await supabase
    .from('users').select('team_id').eq('id', userId).maybeSingle();
  if (!user || !user.team_id) return [];

  const { data, error } = await supabase
    .from('users')
    .select('*')
    .eq('team_id', user.team_id)
    .neq('id', userId);
  if (error) throw new Error(`getTeammates: ${error.message}`);
  return (data || []).map(toUser);
}

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

async function findUserByName(query) {
  const { data, error } = await supabase
    .from('users')
    .select('*')
    .ilike('display_name', `%${query}%`);
  if (error) throw new Error(`findUserByName: ${error.message}`);
  return (data || []).map(toUser);
}

async function getDependencyGraph(userId) {
  const { data, error } = await supabase
    .from('dependencies')
    .select('peer_id, score, is_manual')
    .eq('user_id', userId);
  if (error) throw new Error(`getDependencyGraph: ${error.message}`);
  return (data || []).map(r => ({ peerId: r.peer_id, score: r.score, isManual: r.is_manual }));
}

async function getAllManualDependencies() {
  const { data, error } = await supabase
    .from('dependencies')
    .select('user_id, peer_id, score')
    .eq('is_manual', true);
  if (error) throw new Error(`getAllManualDependencies: ${error.message}`);
  return data || [];
}

async function _updateDependencies(userId, edges) {
  // Replace all edges for this user atomically
  await supabase.from('dependencies').delete().eq('user_id', userId);
  if (edges.length === 0) return;
  const { error } = await supabase.from('dependencies').insert(
    edges.map(e => ({ user_id: userId, peer_id: e.peerId, score: e.score, is_manual: e.isManual || false }))
  );
  if (error) throw new Error(`_updateDependencies: ${error.message}`);
}

// ---------------------------------------------------------------------------

module.exports = {
  STATUS,
  ensureUser,
  getUser,
  getAllUsers,
  getStatusForDate,
  getScheduleForDates,
  setStatus,
  onStatusChange,
  saveUserToken,
  getUserToken,
  saveGoogleTokens,
  getGoogleTokens,
  saveGoogleEmail,
  getGoogleEmail,
  saveGoogleChannel,
  getUserByChannelId,
  getAllGoogleConnectedUsers,
  getTeam,
  upsertTeam,
  updateUserTeam,
  getTeammates,
  findUserByName,
  getDependencyGraph,
  getAllManualDependencies,
  _updateDependencies,
};
