import Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "../db/schema.js";
import { createMeal } from "../db/meals.js";
import { upsertProfile } from "../db/profiles.js";
import { recordReminder } from "../db/reminders.js";
import { createUser } from "../db/users.js";
import { addWeightEntry } from "../db/weightLog.js";
import { findHabitualMealTimes, sendMealReminders, sendWeightReminders } from "./reminders.js";

const TZ = "Europe/Moscow";

function makeDb() {
  const sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: "./drizzle" });
  return db;
}

type Db = ReturnType<typeof makeDb>;

function addMeal(db: Db, userId: number, loggedAt: Date) {
  const mealId = createMeal(db, {
    userId,
    mealType: "lunch",
    source: "text",
    description: "суп",
    items: [{ name: "суп", weightG: 300, kcal: 150, proteinG: 5, fatG: 4, carbG: 20 }],
  });
  db.update(schema.meals).set({ loggedAt }).where(eq(schema.meals.id, mealId)).run();
}

// Москва — UTC+3: "13:00" по Москве в день 2026-09-DD.
function msk(day: number, time: string): Date {
  return new Date(`2026-09-${String(day).padStart(2, "0")}T${time}:00+03:00`);
}

function addProfile(db: Db, userId: number) {
  upsertProfile(db, userId, {
    sex: "female",
    age: 30,
    heightCm: 165,
    weightKg: 60,
    activityLevel: "light",
    goal: "maintain",
    dailyKcalTarget: 1900,
    proteinGTarget: 100,
    fatGTarget: 60,
    carbGTarget: 240,
  });
}

describe("cron/reminders findHabitualMealTimes", () => {
  it("берёт медиану первого приёма пищи в окне слота по дням", () => {
    const times = [
      msk(1, "08:00"), // завтрак — не в счёт
      msk(1, "13:00"),
      msk(1, "14:30"), // второй приём в тот же день — не в счёт
      msk(2, "12:30"),
      msk(3, "13:30"),
      msk(1, "19:00"),
      msk(2, "20:00"),
    ];
    // Ужин есть только за 2 дня — мало для привычки.
    expect(findHabitualMealTimes(times, TZ)).toEqual({ lunch: 13 * 60 });
  });

  it("без истории привычек нет", () => {
    expect(findHabitualMealTimes([], TZ)).toEqual({});
  });
});

describe("cron/reminders sendMealReminders", () => {
  let db: Db;
  const sendMessage = vi.fn();

  beforeEach(() => {
    db = makeDb();
    createUser(db, 1, "alice");
    createUser(db, 2, "bob");
    sendMessage.mockReset().mockResolvedValue({});
    // У alice обед около 13:00 три последних дня.
    for (const day of [25, 26, 27]) addMeal(db, 1, msk(day, "13:00"));
  });

  it("напоминает через час после привычного времени, если ничего не записано", async () => {
    await sendMealReminders({ sendMessage } as never, db, msk(28, "14:00"), TZ);

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage.mock.calls[0][0]).toBe(1);
    expect(sendMessage.mock.calls[0][1]).toContain("Обед у вас обычно около 13:00");
  });

  it("не напоминает раньше срока и слишком поздно", async () => {
    await sendMealReminders({ sendMessage } as never, db, msk(28, "13:45"), TZ);
    await sendMealReminders({ sendMessage } as never, db, msk(28, "16:00"), TZ);

    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("не напоминает, если с начала окна обеда уже что-то записано", async () => {
    addMeal(db, 1, msk(28, "11:30"));

    await sendMealReminders({ sendMessage } as never, db, msk(28, "14:00"), TZ);

    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("завтрак не отменяет напоминание об обеде", async () => {
    addMeal(db, 1, msk(28, "09:00"));

    await sendMealReminders({ sendMessage } as never, db, msk(28, "14:00"), TZ);

    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it("напоминает не больше раза в день", async () => {
    await sendMealReminders({ sendMessage } as never, db, msk(28, "14:00"), TZ);
    await sendMealReminders({ sendMessage } as never, db, msk(28, "14:15"), TZ);

    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it("ошибка отправки не приводит к повторным попыткам", async () => {
    sendMessage.mockRejectedValue(new Error("Forbidden: bot was blocked by the user"));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    await sendMealReminders({ sendMessage } as never, db, msk(28, "14:00"), TZ);
    await sendMealReminders({ sendMessage } as never, db, msk(28, "14:15"), TZ);

    expect(sendMessage).toHaveBeenCalledTimes(1);
    consoleError.mockRestore();
  });
});

describe("cron/reminders sendWeightReminders", () => {
  let db: Db;
  const sendMessage = vi.fn();
  const now = msk(28, "09:00");

  beforeEach(() => {
    db = makeDb();
    createUser(db, 1, "alice");
    addProfile(db, 1);
    addMeal(db, 1, msk(27, "13:00"));
    sendMessage.mockReset().mockResolvedValue({});
  });

  it("напоминает, если вес не обновлялся неделю, с кнопкой записи", async () => {
    addWeightEntry(db, 1, 60, msk(20, "08:00"));

    await sendWeightReminders({ sendMessage } as never, db, now, TZ);

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage.mock.calls[0][1]).toContain("Вес не обновлялся уже 8 дн.");
    expect(JSON.stringify(sendMessage.mock.calls[0][2])).toContain("menu:weight");
  });

  it("не напоминает, если вес свежий", async () => {
    addWeightEntry(db, 1, 60, msk(25, "08:00"));

    await sendWeightReminders({ sendMessage } as never, db, now, TZ);

    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("не напоминает чаще раза в неделю", async () => {
    recordReminder(db, 1, "weight", msk(23, "09:00"));

    await sendWeightReminders({ sendMessage } as never, db, now, TZ);
    expect(sendMessage).not.toHaveBeenCalled();

    await sendWeightReminders({ sendMessage } as never, db, msk(30, "09:00"), TZ);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage.mock.calls[0][1]).toContain("ещё ни разу не записывали вес");
  });

  it("не тревожит пользователей без профиля и без недавних записей еды", async () => {
    createUser(db, 2, "bob"); // без профиля
    addMeal(db, 2, msk(27, "13:00"));
    createUser(db, 3, "carol"); // давно не пользуется ботом
    addProfile(db, 3);
    addMeal(db, 3, msk(1, "13:00"));
    addWeightEntry(db, 1, 60, msk(27, "08:00"));

    await sendWeightReminders({ sendMessage } as never, db, now, TZ);

    expect(sendMessage).not.toHaveBeenCalled();
  });
});
