// Express REST API — serves graph + schedule data to the React admin dashboard.
// Runs on port 3001 alongside the Bolt Socket Mode app (no port conflict).

const express      = require('express');
const cors         = require('cors');
const jwt          = require('jsonwebtoken');
const { InstallProvider } = require('@slack/oauth');
const { WebClient }       = require('@slack/web-api');
const db           = require('./db');
const { upcomingWorkDays } = require('./utils/dates');
const { syncTeamsFromChannels } = require('./services/teamSync');
const googleCalendar = require('./services/googleCalendar');
const { getUserEmail, watchCalendar } = googleCalendar;

// In-memory cooldown — prevents spamming DMs when calendar changes rapidly
const wfhDmCooldown = new Map(); // userId → timestamp
const WFH_DM_COOLDOWN_MS = 60 * 60 * 1000; // 1 hour

const JWT_SECRET   = process.env.JWT_SECRET   || 'hybridsync-secret';
const BACKEND_URL  = process.env.BACKEND_URL  || 'http://localhost:3001';
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:5173';

const app = express();
app.use(cors());
app.use(express.json());

// ---------------------------------------------------------------------------
// Slack OAuth distribution — /slack/install and /slack/oauth_redirect
// ---------------------------------------------------------------------------
// We host these on Express because Bolt's built-in install server runs on its
// own port (default 3000) which Railway doesn't expose publicly. Same Bolt
// `installationStore` (in app.js) is referenced via db helpers.

const slackInstaller = process.env.SLACK_CLIENT_ID && process.env.SLACK_CLIENT_SECRET && process.env.SLACK_STATE_SECRET
  ? new InstallProvider({
      clientId:     process.env.SLACK_CLIENT_ID,
      clientSecret: process.env.SLACK_CLIENT_SECRET,
      stateSecret:  process.env.SLACK_STATE_SECRET,
      installationStore: {
        storeInstallation: (installation) => db.upsertWorkspace(installation),
        fetchInstallation: async (q) => {
          const ws = await db.getWorkspace(q.teamId);
          if (!ws) throw new Error(`No installation for team ${q.teamId}`);
          return ws.installation;
        },
        deleteInstallation: (q) => db.deleteWorkspace(q.teamId),
      },
    })
  : null;

if (slackInstaller) {
  // GET /slack/install — generates the Slack OAuth consent URL and 302s
  app.get('/slack/install', async (req, res) => {
    await slackInstaller.handleInstallPath(req, res, {}, {
      scopes: [
        'channels:history', 'channels:read',
        'chat:write',
        'im:history', 'im:write',
        'users:read', 'users:read.email',
        'team:read',
        'app_mentions:read',
        'groups:history', 'groups:read',
        'reactions:write',
      ],
    });
  });

  // GET /slack/oauth_redirect — Slack redirects here after consent
  app.get('/slack/oauth_redirect', async (req, res) => {
    await slackInstaller.handleCallback(req, res, {
      success: async (installation, _options, _req, response) => {
        // storeInstallation has already run. Promote installer to admin.
        await db.setUserRole(installation.user.id, 'admin');
        response.writeHead(302, { Location: `${FRONTEND_URL}?installed=true` });
        response.end();
      },
      failure: async (error, _options, _req, response) => {
        response.writeHead(302, {
          Location: `${FRONTEND_URL}?install_error=${encodeURIComponent(error.message)}`,
        });
        response.end();
      },
    });
  });

  console.log('[OAuth] Slack install routes mounted at /slack/install + /slack/oauth_redirect');
}

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

// Builds a teamId -> teamName lookup across both legacy primary teamId
// and the multi-team teamIds array on each user.
async function teamNameMap(users) {
  const ids = new Set();
  for (const u of users) {
    if (u.teamId && typeof u.teamId === 'string') ids.add(u.teamId);
    for (const id of u.teamIds || []) if (id) ids.add(id);
  }
  const teams = await Promise.all([...ids].map(id => db.getTeam(id)));
  return Object.fromEntries(teams.filter(Boolean).map(t => [t.id, t.name]));
}

function decorateUser(u, map) {
  const teamIds   = u.teamIds && u.teamIds.length ? u.teamIds : (u.teamId ? [u.teamId] : []);
  const teamNames = teamIds.map(id => map[id] || id);
  return { ...u, teamIds, teamNames, teamName: map[u.teamId] || u.teamId };
}

