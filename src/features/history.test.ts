import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { beforeEach, describe, expect, it } from "vitest";
import * as schema from "../db/schema.js";
import { createMeal } from "../db/meals.js";
import { createUser, setUserTimeZone } from "../db/users.js";
import { createWorkout } from "../db/workouts.js";
import { buildDayTitle, buildDayView, dayViewKeyboard, PAST_DAY_EMPTY_HINT } from "./history.js";

function makeDb() {
  const sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: "./drizzle" });
  return db;
}

type Button = { text: string; callback_data?: string };
const rows = (keyboard: { inline_keyboard: unknown[][] }) =>
  (keyboard.inline_keyboard as Button[][]).map((row) => row.map((b) => [b.text, b.callback_data]));

const today = { year: 2026, month: 10, day: 8 }; // четверг

describe("features/history buildDayTitle", () => {
  it("сегодня, вчера и другие дни", () => {
    expect(buildDayTitle(today, today)).toBe("📋 Сегодня");
    expect(buildDayTitle({ ...today, day: 7 }, today)).toBe("📋 Вчера, Ср 07.10");
    expect(buildDayTitle({ ...today, day: 5 }, today)).toBe("📋 Пн 05.10");
  });
});

describe("features/history dayViewKeyboard", () => {
  it("сегодня: кнопки записей по номерам и только «назад»", () => {
    expect(rows(dayViewKeyboard(today, today, [11, 12], [5]))).toEqual([
      [
        ["✏️ 1", "day_edit:meal:11"],
        ["🗑 1", "day_del:meal:11:2026-10-08"],
        ["🔁 1", "day_rep:11:2026-10-08"],
      ],
      [
        ["✏️ 2", "day_edit:meal:12"],
        ["🗑 2", "day_del:meal:12:2026-10-08"],
        ["🔁 2", "day_rep:12:2026-10-08"],
      ],
      [
        ["✏️ 3", "day_edit:workout:5"],
        ["🗑 3", "day_del:workout:5:2026-10-08"],
      ],
      [["◀️ Ср 07.10", "day:2026-10-07"]],
    ]);
  });

  it("прошлый день: вперёд, к сегодня и «↩️ Вернуть» после удаления", () => {
    const day = { ...today, day: 1 };
    const keyboard = dayViewKeyboard(day, today, [], [], {
      kind: "meal",
      id: 3,
      label: "овсянка",
    });
    expect(rows(keyboard)).toEqual([
      [["↩️ Вернуть «овсянка»", "day_undo:meal:3:2026-10-01"]],
      [
        ["◀️ Ср 30.09", "day:2026-09-30"],
        ["Пт 02.10 ▶️", "day:2026-10-02"],
        ["📋 Сегодня", "day:2026-10-08"],
      ],
    ]);
  });

  it("callback_data укладывается в 64 байта", () => {
    const keyboard = dayViewKeyboard(today, { ...today, day: 9 }, [2_000_000_000], [2_000_000_000], {
      kind: "workout",
      id: 2_000_000_000,
      label: "x",
    });
    for (const row of rows(keyboard)) {
      for (const [, data] of row) expect(Buffer.byteLength(data ?? "")).toBeLessThanOrEqual(64);
    }
  });
});

describe("features/history buildDayView", () => {
  const now = new Date("2026-10-08T12:00:00Z"); // 15:00 МСК
  let db: ReturnType<typeof makeDb>;

  beforeEach(() => {
    db = makeDb();
    createUser(db, 1, "alice");
    setUserTimeZone(db, 1, "Europe/Moscow");
  });

  it("показывает записи выбранного дня в поясе пользователя", () => {
    const yesterdayMeal = createMeal(db, {
      userId: 1,
      mealType: "dinner",
      source: "text",
      description: "плов",
      items: [{ name: "плов", weightG: 300, kcal: 500, proteinG: 15, fatG: 20, carbG: 60 }],
      loggedAt: new Date("2026-10-07T16:00:00Z"), // 19:00 МСК
    });
    createMeal(db, {
      userId: 1,
      mealType: "breakfast",
      source: "text",
      description: "каша",
      items: [{ name: "каша", weightG: 200, kcal: 200, proteinG: 5, fatG: 3, carbG: 30 }],
      loggedAt: new Date("2026-10-08T06:00:00Z"),
    });
    createWorkout(db, {
      userId: 1,
      activityType: "running",
      description: "бег",
      durationMin: 30,
      intensity: "moderate",
      kcalBurned: 300,
      source: "command",
      performedAt: new Date("2026-10-07T05:00:00Z"),
    });

    const view = buildDayView(db, 1, { ...today, day: 7 }, now);
    expect(view.text).toContain("📋 Вчера, Ср 07.10");
    expect(view.text).toContain("1. 19:00 🌙 Ужин — плов");
    expect(view.text).toContain("2. 08:00 🏃 Бег");
    expect(view.text).not.toContain("каша");
    expect(rows(view.keyboard)[0][0]).toEqual(["✏️ 1", `day_edit:meal:${yesterdayMeal}`]);
  });

  it("пустой прошлый день — с подсказкой; будущий день — это сегодня", () => {
    expect(buildDayView(db, 1, { ...today, day: 6 }, now).text).toContain(PAST_DAY_EMPTY_HINT);
    expect(buildDayView(db, 1, { ...today, day: 20 }, now).text.startsWith("📋 Сегодня")).toBe(
      true,
    );
  });
});
