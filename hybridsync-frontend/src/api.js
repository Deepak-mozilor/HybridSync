const BASE = 'http://localhost:3001/api';

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

export async function fetchUsers()       { return (await fetch(`${BASE}/users`)).json(); }
export async function fetchGraph()       { return (await fetch(`${BASE}/graph`)).json(); }
export async function fetchWeekSchedule(){ return (await fetch(`${BASE}/schedule/week`)).json(); }
export async function fetchTeams()       { return (await fetch(`${BASE}/teams`)).json(); }
export async function updateAnchor(teamId, anchorDays) {
  return (await fetch(`${BASE}/teams/${teamId}/anchor`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ anchorDays }),
  })).json();
}

export async function syncTeams() {
  return (await fetch(`${BASE}/sync-teams`, { method: 'POST' })).json();
}
