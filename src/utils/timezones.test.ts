import { describe, expect, it } from "vitest";
import {
  formatLocalTime,
  formatTimeZone,
  isValidTimeZone,
  parseTimeZoneText,
} from "./timezones.js";

describe("utils/timezones parseTimeZoneText", () => {
  it("понимает смещение от UTC и от Москвы", () => {
    expect(parseTimeZoneText("UTC+5")).toBe("Etc/GMT-5");
    expect(parseTimeZoneText("+3")).toBe("Etc/GMT-3");
    expect(parseTimeZoneText("gmt -4")).toBe("Etc/GMT+4");
    expect(parseTimeZoneText("UTC+0")).toBe("UTC");
    expect(parseTimeZoneText("МСК+2")).toBe("Etc/GMT-5");
    expect(parseTimeZoneText("мск-1")).toBe("Etc/GMT-2");
  });

  it("отклоняет несуществующее смещение", () => {
    expect(parseTimeZoneText("UTC+15")).toBeUndefined();
    expect(parseTimeZoneText("UTC-13")).toBeUndefined();
  });

  it("понимает IANA-имя в любом регистре", () => {
    expect(parseTimeZoneText("europe/berlin")).toBe("Europe/Berlin");
    expect(parseTimeZoneText("Mars/Olympus")).toBeUndefined();
  });

  it("узнаёт город словами", () => {
    expect(parseTimeZoneText("Екатеринбург")).toBe("Asia/Yekaterinburg");
    expect(parseTimeZoneText("я в Питере")).toBe("Europe/Moscow");
    expect(parseTimeZoneText("Уфа")).toBe("Asia/Yekaterinburg");
    expect(parseTimeZoneText("Красноярск")).toBe("Asia/Novosibirsk");
    expect(parseTimeZoneText("живу в Минске")).toBe("Europe/Minsk");
    expect(parseTimeZoneText("Южно-Сахалинск")).toBe("Asia/Magadan");
  });

  it("не угадывает, если город не знаком или городов несколько", () => {
    expect(parseTimeZoneText("Урюпинск")).toBeUndefined();
    expect(parseTimeZoneText("между Москвой и Омском")).toBeUndefined();
    expect(parseTimeZoneText("")).toBeUndefined();
  });
});

describe("utils/timezones formatting", () => {
  const now = new Date("2026-01-15T10:00:00Z");

  it("подписывает пояс городом и смещением", () => {
    expect(formatTimeZone("Europe/Moscow", now)).toBe("Москва (UTC+3)");
    expect(formatTimeZone("Europe/Berlin", now)).toBe("Europe/Berlin (UTC+1)");
    expect(formatTimeZone("Etc/GMT-5", now)).toBe("UTC+5");
    expect(formatTimeZone("UTC", now)).toBe("UTC+0");
  });

  it("показывает местное время", () => {
    expect(formatLocalTime("Asia/Yekaterinburg", now)).toBe("15:00");
  });

  it("проверяет, что пояс существует", () => {
    expect(isValidTimeZone("Asia/Vladivostok")).toBe(true);
    expect(isValidTimeZone("Asia/Atlantis")).toBe(false);
  });
});
