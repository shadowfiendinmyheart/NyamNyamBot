import { describe, expect, it, vi } from "vitest";

vi.mock("../config.js", () => ({
  config: {
    anthropicApiKey: "test-key",
    anthropicBaseUrl: undefined,
    anthropicModel: "claude-sonnet-5",
  },
}));

const { thinkingOff } = await import("./client.js");

describe("claude/client thinkingOff", () => {
  it("Sonnet 5 и старше — thinking disabled", () => {
    expect(thinkingOff("claude-sonnet-5")).toEqual({ thinking: { type: "disabled" } });
    expect(thinkingOff("claude-opus-4-8")).toEqual({ thinking: { type: "disabled" } });
  });

  it("Sonnet 5.5 — between_tools: disabled она отклоняет", () => {
    expect(thinkingOff("claude-sonnet-5-5")).toEqual({ thinking: { type: "between_tools" } });
    expect(thinkingOff("anthropic/claude-sonnet-5.5")).toEqual({
      thinking: { type: "between_tools" },
    });
  });

  it("Opus 5.5 и Fable — thinking не передаётся: отключить его нельзя", () => {
    expect(thinkingOff("claude-opus-5-5")).toEqual({});
    expect(thinkingOff("anthropic/claude-fable-5.1")).toEqual({});
  });
});
