import { describe, expect, it } from "vitest";
import { parseGuestInput } from "./accessGate.js";

describe("features/accessGate parseGuestInput", () => {
  it("/start без кода — приветствие, а не попытка ввести код", () => {
    expect(parseGuestInput("/start")).toEqual({ kind: "welcome" });
    expect(parseGuestInput("/start@nyam_bot")).toEqual({ kind: "welcome" });
  });

  it("код из deep link t.me/<bot>?start=<код>", () => {
    expect(parseGuestInput("/start family2026")).toEqual({ kind: "code", code: "family2026" });
    expect(parseGuestInput("/start@nyam_bot letmein")).toEqual({ kind: "code", code: "letmein" });
  });

  it("другие команды — приветствие", () => {
    expect(parseGuestInput("/help")).toEqual({ kind: "welcome" });
    expect(parseGuestInput("/today")).toEqual({ kind: "welcome" });
  });

  it("обычный текст — код", () => {
    expect(parseGuestInput("  letmein \n")).toEqual({ kind: "code", code: "letmein" });
  });

  it("сообщение без текста — ничего", () => {
    expect(parseGuestInput(undefined)).toEqual({ kind: "none" });
    expect(parseGuestInput("   ")).toEqual({ kind: "none" });
  });
});
