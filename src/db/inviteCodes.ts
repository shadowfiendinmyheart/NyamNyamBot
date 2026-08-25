import { and, eq, isNull, sql } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema.js";
import { createUser } from "./users.js";

type Db = BetterSQLite3Database<typeof schema>;

// Инвайт-коды заданы в .env, но факт использования (кем и когда) живёт в БД —
// поэтому при старте недостающие коды из конфига досеиваются сюда, не трогая
// уже занятые. Коды, пропавшие из конфига, но ещё не использованные, удаляются —
// это единственный способ отозвать код, так как редемпшн больше не сверяется с .env.
export function syncInviteCodes(db: Db, codes: string[]) {
  const normalized = new Set(codes.map((code) => code.trim().toLowerCase()));

  for (const code of codes) {
    db.insert(schema.inviteCodes).values({ code }).onConflictDoNothing().run();
  }

  const staleCodes = db
    .select()
    .from(schema.inviteCodes)
    .where(isNull(schema.inviteCodes.usedByUserId))
    .all()
    .filter((row) => !normalized.has(row.code.trim().toLowerCase()));

  for (const row of staleCodes) {
    db.delete(schema.inviteCodes).where(eq(schema.inviteCodes.code, row.code)).run();
  }
}

function findAvailableInviteCode(db: Db, code: string) {
  const normalized = code.trim().toLowerCase();
  return db
    .select()
    .from(schema.inviteCodes)
    .where(
      and(
        isNull(schema.inviteCodes.usedByUserId),
        eq(sql`lower(${schema.inviteCodes.code})`, normalized),
      ),
    )
    .get();
}

// Помеченное "уже занято" (не бросающее исключение) поражение гонки внутри
// транзакции: better-sqlite3 коммитит транзакцию, если колбэк просто вернул
// значение, а не бросил — поэтому единственный способ откатить createUser,
// если код в итоге не удалось захватить, это выбросить исключение и поймать
// его снаружи.
class InviteCodeRaceError extends Error {}

// Атомарно создаёт пользователя и помечает код использованным в одной
// транзакции: WHERE usedByUserId IS NULL защищает от гонки, если два человека
// одновременно прислали один и тот же ещё свободный код. createUser выполняется
// до UPDATE (FK usedByUserId -> users.id требует, чтобы пользователь уже
// существовал), поэтому при проигрыше гонки транзакция откатывается через throw,
// а не тихо коммитит уже созданного пользователя без использованного кода.
export function redeemInviteCode(
  db: Db,
  code: string,
  telegramId: number,
  username: string | undefined,
): boolean {
  try {
    return db.transaction((tx) => {
      const row = findAvailableInviteCode(tx, code);
      if (!row) return false;

      createUser(tx, telegramId, username);

      const result = tx
        .update(schema.inviteCodes)
        .set({ usedByUserId: telegramId, usedAt: new Date() })
        .where(
          and(eq(schema.inviteCodes.code, row.code), isNull(schema.inviteCodes.usedByUserId)),
        )
        .run();

      if (result.changes === 0) {
        throw new InviteCodeRaceError();
      }

      return true;
    });
  } catch (err) {
    if (err instanceof InviteCodeRaceError) return false;
    throw err;
  }
}
