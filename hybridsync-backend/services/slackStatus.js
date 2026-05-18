const { WebClient } = require('@slack/web-api');
const db = require('../db');
const { todayKey } = require('../utils/dates');

const PROFILES = {
  WFH:    { status_emoji: ':house:',                 status_text: 'Working from home' },
  Office: { status_emoji: ':office:',                status_text: 'In the office'     },
  Sick:   { status_emoji: ':face_with_thermometer:', status_text: 'Out sick'          },
  Leave:  { status_emoji: ':palm_tree:',             status_text: 'On leave'          },
};

function endOfDayTs(dateKey) {
  // Returns Unix timestamp for 23:59:59 on dateKey (local calendar date)
  const d = new Date(dateKey + 'T23:59:59');
  return Math.floor(d.getTime() / 1000);
}

async function syncToProfile(userId, status, dateKey) {
  if (dateKey !== todayKey()) return; // only sync today's status

  const token = await db.getUserToken(userId);
  if (!token) return;

  const profile = PROFILES[status];
  if (!profile) return;

  try {
    const client = new WebClient(token);
    await client.users.profile.set({
      profile: JSON.stringify({
        ...profile,
        status_expiration: endOfDayTs(dateKey),
      }),
    });
    console.log(`[SlackStatus] ${userId} → ${status}`);
  } catch (e) {
    console.warn(`[SlackStatus] Profile update failed for ${userId}:`, e?.data?.error || e.message);
  }
}

module.exports = { syncToProfile };
