const { WebClient } = require('@slack/web-api');
const db = require('../db');
const { todayKey } = require('../utils/dates');
const { markSyncedByUs } = require('../listeners/slackStatusSync');

const PROFILES = {
  WFH:    { status_emoji: ':house:',                 status_text: 'Working from home' },
  Office: { status_emoji: ':office:',                status_text: 'In the office'     },
  Sick:   { status_emoji: ':face_with_thermometer:', status_text: 'Out sick'          },
  Leave:  { status_emoji: ':palm_tree:',             status_text: 'On leave'          },
};

// Emojis HybridSync sets — used to detect statuses we previously wrote vs. user-custom ones
const OWNED_EMOJIS = new Set(Object.values(PROFILES).map(p => p.status_emoji));

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
    markSyncedByUs(userId); // prevent loop — ignore the user_change event this triggers
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

// Daily sweep: push today's status to every connected user's Slack profile,
// but only if their current Slack status is empty or one we previously set —
// never overwrite a custom status the user typed themselves.
async function syncAllUsersForToday() {
  const users   = await db.getAllUsers();
  const dateKey = todayKey();
  let pushed = 0, skippedCustom = 0, skippedNoToken = 0, skippedNoStatus = 0;

  for (const u of users) {
    const token = await db.getUserToken(u.id);
    if (!token) { skippedNoToken++; continue; }

    const status = await db.getStatusForDate(u.id, dateKey);
    if (!status || !PROFILES[status]) { skippedNoStatus++; continue; }

    try {
      const client = new WebClient(token);
      const current = await client.users.profile.get();
      const currentEmoji = current.profile?.status_emoji || '';

      // Respect custom statuses — only overwrite when empty or set by us
      if (currentEmoji && !OWNED_EMOJIS.has(currentEmoji)) {
        skippedCustom++;
        continue;
      }
    } catch (e) {
      console.warn(`[DailyStatusSync] Could not read profile for ${u.id}:`, e?.data?.error || e.message);
      continue;
    }

    await syncToProfile(u.id, status, dateKey);
    pushed++;
  }

  console.log(`[DailyStatusSync] pushed=${pushed} skippedCustom=${skippedCustom} skippedNoToken=${skippedNoToken} skippedNoStatus=${skippedNoStatus}`);
}

module.exports = { syncToProfile, syncAllUsersForToday };
