import { describe, expect, it } from "vitest";
import {
  buildVoiceConfirmMessage,
  MAX_TRANSCRIPT_LENGTH,
  parseVoiceConfirmMessage,
  voiceConfirmKeyboard,
  voiceConfirmPattern,
} from "./voiceConfirm.js";

describe("features/voiceConfirm message", () => {
  it("round-trips the transcript through the confirmation message", () => {
    const transcript = "съел тарелку борща\nи кусок хлеба";
    expect(parseVoiceConfirmMessage(buildVoiceConfirmMessage(transcript))).toBe(transcript);
  });

  it("truncates long transcripts to fit Telegram's 4096-character limit", () => {
    const message = buildVoiceConfirmMessage("а".repeat(10_000));
    expect(message.length).toBeLessThanOrEqual(4096);
    expect(parseVoiceConfirmMessage(message)).toBe(`${"а".repeat(MAX_TRANSCRIPT_LENGTH)}…`);
  });

  it("returns undefined for messages that are not voice confirmations", () => {
    expect(parseVoiceConfirmMessage(undefined)).toBeUndefined();
    expect(parseVoiceConfirmMessage("🎙 съел борщ")).toBeUndefined();
    expect(parseVoiceConfirmMessage(buildVoiceConfirmMessage("   "))).toBeUndefined();
  });
});

describe("features/voiceConfirm buttons", () => {
  it("builds scope-specific callback data that the scope's pattern matches", () => {
    const data = voiceConfirmKeyboard("coach")
      .inline_keyboard.flat()
      .map((button) => ("callback_data" in button ? button.callback_data : undefined));
    expect(data).toEqual(["voice_coach:yes", "voice_coach:no"]);

    expect("voice_coach:yes".match(voiceConfirmPattern("coach"))?.[1]).toBe("yes");
    expect("voice_meal:yes".match(voiceConfirmPattern("coach"))).toBeNull();
  });
});
