import { sql } from "drizzle-orm";
import { integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const users = sqliteTable("users", {
  id: integer("id").primaryKey(),
  username: text("username"),
  invitedAt: integer("invited_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
});

export const inviteCodes = sqliteTable("invite_codes", {
  code: text("code").primaryKey(),
  usedByUserId: integer("used_by_user_id").references(() => users.id),
  usedAt: integer("used_at", { mode: "timestamp" }),
});

export const profiles = sqliteTable("profiles", {
  userId: integer("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  sex: text("sex", { enum: ["male", "female"] }).notNull(),
  age: integer("age").notNull(),
  heightCm: real("height_cm").notNull(),
  weightKg: real("weight_kg").notNull(),
  activityLevel: text("activity_level", {
    enum: ["sedentary", "light", "moderate", "active", "very_active"],
  }).notNull(),
  goal: text("goal", { enum: ["lose", "maintain", "gain"] }).notNull(),
  dailyKcalTarget: integer("daily_kcal_target").notNull(),
  proteinGTarget: real("protein_g_target").notNull(),
  fatGTarget: real("fat_g_target").notNull(),
  carbGTarget: real("carb_g_target").notNull(),
  // Зачем пользователь ведёт дневник — своими словами (текстом или расшифровкой голоса).
  // Контекст для коуча Ням-Ням; null — не рассказал.
  motivation: text("motivation"),
});

export const meals = sqliteTable("meals", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: integer("user_id")
    .notNull()
    .references(() => users.id),
  loggedAt: integer("logged_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
  mealType: text("meal_type", {
    enum: ["breakfast", "lunch", "dinner", "snack"],
  }).notNull(),
  source: text("source", { enum: ["photo", "text", "voice"] }).notNull(),
  // file_id фото в Telegram: само фото храним только там, а не на диске.
  telegramFileId: text("telegram_file_id"),
  description: text("description").notNull(),
  kcal: integer("kcal").notNull(),
  proteinG: real("protein_g").notNull(),
  fatG: real("fat_g").notNull(),
  carbG: real("carb_g").notNull(),
  rawClaudeResponse: text("raw_claude_response", { mode: "json" }),
});

export const mealItems = sqliteTable("meal_items", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  mealId: integer("meal_id")
    .notNull()
    .references(() => meals.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  weightG: real("weight_g").notNull(),
  kcal: integer("kcal").notNull(),
  proteinG: real("protein_g").notNull(),
  fatG: real("fat_g").notNull(),
  carbG: real("carb_g").notNull(),
});

// Отправленные напоминания — чтобы не слать одно и то же повторно (в том числе после
// перезапуска бота).
export const reminders = sqliteTable("reminders", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: integer("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  kind: text("kind", { enum: ["lunch", "dinner", "weight"] }).notNull(),
  sentAt: integer("sent_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
});

export const workouts = sqliteTable("workouts", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: integer("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  performedAt: integer("performed_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
  // Синхронно с WORKOUT_ACTIVITY_TYPES / WORKOUT_INTENSITIES из nutrition/calculations.ts:
  // drizzle-kit не умеет импортировать их сюда (см. drizzle.config.ts).
  activityType: text("activity_type", {
    enum: [
      "walking",
      "running",
      "cycling",
      "swimming",
      "strength",
      "hiit",
      "yoga",
      "sports",
      "dancing",
      "skiing",
      "other",
    ],
  }).notNull(),
  // Как назвал активность пользователь/ИИ («теннис», «бег»): для «other» тип ничего не говорит.
  description: text("description").notNull(),
  durationMin: integer("duration_min").notNull(),
  intensity: text("intensity", { enum: ["low", "moderate", "high"] }).notNull(),
  kcalBurned: integer("kcal_burned").notNull(),
  source: text("source", { enum: ["command", "text", "voice"] }).notNull(),
  rawText: text("raw_text"),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
});

// Упражнения силовой тренировки: «подтягивания 3×10», «жим лёжа 3×8 по 60 кг»,
// «планка 3×60 с». Все параметры необязательны — что пользователь назвал, то и есть.
export const workoutExercises = sqliteTable("workout_exercises", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  workoutId: integer("workout_id")
    .notNull()
    .references(() => workouts.id, { onDelete: "cascade" }),
  // В нижнем регистре — чтобы искать историю упражнения без учёта регистра (SQLite
  // LIKE не понимает регистр кириллицы).
  name: text("name").notNull(),
  sets: integer("sets"),
  reps: integer("reps"),
  weightKg: real("weight_kg"),
  durationSec: integer("duration_sec"),
});

export const weightLog = sqliteTable("weight_log", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: integer("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  weightKg: real("weight_kg").notNull(),
  loggedAt: integer("logged_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
});
