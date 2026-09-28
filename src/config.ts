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
  // Если задан ANTHROPIC_BASE_URL (сторонний Anthropic-совместимый прокси), ключ
  // берётся из CUSTOMIX_API_KEY, а не из ANTHROPIC_API_KEY — это разные ключи от
  // разных сервисов, и переключение прокси не должно затирать прямой ключ Anthropic.
  get anthropicApiKey(): string {
    return process.env.ANTHROPIC_BASE_URL
      ? required("CUSTOMIX_API_KEY")
      : required("ANTHROPIC_API_KEY");
  },
  // Пусто/не задано — используется официальный endpoint Anthropic по умолчанию из SDK.
  anthropicBaseUrl: process.env.ANTHROPIC_BASE_URL || undefined,
  anthropicModel: process.env.ANTHROPIC_MODEL || "claude-sonnet-5",
  // Для распознавания голосовых сообщений (Whisper API) — Claude не принимает аудио
  // напрямую, поэтому голос сначала расшифровывается в текст через OpenAI.
  get openaiApiKey(): string {
    return required("OPENAI_API_KEY");
  },
  // Пусто/не задано — используется официальный endpoint OpenAI по умолчанию из SDK.
  openaiBaseUrl: process.env.OPENAI_BASE_URL || undefined,
  inviteCodes: (process.env.INVITE_CODES ?? "")
    .split(",")
    .map((code) => code.trim())
    .filter(Boolean),
  dbPath: process.env.DB_PATH ?? "./data/db.sqlite",
  defaultTimezone: process.env.DEFAULT_TIMEZONE ?? "Europe/Moscow",
  // Время вечерней сводки (HH:MM) в DEFAULT_TIMEZONE.
  eveningSummaryTime: process.env.EVENING_SUMMARY_TIME || "23:30",
  // Время недельного отчёта по воскресеньям (HH:MM) в DEFAULT_TIMEZONE.
  weeklyReportTime: process.env.WEEKLY_REPORT_TIME || "21:00",
  // Напоминания о пропущенном обеде/ужине. По умолчанию выключены.
  mealRemindersEnabled: process.env.MEAL_REMINDERS_ENABLED === "true",
  // Время ежедневной проверки, не пора ли напомнить записать вес (HH:MM, в DEFAULT_TIMEZONE).
  weightReminderTime: process.env.WEIGHT_REMINDER_TIME || "09:00",
};
