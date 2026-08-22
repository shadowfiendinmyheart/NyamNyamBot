import "dotenv/config";
import { defineConfig } from "drizzle-kit";

// Не импортируем src/config.ts: drizzle-kit грузит этот файл через свой CJS-загрузчик,
// который не резолвит NodeNext-style ESM-импорты (`./config.js` -> `config.ts`).
// Дефолт держим синхронным с DB_PATH из src/config.ts вручную.
export default defineConfig({
  dialect: "sqlite",
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dbCredentials: {
    url: process.env.DB_PATH ?? "./data/db.sqlite",
  },
});
