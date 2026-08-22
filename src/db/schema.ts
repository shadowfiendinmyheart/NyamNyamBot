import { sql } from "drizzle-orm";
import { integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const users = sqliteTable("users", {
  id: integer("id").primaryKey(),
  username: text("username"),
  invitedAt: integer("invited_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
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
  source: text("source", { enum: ["photo", "text"] }).notNull(),
  photoPath: text("photo_path"),
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
