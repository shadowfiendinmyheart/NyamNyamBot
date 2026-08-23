import { db, sqlite } from "../src/db/client.js";
import { deleteProfile } from "../src/db/profiles.js";

const userId = Number(process.argv[2]);

if (!Number.isInteger(userId)) {
  console.error("Использование: npm run reset:profile -- <telegram_user_id>");
  process.exit(1);
}

const deleted = deleteProfile(db, userId);
console.log(
  deleted
    ? `Профиль пользователя ${userId} удалён. Отправьте боту /start, чтобы пройти анкету заново.`
    : `У пользователя ${userId} не было профиля.`,
);

sqlite.close();