// GET /api/auth/slack — initiate Sign in with Slack (OpenID Connect)
app.get('/api/auth/slack', (req, res) => {
  if (!process.env.SLACK_CLIENT_ID) return res.status(503).send('Slack OAuth not configured');
  const params = new URLSearchParams({
    client_id:     process.env.SLACK_CLIENT_ID,
    scope:         'openid profile email',
    redirect_uri:  `${BACKEND_URL}/api/auth/slack/callback`,
    response_type: 'code',
    state:         'hybridsync-dashboard',
  });
  res.redirect(`https://slack.com/openid/connect/authorize?${params}`);
});

// GET /api/auth/slack/callback — Slack redirects here after user authorises
app.get('/api/auth/slack/callback', async (req, res) => {
  const { code, error } = req.query;
  if (error || !code) return res.redirect(`${FRONTEND_URL}?auth_error=cancelled`);

  try {
    const response = await fetch('https://slack.com/api/openid.connect.token', {
      method:  'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id:     process.env.SLACK_CLIENT_ID,
        client_secret: process.env.SLACK_CLIENT_SECRET,
        code,
        redirect_uri:  `${BACKEND_URL}/api/auth/slack/callback`,
      }),
    });
    const data = await response.json();
    if (!data.ok) throw new Error(data.error);

    // Decode id_token (JWT) — email and user ID are already in the token, no extra API call needed
    const payload    = JSON.parse(Buffer.from(data.id_token.split('.')[1], 'base64url').toString());
    const slackUserId = payload.sub;
    const name        = payload.name || payload['https://slack.com/user_name'] || slackUserId;

    // Determine dashboard role — admins are DB-driven (set on Slack install);
    // managers are derived from teams.manager_id.
    const userRole = await db.getUserRole(slackUserId);

    let role, teamId, displayName;

    if (userRole === 'admin') {
      role        = 'admin';
      displayName = name;
    } else {
      // Check if this user is a manager of any team
      const teams       = await db.getAllTeams();
      const managedTeam = teams.find(t => t.managerId === slackUserId);
      if (managedTeam) {
        role        = 'manager';
        teamId      = managedTeam.id;
        displayName = managedTeam.name;
      } else {
        return res.redirect(`${FRONTEND_URL}?auth_error=unauthorized`);
      }
    }

    const token = jwt.sign({ role, teamId, name: displayName }, JWT_SECRET, { expiresIn: '12h' });
    const params = new URLSearchParams({ token, role, name: displayName });
    if (teamId) params.set('teamId', teamId);
    res.redirect(`${FRONTEND_URL}?${params}`);
  } catch (e) {
    console.error('[SlackAuth] Callback error:', e.message);
    res.redirect(`${FRONTEND_URL}?auth_error=${encodeURIComponent(e.message)}`);
  }
});

// GET /api/auth/teams — public: list of teams for the login page dropdown
app.get('/api/auth/teams', async (req, res) => {
  const users   = await db.getAllUsers();
  const teamIds = new Set();
  for (const u of users) {
    if (u.teamId) teamIds.add(u.teamId);
    for (const id of u.teamIds || []) teamIds.add(id);
  }
  const teams = (await Promise.all([...teamIds].map(id => db.getTeam(id)))).filter(Boolean);
  res.json(teams.map(t => ({ id: t.id, name: t.name })));
});

// GET /api/users — all users with team info (teamIds[] + teamNames[])
app.get('/api/users', requireAuth, async (req, res) => {
  const users = await db.getAllUsers();
  const map   = await teamNameMap(users);
  res.json(users.map(u => decorateUser(u, map)));
});

// GET /api/graph — full company dependency graph as { nodes, edges }
// Suitable for direct consumption by React Flow
app.get('/api/graph', requireAuth, async (req, res) => {
  const users = await db.getAllUsers();

  const map   = await teamNameMap(users);
  const nodes = users.map(u => {
    const teamIds   = u.teamIds && u.teamIds.length ? u.teamIds : (u.teamId ? [u.teamId] : []);
    const teamNames = teamIds.map(id => map[id] || id);
    return {
      id: u.id,
      data: {
        label:    u.displayName,
        team:     u.teamId,                          // primary (legacy field)
        teamName: map[u.teamId] || u.teamId,
        teamIds,
        teamNames,
        role:     u.role,
      },
      position: { x: 0, y: 0 },
    };
  });

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
      user:     decorateUser(u, map),
      schedule: await db.getScheduleForDates(u.id, dateKeys),
    }))
  );

  res.json({ dates, rows });
});

// GET /api/teams — all teams that have any membership (primary or multi-team)
app.get('/api/teams', requireAuth, async (req, res) => {
  const users   = await db.getAllUsers();
  const teamIds = new Set();
  for (const u of users) {
    if (u.teamId) teamIds.add(u.teamId);
    for (const id of u.teamIds || []) teamIds.add(id);
  }
  const teams = await Promise.all([...teamIds].map(id => db.getTeam(id)));
  res.json(teams.filter(Boolean));
});

