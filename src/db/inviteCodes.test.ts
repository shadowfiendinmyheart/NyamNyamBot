import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { beforeEach, describe, expect, it } from "vitest";
import * as schema from "./schema.js";
import { redeemInviteCode, syncInviteCodes } from "./inviteCodes.js";
import { getUserByTelegramId } from "./users.js";

function makeDb() {
  const sqlite = new Database(":memory:");
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: "./drizzle" });
  return db;
}

describe("db/inviteCodes", () => {
  let db: ReturnType<typeof makeDb>;

  beforeEach(() => {
    db = makeDb();
    syncInviteCodes(db, ["ABC123"]);
  });

  it("redeems a known code and creates the user", () => {
    const redeemed = redeemInviteCode(db, "ABC123", 111, "alice");

    expect(redeemed).toBe(true);
    expect(getUserByTelegramId(db, 111)?.username).toBe("alice");
  });

  it("is case-insensitive", () => {
    expect(redeemInviteCode(db, "abc123", 111, "alice")).toBe(true);
  });

  it("rejects an unknown code", () => {
    expect(redeemInviteCode(db, "NOPE", 111, "alice")).toBe(false);
    expect(getUserByTelegramId(db, 111)).toBeUndefined();
  });

  it("rejects a code that was already used by someone else", () => {
    expect(redeemInviteCode(db, "ABC123", 111, "alice")).toBe(true);

    const secondAttempt = redeemInviteCode(db, "ABC123", 222, "bob");

    expect(secondAttempt).toBe(false);
    expect(getUserByTelegramId(db, 222)).toBeUndefined();
  });

  it("does not re-add a code that is already used when syncing again", () => {
    redeemInviteCode(db, "ABC123", 111, "alice");

    syncInviteCodes(db, ["ABC123"]);

    expect(redeemInviteCode(db, "ABC123", 222, "bob")).toBe(false);
  });
});
