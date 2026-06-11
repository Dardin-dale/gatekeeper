import { parseWhen, epochFromWallTime, WhenParseError } from '../../lib/lambdas/utils/schedule-time';

const TZ = 'America/Los_Angeles';

// Fixed "now": Wednesday 2026-06-10 21:00 PDT (UTC-7) = 2026-06-11T04:00Z
const NOW = Date.UTC(2026, 5, 11, 4, 0, 0);

describe('epochFromWallTime', () => {
  test('PDT (UTC-7) conversion', () => {
    expect(epochFromWallTime(2026, 6, 10, 21, 0, TZ)).toBe(Date.UTC(2026, 5, 11, 4, 0));
  });

  test('PST (UTC-8) conversion', () => {
    expect(epochFromWallTime(2026, 1, 15, 21, 0, TZ)).toBe(Date.UTC(2026, 0, 16, 5, 0));
  });

  test('UTC passthrough', () => {
    expect(epochFromWallTime(2026, 6, 10, 12, 30, 'UTC')).toBe(Date.UTC(2026, 5, 10, 12, 30));
  });
});

describe('parseWhen', () => {
  test('bare HH:MM still ahead today resolves to today', () => {
    // 22:30 PDT today = 05:30Z tomorrow
    expect(parseWhen('22:30', TZ, NOW)).toBe(Date.UTC(2026, 5, 11, 5, 30));
  });

  test('bare HH:MM already past rolls to tomorrow', () => {
    // 19:00 PDT is past at 21:00 → Thursday 19:00 PDT = 02:00Z Friday
    expect(parseWhen('19:00', TZ, NOW)).toBe(Date.UTC(2026, 5, 12, 2, 0));
  });

  test('tomorrow HH:MM', () => {
    expect(parseWhen('tomorrow 08:00', TZ, NOW)).toBe(Date.UTC(2026, 5, 11, 15, 0));
  });

  test('weekday name resolves to next occurrence', () => {
    // Friday 19:30 PDT from Wednesday night = 2026-06-12T19:30 PDT = 02:30Z Sat
    expect(parseWhen('fri 19:30', TZ, NOW)).toBe(Date.UTC(2026, 5, 13, 2, 30));
    expect(parseWhen('friday 19:30', TZ, NOW)).toBe(parseWhen('fri 19:30', TZ, NOW));
  });

  test('same weekday with past time goes to next week', () => {
    // It IS Wednesday 21:00; "wed 20:00" must be next Wednesday
    expect(parseWhen('wed 20:00', TZ, NOW)).toBe(Date.UTC(2026, 5, 18, 3, 0));
  });

  test('same weekday with future time stays today', () => {
    expect(parseWhen('wed 22:00', TZ, NOW)).toBe(Date.UTC(2026, 5, 11, 5, 0));
  });

  test('explicit date', () => {
    expect(parseWhen('2026-07-04 18:00', TZ, NOW)).toBe(Date.UTC(2026, 6, 5, 1, 0));
  });

  test('explicit date in the past throws', () => {
    expect(() => parseWhen('2026-01-01 18:00', TZ, NOW)).toThrow(WhenParseError);
  });

  test('garbage input throws with format hint', () => {
    expect(() => parseWhen('whenever', TZ, NOW)).toThrow(WhenParseError);
    expect(() => parseWhen('8pm', TZ, NOW)).toThrow(/Use/);
    expect(() => parseWhen('25:00', TZ, NOW)).toThrow(WhenParseError);
  });

  test('unknown weekday word throws', () => {
    expect(() => parseWhen('someday 20:00', TZ, NOW)).toThrow(/weekday/);
  });

  test('never returns the past across a DST fall-back boundary', () => {
    // Sat 2026-10-31 21:00 PDT; "sun 09:00" crosses fall-back (Nov 1, 2026)
    const beforeFallBack = Date.UTC(2026, 10, 1, 4, 0); // 21:00 PDT Oct 31
    const result = parseWhen('sun 09:00', TZ, beforeFallBack);
    expect(result).toBeGreaterThan(beforeFallBack);
    // 09:00 PST (UTC-8) on Nov 1 = 17:00Z
    expect(result).toBe(Date.UTC(2026, 10, 1, 17, 0));
  });
});
