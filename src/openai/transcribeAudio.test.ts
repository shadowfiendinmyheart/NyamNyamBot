import { beforeEach, describe, expect, it, vi } from "vitest";

const createMock = vi.fn();
const clientConstructorMock = vi.fn();
const toFileMock = vi.fn(async (buffer: Buffer, filename: string) => ({ buffer, filename }));

class FakeAPIConnectionError extends Error {}
class FakeRateLimitError extends Error {}
class FakeAPIError extends Error {
  status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.status = status;
  }
}

vi.mock("openai", () => ({
  default: Object.assign(
    class {
      audio = { transcriptions: { create: createMock } };
      constructor(options: unknown) {
        clientConstructorMock(options);
      }
    },
    {
      APIConnectionError: FakeAPIConnectionError,
      RateLimitError: FakeRateLimitError,
      APIError: FakeAPIError,
    },
  ),
  toFile: toFileMock,
}));

vi.mock("../config.js", () => ({
  config: { openaiApiKey: "test-key" },
}));

const { transcribeAudio } = await import("./transcribeAudio.js");

describe("openai/transcribeAudio", () => {
  beforeEach(() => {
    createMock.mockReset();
    clientConstructorMock.mockReset();
    toFileMock.mockClear();
  });

  it("sends the audio file to whisper-1 with a Russian language hint", async () => {
    createMock.mockResolvedValue({ text: "гречка с курицей" });

    const result = await transcribeAudio({
      audioBuffer: Buffer.from("audio"),
      mimeType: "audio/ogg",
      filename: "voice.oga",
    });

    expect(result).toBe("гречка с курицей");
    const call = createMock.mock.calls[0][0];
    expect(call.model).toBe("whisper-1");
    expect(call.language).toBe("ru");
    expect(clientConstructorMock).toHaveBeenCalledWith({
      apiKey: "test-key",
      timeout: 60_000,
      maxRetries: 1,
    });
  });

  it("trims the transcribed text", async () => {
    createMock.mockResolvedValue({ text: "  курица с рисом  " });

    const result = await transcribeAudio({
      audioBuffer: Buffer.from("audio"),
      mimeType: "audio/ogg",
      filename: "voice.oga",
    });

    expect(result).toBe("курица с рисом");
  });

  it("throws a non-retryable error when the transcription is empty", async () => {
    createMock.mockResolvedValue({ text: "   " });

    await expect(
      transcribeAudio({ audioBuffer: Buffer.from("audio"), mimeType: "audio/ogg", filename: "v.oga" }),
    ).rejects.toMatchObject({ name: "TranscriberError", retryable: false });
  });

  it("maps connection errors to a retryable TranscriberError", async () => {
    createMock.mockRejectedValue(new FakeAPIConnectionError("boom"));

    await expect(
      transcribeAudio({ audioBuffer: Buffer.from("audio"), mimeType: "audio/ogg", filename: "v.oga" }),
    ).rejects.toMatchObject({ name: "TranscriberError", retryable: true });
  });

  it("maps rate limit errors to a retryable TranscriberError", async () => {
    createMock.mockRejectedValue(new FakeRateLimitError("boom"));

    await expect(
      transcribeAudio({ audioBuffer: Buffer.from("audio"), mimeType: "audio/ogg", filename: "v.oga" }),
    ).rejects.toMatchObject({ name: "TranscriberError", retryable: true });
  });

  it("maps 5xx API errors to a retryable TranscriberError", async () => {
    createMock.mockRejectedValue(new FakeAPIError("boom", 503));

    await expect(
      transcribeAudio({ audioBuffer: Buffer.from("audio"), mimeType: "audio/ogg", filename: "v.oga" }),
    ).rejects.toMatchObject({ name: "TranscriberError", retryable: true });
  });

  it("maps 4xx API errors to a non-retryable TranscriberError", async () => {
    createMock.mockRejectedValue(new FakeAPIError("boom", 400));

    await expect(
      transcribeAudio({ audioBuffer: Buffer.from("audio"), mimeType: "audio/ogg", filename: "v.oga" }),
    ).rejects.toMatchObject({ name: "TranscriberError", retryable: false });
  });
});
