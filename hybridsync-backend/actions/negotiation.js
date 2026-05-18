const db = require('../db');
const { todayKey } = require('../utils/dates');
const { publishHome } = require('../views/appHome');

function collapseDM(client, channelId, ts, text) {
  return client.chat.update({
    channel: channelId,
    ts,
    text,
    blocks: [{ type: 'section', text: { type: 'mrkdwn', text } }],
  });
}

function register(app) {
  app.action('negotiation_switch_wfh', async ({ ack, body, client, logger }) => {
    await ack();
    try {
      const ctx    = JSON.parse(body.actions[0].value);
      const userId = body.user.id;
      const date   = ctx.date || todayKey();

      await db.ensureUser(userId);
      await db.setStatus(userId, date, 'WFH');
      await publishHome(client, userId);

      await collapseDM(client, body.channel.id, body.message.ts,
        `✅ *Schedule updated:* You switched to *WFH 🏠* on *${date}*.`);

      console.log(`[Negotiation] ${userId} → WFH on ${date}`);
    } catch (err) {
      logger.error('negotiation_switch_wfh error:', err);
    }
  });

  app.action('negotiation_stay_office', async ({ ack, body, client, logger }) => {
    await ack();
    try {
      const ctx    = JSON.parse(body.actions[0].value);
      const userId = body.user.id;
      const date   = ctx.date || todayKey();

      await db.ensureUser(userId);
      await db.setStatus(userId, date, 'Office');  // confirm the choice in DB
      await publishHome(client, userId);            // refresh App Home

      await collapseDM(client, body.channel.id, body.message.ts,
        `👍 Got it! *Staying in Office 🏢* on *${date}*. Schedule confirmed.`);

      console.log(`[Negotiation] ${userId} → Office (confirmed) on ${date}`);
    } catch (err) {
      logger.error('negotiation_stay_office error:', err);
    }
  });
}

module.exports = { register };
