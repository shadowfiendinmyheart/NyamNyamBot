import { describe, expect, it } from "vitest";
import {
  addDays,
  diffDays,
  formatYmd,
  getDayBoundsUtc,
  getTodayBoundsUtc,
  getWeekBoundsUtc,
  parseYmd,
} from "./dates.js";

describe("utils/dates getTodayBoundsUtc", () => {
  it("computes UTC bounds for Europe/Moscow (UTC+3), where local midnight falls on the previous UTC day", () => {
    const now = new Date("2026-08-22T21:30:00Z"); // 2026-08-23T00:30 в Москве
    const { start, end } = getTodayBoundsUtc(now, "Europe/Moscow");
    expect(start).toEqual(new Date("2026-08-22T21:00:00Z"));
    expect(end).toEqual(new Date("2026-08-23T21:00:00Z"));
  });

  it("computes UTC bounds for a negative-offset zone (America/Los_Angeles, PDT UTC-7)", () => {
    const now = new Date("2026-08-23T05:00:00Z"); // 2026-08-22T22:00 в Лос-Анджелесе
    const { start, end } = getTodayBoundsUtc(now, "America/Los_Angeles");
    expect(start).toEqual(new Date("2026-08-22T07:00:00Z"));
    expect(end).toEqual(new Date("2026-08-23T07:00:00Z"));
  });
});

describe("utils/dates getDayBoundsUtc", () => {
  it("учитывает переход на зимнее время (день длиной 25 часов)", () => {
    const { start, end } = getDayBoundsUtc({ year: 2026, month: 11, day: 1 }, "America/Los_Angeles");
    expect(start).toEqual(new Date("2026-11-01T07:00:00Z"));
    expect(end).toEqual(new Date("2026-11-02T08:00:00Z"));
  });
});

describe("utils/dates getWeekBoundsUtc", () => {
  it("возвращает неделю пн–вс, содержащую текущий день", () => {
    // Воскресенье 2026-09-27, 21:00 в Москве
    const week = getWeekBoundsUtc(new Date("2026-09-27T18:00:00Z"), "Europe/Moscow");
    expect(formatYmd(week.first)).toBe("2026-09-21");
    expect(formatYmd(week.last)).toBe("2026-09-27");
    expect(week.start).toEqual(new Date("2026-09-20T21:00:00Z"));
    expect(week.end).toEqual(new Date("2026-09-27T21:00:00Z"));
  });

  it("понедельник — первый день своей недели", () => {
    const week = getWeekBoundsUtc(new Date("2026-09-28T09:00:00Z"), "Europe/Moscow");
    expect(formatYmd(week.first)).toBe("2026-09-28");
  });
});

describe("utils/dates parseYmd / addDays / diffDays", () => {
  it("парсит корректные даты и отклоняет несуществующие", () => {
    expect(parseYmd("2026-02-28")).toEqual({ year: 2026, month: 2, day: 28 });
    expect(parseYmd("2026-02-30")).toBeUndefined();
    expect(parseYmd("28.02.2026")).toBeUndefined();
  });

  it("переходит через границу месяца и года", () => {
    expect(formatYmd(addDays({ year: 2026, month: 12, day: 31 }, 1))).toBe("2027-01-01");
    expect(diffDays({ year: 2026, month: 9, day: 1 }, { year: 2026, month: 10, day: 1 })).toBe(30);
  });
});
