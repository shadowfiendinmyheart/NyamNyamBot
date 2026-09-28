import { describe, expect, it } from "vitest";
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
});
