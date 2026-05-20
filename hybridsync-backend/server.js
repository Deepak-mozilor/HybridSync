// Express REST API — serves graph + schedule data to the React admin dashboard.
// Runs on port 3001 alongside the Bolt Socket Mode app (no port conflict).

const express      = require('express');
const cors         = require('cors');
const jwt          = require('jsonwebtoken');
const db           = require('./db');
const { upcomingWorkDays } = require('./utils/dates');
const { syncTeamsFromChannels } = require('./services/teamSync');
const googleCalendar = require('./services/googleCalendar');

const JWT_SECRET = process.env.JWT_SECRET || 'hybridsync-secret';

let slackClient = null;

const app = express();
app.use(cors());
app.use(express.json());

// JWT auth middleware — verifies Authorization: Bearer <token>
function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token  = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Missing token' });
  try {
    req.auth = jwt.verify(token, JWT_SECRET);
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

// Builds a teamId -> teamName lookup from Firestore
async function teamNameMap(users) {
  const ids   = [...new Set(users.map(u => u.teamId).filter(id => id && typeof id === 'string'))];
  const teams = await Promise.all(ids.map(id => db.getTeam(id)));
  return Object.fromEntries(teams.filter(Boolean).map(t => [t.id, t.name]));
}

// POST /api/auth/login
app.post('/api/auth/login', async (req, res) => {
  const { role, password, teamId } = req.body;

  if (role === 'hr') {
    if (password !== (process.env.HR_PASSWORD || 'hr@hybridsync')) {
      return res.status(401).json({ error: 'Invalid password' });
    }
    const token = jwt.sign({ role: 'hr', name: 'HR Admin' }, JWT_SECRET, { expiresIn: '12h' });
    return res.json({ token, role: 'hr', name: 'HR Admin' });
  }

  if (role === 'manager') {
    if (password !== (process.env.MANAGER_PASSWORD || 'manager@hybridsync')) {
      return res.status(401).json({ error: 'Invalid password' });
    }
    if (!teamId) return res.status(400).json({ error: 'teamId required for manager login' });
    const team = await db.getTeam(teamId);
    if (!team) return res.status(404).json({ error: 'Team not found' });
    const token = jwt.sign({ role: 'manager', teamId, name: team.name }, JWT_SECRET, { expiresIn: '12h' });
    return res.json({ token, role: 'manager', teamId, name: team.name });
  }

  return res.status(400).json({ error: 'role must be hr or manager' });
});

// GET /api/auth/teams — public: list of teams for the login page dropdown
app.get('/api/auth/teams', async (req, res) => {
  const users   = await db.getAllUsers();
  const teamIds = [...new Set(users.map(u => u.teamId).filter(Boolean))];
  const teams   = (await Promise.all(teamIds.map(id => db.getTeam(id)))).filter(Boolean);
  res.json(teams.map(t => ({ id: t.id, name: t.name })));
});

// GET /api/users — all users with team info
app.get('/api/users', requireAuth, async (req, res) => {
  const users = await db.getAllUsers();
  const map   = await teamNameMap(users);
  res.json(users.map(u => ({ ...u, teamName: map[u.teamId] || u.teamId })));
});

// GET /api/graph — full company dependency graph as { nodes, edges }
// Suitable for direct consumption by React Flow
app.get('/api/graph', requireAuth, async (req, res) => {
  const users = await db.getAllUsers();

  const map   = await teamNameMap(users);
  const nodes = users.map(u => ({
    id: u.id,
    data: { label: u.displayName, team: u.teamId, teamName: map[u.teamId] || u.teamId, role: u.role },
    position: { x: 0, y: 0 },
  }));

  const edges = [];
  const seen  = new Set();
  for (const u of users) {
    const deps = await db.getDependencyGraph(u.id);
    for (const { peerId, score } of deps) {
      const key = [u.id, peerId].sort().join('--');
      if (seen.has(key)) continue; // deduplicate symmetric pairs
      seen.add(key);
      edges.push({
        id:     `${u.id}-${peerId}`,
        source: u.id,
        target: peerId,
        label:  String(score),
        data:   { score },
        style:  { strokeWidth: Math.max(1, score / 2.5) },
      });
    }
  }

  res.json({ nodes, edges });
});

// GET /api/graph/:userId — dependency edges for one user
app.get('/api/graph/:userId', requireAuth, async (req, res) => {
  const edges = await db.getDependencyGraph(req.params.userId);
  res.json(edges);
});

// GET /api/schedule/week — all users' statuses for the current week
// Returns { dates: [...], rows: [{ user, schedule: [{dateKey, day, status}] }] }
app.get('/api/schedule/week', requireAuth, async (req, res) => {
  const users    = await db.getAllUsers();
  const dates    = upcomingWorkDays(5);
  const dateKeys = dates.map(d => d.dateKey);

  const map  = await teamNameMap(users);
  const rows = await Promise.all(
    users.map(async u => ({
      user:     { ...u, teamName: map[u.teamId] || u.teamId },
      schedule: await db.getScheduleForDates(u.id, dateKeys),
    }))
  );

  res.json({ dates, rows });
});

// GET /api/teams — all teams with anchorDays
app.get('/api/teams', requireAuth, async (req, res) => {
  const users   = await db.getAllUsers();
  const teamIds = [...new Set(users.map(u => u.teamId).filter(id => id && typeof id === 'string'))];
  const teams   = await Promise.all(teamIds.map(id => db.getTeam(id)));
  res.json(teams.filter(Boolean));
});

// POST /api/teams/:teamId/anchor — update anchor days { anchorDays: ['Tue', 'Wed'] }
app.post('/api/teams/:teamId/anchor', requireAuth, async (req, res) => {
  const { anchorDays } = req.body;
  if (!Array.isArray(anchorDays)) return res.status(400).json({ error: 'anchorDays must be an array' });

  const team = await db.getTeam(req.params.teamId);
  if (!team) return res.status(404).json({ error: 'Team not found' });

  const updated = await db.upsertTeam({ ...team, anchorDays });
  res.json(updated);
});

// GET /api/oauth/callback — Slack redirects here after user grants users.profile:write
app.get('/api/oauth/callback', async (req, res) => {
  const { code, state: userId, error } = req.query;
  if (error) return res.send('<h2 style="font-family:system-ui;text-align:center;padding-top:60px">Authorization cancelled.</h2>');
  if (!code || !userId) return res.status(400).send('Missing code or state');

  try {
    const response = await fetch('https://slack.com/api/oauth.v2.access', {
      method:  'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id:     process.env.SLACK_CLIENT_ID,
        client_secret: process.env.SLACK_CLIENT_SECRET,
        code,
        redirect_uri:  process.env.SLACK_OAUTH_REDIRECT_URI || 'http://localhost:3001/api/oauth/callback',
      }),
    });
    const data = await response.json();
    if (!data.ok) throw new Error(data.error);

    const userToken = data.authed_user?.access_token;
    if (!userToken) throw new Error('No user token returned');

    await db.saveUserToken(userId, userToken);
    console.log(`[OAuth] Saved user token for ${userId}`);

    res.send(`<html><body style="font-family:system-ui;text-align:center;padding-top:60px;color:#1e293b">
      <div style="font-size:48px;margin-bottom:16px">✅</div>
      <h2 style="margin:0 0 8px">Slack Status Connected!</h2>
      <p style="color:#6b7280">Your HybridSync statuses will now update your Slack profile automatically.</p>
      <p style="color:#9ca3af;font-size:13px">You can close this tab and return to Slack.</p>
    </body></html>`);
  } catch (e) {
    console.error('[OAuth] Callback error:', e.message);
    res.status(500).send(`<h2 style="font-family:system-ui;text-align:center;padding-top:60px">Connection failed: ${e.message}</h2>`);
  }
});

