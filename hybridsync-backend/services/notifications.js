const db = require('../db');

const STATUS_EMOJI = { WFH: '🏠', Office: '🏢', Sick: '🤒', Leave: '🌴' };

// Debounce duplicate notification waves for the same (user, date) pair.
// Prevents rapid back-to-back status updates from spamming collaborators.
const recentNotifications = new Map();
const DEBOUNCE_MS = 10_000;

function shouldNotify(userId, dateKey) {
  const key = `${userId}:${dateKey}`;
  const now = Date.now();
  const last = recentNotifications.get(key);
  if (last && now - last < DEBOUNCE_MS) {
    console.log(`[Notify] Skipping duplicate notification wave for ${key}`);
    return false;
  }
  recentNotifications.set(key, now);
  if (recentNotifications.size > 1000) {
    for (const [k, t] of recentNotifications) {
      if (now - t > DEBOUNCE_MS * 2) recentNotifications.delete(k);
    }
  }
  return true;
}

async function notifyDependents(slackClient, triggeringUserId, dateKey, newStatus) {
  const deps     = await db.getDependencyGraph(triggeringUserId);
  const highDeps = deps.filter(d => d.score >= 7);
  if (!highDeps.length) return;

  const emoji = STATUS_EMOJI[newStatus] || '📅';

  for (const { peerId, score } of highDeps) {
    // Slack user IDs: U/W prefix + 8-10 alphanumeric uppercase chars.
    // Bad IDs are also rejected by the Slack API, but checking up-front
    // avoids wasted API calls and noisy error logs.
    if (!/^[UW][A-Z0-9]{8,10}$/.test(peerId)) continue;
    if (peerId === triggeringUserId) continue;

    const peerStatus = await db.getStatusForDate(peerId, dateKey);
    if (peerStatus === newStatus) continue;

    const peerCtx = JSON.stringify({ triggeringUserId, date: dateKey, targetUserId: peerId });

    try {
      await slackClient.chat.postMessage({
        channel: peerId,
        text: `<@${triggeringUserId}> switched to ${newStatus} ${emoji}. Want to adjust your schedule?`,
        blocks: [
          {
            type: 'header',
            text: { type: 'plain_text', text: '🤝 HybridSync: Schedule Coordination', emoji: true },
          },
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `<@${triggeringUserId}> just switched to *${newStatus} ${emoji}* on *${dateKey}*.\nYour collaboration score: *${score}/10*\n\nWould you like to adjust your schedule?`,
            },
          },
          {
            type: 'actions',
            elements: [
              {
                type: 'button',
                text: { type: 'plain_text', text: '🏠 Switch to WFH', emoji: true },
                style: 'primary',
                value: peerCtx,
                action_id: 'negotiation_switch_wfh',
              },
              {
                type: 'button',
                text: { type: 'plain_text', text: '🏢 Stay in Office', emoji: true },
                value: peerCtx,
                action_id: 'negotiation_stay_office',
              },
            ],
          },
        ],
      });
      console.log(`[Notify] <@${peerId}> ← ${triggeringUserId} → ${newStatus} (score ${score})`);
    } catch (e) {
      console.warn(`[Notify] Could not DM ${peerId}:`, e?.data?.error || e.message);
    }
  }
}

module.exports = { notifyDependents, shouldNotify };
