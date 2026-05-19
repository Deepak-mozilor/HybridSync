const db = require('../db');
const { buildManageDepsModal } = require('../views/manageDepsModal');
const { publishHome } = require('../views/appHome');

const LOADING_VIEW = {
  type:        'modal',
  callback_id: 'manage_deps_submit',
  title:       { type: 'plain_text', text: 'My Dependencies', emoji: true },
  close:       { type: 'plain_text', text: 'Cancel', emoji: true },
  blocks:      [{ type: 'section', text: { type: 'mrkdwn', text: '_Loading your collaborators…_' } }],
};

function register(app) {
  app.action('button_manage_deps', async ({ ack, body, client, logger }) => {
    // Start views.open immediately — trigger_id expires 3 s after the click.
    // Run ack() and views.open() in parallel so neither blocks the other.
    let opened;
    try {
      [, opened] = await Promise.all([
        ack(),
        client.views.open({ trigger_id: body.trigger_id, view: LOADING_VIEW }),
      ]);
    } catch (err) {
      logger.error('Could not open manage deps modal:', err.message);
      client.chat.postMessage({
        channel: body.user.id,
        text: "⚠️ Couldn't open the dependencies editor — please try clicking *Manage Dependencies* again.",
      }).catch(() => {});
      return;
    }

    try {
      const view = await buildManageDepsModal(body.user.id);
      await client.views.update({ view_id: opened.view.id, view });
    } catch (err) {
      logger.error('Error loading dependencies into modal:', err);
      try {
        await client.views.update({
          view_id: opened.view.id,
          view: {
            type: 'modal',
            title: { type: 'plain_text', text: 'My Dependencies', emoji: true },
            close: { type: 'plain_text', text: 'Close', emoji: true },
            blocks: [{
              type: 'section',
              text: { type: 'mrkdwn', text: '⚠️ *Could not load your collaborators.*\nPlease close this dialog and try again in a moment.' },
            }],
          },
        });
      } catch (updateErr) {
        logger.error('Could not show error modal:', updateErr.message);
      }
    }
  });

  app.view('manage_deps_submit', async ({ ack, body, view, client, logger }) => {
    const userId = body.user.id;
    const vals   = view.state.values;

    const addUserId  = vals.add_user?.user_select?.selected_user;
    const addScore   = parseInt(vals.add_score?.score_select?.selected_option?.value, 10);
    const removeUserId = vals.remove_user?.remove_select?.selected_user;

    // Validate score before accepting the submission
    if (addUserId && (isNaN(addScore) || addScore < 1 || addScore > 10)) {
      await ack({
        response_action: 'errors',
        errors: { add_score: 'Score must be a number between 1 and 10.' },
      });
      return;
    }

    await ack();

    try {
      const edges = await db.getDependencyGraph(userId);

      let changed = false;

      if (addUserId && addUserId !== userId) {
        const idx = edges.findIndex(e => e.peerId === addUserId);
        if (idx >= 0) {
          edges[idx] = { peerId: addUserId, score: addScore, isManual: true };
        } else {
          edges.push({ peerId: addUserId, score: addScore, isManual: true });
        }
        changed = true;
      }

      if (removeUserId) {
        const before = edges.length;
        const filtered = edges.filter(e => e.peerId !== removeUserId);
        if (filtered.length !== before) {
          edges.length = 0;
          edges.push(...filtered);
          changed = true;
        }
      }

      if (changed) {
        await db._updateDependencies(userId, edges);
        await publishHome(client, userId);

        const parts = [];
        if (addUserId && !isNaN(addScore)) parts.push(`updated <@${addUserId}> (score ${addScore}/10)`);
        if (removeUserId)                  parts.push(`removed <@${removeUserId}>`);
        await client.chat.postMessage({
          channel: userId,
          text: `✅ Dependencies updated: ${parts.join('; ')}.`,
        });
      }

      console.log(`[ManageDeps] ${userId} — changed=${changed}`);
    } catch (err) {
      logger.error('Error handling manage_deps_submit:', err);
    }
  });
}

module.exports = { register };