// GET /api/google/auth — start Google Calendar OAuth (opened in browser from App Home button)
app.get('/api/google/auth', async (req, res) => {
  const { state: userId } = req.query;
  if (!userId) return res.status(400).send('Missing user ID');
  if (!process.env.GOOGLE_CLIENT_ID) return res.status(503).send('Google Calendar not configured');
  try {
    const url = googleCalendar.generateAuthUrl(userId);
    res.redirect(url);
  } catch (e) {
    res.status(500).send(`Failed to start OAuth: ${e.message}`);
  }
});

// GET /api/google/callback — Google redirects here after user grants calendar access
app.get('/api/google/callback', async (req, res) => {
  const { code, state: userId, error } = req.query;
  if (error || !code || !userId) {
    return res.send('<html><body style="font-family:system-ui;text-align:center;padding-top:60px"><div style="font-size:48px">❌</div><h2>Authorization cancelled.</h2><p style="color:#6b7280">You can close this tab.</p></body></html>');
  }
  try {
    const tokens = await googleCalendar.exchangeCode(code);
    await db.saveGoogleTokens(userId, tokens);
    console.log(`[Google] Saved calendar tokens for ${userId}`);
    res.send(`<html><body style="font-family:system-ui;text-align:center;padding-top:60px;color:#1e293b">
      <div style="font-size:48px;margin-bottom:16px">✅</div>
      <h2 style="margin:0 0 8px">Google Calendar Connected!</h2>
      <p style="color:#6b7280">Your meeting schedule will now be considered when coordinating with collaborators.</p>
      <p style="color:#9ca3af;font-size:13px">You can close this tab and return to Slack.</p>
    </body></html>`);
  } catch (e) {
    console.error('[Google] OAuth callback error:', e.message);
    res.status(500).send(`<html><body style="font-family:system-ui;text-align:center;padding-top:60px"><h2>Connection failed: ${e.message}</h2></body></html>`);
  }
});

// POST /api/recalculate-deps — rebuild dependency graph from last 30 days of Slack interactions
app.post('/api/recalculate-deps', requireAuth, async (req, res) => {
  if (!slackClient) return res.status(503).json({ error: 'Slack client not initialised yet' });
  try {
    const { runWeeklyMapping } = require('./ai/batch');
    await runWeeklyMapping(slackClient);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/sync-teams — pull all channels the bot is in and create/update teams
app.post('/api/sync-teams', requireAuth, async (req, res) => {
  if (!slackClient) return res.status(503).json({ error: 'Slack client not initialised yet' });
  try {
    const results = await syncTeamsFromChannels(slackClient);
    res.json({ synced: results.length, results });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});


function start(port = 3001, client) {
  slackClient = client;
  app.listen(port, () => console.log(`[API] REST server listening on http://localhost:${port}`));
}

module.exports = { start };
