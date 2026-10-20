import { describe, expect, it } from "vitest";
import { clampPhrase, trimToLastSentence } from "./text.js";

describe("utils/text trimToLastSentence", () => {
  it("не трогает законченный текст", () => {
    expect(trimToLastSentence("Всё хорошо. Так держать!")).toBe("Всё хорошо. Так держать!");
    expect(trimToLastSentence("Мур-мур 🐱")).toBe("Мур-мур 🐱");
  });

  it("отрезает оборванное последнее предложение", () => {
    expect(trimToLastSentence("Белка хватает. Углеводов многова")).toBe("Белка хватает.");
  });

  it("режет по концу строки, если последняя строка — оборванный пункт списка", () => {
    const text = "Совет на завтра:\n• больше овощей\n• добавить тво";
    expect(trimToLastSentence(text)).toBe("Совет на завтра:\n• больше овощей");
  });

  it("укладывается в maxLength", () => {
    const text = "Первое предложение. Второе предложение. Третье предложение.";
    expect(trimToLastSentence(text, 45)).toBe("Первое предложение. Второе предложение.");
  });

  it("без подходящей границы режет по слову с многоточием", () => {
    expect(trimToLastSentence("Одно очень длинное предложение без конца", 30)).toBe(
      "Одно очень длинное…",
    );
  });

  it("пустой текст остаётся пустым, а не превращается в «…»", () => {
    expect(trimToLastSentence("")).toBe("");
    expect(trimToLastSentence("   ")).toBe("");
  });
});

describe("clampPhrase", () => {
  it("убирает эмодзи модели в начале — его ставит бот", () => {
    expect(clampPhrase("🎯 💪 Много белка — хорошо для мышц", 100)).toBe(
      "Много белка — хорошо для мышц",
    );
  });

  it("короткую фразу без точки не дорезает, длинную — по предложению; не строка — пусто", () => {
    expect(clampPhrase("Сытно и без лишнего жира", 100)).toBe("Сытно и без лишнего жира");
    expect(clampPhrase("Первое предложение тут. Второе длинное предложение", 30)).toBe(
      "Первое предложение тут.",
    );
    expect(clampPhrase(42, 100)).toBe("");
  });
});
