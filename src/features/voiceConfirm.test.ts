import { describe, expect, it } from "vitest";
import {
  buildSettledVoiceMessage,
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

  it("still reads confirmations sent before the wording change", () => {
    expect(parseVoiceConfirmMessage("🎙 Распознал:\n\nсъел борщ\n\nВсё верно?")).toBe("съел борщ");
  });
});

describe("features/voiceConfirm buttons", () => {
  it("builds scope-specific callback data that the scope's pattern matches", () => {
    const data = voiceConfirmKeyboard("coach")
      .inline_keyboard.flat()
      .map((button) => ("callback_data" in button ? button.callback_data : undefined));
    expect(data).toEqual(["voice_coach:yes", "voice_coach:edit", "voice_coach:no"]);

    for (const action of ["yes", "edit", "no"]) {
      expect(`voice_coach:${action}`.match(voiceConfirmPattern("coach"))?.[1]).toBe(action);
    }
    expect("voice_meal:yes".match(voiceConfirmPattern("coach"))).toBeNull();
    expect("voice_coach:maybe".match(voiceConfirmPattern("coach"))).toBeNull();
  });

  it("keeps old Yes/No buttons of already sent messages working", () => {
    expect("voice_meal:yes".match(voiceConfirmPattern("meal"))?.[1]).toBe("yes");
    expect("voice_meal:no".match(voiceConfirmPattern("meal"))?.[1]).toBe("no");
  });
});

describe("features/voiceConfirm settled message", () => {
  const hints = { reject: "Не записываю.", edit: "Пришлите исправленный вариант." };

  it("leaves only the transcript after ✅", () => {
    expect(buildSettledVoiceMessage("съела борщ", "yes", hints)).toEqual({
      text: "🎙 съела борщ",
      entities: [],
    });
  });

  it("adds the reject hint after ❌", () => {
    expect(buildSettledVoiceMessage("съела борщ", "no", hints)).toEqual({
      text: "🎙 съела борщ\n\n❌ Не записываю.",
      entities: [],
    });
  });

  it("makes the transcript monospaced after ✏️ so it can be copied", () => {
    const { text, entities } = buildSettledVoiceMessage("съела борщ", "edit", hints);
    expect(text).toBe("🎙 съела борщ\n\n✏️ Пришлите исправленный вариант.");
    expect(entities).toHaveLength(1);
    const [entity] = entities;
    expect(entity.type).toBe("code");
    expect(text.slice(entity.offset, entity.offset + entity.length)).toBe("съела борщ");
  });

  it("fits Telegram's limit with a long transcript", () => {
    const transcript = parseVoiceConfirmMessage(buildVoiceConfirmMessage("а".repeat(10_000)))!;
    for (const action of ["yes", "edit", "no"] as const) {
      const { text, entities } = buildSettledVoiceMessage(transcript, action, hints);
      expect(text.length).toBeLessThanOrEqual(4096);
      for (const entity of entities) {
        expect(entity.offset + entity.length).toBeLessThanOrEqual(text.length);
      }
    }
  });
});
