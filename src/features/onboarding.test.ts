import { describe, expect, it } from "vitest";
import { MAX_MOTIVATION_LENGTH, normalizeMotivation } from "./onboarding.js";

describe("features/onboarding normalizeMotivation", () => {
  it("обрезает пробелы по краям", () => {
    expect(normalizeMotivation("  Хочу похудеть к лету \n")).toBe("Хочу похудеть к лету");
  });

  it("пустой ответ — null", () => {
    expect(normalizeMotivation("   ")).toBeNull();
  });

  it("слишком длинный ответ обрезается с многоточием", () => {
    const result = normalizeMotivation("а".repeat(MAX_MOTIVATION_LENGTH + 100));
    expect(result).toHaveLength(MAX_MOTIVATION_LENGTH + 1);
    expect(result?.endsWith("…")).toBe(true);
  });
});
