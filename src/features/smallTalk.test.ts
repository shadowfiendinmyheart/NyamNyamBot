import { describe, expect, it } from "vitest";
import { detectSmallTalk, smallTalkReply } from "./smallTalk.js";

describe("features/smallTalk detectSmallTalk", () => {
  it("узнаёт приветствия, благодарности, согласие и прощания", () => {
    expect(detectSmallTalk("Привет!")).toBe("greeting");
    expect(detectSmallTalk("добрый вечер, Ням-Ням")).toBe("greeting");
    expect(detectSmallTalk("Спасибо большое!")).toBe("thanks");
    expect(detectSmallTalk("спс")).toBe("thanks");
    expect(detectSmallTalk("ок")).toBe("ack");
    expect(detectSmallTalk("Понятно)")).toBe("ack");
    expect(detectSmallTalk("спокойной ночи")).toBe("bye");
  });

  it("составная реплика — благодарность важнее «ок»", () => {
    expect(detectSmallTalk("ок, спасибо")).toBe("thanks");
    expect(detectSmallTalk("привет привет")).toBe("greeting");
  });

  it("реакции эмодзи — согласие, а эмодзи еды — нет", () => {
    expect(detectSmallTalk("👍")).toBe("ack");
    expect(detectSmallTalk("❤️❤️")).toBe("ack");
    expect(detectSmallTalk("👍🏻")).toBe("ack");
    expect(detectSmallTalk(")))")).toBe("ack");
    expect(detectSmallTalk("🍎")).toBeUndefined();
    expect(detectSmallTalk("   ")).toBeUndefined();
  });

  it("не трогает сообщения с едой, тренировками и вопросы", () => {
    expect(detectSmallTalk("спасибо, съел яблоко")).toBeUndefined();
    expect(detectSmallTalk("привет, на обед был борщ")).toBeUndefined();
    expect(detectSmallTalk("бегал 40 минут")).toBeUndefined();
    expect(detectSmallTalk("ням")).toBeUndefined();
    expect(detectSmallTalk("Мерси")).toBeUndefined();
    expect(detectSmallTalk("хорошо хорошо хорошо хорошо хорошо хорошо")).toBeUndefined();
  });
});

describe("features/smallTalk smallTalkReply", () => {
  it("короткий ответ на реплику и undefined на остальное", () => {
    expect(smallTalkReply("привет")).toContain("привет");
    expect(smallTalkReply("спасибо")).toContain("пожалуйста");
    expect(smallTalkReply("2 яйца")).toBeUndefined();
  });
});
