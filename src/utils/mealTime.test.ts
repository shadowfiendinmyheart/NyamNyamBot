import { describe, expect, it } from "vitest";
import {
  determineMealType,
  formatMealDay,
  MAX_MEAL_DAYS_AGO,
  mealDaysAgo,
  normalizeDaysAgo,
  resolveMealTime,
} from "./mealTime.js";

describe("utils/mealTime determineMealType", () => {
  const tz = "Europe/Moscow";

  it("classifies morning hours as breakfast", () => {
    expect(determineMealType(new Date("2026-08-22T05:00:00Z"), tz)).toBe("breakfast");
  });

  it("classifies midday hours as lunch", () => {
    expect(determineMealType(new Date("2026-08-22T09:30:00Z"), tz)).toBe("lunch");
  });

  it("classifies evening hours as dinner", () => {
    expect(determineMealType(new Date("2026-08-22T15:00:00Z"), tz)).toBe("dinner");
  });

  it("classifies night hours as snack", () => {
    expect(determineMealType(new Date("2026-08-22T22:30:00Z"), tz)).toBe("snack");
  });

  it("uses the given timezone rather than the server's local time", () => {
    // 06:00 UTC is 09:00 in Europe/Moscow (breakfast) but still 23:00 the previous
    // day in America/Los_Angeles (snack).
    const date = new Date("2026-08-22T06:00:00Z");
    expect(determineMealType(date, "Europe/Moscow")).toBe("breakfast");
    expect(determineMealType(date, "America/Los_Angeles")).toBe("snack");
  });
});

describe("utils/mealTime resolveMealTime", () => {
  const tz = "Europe/Moscow"; // UTC+3
  const now = new Date("2026-10-07T18:10:00Z"); // 21:10 по Москве
  const noHint = { daysAgo: 0, minutesOfDay: null, mealType: null };

  it("logs at the current moment when nothing was named", () => {
    expect(resolveMealTime(noHint, now, tz)).toEqual({ loggedAt: now, mealType: "dinner" });
  });

  it("puts «вчера на ужин» on yesterday's typical dinner time", () => {
    expect(resolveMealTime({ daysAgo: 1, minutesOfDay: null, mealType: "dinner" }, now, tz)).toEqual({
      loggedAt: new Date("2026-10-06T16:00:00Z"), // 19:00 по Москве
      mealType: "dinner",
    });
  });

  it("uses the named time and derives the meal type from it", () => {
    expect(resolveMealTime({ daysAgo: 0, minutesOfDay: 9 * 60, mealType: null }, now, tz)).toEqual({
      loggedAt: new Date("2026-10-07T06:00:00Z"),
      mealType: "breakfast",
    });
  });

  it("keeps the current time of day for «вчера» without a meal or time", () => {
    const { loggedAt, mealType } = resolveMealTime({ ...noHint, daysAgo: 1 }, now, tz);
    expect(loggedAt).toEqual(new Date("2026-10-06T18:10:00Z"));
    expect(mealType).toBe("dinner");
  });

  it("never logs into the future", () => {
    const morning = new Date("2026-10-07T07:00:00Z"); // 10:00 по Москве
    expect(resolveMealTime({ daysAgo: 0, minutesOfDay: null, mealType: "dinner" }, morning, tz)).toEqual({
      loggedAt: morning,
      mealType: "dinner",
    });
    expect(resolveMealTime({ daysAgo: 0, minutesOfDay: 20 * 60, mealType: null }, morning, tz)).toEqual({
      loggedAt: morning,
      mealType: "breakfast",
    });
  });

  it("counts days in the user's time zone", () => {
    // 01:00 8 октября по Москве, но ещё 7 октября по UTC: «вчера» — 7 октября по Москве.
    const afterMidnight = new Date("2026-10-07T22:00:00Z");
    const { loggedAt } = resolveMealTime({ daysAgo: 1, minutesOfDay: 13 * 60, mealType: null }, afterMidnight, tz);
    expect(loggedAt).toEqual(new Date("2026-10-07T10:00:00Z"));
  });

  it("ignores an out-of-range day offset", () => {
    expect(resolveMealTime({ ...noHint, daysAgo: 30 }, now, tz).loggedAt).toEqual(now);
  });
});

describe("utils/mealTime normalizeDaysAgo", () => {
  it("accepts whole days within the limit and falls back to today otherwise", () => {
    expect(normalizeDaysAgo(1)).toBe(1);
    expect(normalizeDaysAgo(MAX_MEAL_DAYS_AGO)).toBe(MAX_MEAL_DAYS_AGO);
    expect(normalizeDaysAgo(MAX_MEAL_DAYS_AGO + 1)).toBe(0);
    expect(normalizeDaysAgo(-1)).toBe(0);
    expect(normalizeDaysAgo(1.5)).toBe(0);
    expect(normalizeDaysAgo(undefined)).toBe(0);
  });
});

describe("utils/mealTime formatMealDay", () => {
  const tz = "Europe/Moscow";
  const now = new Date("2026-10-07T18:10:00Z");

  it("labels today, yesterday, the day before and older days", () => {
    expect(formatMealDay(new Date("2026-10-07T06:00:00Z"), now, tz)).toBeNull();
    expect(formatMealDay(new Date("2026-10-06T16:00:00Z"), now, tz)).toBe("вчера");
    expect(formatMealDay(new Date("2026-10-05T16:00:00Z"), now, tz)).toBe("позавчера");
    expect(formatMealDay(new Date("2026-10-03T16:00:00Z"), now, tz)).toBe("3 октября");
  });

  it("counts days ago by local dates", () => {
    // 23:30 6 октября по Москве — вчера, хотя по UTC прошло меньше суток.
    expect(mealDaysAgo(new Date("2026-10-06T20:30:00Z"), now, tz)).toBe(1);
  });
});
