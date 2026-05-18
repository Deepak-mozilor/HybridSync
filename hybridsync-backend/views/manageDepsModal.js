const db = require('../db');

function scoreLabel(n) {
  if (n >= 9) return 'Critical';
  if (n >= 7) return 'High';
  if (n >= 5) return 'Moderate';
  if (n >= 3) return 'Low';
  return 'Minimal';
}

const SCORE_OPTIONS = Array.from({ length: 10 }, (_, i) => {
  const v = 10 - i;
  return {
    text:  { type: 'plain_text', text: `${v}  —  ${scoreLabel(v)}`, emoji: false },
    value: String(v),
  };
});

async function buildManageDepsModal(userId) {
  const deps = (await db.getDependencyGraph(userId))
    .sort((a, b) => b.score - a.score);

  const depsList = deps.length
    ? deps.map(d => `• <@${d.peerId}>  —  *${d.score}/10* (${scoreLabel(d.score)})`).join('\n')
    : '_No collaborators set yet._';

  return {
    type:        'modal',
    callback_id: 'manage_deps_submit',
    title:       { type: 'plain_text', text: 'My Dependencies', emoji: true },
    submit:      { type: 'plain_text', text: 'Save',            emoji: true },
    close:       { type: 'plain_text', text: 'Cancel',          emoji: true },
    blocks: [
      {
        type: 'section',
        text: { type: 'mrkdwn', text: `*Current collaborators:*\n${depsList}` },
      },
      { type: 'divider' },
      { type: 'section', text: { type: 'mrkdwn', text: '*➕  Add or update a collaborator*' } },
      {
        type:       'input',
        block_id:   'add_user',
        optional:   true,
        label:      { type: 'plain_text', text: 'Team member' },
        element: {
          type:        'users_select',
          action_id:   'user_select',
          placeholder: { type: 'plain_text', text: 'Pick a person…' },
        },
      },
      {
        type:     'input',
        block_id: 'add_score',
        optional: true,
        label:    { type: 'plain_text', text: 'Collaboration score (1 = minimal · 10 = critical)' },
        element: {
          type:        'static_select',
          action_id:   'score_select',
          placeholder: { type: 'plain_text', text: 'Select score…' },
          options:     SCORE_OPTIONS,
        },
      },
      { type: 'divider' },
      { type: 'section', text: { type: 'mrkdwn', text: '*🗑️  Remove a collaborator*' } },
      {
        type:     'input',
        block_id: 'remove_user',
        optional: true,
        label:    { type: 'plain_text', text: 'Remove person' },
        element: {
          type:        'users_select',
          action_id:   'remove_select',
          placeholder: { type: 'plain_text', text: 'Pick a person to remove…' },
        },
      },
    ],
  };
}

module.exports = { buildManageDepsModal };
