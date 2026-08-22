import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { db, sqlite } from "./client.js";

migrate(db, { migrationsFolder: "./drizzle" });
console.log("Миграции применены успешно.");

sqlite.close();
