import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { beforeEach, describe, expect, it } from "vitest";
import * as schema from "./schema.js";
import { createUser } from "./users.js";
import {
  deleteProfile,
  getProfileByUserId,
  upsertProfile,
  type UpsertProfileInput,
} from "./profiles.js";

function makeDb() {
  const sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: "./drizzle" });
  return db;
}

const sampleInput: UpsertProfileInput = {
  sex: "male",
  age: 30,
  heightCm: 180,
  weightKg: 80,
  activityLevel: "sedentary",
  goal: "maintain",
  dailyKcalTarget: 2136,
  proteinGTarget: 144,
  fatGTarget: 65.3,
  carbGTarget: 218.7,
};

describe("db/profiles", () => {
  let db: ReturnType<typeof makeDb>;

  beforeEach(() => {
    db = makeDb();
    createUser(db, 1, "alice");
  });

  it("создаёт профиль пользователя", () => {
    upsertProfile(db, 1, sampleInput);

    const profile = getProfileByUserId(db, 1);
    expect(profile?.dailyKcalTarget).toBe(2136);
    expect(profile?.proteinGTarget).toBe(144);
    expect(profile?.activityLevel).toBe("sedentary");
  });

  it("возвращает undefined, если профиля нет", () => {
    expect(getProfileByUserId(db, 1)).toBeUndefined();
  });

  it("повторный вызов обновляет существующий профиль, а не создаёт второй", () => {
    upsertProfile(db, 1, sampleInput);
    upsertProfile(db, 1, { ...sampleInput, weightKg: 75, dailyKcalTarget: 2000 });

    const profile = getProfileByUserId(db, 1);
    expect(profile?.weightKg).toBe(75);
    expect(profile?.dailyKcalTarget).toBe(2000);

    const all = db.select().from(schema.profiles).all();
    expect(all).toHaveLength(1);
  });

  it("удаляет профиль", () => {
    upsertProfile(db, 1, sampleInput);

    expect(deleteProfile(db, 1)).toBe(true);
    expect(getProfileByUserId(db, 1)).toBeUndefined();
  });

  it("удаление несуществующего профиля возвращает false", () => {
    expect(deleteProfile(db, 1)).toBe(false);
  });
});
