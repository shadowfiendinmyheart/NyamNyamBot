// Stop: если в рабочей копии изменены .ts-файлы — прогоняет tsc --noEmit.
// При ошибках возвращает exit 2: Claude получает вывод tsc и продолжает работу, чтобы их исправить.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

const input = JSON.parse(readFileSync(0, "utf8") || "{}");
// Повторный Stop после того, как хук уже вернул ошибку, — не зацикливаемся.
if (input.stop_hook_active) process.exit(0);

const projectDir = process.env.CLAUDE_PROJECT_DIR ?? input.cwd ?? process.cwd();

let status = "";
try {
  status = execFileSync("git", ["status", "--porcelain"], { cwd: projectDir, encoding: "utf8" });
} catch {
  process.exit(0);
}
const tsChanged = status.split("\n").some((line) => /\.(ts|mts|cts)"?$/.test(line.trim()));
if (!tsChanged) process.exit(0);

const tsc = path.join(projectDir, "node_modules", "typescript", "bin", "tsc");
try {
  execFileSync(process.execPath, [tsc, "--noEmit", "-p", "tsconfig.json"], {
    cwd: projectDir,
    encoding: "utf8",
    stdio: "pipe",
  });
} catch (err) {
  const out = `${err.stdout ?? ""}${err.stderr ?? ""}`.trim() || String(err);
  process.stderr.write(`tsc --noEmit нашёл ошибки типов — исправь их:\n${out.slice(0, 6000)}\n`);
  process.exit(2);
}
