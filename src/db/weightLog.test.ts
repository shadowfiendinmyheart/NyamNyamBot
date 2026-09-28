import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { beforeEach, describe, expect, it } from "vitest";
import * as schema from "./schema.js";
import { createUser } from "./users.js";
import { getProfileByUserId, updateProfileMetrics, upsertProfile } from "./profiles.js";
import { addWeightEntry, getWeightHistory, logWeight } from "./weightLog.js";
import { calculateDailyTargets, type ProfileInput } from "../nutrition/calculations.js";

function makeDb() {
  const sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: "./drizzle" });
  return db;
}

const sedentaryMale: ProfileInput = {
  sex: "male",
  age: 30,
  heightCm: 180,
  weightKg: 80,
  activityLevel: "sedentary",
  goal: "maintain",
};

describe("db/weightLog", () => {
  let db: ReturnType<typeof makeDb>;

  beforeEach(() => {
    db = makeDb();
    createUser(db, 1, "alice");
    upsertProfile(db, 1, { ...sedentaryMale, ...calculateDailyTargets(sedentaryMale) });
  });

  it("logWeight пишет вес в журнал и пересчитывает норму в профиле", () => {
    const result = logWeight(db, 1, 75, new Date("2026-09-01T08:00:00Z"));

    expect(result?.before.weightKg).toBe(80);
    expect(result?.before.dailyKcalTarget).toBe(2136);
    // BMR: 10*75 + 6.25*180 - 5*30 + 5 = 1730; * 1.2 = 2076
    expect(result?.after.dailyKcalTarget).toBe(2076);
    expect(result?.after.proteinGTarget).toBe(135);

    const profile = getProfileByUserId(db, 1);
    expect(profile?.weightKg).toBe(75);
    expect(profile?.dailyKcalTarget).toBe(2076);

    const history = getWeightHistory(db, 1, 10);
    expect(history.map((e) => e.weightKg)).toEqual([75]);
  });

  it("logWeight без профиля ничего не пишет", () => {
    createUser(db, 2, "bob");

    expect(logWeight(db, 2, 70)).toBeUndefined();
    expect(getWeightHistory(db, 2, 10)).toEqual([]);
  });

  it("getWeightHistory отдаёт последние записи, новые сверху", () => {
    addWeightEntry(db, 1, 80, new Date("2026-09-01T08:00:00Z"));
    addWeightEntry(db, 1, 79.2, new Date("2026-09-08T08:00:00Z"));
    addWeightEntry(db, 1, 78.5, new Date("2026-09-15T08:00:00Z"));

    expect(getWeightHistory(db, 1, 2).map((e) => e.weightKg)).toEqual([78.5, 79.2]);
  });

  it("смена активности с сидячей на среднюю поднимает норму, вес не трогает", () => {
    const result = updateProfileMetrics(db, 1, { activityLevel: "moderate" });

    // 1780 * 1.55 = 2759
    expect(result?.after.dailyKcalTarget).toBe(2759);
    expect(result?.after.weightKg).toBe(80);

    const profile = getProfileByUserId(db, 1);
    expect(profile?.activityLevel).toBe("moderate");
    expect(profile?.dailyKcalTarget).toBe(2759);
    expect(getWeightHistory(db, 1, 10)).toEqual([]);
  });

  it("удаление пользователя удаляет его журнал веса", () => {
    logWeight(db, 1, 79);
    db.delete(schema.profiles).run();
    db.delete(schema.users).run();

    expect(db.select().from(schema.weightLog).all()).toEqual([]);
  });
});
