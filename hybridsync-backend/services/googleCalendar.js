const { google } = require('googleapis');
const db = require('../db');

function createOAuthClient() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI || 'http://localhost:3001/api/google/callback'
  );
}

function generateAuthUrl(userId) {
  const client = createOAuthClient();
  return client.generateAuthUrl({
    access_type: 'offline',
    scope: ['https://www.googleapis.com/auth/calendar.readonly'],
    state: userId,
    prompt: 'consent',
  });
}

async function exchangeCode(code) {
  const client = createOAuthClient();
  const { tokens } = await client.getToken(code);
  return tokens;
}

async function getMeetingsForDate(userId, dateKey) {
  const tokens = await db.getGoogleTokens(userId);
  if (!tokens) return null;

  const client = createOAuthClient();
  client.setCredentials(tokens);

  // Auto-save refreshed tokens when they expire
  client.on('tokens', async (newTokens) => {
    await db.saveGoogleTokens(userId, { ...tokens, ...newTokens }).catch(() => {});
  });

  const calendar = google.calendar({ version: 'v3', auth: client });
  const timeMin = new Date(dateKey + 'T00:00:00').toISOString();
  const timeMax = new Date(dateKey + 'T23:59:59').toISOString();

  const res = await calendar.events.list({
    calendarId: 'primary',
    timeMin,
    timeMax,
    singleEvents: true,
    orderBy: 'startTime',
    fields: 'items(summary,start,end,status,location,conferenceData,attendees)',
  });

  const events = (res.data.items || []).filter(
    e => e.status !== 'cancelled' && e.start?.dateTime
  );

  // Classify each meeting as online, offline, or unknown.
  // Location takes priority — if a physical location is set, you need to be there
  // regardless of whether a Meet link was also added.
  function classifyEvent(e) {
    if (e.location && e.location.trim().length > 0) return 'offline';
    if (e.conferenceData?.entryPoints?.length) return 'online';
    return 'unknown';
  }

  const totalMinutes = events.reduce((sum, e) => {
    return sum + (new Date(e.end.dateTime) - new Date(e.start.dateTime)) / 60000;
  }, 0);

  const label = totalMinutes >= 240 ? 'Heavy' : totalMinutes >= 120 ? 'Moderate' : 'Light';
  const emoji = totalMinutes >= 240 ? '🔴' : totalMinutes >= 120 ? '🟡' : '🟢';

  const classified = events.map(e => ({ ...e, type: classifyEvent(e) }));
  const onlineCount  = classified.filter(e => e.type === 'online').length;
  const offlineCount = classified.filter(e => e.type === 'offline').length;
  const unknownCount = classified.filter(e => e.type === 'unknown').length;

  // Cross-reference attendee emails with HybridSync users
  const allUsers = await db.getAllUsers();
  const emailToName = {};
  for (const u of allUsers) {
    const email = await db.getGoogleEmail(u.id).catch(() => null);
    if (email) emailToName[email.toLowerCase()] = u.displayName;
  }

  return {
    count:        events.length,
    totalMinutes: Math.round(totalMinutes),
    label,
    emoji,
    onlineCount,
    offlineCount,
    unknownCount,
    slots: classified.map(e => {
      const attendeeEmails = (e.attendees || [])
        .filter(a => !a.self)
        .map(a => a.email?.toLowerCase())
        .filter(Boolean);

      const knownAttendees = attendeeEmails
        .map(email => emailToName[email])
        .filter(Boolean);

      return {
        title:     e.summary || 'Meeting',
        type:      e.type,
        start:     new Date(e.start.dateTime).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true }),
        end:       new Date(e.end.dateTime).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true }),
        attendees: knownAttendees,
      };
    }),
  };
}

function getWebhookUrl() {
  const base = process.env.SLACK_OAUTH_REDIRECT_URI?.replace('/api/oauth/callback', '')
    || 'http://localhost:3001';
  return `${base}/api/google/webhook`;
}

async function watchCalendar(userId, tokens) {
  const client = createOAuthClient();
  client.setCredentials(tokens);
  const calendar  = google.calendar({ version: 'v3', auth: client });
  const channelId = `hybridsync-${userId}-${Date.now()}`;

  const res = await calendar.events.watch({
    calendarId: 'primary',
    requestBody: {
      id:      channelId,
      type:    'web_hook',
      address: getWebhookUrl(),
      // 7 days max, in seconds
      expiration: String(Date.now() + 7 * 24 * 60 * 60 * 1000),
    },
  });

  const expiry = Number(res.data.expiration);
  await db.saveGoogleChannel(userId, channelId, expiry);
  console.log(`[Google] Watching calendar for ${userId} — channel ${channelId}`);
  return channelId;
}

// Renew channels that expire within the next 24 hours
async function renewChannels() {
  const users = await db.getAllGoogleConnectedUsers();
  const cutoff = Date.now() + 24 * 60 * 60 * 1000;
  for (const user of users) {
    const expiry = user.googleChannelExpiry;
    if (!expiry || expiry > cutoff) continue;
    const tokens = await db.getGoogleTokens(user.id).catch(() => null);
    if (!tokens) continue;
    await watchCalendar(user.id, tokens).catch(e =>
      console.error(`[Google] Failed to renew channel for ${user.id}:`, e.message)
    );
  }
}

async function getUserEmail(tokens) {
  const client = createOAuthClient();
  client.setCredentials(tokens);
  const oauth2 = google.oauth2({ version: 'v2', auth: client });
  const { data } = await oauth2.userinfo.get();
  return data.email;
}

// Count meetings in the last `days` days where both userA and userB are attendees.
// Only works if userA has connected Google Calendar and userB has a stored Google email.
async function getSharedMeetingCount(userIdA, userIdB, days = 30) {
  const [tokensA, emailB] = await Promise.all([
    db.getGoogleTokens(userIdA),
    db.getGoogleEmail(userIdB),
  ]);
  if (!tokensA || !emailB) return 0;

  const client = createOAuthClient();
  client.setCredentials(tokensA);
  client.on('tokens', async (newTokens) => {
    await db.saveGoogleTokens(userIdA, { ...tokensA, ...newTokens }).catch(() => {});
  });

  const calendar = google.calendar({ version: 'v3', auth: client });
  const timeMin = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const timeMax = new Date().toISOString();

  const res = await calendar.events.list({
    calendarId: 'primary',
    timeMin,
    timeMax,
    singleEvents: true,
    fields: 'items(attendees,status)',
  });

  const events = (res.data.items || []).filter(e => e.status !== 'cancelled');
  return events.filter(e =>
    (e.attendees || []).some(a => a.email?.toLowerCase() === emailB.toLowerCase())
  ).length;
}

module.exports = { generateAuthUrl, exchangeCode, getMeetingsForDate, getUserEmail, getSharedMeetingCount, watchCalendar, renewChannels };
