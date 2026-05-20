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
    fields: 'items(summary,start,end,status)',
  });

  const events = (res.data.items || []).filter(
    e => e.status !== 'cancelled' && e.start?.dateTime
  );

  const totalMinutes = events.reduce((sum, e) => {
    return sum + (new Date(e.end.dateTime) - new Date(e.start.dateTime)) / 60000;
  }, 0);

  const label = totalMinutes >= 240 ? 'Heavy' : totalMinutes >= 120 ? 'Moderate' : 'Light';
  const emoji = totalMinutes >= 240 ? '🔴' : totalMinutes >= 120 ? '🟡' : '🟢';

  return {
    count:        events.length,
    totalMinutes: Math.round(totalMinutes),
    label,
    emoji,
  };
}

module.exports = { generateAuthUrl, exchangeCode, getMeetingsForDate };
