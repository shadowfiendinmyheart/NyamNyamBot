import { describe, expect, it } from "vitest";
import { DiaryOfferStore, type DiaryOffer } from "./diaryOffers.js";

const sentAt = new Date("2026-10-08T20:50:00Z");

function offer(text: string, userId = 1): DiaryOffer {
  return { userId, text, source: "text", sentAt };
}

describe("features/coach DiaryOfferStore", () => {
  it("отдаёт предложение один раз и только его автору", () => {
    const offers = new DiaryOfferStore();
    const id = offers.add(offer("съел яблоко"));

    expect(offers.take(id, 2)).toBeUndefined();
    expect(offers.take(id, 1)).toEqual(offer("съел яблоко"));
    expect(offers.take(id, 1)).toBeUndefined();
  });

  it("хранит не больше maxSize последних предложений", () => {
    const offers = new DiaryOfferStore(2);
    const first = offers.add(offer("a"));
    const second = offers.add(offer("b"));
    const third = offers.add(offer("c"));

    expect(offers.size).toBe(2);
    expect(offers.take(first, 1)).toBeUndefined();
    expect(offers.take(second, 1)?.text).toBe("b");
    expect(offers.take(third, 1)?.text).toBe("c");
  });

  it("номера после рестарта не совпадают с прежними", () => {
    const before = new DiaryOfferStore(500, 1_000).add(offer("торт"));
    const after = new DiaryOfferStore(500, 2_000).add(offer("бег"));
    expect(after).not.toBe(before);
    expect(new DiaryOfferStore().add(offer("x"))).toBeGreaterThan(1_000_000);
  });
});