// POST /api/teams/:teamId/manager — set manager { managerId: 'U...' }
app.post('/api/teams/:teamId/manager', requireAuth, async (req, res) => {
  const { managerId } = req.body;
  if (!managerId) return res.status(400).json({ error: 'managerId required' });
  const team = await db.getTeam(req.params.teamId);
  if (!team) return res.status(404).json({ error: 'Team not found' });
  const updated = await db.upsertTeam({ ...team, managerId });
  res.json(updated);
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
    const email  = await getUserEmail(tokens).catch(e => {
      console.error('[Google] Failed to get email:', e.message);
      return null;
    });
    await db.saveGoogleTokens(userId, tokens);
    if (email) await db.saveGoogleEmail(userId, email);
    else console.warn('[Google] Email not returned — check OAuth scopes');
    watchCalendar(userId, tokens).catch(e =>
      console.error('[Google] Failed to set up webhook:', e.message)
    );
    console.log(`[Google] Saved calendar tokens for ${userId} (${email || 'email unavailable'})`);
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

// POST /api/google/webhook — Google Calendar push notification
app.post('/api/google/webhook', async (req, res) => {
  res.sendStatus(200); // Respond immediately — Google expects fast response

  const channelId     = req.headers['x-goog-channel-id'];
  const resourceState = req.headers['x-goog-resource-state'];

  if (!channelId || resourceState === 'sync') return; // Initial handshake — ignore

  try {
    const user = await db.getUserByChannelId(channelId);
    if (!user) return;

    const { todayKey } = require('./utils/dates');
    const today   = todayKey();
    const tokens  = await db.getGoogleTokens(user.id);
    if (!tokens) return;

    const [load, statusResult] = await Promise.all([
      googleCalendar.getMeetingsForDate(user.id, today),
      db.getStatusForDate(user.id, today),
    ]);

    if (!load || load.label !== 'Heavy') return;
    if (statusResult !== 'Office') return;

    // Only suggest WFH if most meetings are online
    const mostlyOnline = (load.onlineCount + load.unknownCount) > load.offlineCount;
    if (!mostlyOnline) return;

    // Cooldown check — don't DM same user more than once per hour
    const lastDm = wfhDmCooldown.get(user.id);
    if (lastDm && Date.now() - lastDm < WFH_DM_COOLDOWN_MS) return;
    wfhDmCooldown.set(user.id, Date.now());

    const workspaces = await db.getAllWorkspaces();
    if (!workspaces.length) {
      console.warn('[Google Webhook] No workspace installed — cannot DM');
      return;
    }
    const client = new WebClient(workspaces[0].bot_token);
    await client.chat.postMessage({
      channel: user.id,
      text: `🔴 *Meeting load update:* You now have *${load.count} meetings* today (${load.totalMinutes} min total — ${load.onlineCount} online, ${load.offlineCount} offline). Most can be attended remotely — consider switching to *WFH 🏠*.`,
    });
    console.log(`[Google Webhook] WFH suggestion sent to ${user.id}`);
  } catch (e) {
    console.error('[Google Webhook] Error:', e.message);
  }
});

// POST /api/recalculate-deps — rebuild dependency graph from last 30 days of Slack interactions
app.post('/api/recalculate-deps', requireAuth, async (req, res) => {
  try {
    const workspaces = await db.getAllWorkspaces();
    if (!workspaces.length) return res.status(503).json({ error: 'No Slack workspace installed' });
    const client = new WebClient(workspaces[0].bot_token);
    const { runWeeklyMapping } = require('./ai/batch');
    await runWeeklyMapping(client);
    res.json({ ok: true });
  } catch (e) {
    console.error('[Recalc] Error:', e);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/sync-teams — pull all channels the bot is in and create/update teams
app.post('/api/sync-teams', requireAuth, async (req, res) => {
  try {
    const workspaces = await db.getAllWorkspaces();
    if (!workspaces.length) return res.status(503).json({ error: 'No Slack workspace installed' });
    const client = new WebClient(workspaces[0].bot_token);
    const results = await syncTeamsFromChannels(client);
    res.json({ synced: results.length, results });
  } catch (e) {
    console.error('[SyncTeams] Error:', e);
    res.status(500).json({ error: e.message });
  }
});


function start(port = 3001) {
  app.listen(port, () => console.log(`[API] REST server listening on http://localhost:${port}`));
}

module.exports = { start };
