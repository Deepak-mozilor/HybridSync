const { getMeetingsForDate } = require('./googleCalendar');
const { todayKey } = require('../utils/dates');

// DMs the user if they set WFH but have offline meetings today that require physical presence.
async function checkWFHConflict(slackClient, userId, date, newStatus) {
  if (newStatus !== 'WFH' || date !== todayKey()) return;

  const load = await getMeetingsForDate(userId, date).catch(() => null);
  if (!load || load.offlineCount === 0) return;

  const offlineMeetings = load.slots.filter(s => s.type === 'offline');
  const list = offlineMeetings.map(s => {
    const with_ = s.attendees?.length ? `  _with ${s.attendees.join(', ')}_` : '';
    return `• *${s.title}* (${s.start} – ${s.end})${with_}`;
  }).join('\n');

  await slackClient.chat.postMessage({
    channel: userId,
    text: `⚠️ *WFH Conflict Detected*\nYou've set *WFH 🏠* but you have *${load.offlineCount} offline meeting${load.offlineCount > 1 ? 's' : ''}* today that require you to be in person:\n\n${list}\n\nConsider switching back to *Office 🏢* or rescheduling those meetings.`,
  }).catch(e => console.error('[CalendarAlert] Failed to DM conflict:', e.message));
}

module.exports = { checkWFHConflict };
