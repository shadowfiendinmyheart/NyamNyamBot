import { describe, expect, it, vi } from "vitest";

vi.mock("../config.js", () => ({
  config: {
    anthropicApiKey: "test-key",
    anthropicBaseUrl: undefined,
    anthropicModel: "claude-sonnet-5",
  },
}));

const { thinkingOff, hasMandatoryThinking, withoutForcedToolChoice, formatUsageLine } =
  await import("./client.js");

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

describe("claude/client formatUsageLine", () => {
  const usage = { input_tokens: 1883, output_tokens: 1086 } as Parameters<
    typeof formatUsageLine
  >[2];

  it("без цен — только токены", () => {
    expect(formatUsageLine("photo", "google/gemini-3.8-flash", usage)).toBe(
      "[ai-usage] kind=photo model=google/gemini-3.8-flash in=1883 cached=0 out=1086",
    );
  });

  it("с ценами — оценка в ₽", () => {
    expect(
      formatUsageLine("coach", "m", usage, { inputPerM: 82, outputPerM: 413 }),
    ).toBe("[ai-usage] kind=coach model=m in=1883 cached=0 out=1086 ≈0.603₽");
  });

  it("кэшированный вход — отдельно, в ₽ по цене входа; запись в кэш — во входе", () => {
    const cachedUsage = {
      ...usage,
      input_tokens: 400,
      cache_read_input_tokens: 1500,
      cache_creation_input_tokens: 100,
    } as typeof usage;
    expect(formatUsageLine("comment", "m", cachedUsage, { inputPerM: 100, outputPerM: 0 })).toBe(
      "[ai-usage] kind=comment model=m in=500 cached=1500 out=1086 ≈0.200₽",
    );
  });
});
