const db = require('../db');
const { todayKey } = require('../utils/dates');
const { shouldNotify } = require('../services/notifications');
const orchestrator = require('../ai/orchestrator');

// Tracks users whose Slack status was just set BY HybridSync — ignore their next user_change event.
const recentlySyncedByUs = new Map(); // userId → timestamp
const SYNC_DEBOUNCE_MS = 30_000;

// Call this from slackStatus.js before syncing so we don't react to our own update.
function markSyncedByUs(userId) {
  recentlySyncedByUs.set(userId, Date.now());
}

function wasSyncedByUs(userId) {
  const t = recentlySyncedByUs.get(userId);
  if (!t) return false;
  if (Date.now() - t < SYNC_DEBOUNCE_MS) return true;
  recentlySyncedByUs.delete(userId);
  return false;
}

// Map Slack status emoji + text to a HybridSync status.
function classifySlackStatus(emoji, text) {
  const e = (emoji || '').toLowerCase();
  const t = (text  || '').toLowerCase();

  // Emoji-based classification
  if ([':house:', ':house_with_garden:', ':homes:', ':wfh:'].includes(e))                          return 'WFH';
  if ([':office:', ':office_building:', ':classical_building:', ':briefcase:', ':necktie:', ':cityscape:'].includes(e)) return 'Office';
  if ([':face_with_thermometer:', ':mask:', ':microbe:', ':nauseated_face:', ':sneezing_face:'].includes(e)) return 'Sick';
  if ([':palm_tree:', ':desert_island:', ':airplane:', ':beach_with_umbrella:', ':sun_with_face:', ':luggage:'].includes(e)) return 'Leave';

  // Text-based classification
  if (/\b(wfh|work.?from.?home|remote|working.?from.?home|at home|from home)\b/.test(t)) return 'WFH';
  if (/\b(wfo|in.?office|at.?office|office today|coming in|in the office|at work|going in)\b/.test(t)) return 'Office';
  if (/\b(sick|unwell|ill|not feeling|fever|doctor|under the weather)\b/.test(t))         return 'Sick';
  if (/\b(leave|vacation|holiday|ooo|out.?of.?office|day off|off today|on leave)\b/.test(t)) return 'Leave';

  return null; // unrecognised — don't update HybridSync
}

function register(app) {
  app.event('user_change', async ({ event, client }) => {
    try {
      const userId  = event.user?.id;
      const profile = event.user?.profile;
      if (!userId || !profile) return;

      // Ignore changes triggered by HybridSync itself
      if (wasSyncedByUs(userId)) return;

      const emoji  = profile.status_emoji || '';
      const text   = profile.status_text  || '';
      const status = classifySlackStatus(emoji, text);

      if (!status) return; // unrecognised status — leave HybridSync unchanged

      const today   = todayKey();
      const current = await db.getStatusForDate(userId, today);
      if (current === status) return; // already matches — no update needed

      await db.ensureUser(userId);
      await db.setStatus(userId, today, status);
      console.log(`[SlackStatusSync] ${userId} → ${status} (from Slack status "${emoji} ${text}")`);

      // Fire notifications — same path as a channel message status change for today
      if (shouldNotify(userId, today)) {
        orchestrator.run(userId, today, status, client).catch(e =>
          console.error('[SlackStatusSync] Orchestrator error:', e.message)
        );
      }
    } catch (err) {
      console.error('[SlackStatusSync] Error:', err.message);
    }
  });
}

module.exports = { register, markSyncedByUs };
