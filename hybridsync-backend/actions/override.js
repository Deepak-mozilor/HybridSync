const db = require('../db');
const { buildOverrideModal, parseModalValues } = require('../views/overrideModal');
const { publishHome } = require('../views/appHome');
const { notifyDependents } = require('../services/notifications');
const { todayKey } = require('../utils/dates');

const LOADING_VIEW = {
  type:      'modal',
  callback_id: 'override_submit',
  title:     { type: 'plain_text', text: '✏️ Edit Schedule', emoji: true },
  close:     { type: 'plain_text', text: 'Cancel', emoji: true },
  blocks:    [{ type: 'section', text: { type: 'mrkdwn', text: '_Loading your schedule…_' } }],
};

function register(app) {
  app.action('button_override', async ({ ack, body, client, logger }) => {
    // Run ack() and views.open() in parallel — trigger_id expires 3 s after click.
    let opened;
    try {
      [, opened] = await Promise.all([
        ack(),
        client.views.open({ trigger_id: body.trigger_id, view: LOADING_VIEW }),
      ]);
    } catch (err) {
      logger.error('Could not open override modal (trigger_id expired?):', err.message);
      return;
    }

    // Now safe to do async DB reads — update the already-open modal with real content.
    try {
      await db.ensureUser(body.user.id);
      const view = await buildOverrideModal(body.user.id);
      await client.views.update({ view_id: opened.view.id, view });
    } catch (err) {
      logger.error('Error loading schedule into override modal:', err);
    }
  });

  app.view('override_submit', async ({ ack, body, view, client, logger }) => {
    await ack();
    try {
      const userId  = body.user.id;
      const today   = todayKey();
      const updates = parseModalValues(view);
      for (const [dateKey, status] of Object.entries(updates)) {
        await db.setStatus(userId, dateKey, status);
        notifyDependents(client, userId, dateKey, status).catch(e =>
          logger.error('[Override] notifyDependents error:', e)
        );
      }
      await publishHome(client, userId);

      await client.chat.postMessage({
        channel: userId,
        text: `✅ Schedule updated for ${Object.keys(updates).length} day(s). Open *HybridSync* app home to see changes.`,
      });
      console.log(`[Override] ${userId} updated ${Object.keys(updates).length} day(s)`);
    } catch (err) {
      logger.error('Error handling override submission:', err);
    }
  });
}

module.exports = { register };
