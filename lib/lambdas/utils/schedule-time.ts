/**
 * Wall-clock time parsing for /gate schedule — pure functions, no AWS.
 *
 * Input times are interpreted in a single configured IANA timezone
 * (SCHEDULE_TZ); everything downstream works in epoch ms and is displayed via
 * Discord native timestamps (<t:epoch>), which render in each viewer's own
 * local timezone — so the TZ only matters for *parsing* what the user typed.
 *
 * Accepted forms (strict, no natural-language parsing — see Phase 11):
 *   "20:00"              today at 20:00, or tomorrow if already past
 *   "tomorrow 20:00"     tomorrow at 20:00
 *   "fri 19:30"          next Friday (today allowed if still ahead); full
 *                        names ("friday") work too
 *   "2026-06-13 18:00"   exact date
 */

const WEEKDAYS = [
  'sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday',
];

interface WallParts {
  y: number; mo: number; d: number; hh: number; mm: number; ss: number;
  weekday: number; // 0 = Sunday
}

/** What wall-clock time does this instant read as in `tz`? */
function wallPartsAt(epochMs: number, tz: string): WallParts {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hourCycle: 'h23', weekday: 'short',
  });
  const p: Record<string, string> = {};
  for (const part of dtf.formatToParts(new Date(epochMs))) p[part.type] = part.value;
  return {
    y: Number(p.year), mo: Number(p.month), d: Number(p.day),
    hh: Number(p.hour), mm: Number(p.minute), ss: Number(p.second),
    weekday: WEEKDAYS.findIndex((w) => w.startsWith(p.weekday.toLowerCase())),
  };
}

/**
 * Epoch ms for a wall-clock date/time in `tz`. Two-pass offset resolution
 * handles DST: the first guess uses the offset at the naive UTC reading, the
 * second re-reads the offset at the guessed instant.
 */
export function epochFromWallTime(
  y: number, mo: number, d: number, hh: number, mm: number, tz: string,
): number {
  const naive = Date.UTC(y, mo - 1, d, hh, mm, 0);
  const offsetAt = (epoch: number): number => {
    const w = wallPartsAt(epoch, tz);
    return Date.UTC(w.y, w.mo - 1, w.d, w.hh, w.mm, w.ss) - epoch;
  };
  let guess = naive - offsetAt(naive);
  guess = naive - offsetAt(guess);
  return guess;
}

export class WhenParseError extends Error {}

/**
 * Parse a `/gate schedule set when:` string into epoch ms (interpreting wall
 * times in `tz`, relative to `nowMs`). Throws WhenParseError with a
 * user-presentable message on bad input. Never returns a past instant.
 */
export function parseWhen(when: string, tz: string, nowMs: number): number {
  const input = when.trim().toLowerCase();
  const formatsHint =
    'Use `HH:MM`, `tomorrow HH:MM`, `<weekday> HH:MM`, or `YYYY-MM-DD HH:MM`.';

  const m = input.match(/^(?:(\d{4})-(\d{2})-(\d{2})|([a-z]+))?\s*(\d{1,2}):(\d{2})$/);
  if (!m) throw new WhenParseError(`Couldn't read \`${when}\`. ${formatsHint}`);

  const [, year, month, day, word, hhStr, mmStr] = m;
  const hh = Number(hhStr);
  const mm = Number(mmStr);
  if (hh > 23 || mm > 59) {
    throw new WhenParseError(`\`${hhStr}:${mmStr}\` isn't a valid 24h time.`);
  }

  // Explicit date: take it literally (but never in the past).
  if (year) {
    const epoch = epochFromWallTime(Number(year), Number(month), Number(day), hh, mm, tz);
    if (epoch <= nowMs) throw new WhenParseError(`\`${when}\` is in the past.`);
    return epoch;
  }

  // Relative forms: work from today's date in tz, shifting whole days with
  // Date.UTC arithmetic (calendar-safe; epochFromWallTime re-handles DST).
  const today = wallPartsAt(nowMs, tz);
  const onDayOffset = (days: number): number => {
    const shifted = new Date(Date.UTC(today.y, today.mo - 1, today.d + days));
    return epochFromWallTime(
      shifted.getUTCFullYear(), shifted.getUTCMonth() + 1, shifted.getUTCDate(), hh, mm, tz,
    );
  };

  if (!word) {
    // Bare HH:MM — today, or tomorrow once it's past.
    const todayEpoch = onDayOffset(0);
    return todayEpoch > nowMs ? todayEpoch : onDayOffset(1);
  }

  if (word === 'today') {
    const epoch = onDayOffset(0);
    if (epoch <= nowMs) throw new WhenParseError(`${hhStr}:${mmStr} today is already past.`);
    return epoch;
  }
  if (word === 'tomorrow') return onDayOffset(1);

  const target = WEEKDAYS.findIndex((w) => w === word || (word.length >= 3 && w.startsWith(word)));
  if (target === -1) {
    throw new WhenParseError(`\`${word}\` isn't a weekday I know. ${formatsHint}`);
  }
  let delta = (target - today.weekday + 7) % 7;
  // Same weekday: today if the time is still ahead, else next week.
  if (delta === 0 && onDayOffset(0) <= nowMs) delta = 7;
  return onDayOffset(delta);
}
