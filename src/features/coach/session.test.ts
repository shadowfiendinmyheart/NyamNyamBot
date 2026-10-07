import { describe, expect, it, vi } from "vitest";
import { CoachSessionStore } from "./session.js";

const MINUTE = 60 * 1000;

function makeStore(maxMessages = 4) {
  let now = 0;
  const store = new CoachSessionStore({ idleTimeoutMs: 60 * MINUTE, maxMessages, now: () => now });
  return { store, advance: (ms: number) => (now += ms) };
}

describe("features/coach CoachSessionStore", () => {
  it("без старта сессии её нет", () => {
    const { store } = makeStore();
    expect(store.get(1)).toBeUndefined();
  });

  it("isActive не закрывает истёкшую сессию и не зовёт onExpire", () => {
    const { store, advance } = makeStore();
    const onExpire = vi.fn();
    store.onExpire(onExpire);
    store.start(1);
    expect(store.isActive(1)).toBe(true);

    advance(61 * MINUTE);
    expect(store.isActive(1)).toBe(false);
    expect(onExpire).not.toHaveBeenCalled();
    expect(store.has(1)).toBe(true);
  });

  it("хранит историю парами и контекст", () => {
    const { store } = makeStore();
    store.start(1, "🌙 Итоги дня ...");
    store.append(1, "Как я поел?", "Хорошо!");

    expect(store.get(1)).toMatchObject({
      context: "🌙 Итоги дня ...",
      history: [
        { role: "user", text: "Как я поел?" },
        { role: "assistant", text: "Хорошо!" },
      ],
    });
  });

  it("обрезает историю до последних maxMessages, начиная с вопроса", () => {
    const { store } = makeStore(4);
    store.start(1);
    for (let i = 1; i <= 3; i++) store.append(1, `вопрос ${i}`, `ответ ${i}`);

    expect(store.get(1)!.history.map((m) => m.text)).toEqual([
      "вопрос 2",
      "ответ 2",
      "вопрос 3",
      "ответ 3",
    ]);
  });

  it("нечётный maxMessages округляется вниз, чтобы история начиналась с вопроса", () => {
    const { store } = makeStore(3);
    store.start(1);
    for (let i = 1; i <= 3; i++) store.append(1, `вопрос ${i}`, `ответ ${i}`);
    expect(store.get(1)!.history[0].role).toBe("user");
  });

  it("сессия истекает после часа бездействия, активность продлевает её", () => {
    const { store, advance } = makeStore();
    store.start(1);
    advance(50 * MINUTE);
    store.append(1, "вопрос", "ответ");
    advance(50 * MINUTE);
    expect(store.get(1)).toBeDefined();

    advance(11 * MINUTE);
    expect(store.get(1)).toBeUndefined();
    expect(store.size).toBe(0);
  });

  it("sweep удаляет только просроченные сессии", () => {
    const { store, advance } = makeStore();
    store.start(1);
    advance(61 * MINUTE);
    store.start(2);

    expect(store.sweep()).toBe(1);
    expect(store.size).toBe(1);
    expect(store.get(2)).toBeDefined();
  });

  it("end завершает сессию", () => {
    const { store } = makeStore();
    store.start(1);
    expect(store.end(1)).toBe(true);
    expect(store.end(1)).toBe(false);
    expect(store.get(1)).toBeUndefined();
  });

  it("сообщает о закрытии по таймауту — из sweep и из get, но не из end", () => {
    const { store, advance } = makeStore();
    const expired: number[] = [];
    store.onExpire((userId) => expired.push(userId));

    store.start(1);
    store.start(2);
    store.start(3);
    expect(store.end(3)).toBe(true);
    advance(61 * MINUTE);

    expect(store.get(1)).toBeUndefined();
    expect(store.sweep()).toBe(1);
    expect(store.sweep()).toBe(0);
    expect(expired).toEqual([1, 2]);
  });

  it("touch продлевает сессию, has видит истёкшую до её удаления", () => {
    const { store, advance } = makeStore();
    store.start(1);
    advance(59 * MINUTE);
    store.touch(1);
    advance(59 * MINUTE);
    expect(store.get(1)).toBeDefined();

    advance(61 * MINUTE);
    expect(store.has(1)).toBe(true);
    expect(store.get(1)).toBeUndefined();
    expect(store.has(1)).toBe(false);
  });

  it("ошибка слушателя не ломает удаление сессии", () => {
    const { store, advance } = makeStore();
    vi.spyOn(console, "error").mockImplementation(() => {});
    store.onExpire(() => {
      throw new Error("boom");
    });
    store.start(1);
    advance(61 * MINUTE);

    expect(store.get(1)).toBeUndefined();
    expect(store.size).toBe(0);
  });
});
