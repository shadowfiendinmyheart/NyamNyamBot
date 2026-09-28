import type { CoachMessage } from "../../ai/coach.js";

export interface CoachSession {
  history: CoachMessage[];
  context?: string;
  lastActivityAt: number;
}

export interface CoachSessionStoreOptions {
  idleTimeoutMs?: number;
  maxMessages?: number;
  now?: () => number;
}

// Разговоры с Ням-Ням живут только в памяти процесса: после «Завершить», часа
// бездействия или рестарта бота всё забывается. Память ограничена: в истории не больше
// maxMessages реплик, а брошенные сессии удаляет sweep() (см. startSweeper), так что
// объём зависит только от числа недавно активных пользователей, а не от времени работы.
export class CoachSessionStore {
  private readonly sessions = new Map<number, CoachSession>();
  private readonly idleTimeoutMs: number;
  private readonly maxMessages: number;
  private readonly now: () => number;

  constructor(options: CoachSessionStoreOptions = {}) {
    this.idleTimeoutMs = options.idleTimeoutMs ?? 60 * 60 * 1000;
    // Чётное число: история режется парами «вопрос–ответ» и всегда начинается с вопроса.
    const maxMessages = options.maxMessages ?? 20;
    this.maxMessages = Math.max(2, maxMessages - (maxMessages % 2));
    this.now = options.now ?? Date.now;
  }

  start(userId: number, context?: string): CoachSession {
    const session: CoachSession = { history: [], context, lastActivityAt: this.now() };
    this.sessions.set(userId, session);
    return session;
  }

  get(userId: number): CoachSession | undefined {
    const session = this.sessions.get(userId);
    if (session && this.isExpired(session)) {
      this.sessions.delete(userId);
      return undefined;
    }
    return session;
  }

  append(userId: number, question: string, answer: string): void {
    const session = this.get(userId);
    if (!session) return;
    session.history.push({ role: "user", text: question }, { role: "assistant", text: answer });
    if (session.history.length > this.maxMessages) {
      session.history.splice(0, session.history.length - this.maxMessages);
    }
    session.lastActivityAt = this.now();
  }

  end(userId: number): boolean {
    return this.sessions.delete(userId);
  }

  sweep(): number {
    let removed = 0;
    for (const [userId, session] of this.sessions) {
      if (this.isExpired(session)) {
        this.sessions.delete(userId);
        removed++;
      }
    }
    return removed;
  }

  startSweeper(intervalMs = 10 * 60 * 1000): NodeJS.Timeout {
    const timer = setInterval(() => this.sweep(), intervalMs);
    // Таймер не должен держать процесс живым (например, в тестах или при остановке).
    timer.unref();
    return timer;
  }

  get size(): number {
    return this.sessions.size;
  }

  private isExpired(session: CoachSession): boolean {
    return this.now() - session.lastActivityAt > this.idleTimeoutMs;
  }
}
