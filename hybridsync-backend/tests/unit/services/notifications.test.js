// Mock db so the Supabase client is never initialised during tests.
jest.mock('../../../db', () => ({}));

const { shouldNotify } = require('../../../services/notifications');

// Each test uses unique userIds to avoid interference from the shared Map.

describe('shouldNotify', () => {
  it('returns true on first call for a new user+date pair', () => {
    expect(shouldNotify('UTEST_A1', '2030-01-01')).toBe(true);
  });

  it('returns false on immediate duplicate call for same user+date', () => {
    shouldNotify('UTEST_B1', '2030-01-02');
    expect(shouldNotify('UTEST_B1', '2030-01-02')).toBe(false);
  });

  it('returns true for same user on a different date', () => {
    shouldNotify('UTEST_C1', '2030-01-03');
    expect(shouldNotify('UTEST_C1', '2030-01-04')).toBe(true);
  });

  it('returns true for a different user on the same date', () => {
    shouldNotify('UTEST_D1', '2030-01-05');
    expect(shouldNotify('UTEST_D2', '2030-01-05')).toBe(true);
  });

  it('allows a third unique user+date pair independently', () => {
    expect(shouldNotify('UTEST_E1', '2030-02-01')).toBe(true);
    expect(shouldNotify('UTEST_E2', '2030-02-01')).toBe(true);
    expect(shouldNotify('UTEST_E1', '2030-02-02')).toBe(true);
  });
});
