const BASE = 'http://localhost:3001/api';

function authHeaders() {
  const token = localStorage.getItem('hs_token');
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function authedFetch(url, opts = {}) {
  const res = await fetch(url, {
    ...opts,
    headers: { ...(opts.headers || {}), ...authHeaders() },
  });
  if (res.status === 401) {
    localStorage.removeItem('hs_token');
    localStorage.removeItem('hs_auth');
    window.location.reload();
    throw new Error('Session expired');
  }
  return res;
}

export async function fetchLoginTeams() { return (await fetch(`${BASE}/auth/teams`)).json(); }
export async function login(role, password, teamId) {
  const res = await fetch(`${BASE}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ role, password, teamId }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Login failed');
  return data;
}

export async function fetchUsers()       { return (await authedFetch(`${BASE}/users`)).json(); }
export async function fetchGraph()       { return (await authedFetch(`${BASE}/graph`)).json(); }
export async function fetchWeekSchedule(){ return (await authedFetch(`${BASE}/schedule/week`)).json(); }
export async function fetchTeams()       { return (await authedFetch(`${BASE}/teams`)).json(); }
export async function updateAnchor(teamId, anchorDays) {
  return (await authedFetch(`${BASE}/teams/${teamId}/anchor`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ anchorDays }),
  })).json();
}

export async function syncTeams() {
  return (await authedFetch(`${BASE}/sync-teams`, { method: 'POST' })).json();
}

export async function recalculateDeps() {
  const res = await authedFetch(`${BASE}/recalculate-deps`, { method: 'POST' });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Recalculation failed');
  return data;
}
