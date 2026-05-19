const { todayKey, upcomingWorkDays, parseTargetDate, toKey } = require('../../../utils/dates');

describe('todayKey', () => {
  it('returns YYYY-MM-DD format', () => {
    expect(todayKey()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('matches today\'s date', () => {
    const today = new Date();
    const expected = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    expect(todayKey()).toBe(expected);
  });
});

describe('upcomingWorkDays', () => {
  it('returns correct number of days', () => {
    expect(upcomingWorkDays(5)).toHaveLength(5);
    expect(upcomingWorkDays(10)).toHaveLength(10);
  });

  it('never includes weekends', () => {
    const days = upcomingWorkDays(10);
    days.forEach(({ dateKey }) => {
      const d = new Date(dateKey + 'T00:00:00');
      expect(d.getDay()).not.toBe(0);
      expect(d.getDay()).not.toBe(6);
    });
  });

  it('starts from today if today is a weekday', () => {
    const today = new Date();
    const dow = today.getDay();
    if (dow !== 0 && dow !== 6) {
      expect(upcomingWorkDays(1)[0].dateKey).toBe(todayKey());
    }
  });

  it('each day has a valid day label', () => {
    const validDays = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'];
    upcomingWorkDays(5).forEach(({ day }) => {
      expect(validDays).toContain(day);
    });
  });
});

describe('parseTargetDate', () => {
  it('returns today for "today"', () => {
    expect(parseTargetDate('I am wfh today').dateKey).toBe(todayKey());
  });

  it('returns today for "tmr" — tomorrow is a work day after skipping weekends', () => {
    const result = parseTargetDate('wfh tmr');
    expect(result.dateKey > todayKey()).toBe(true);
  });

  it('returns a future Friday for "on friday"', () => {
    const result = parseTargetDate('on friday');
    const d = new Date(result.dateKey + 'T00:00:00');
    expect(d.getDay()).toBe(5);
    expect(result.dateKey >= todayKey()).toBe(true);
  });

  it('returns a future Monday for "on monday"', () => {
    const result = parseTargetDate('on monday');
    const d = new Date(result.dateKey + 'T00:00:00');
    expect(d.getDay()).toBe(1);
    expect(result.dateKey >= todayKey()).toBe(true);
  });

  it('falls back to today for unrecognised text', () => {
    expect(parseTargetDate('just some random message').dateKey).toBe(todayKey());
  });

  it('does not throw on negation text', () => {
    expect(() => parseTargetDate('not wfh today')).not.toThrow();
    expect(() => parseTargetDate('won\'t be in office')).not.toThrow();
  });

  it('resolves "next week" to next Monday', () => {
    const result = parseTargetDate('wfh next week');
    const d = new Date(result.dateKey + 'T00:00:00');
    expect(d.getDay()).toBe(1);
    expect(result.dateKey > todayKey()).toBe(true);
  });
});
