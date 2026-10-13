import { describe, expect, it, vi } from "vitest";

vi.mock("../config.js", () => ({
  config: {
    anthropicApiKey: "test-key",
    anthropicBaseUrl: undefined,
    anthropicModel: "claude-sonnet-5",
  },
}));

const { thinkingOff, hasMandatoryThinking, withoutForcedToolChoice } = await import(
  "./client.js"
);

describe("claude/client tool_choice при обязательном thinking", () => {
  it("обязательный thinking — у Sonnet 5.5, Opus 5.5 и Fable", () => {
    expect(hasMandatoryThinking("claude-sonnet-5")).toBe(false);
    expect(hasMandatoryThinking("claude-sonnet-5-5")).toBe(true);
    expect(hasMandatoryThinking("claude-opus-5-5")).toBe(true);
    expect(hasMandatoryThinking("anthropic/claude-fable-5.1")).toBe(true);
  });

  it("принудительный вызов инструмента переносит в system prompt, tool_choice — auto", () => {
    const params = withoutForcedToolChoice({
      max_tokens: 100,
      system: "промпт",
      tool_choice: { type: "tool", name: "analyze_food" },
      messages: [{ role: "user", content: "гречка" }],
    });

    expect(params.tool_choice).toEqual({ type: "auto" });
    expect(params.system).toEqual([
      { type: "text", text: "промпт" },
      { type: "text", text: expect.stringContaining("analyze_food") },
    ]);
  });

  it("запрос без принудительного tool_choice не меняет", () => {
    const params = { max_tokens: 100, messages: [{ role: "user" as const, content: "привет" }] };
    expect(withoutForcedToolChoice(params)).toBe(params);
  });
});

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
