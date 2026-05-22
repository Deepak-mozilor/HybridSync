const { todayKey, upcomingWorkDays } = require('../../../utils/dates');

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

