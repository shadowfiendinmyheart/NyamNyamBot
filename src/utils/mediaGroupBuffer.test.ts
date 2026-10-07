import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MediaGroupBuffer } from "./mediaGroupBuffer.js";

describe("utils/MediaGroupBuffer", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("отдаёт части одного альбома одной пачкой после паузы", async () => {
    const onFlush = vi.fn(async () => {});
    const buffer = new MediaGroupBuffer<string>(1000, onFlush);

    buffer.add("chat:album", "суп");
    await vi.advanceTimersByTimeAsync(800);
    buffer.add("chat:album", "второе");
    await vi.advanceTimersByTimeAsync(800);
    expect(onFlush).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(200);
    expect(onFlush).toHaveBeenCalledTimes(1);
    expect(onFlush).toHaveBeenCalledWith(["суп", "второе"]);
  });

  it("разные альбомы — разные пачки; после отправки альбом начинается заново", async () => {
    const onFlush = vi.fn(async () => {});
    const buffer = new MediaGroupBuffer<string>(1000, onFlush);

    buffer.add("a", "1");
    buffer.add("b", "2");
    await vi.advanceTimersByTimeAsync(1000);
    expect(onFlush.mock.calls).toEqual([[["1"]], [["2"]]]);

    buffer.add("a", "3");
    await vi.advanceTimersByTimeAsync(1000);
    expect(onFlush).toHaveBeenLastCalledWith(["3"]);
  });

  it("ошибка обработки не роняет таймер", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const buffer = new MediaGroupBuffer<string>(10, async () => {
      throw new Error("boom");
    });

    buffer.add("a", "1");
    await vi.advanceTimersByTimeAsync(10);
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});
