import { describe, expect, it } from "vitest";
import {
  buildNotificationsMessage,
  notificationsKeyboard,
  SUMMARY_TIME_OPTIONS,
  summaryTimeKeyboard,
} from "./notifications.js";

const settings = {
  eveningSummaryTime: "22:30",
  eveningSummaryEnabled: true,
  weeklyReportEnabled: false,
  remindersEnabled: true,
};

describe("features/notifications", () => {
  it("offers summary times from 18:00 to 23:30 every half hour", () => {
    expect(SUMMARY_TIME_OPTIONS[0]).toBe("18:00");
    expect(SUMMARY_TIME_OPTIONS[1]).toBe("18:30");
    expect(SUMMARY_TIME_OPTIONS.at(-1)).toBe("23:30");
    expect(SUMMARY_TIME_OPTIONS).toHaveLength(12);
  });

  it("describes the current settings", () => {
    const text = buildNotificationsMessage(settings, "21:00");
    expect(text).toContain("🌙 Вечерняя сводка — ✅ вкл, в 22:30");
    expect(text).toContain("📅 Недельный отчёт — ⛔ выкл, по воскресеньям в 21:00");
    expect(text).toContain("⏰ Напоминания — ✅ вкл");
  });

  it("shows toggles with their state and the summary time", () => {
    const buttons = notificationsKeyboard(settings).inline_keyboard.flat();
    expect(buttons.map((button) => button.text)).toEqual([
      "✅ Сводка",
      "🕐 Время: 22:30",
      "⛔ Недельный отчёт",
      "✅ Напоминания",
      "◀️ Назад",
    ]);
  });

  it("marks the current summary time in the picker", () => {
    const buttons = summaryTimeKeyboard("22:30").inline_keyboard.flat();
    expect(buttons.find((button) => button.text === "✅ 22:30")).toMatchObject({
      callback_data: "notif:settime:22:30",
    });
    expect(buttons.filter((button) => button.text.startsWith("✅"))).toHaveLength(1);
  });
});
