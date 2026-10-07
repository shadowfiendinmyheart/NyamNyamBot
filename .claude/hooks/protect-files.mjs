// PreToolUse (Edit|Write|MultiEdit|NotebookEdit): запрещает Claude править файлы,
// которые нельзя менять руками. Exit 2 + stderr — блокировка с объяснением для Claude.
import { readFileSync } from "node:fs";
import path from "node:path";

const input = JSON.parse(readFileSync(0, "utf8"));
const filePath = input.tool_input?.file_path ?? input.tool_input?.notebook_path;
if (!filePath) process.exit(0);

const projectDir = process.env.CLAUDE_PROJECT_DIR ?? input.cwd ?? process.cwd();
const rel = path.relative(projectDir, path.resolve(projectDir, filePath)).split(path.sep).join("/");
const base = path.basename(rel);

const rules = [
  {
    test: () => base === ".env" || (base.startsWith(".env.") && base !== ".env.example"),
    reason: "это файл с секретами (BOT_TOKEN, API-ключи). Попроси пользователя изменить его самому.",
  },
  {
    test: () => rel.startsWith("drizzle/"),
    reason: "миграции и снапшоты генерирует drizzle-kit. Измени src/db/schema.ts и запусти `npm run db:generate`.",
  },
  {
    test: () => base === "package-lock.json",
    reason: "lock-файл обновляется только через npm install / npm uninstall.",
  },
];

const hit = rules.find((r) => r.test());
if (hit) {
  process.stderr.write(`Правка ${rel} заблокирована хуком: ${hit.reason}\n`);
  process.exit(2);
}
