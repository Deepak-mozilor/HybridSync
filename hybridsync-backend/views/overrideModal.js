const db = require('../db');
const { upcomingWorkDays } = require('../utils/dates');
const { STATUS } = require('../data/seed');

const STATUS_OPTIONS = [
  { value: STATUS.WFH,    text: '🏠 WFH' },
  { value: STATUS.OFFICE, text: '🏢 Office' },
  { value: STATUS.SICK,   text: '🤒 Sick' },
  { value: STATUS.LEAVE,  text: '🌴 Leave' },
];

function option(opt) {
  return {
    text: { type: 'plain_text', text: opt.text, emoji: true },
    value: opt.value,
  };
}

async function buildOverrideModal(userId) {
  const { toKey } = require('../utils/dates');
  const maxDate = new Date(); maxDate.setMonth(maxDate.getMonth() + 1);
  const maxKey  = toKey(maxDate);
  const today   = toKey(new Date());

  const week = upcomingWorkDays(5).filter(w => w.dateKey >= today && w.dateKey <= maxKey);
  const schedule = await db.getScheduleForDates(userId, week.map(w => w.dateKey));

  const blocks = schedule.map(entry => {
    const currentOpt = STATUS_OPTIONS.find(o => o.value === entry.status) || STATUS_OPTIONS[0];
    return {
      type: 'input',
      block_id: `day_${entry.dateKey}`,
      label: { type: 'plain_text', text: `${entry.day} (${entry.dateKey})`, emoji: true },
      element: {
        type: 'static_select',
        action_id: 'status_select',
        initial_option: option(currentOpt),
        options: STATUS_OPTIONS.map(option),
      },
    };
  });

  return {
    type: 'modal',
    callback_id: 'override_submit',
    title: { type: 'plain_text', text: 'Override Schedule', emoji: true },
    submit: { type: 'plain_text', text: 'Save', emoji: true },
    close:  { type: 'plain_text', text: 'Cancel', emoji: true },
    blocks,
  };
}

// Parses a view_submission payload back into { dateKey: status } pairs.
function parseModalValues(view) {
  const values = view.state.values || {};
  const result = {};
  for (const [blockId, fields] of Object.entries(values)) {
    if (!blockId.startsWith('day_')) continue;
    const dateKey = blockId.slice(4);
    const status = fields.status_select?.selected_option?.value;
    if (status) result[dateKey] = status;
  }
  return result;
}

module.exports = { buildOverrideModal, parseModalValues };
