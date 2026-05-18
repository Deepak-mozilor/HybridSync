const db = require('../db');

const STATUS_EMOJI = { WFH: '🏠', Office: '🏢', Sick: '🤒', Leave: '🌴' };

async function notifyDependents(slackClient, triggeringUserId, dateKey, newStatus) {
  const deps     = await db.getDependencyGraph(triggeringUserId);
  const highDeps = deps.filter(d => d.score >= 7);
  if (!highDeps.length) return;

  const emoji = STATUS_EMOJI[newStatus] || '📅';

  for (const { peerId, score } of highDeps) {
    if (!/^U[A-Z0-9]{6,}$/.test(peerId)) continue;
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

module.exports = { notifyDependents };
