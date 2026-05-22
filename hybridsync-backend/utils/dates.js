// Date helpers. All keys are local-time YYYY-MM-DD; weeks are Mon-Fri.

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function pad(n) {
  return String(n).padStart(2, '0');
}

function toKey(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function fromKey(key) {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function todayKey() {
  return toKey(new Date());
}

function dayLabel(key) {
  return DAYS[fromKey(key).getDay()];
}

// Returns n upcoming work days starting from today (skips weekends).
function upcomingWorkDays(n = 5) {
  const out = [];
  const d   = new Date();
  d.setHours(0, 0, 0, 0);
  while (out.length < n) {
    const dow = d.getDay();
    if (dow !== 0 && dow !== 6) out.push({ dateKey: toKey(d), day: DAYS[dow] });
    d.setDate(d.getDate() + 1);
  }
  return out;
}

module.exports = { toKey, fromKey, todayKey, dayLabel, upcomingWorkDays, DAYS };
