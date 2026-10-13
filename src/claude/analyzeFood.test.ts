import { beforeEach, describe, expect, it, vi } from "vitest";

const createMock = vi.fn();
const clientConstructorMock = vi.fn();

vi.mock("@anthropic-ai/sdk", () => ({
  // Классы ошибок нужны classifyApiError: без них любой instanceof в нём бросил бы TypeError.
  default: Object.assign(
    class {
      messages = { create: createMock };
      constructor(options: unknown) {
        clientConstructorMock(options);
      }
    },
    {
      APIConnectionError: class extends Error {},
      RateLimitError: class extends Error {},
      APIError: class extends Error {},
    },
  ),
}));

vi.mock("../config.js", () => ({
  config: {
    anthropicApiKey: "test-key",
    anthropicBaseUrl: undefined,
    anthropicModel: "claude-sonnet-5",
  },
}));

const { analyzeFood } = await import("./analyzeFood.js");

function toolUseResponse(input: unknown) {
  return {
    content: [{ type: "tool_use", id: "toolu_1", name: "analyze_food", input }],
  };
}

describe("claude/analyzeFood", () => {
  beforeEach(() => {
    createMock.mockReset();
  });

  it("throws without calling the API when there is no image or text", async () => {
    await expect(analyzeFood({})).rejects.toThrow(/фото или text/);
    await expect(analyzeFood({ images: [] })).rejects.toThrow(/фото или text/);
    expect(createMock).not.toHaveBeenCalled();
  });

  it("sends every photo of an album as a separate image block", async () => {
    createMock.mockResolvedValue(toolUseResponse({ food_detected: true, items: [] }));

    await analyzeFood({
      images: [
        { imageBase64: "SOUP", mimeType: "image/jpeg" },
        { imageBase64: "MAIN", mimeType: "image/png" },
      ],
    });

    expect(createMock.mock.calls[0][0].messages[0].content).toEqual([
      { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "SOUP" } },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "MAIN" } },
    ]);
  });

  it("sends image and text blocks in order when both are provided", async () => {
    createMock.mockResolvedValue(
      toolUseResponse({ food_detected: true, items: [] }),
    );

    await analyzeFood({
      images: [{ imageBase64: "BASE64DATA", mimeType: "image/jpeg" }],
      text: "с добавкой соуса",
    });

    const call = createMock.mock.calls[0][0];
    expect(call.messages[0].content).toEqual([
      {
        type: "image",
        source: { type: "base64", media_type: "image/jpeg", data: "BASE64DATA" },
      },
      { type: "text", text: "с добавкой соуса" },
    ]);
    expect(call.model).toBe("claude-sonnet-5");
    expect(clientConstructorMock).toHaveBeenCalledWith({
      apiKey: "test-key",
      baseURL: undefined,
      timeout: 90_000,
      maxRetries: 1,
    });
  });

  it("maps a valid tool response into camelCase result", async () => {
    createMock.mockResolvedValue(
      toolUseResponse({
        food_detected: true,
        items: [
          {
            name: "гречка",
            estimated_weight_g: 200,
            kcal: 220,
            protein_g: 6.5,
            fat_g: 2.1,
            carb_g: 41.3,
          },
        ],
        notes: "вес приблизительный",
      }),
    );

    const result = await analyzeFood({ text: "гречка 200г" });

    expect(result).toEqual({
      foodDetected: true,
      items: [
        {
          name: "гречка",
          estimatedWeightG: 200,
          kcal: 220,
          proteinG: 6.5,
          fatG: 2.1,
          carbG: 41.3,
        },
      ],
      notes: "вес приблизительный",
    });
  });

  it("rounds kcal to an integer and macros to one decimal place", async () => {
    createMock.mockResolvedValue(
      toolUseResponse({
        food_detected: true,
        items: [
          {
            name: "курица",
            estimated_weight_g: 150,
            kcal: 217.6,
            protein_g: 6.53,
            fat_g: 2.149,
            carb_g: 41.35,
          },
        ],
      }),
    );

    const result = await analyzeFood({ text: "курица 150г" });

    expect(result.items[0]).toEqual({
      name: "курица",
      estimatedWeightG: 150,
      kcal: 218,
      proteinG: 6.5,
      fatG: 2.1,
      carbG: 41.4,
    });
  });

  it("throws when a returned item has a non-numeric field", async () => {
    createMock.mockResolvedValue(
      toolUseResponse({
        food_detected: true,
        items: [
          {
            name: "неизвестно",
            estimated_weight_g: 100,
            kcal: Number.NaN,
            protein_g: 1,
            fat_g: 1,
            carb_g: 1,
          },
        ],
      }),
    );

    await expect(analyzeFood({ text: "что-то" })).rejects.toThrow(/некорректный продукт/);
  });

  it("returns an empty result with notes when food is not detected", async () => {
    createMock.mockResolvedValue(
      toolUseResponse({ food_detected: false, items: [], notes: "на фото не видно еды" }),
    );

    const result = await analyzeFood({ text: "случайный текст" });

    expect(result).toEqual({
      foodDetected: false,
      items: [],
      notes: "на фото не видно еды",
    });
  });

  it("throws when the response has no tool_use block", async () => {
    createMock.mockResolvedValue({ content: [{ type: "text", text: "не могу помочь" }] });

    await expect(analyzeFood({ text: "гречка" })).rejects.toThrow(/analyze_food/);
  });

  it.each([
    ["a proxy error object", { error: { message: "upstream provider error" } }, "upstream provider error"],
    ["an OpenAI-shaped body", { choices: [] }, '"choices"'],
    ["an HTML page", "<html>502 Bad Gateway</html>", "502 Bad Gateway"],
  ])("turns %s returned with 200 into a retryable error carrying the body", async (_, body, logged) => {
    createMock.mockResolvedValue(body);

    const err = await analyzeFood({ images: [{ imageBase64: "X", mimeType: "image/jpeg" }] }).catch(
      (e: unknown) => e,
    );

    expect(err).toMatchObject({ name: "FoodAnalyzerError", retryable: true });
    expect(String((err as Error).cause)).toContain(logged);
  });

  it("repeats the request with tool_choice auto when the model rejects a forced tool_choice", async () => {
    createMock
      .mockResolvedValueOnce({
        type: "error",
        error: {
          type: "invalid_request_error",
          message: 'tool_choice: type "tool" and "any" are not supported for this model.',
        },
      })
      .mockResolvedValueOnce(toolUseResponse({ food_detected: true, items: [] }));
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await analyzeFood({ text: "гречка" });

    expect(result.foodDetected).toBe(true);
    const retry = createMock.mock.calls[1][0];
    expect(retry.tool_choice).toEqual({ type: "auto" });
    expect(retry.system.at(-1).text).toContain("analyze_food");
  });

  it("does not call a request rejected by the service a temporary overload", async () => {
    createMock.mockResolvedValue({
      type: "error",
      error: { type: "invalid_request_error", message: "max_tokens: too large" },
    });

    const err = await analyzeFood({ text: "гречка" }).catch((e: unknown) => e);

    expect(err).toMatchObject({ name: "FoodAnalyzerError", retryable: false });
    expect(createMock).toHaveBeenCalledTimes(1);
  });

  it("turns an unparsable JSON body returned with 200 into a retryable error", async () => {
    createMock.mockRejectedValue(new SyntaxError("Unexpected end of JSON input"));

    await expect(analyzeFood({ text: "гречка" })).rejects.toMatchObject({
      name: "FoodAnalyzerError",
      retryable: true,
    });
  });
});
