import { describe, expect, it } from "vitest";
import { DiaryOfferStore } from "./diaryOffers.js";

describe("features/coach DiaryOfferStore", () => {
  it("отдаёт предложение один раз и только его автору", () => {
    const offers = new DiaryOfferStore();
    const id = offers.add(1, "съел яблоко", "text");

    expect(offers.take(id, 2)).toBeUndefined();
    expect(offers.take(id, 1)).toEqual({ userId: 1, text: "съел яблоко", source: "text" });
    expect(offers.take(id, 1)).toBeUndefined();
  });

  it("хранит не больше maxSize последних предложений", () => {
    const offers = new DiaryOfferStore(2);
    const first = offers.add(1, "a", "text");
    const second = offers.add(1, "b", "voice");
    const third = offers.add(1, "c", "text");

    expect(offers.size).toBe(2);
    expect(offers.take(first, 1)).toBeUndefined();
    expect(offers.take(second, 1)?.text).toBe("b");
    expect(offers.take(third, 1)?.text).toBe("c");
  });
});
