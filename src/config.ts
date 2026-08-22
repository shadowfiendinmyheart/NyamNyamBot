import "dotenv/config";

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

export const config = {
  get botToken(): string {
    return required("BOT_TOKEN");
  },
  get anthropicApiKey(): string {
    return required("ANTHROPIC_API_KEY");
  },
  inviteCodes: (process.env.INVITE_CODES ?? "")
    .split(",")
    .map((code) => code.trim())
    .filter(Boolean),
  dbPath: process.env.DB_PATH ?? "./data/db.sqlite",
  photosDir: process.env.PHOTOS_DIR ?? "./data/photos",
  photoRetentionDays: Number(process.env.PHOTO_RETENTION_DAYS ?? "30"),
  defaultTimezone: process.env.DEFAULT_TIMEZONE ?? "Europe/Moscow",
};
