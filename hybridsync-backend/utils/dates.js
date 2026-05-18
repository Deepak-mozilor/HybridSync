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

// Mon-Fri of the week that contains `ref` (defaults to today).
function currentWeekDates(ref = new Date()) {
  const start = new Date(ref);
  const dow = start.getDay();              // 0 = Sun
  const diffToMon = dow === 0 ? -6 : 1 - dow;
  start.setDate(start.getDate() + diffToMon);
  const out = [];
  for (let i = 0; i < 5; i++) {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    out.push({ dateKey: toKey(d), day: DAYS[d.getDay()] });
  }
  return out;
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

// Parses a natural-language date reference from a message.
// Returns { dateKey, label } where label is human-readable for the reply.
// Falls back to today if nothing recognised.
function parseTargetDate(text) {
  const lower = text.toLowerCase();
  const now   = new Date();
  now.setHours(0, 0, 0, 0);

  function nextWorkday(fromDate, skipDays = 1) {
    const d = new Date(fromDate);
    d.setDate(d.getDate() + skipDays);
    while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() + 1);
    return d;
  }

  // Explicit "today"
  if (/\btoday\b/.test(lower)) {
    return { dateKey: toKey(now), label: 'today' };
  }

  // "tomorrow" / "tmr" / "tom"
  if (/\b(tomorrow|tmr|tom)\b/.test(lower)) {
    const d = nextWorkday(now);
    return { dateKey: toKey(d), label: `tomorrow (${d.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' })})` };
  }

  // "next week" → next Monday
  if (/\bnext\s+week\b/.test(lower)) {
    const d = new Date(now);
    const diff = (8 - d.getDay()) % 7 || 7; // days until next Mon
    d.setDate(d.getDate() + (d.getDay() === 1 ? 7 : diff));
    return { dateKey: toKey(d), label: d.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' }) };
  }

  // Day name: "on monday", "next friday", "this wednesday"
  const DAY_NAMES = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];
  const dayMatch  = lower.match(/\b(?:on\s+|next\s+|this\s+)?(monday|tuesday|wednesday|thursday|friday)\b/);
  if (dayMatch) {
    const target = DAY_NAMES.indexOf(dayMatch[1]);
    const d      = new Date(now);
    let diff     = (target - d.getDay() + 7) % 7;
    if (diff === 0) diff = 7; // always a future occurrence
    d.setDate(d.getDate() + diff);
    return { dateKey: toKey(d), label: d.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' }) };
  }

  // "on the 26th" / "on 26th" / "on May 26" / "on 26 May"
  const MONTHS = ['january','february','march','april','may','june','july','august','september','october','november','december'];

  const numFirst   = lower.match(/\bon\s+(?:the\s+)?(\d{1,2})(?:st|nd|rd|th)?(?:\s+(?:of\s+)?([a-z]+))?/);
  const monthFirst = lower.match(/\bon\s+([a-z]+)\s+(\d{1,2})(?:st|nd|rd|th)?\b/);

  let targetDay, targetMonth;
  if (numFirst) {
    targetDay   = parseInt(numFirst[1]);
    targetMonth = numFirst[2] ? MONTHS.indexOf(numFirst[2]) : -1;
  } else if (monthFirst && MONTHS.includes(monthFirst[1])) {
    targetMonth = MONTHS.indexOf(monthFirst[1]);
    targetDay   = parseInt(monthFirst[2]);
  }

  if (targetDay >= 1 && targetDay <= 31) {
    const d = new Date(now);
    if (targetMonth >= 0) d.setMonth(targetMonth);
    d.setDate(targetDay);
    if (d <= now) {
      // Past date this month → roll to next month (or next year if month was explicit)
      targetMonth >= 0 ? d.setFullYear(d.getFullYear() + 1) : d.setMonth(d.getMonth() + 1);
      d.setDate(targetDay);
    }
    return { dateKey: toKey(d), label: d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' }) };
  }

  // Default — today
  return { dateKey: toKey(now), label: 'today' };
}

module.exports = { toKey, fromKey, todayKey, dayLabel, currentWeekDates, upcomingWorkDays, parseTargetDate, DAYS };
