const db = require('../db');
const { buildOverrideModal, parseModalValues } = require('../views/overrideModal');
const { publishHome } = require('../views/appHome');
const { notifyDependents } = require('../services/notifications');
const { checkWFHConflict } = require('../services/calendarAlerts');
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
      client.chat.postMessage({
        channel: body.user.id,
        text: "⚠️ Couldn't open the schedule editor — please try clicking *Edit Schedule* again.",
      }).catch(() => {});
      return;
    }

    // Now safe to do async DB reads — update the already-open modal with real content.
    try {
      await db.ensureUser(body.user.id, { workspaceId: body.team?.id });
      const view = await buildOverrideModal(body.user.id);
      await client.views.update({ view_id: opened.view.id, view });
    } catch (err) {
      logger.error('Error loading schedule into override modal:', err);
      try {
        await client.views.update({
          view_id: opened.view.id,
          view: {
            type: 'modal',
            title: { type: 'plain_text', text: 'Edit Schedule', emoji: true },
            close: { type: 'plain_text', text: 'Close', emoji: true },
            blocks: [{
              type: 'section',
              text: { type: 'mrkdwn', text: '⚠️ *Could not load your schedule.*\nPlease close this dialog and try again in a moment.' },
            }],
          },
        });
      } catch (updateErr) {
        logger.error('Could not show error modal:', updateErr.message);
      }
    }
  });

  app.view('override_submit', async ({ ack, body, view, client, logger }) => {
    await ack();
    const userId  = body.user.id;
    const updates = parseModalValues(view);
    const rejected = [];
    let applied = 0;

    for (const [dateKey, status] of Object.entries(updates)) {
      try {
        await db.setStatus(userId, dateKey, status);
        checkWFHConflict(client, userId, dateKey, status).catch(() => {});
        notifyDependents(client, userId, dateKey, status).catch(e =>
          logger.error('[Override] notifyDependents error:', e)
        );
        applied++;
      } catch (err) {
        rejected.push(`• *${dateKey}* (${status}): ${err.message}`);
      }
    }

    await publishHome(client, userId, body.team?.id);

    const lines = [];
    if (applied)         lines.push(`✅ Schedule updated for ${applied} day(s).`);
    if (rejected.length) lines.push(`⚠️ ${rejected.length} update(s) rejected:`, ...rejected);
    if (lines.length) {
      await client.chat.postMessage({ channel: userId, text: lines.join('\n') });
    }
    console.log(`[Override] ${userId} applied=${applied} rejected=${rejected.length}`);
  });
}

module.exports = { register };
