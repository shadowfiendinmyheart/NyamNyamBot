// Календарные дни в таймзоне пользователя и их границы в UTC. Даты в БД хранятся в UTC,
// а «сегодня», «вторник» и «эта неделя» — понятия локального времени пользователя.

export interface Ymd {
  year: number;
  month: number;
  day: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function zonedParts(date: Date, timeZone: string, withTime: boolean): Record<string, string> {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    ...(withTime
      ? { hourCycle: "h23", hour: "2-digit", minute: "2-digit", second: "2-digit" }
      : {}),
  })
    .formatToParts(date)
    .reduce<Record<string, string>>((acc, p) => {
      if (p.type !== "literal") acc[p.type] = p.value;
      return acc;
    }, {});
}

export function getZonedYmd(date: Date, timeZone: string): Ymd {
  const parts = zonedParts(date, timeZone, false);
  return { year: Number(parts.year), month: Number(parts.month), day: Number(parts.day) };
}

// Минуты от локальной полуночи: 13:45 → 825.
export function getZonedMinutesOfDay(date: Date, timeZone: string): number {
  const parts = zonedParts(date, timeZone, true);
  return Number(parts.hour) * 60 + Number(parts.minute);
}

function getTimeZoneOffsetMs(date: Date, timeZone: string): number {
  const parts = zonedParts(date, timeZone, true);
  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second),
  );
  return asUtc - date.getTime();
}

function zonedMidnightUtc({ year, month, day }: Ymd, timeZone: string): Date {
  const naiveUtc = Date.UTC(year, month - 1, day, 0, 0, 0);
  const offsetMs = getTimeZoneOffsetMs(new Date(naiveUtc), timeZone);
  return new Date(naiveUtc - offsetMs);
}

export function addDays({ year, month, day }: Ymd, days: number): Ymd {
  const date = new Date(Date.UTC(year, month - 1, day) + days * DAY_MS);
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
}

// 0 — воскресенье, 1 — понедельник, ... (как Date.getUTCDay).
export function weekdayOf({ year, month, day }: Ymd): number {
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

export function diffDays(from: Ymd, to: Ymd): number {
  return Math.round(
    (Date.UTC(to.year, to.month - 1, to.day) - Date.UTC(from.year, from.month - 1, from.day)) /
      DAY_MS,
  );
}

export function formatYmd({ year, month, day }: Ymd): string {
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

// "2026-09-28" → Ymd; undefined для некорректной или несуществующей даты.
export function parseYmd(text: string): Ymd | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text.trim());
  if (!match) return undefined;
  const ymd = { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
  return formatYmd(addDays(ymd, 0)) === text.trim() ? ymd : undefined;
}

export function getDayBoundsUtc(ymd: Ymd, timeZone: string): { start: Date; end: Date } {
  return {
    start: zonedMidnightUtc(ymd, timeZone),
    end: zonedMidnightUtc(addDays(ymd, 1), timeZone),
  };
}

export function getTodayBoundsUtc(now: Date, timeZone: string): { start: Date; end: Date } {
  return getDayBoundsUtc(getZonedYmd(now, timeZone), timeZone);
}

// Текущая неделя (пн–вс) в таймзоне пользователя: first/last — локальные дни,
// start/end — полуинтервал [start, end) в UTC.
export function getWeekBoundsUtc(
  now: Date,
  timeZone: string,
): { first: Ymd; last: Ymd; start: Date; end: Date } {
  const today = getZonedYmd(now, timeZone);
  const first = addDays(today, -((weekdayOf(today) + 6) % 7));
  const last = addDays(first, 6);
  return {
    first,
    last,
    start: zonedMidnightUtc(first, timeZone),
    end: zonedMidnightUtc(addDays(last, 1), timeZone),
  };
}
