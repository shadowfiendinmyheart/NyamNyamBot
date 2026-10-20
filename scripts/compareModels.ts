// Сравнение моделей RouterAI на фото еды (тикет 33): для каждой модели — настоящий
// analyzeFood бота с тем же промптом и tool-схемой, модель подменяется через
// config.anthropicModel. Ключ и endpoint — из .env.
//
//   npm run compare:models                         # все фото из data/model-comparison/photos
//   npm run compare:models -- --image a.jpg --image b.jpg   # одно блюдо, альбом из 2 фото
//   npm run compare:models -- --models anthropic/claude-haiku-5.5,openai/gpt-6-luna
//   npm run compare:models -- --repeat 3           # каждое фото по 3 раза: среднее и разброс
//
// Фото в photos/ — каждое отдельное блюдо, подпапка — альбом одного блюда. Эталон
// (необязательно) — data/model-comparison/reference.json:
//   { "poke.jpg": { "kcal": 650, "proteinG": 35, "fatG": 25, "carbG": 70, "weightG": 450 } }
// Без эталона отклонение считается от первой модели списка.
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { analyzeFood, type AnalyzeFoodResult, type FoodImage, type ImageMimeType } from "../src/ai/foodAnalyzer.js";
import { observeUsage } from "../src/claude/client.js";
import { config } from "../src/config.js";
import { sumNutrition } from "../src/db/meals.js";

const DATA_DIR = "data/model-comparison";
const PHOTOS_DIR = join(DATA_DIR, "photos");
const REFERENCE_PATH = join(DATA_DIR, "reference.json");

const DEFAULT_MODELS = [
  "anthropic/claude-sonnet-5.5", // текущая
  "anthropic/claude-haiku-5.5",
  "anthropic/claude-opus-5.5",
  "openai/gpt-6-luna",
  "openai/gpt-6.1-sol",
  "google/gemini-3.8-flash",
  "google/gemini-3.1-pro-preview",
  "qwen/qwen3.8-flash",
  "xiaomi/mimo-v2.6-flash",
  "deepseek/deepseek-v4-flash-vision-exp",
];

const MIME_BY_EXT: Record<string, ImageMimeType> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

interface Reference {
  kcal: number;
  proteinG: number;
  fatG: number;
  carbG: number;
  weightG?: number;
}

interface Meal {
  name: string;
  files: string[];
}

interface Run {
  model: string;
  seconds: number;
  inputTokens: number;
  outputTokens: number;
  costRub: number | null;
  result?: AnalyzeFoodResult;
  error?: string;
}

// Цена — ₽ за токен, как её отдаёт каталог RouterAI (/v1/models).
interface Price {
  prompt: number;
  completion: number;
  // Закэшированный вход (одинаковые промпт и tool-схема) дешевле обычного.
  cacheRead: number;
  cacheWrite: number;
}

function parseArgs(argv: string[]) {
  const images: string[] = [];
  let models: string[] | undefined;
  let repeat = 1;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--image") images.push(argv[++i]);
    else if (argv[i] === "--models") models = argv[++i].split(",").map((m) => m.trim()).filter(Boolean);
    else if (argv[i] === "--repeat") repeat = Math.max(1, Math.floor(Number(argv[++i])) || 1);
  }
  return { images, models: models ?? DEFAULT_MODELS, repeat };
}

function isImage(path: string): boolean {
  return extname(path).toLowerCase() in MIME_BY_EXT;
}

function collectMeals(images: string[]): Meal[] {
  if (images.length > 0) return [{ name: images.map((p) => basename(p)).join(" + "), files: images }];
  if (!existsSync(PHOTOS_DIR)) return [];
  return readdirSync(PHOTOS_DIR)
    .sort()
    .flatMap((entry): Meal[] => {
      const path = join(PHOTOS_DIR, entry);
      if (statSync(path).isDirectory()) {
        const files = readdirSync(path).sort().map((f) => join(path, f)).filter(isImage);
        return files.length > 0 ? [{ name: entry, files }] : [];
      }
      return isImage(path) ? [{ name: entry, files: [path] }] : [];
    });
}

function loadImage(path: string): FoodImage {
  return {
    imageBase64: readFileSync(path).toString("base64"),
    mimeType: MIME_BY_EXT[extname(path).toLowerCase()],
  };
}

function loadReferences(): Record<string, Reference> {
  return existsSync(REFERENCE_PATH)
    ? (JSON.parse(readFileSync(REFERENCE_PATH, "utf8")) as Record<string, Reference>)
    : {};
}

async function loadPrices(): Promise<Map<string, Price>> {
  const prices = new Map<string, Price>();
  if (!config.anthropicBaseUrl) return prices;
  try {
    const response = await fetch(`${config.anthropicBaseUrl.replace(/\/$/, "")}/v1/models`, {
      headers: { Authorization: `Bearer ${config.anthropicApiKey}` },
      signal: AbortSignal.timeout(30_000),
    });
    const body = (await response.json()) as {
      data?: Array<{ id: string; pricing?: Record<string, unknown> }>;
    };
    for (const model of body.data ?? []) {
      const prompt = Number(model.pricing?.prompt);
      const completion = Number(model.pricing?.completion);
      const cacheRead = Number(model.pricing?.input_cache_read ?? model.pricing?.prompt);
      const cacheWrite = Number(model.pricing?.input_cache_write ?? model.pricing?.prompt);
      if (Number.isFinite(prompt) && Number.isFinite(completion)) {
        prices.set(model.id, {
          prompt,
          completion,
          cacheRead: Number.isFinite(cacheRead) ? cacheRead : prompt,
          cacheWrite: Number.isFinite(cacheWrite) ? cacheWrite : prompt,
        });
      }
    }
  } catch (err) {
    console.warn("Не удалось загрузить цены из каталога — стоимость не посчитается:", err);
  }
  return prices;
}

async function runModel(model: string, images: FoodImage[], price: Price | undefined): Promise<Run> {
  config.anthropicModel = model;
  let inputTokens = 0;
  let outputTokens = 0;
  let costRub = 0;
  // Повтор с tool_choice auto — тоже запрос, он тоже оплачивается. Закэшированный вход
  // прокси отдаёт отдельными полями, не в input_tokens.
  observeUsage((_model, apiUsage) => {
    // Поля кэша есть в ответе, но не в типах SDK 0.32.
    const usage = apiUsage as typeof apiUsage & {
      cache_read_input_tokens?: number | null;
      cache_creation_input_tokens?: number | null;
    };
    const fresh = usage.input_tokens ?? 0;
    const cacheRead = usage.cache_read_input_tokens ?? 0;
    const cacheWrite = usage.cache_creation_input_tokens ?? 0;
    const output = usage.output_tokens ?? 0;
    inputTokens += fresh + cacheRead + cacheWrite;
    outputTokens += output;
    if (price) {
      costRub +=
        fresh * price.prompt +
        cacheRead * price.cacheRead +
        cacheWrite * price.cacheWrite +
        output * price.completion;
    }
  });

  const started = performance.now();
  const run = (extra: Partial<Run>): Run => ({
    model,
    seconds: (performance.now() - started) / 1000,
    inputTokens,
    outputTokens,
    costRub: price ? costRub : null,
    ...extra,
  });
  try {
    return run({ result: await analyzeFood({ images }) });
  } catch (err) {
    const cause = err instanceof Error && err.cause instanceof Error ? ` (${err.cause.message})` : "";
    return run({ error: `${err instanceof Error ? err.message : String(err)}${cause}`.slice(0, 300) });
  } finally {
    observeUsage(undefined);
  }
}

function totalsOf(run: Run) {
  if (!run.result?.foodDetected || run.result.items.length === 0) return null;
  const totals = sumNutrition(run.result.items);
  const weightG = run.result.items.reduce((sum, item) => sum + item.estimatedWeightG, 0);
  return { ...totals, weightG };
}

function deviation(value: number, base: number): string {
  if (base === 0) return "—";
  const percent = Math.round(((value - base) / base) * 100);
  return `${percent > 0 ? "+" : ""}${percent}%`;
}

function formatMeal(meal: Meal, runs: Run[], reference: Reference | undefined): string {
  const baseline = reference ?? (runs[0] ? totalsOf(runs[0]) : null);
  const baselineLabel = reference ? "эталона" : `${runs[0]?.model ?? "первой модели"}`;
  const lines = [
    `## ${meal.name}`,
    "",
    reference
      ? `Эталон: ${reference.kcal} ккал, Б ${reference.proteinG} / Ж ${reference.fatG} / У ${reference.carbG}` +
        (reference.weightG ? `, ${reference.weightG} г` : "")
      : `Эталона нет — отклонение от ${baselineLabel}.`,
    "",
    `| Модель | Ккал | Δ ккал | Б | Ж | У | Вес, г | Время, с | Токены вход / выход | ₽ |`,
    `|---|---|---|---|---|---|---|---|---|---|`,
  ];
  for (const run of runs) {
    const totals = totalsOf(run);
    const cost = run.costRub === null ? "—" : run.costRub.toFixed(2);
    const common = `${run.seconds.toFixed(1)} | ${run.inputTokens} / ${run.outputTokens} | ${cost}`;
    if (!totals) {
      const status = run.error ?? `еда не распознана${run.result?.notes ? `: ${run.result.notes}` : ""}`;
      lines.push(`| ${run.model} | ⚠️ ${status.replace(/\|/g, "/")} | | | | | | ${common} |`);
      continue;
    }
    const delta = baseline ? deviation(totals.kcal, baseline.kcal) : "—";
    lines.push(
      `| ${run.model} | ${totals.kcal} | ${delta} | ${totals.proteinG.toFixed(1)} | ` +
        `${totals.fatG.toFixed(1)} | ${totals.carbG.toFixed(1)} | ${Math.round(totals.weightG)} | ${common} |`,
    );
  }

  lines.push("", "<details><summary>Состав по моделям</summary>", "");
  for (const run of runs) {
    if (!run.result?.items.length) continue;
    lines.push(`**${run.model}**`);
    for (const item of run.result.items) {
      lines.push(
        `- ${item.name} — ${item.estimatedWeightG} г: ${item.kcal} ккал ` +
          `(Б ${item.proteinG} / Ж ${item.fatG} / У ${item.carbG})`,
      );
    }
    if (run.result.notes) lines.push(`- ⚠️ ${run.result.notes}`);
    lines.push("");
  }
  lines.push("</details>", "");
  return lines.join("\n");
}

function mean(values: number[]): number {
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

// Сводка по всем фото: средняя ошибка ккал и БЖУ от эталона (или первой модели),
// разброс между повторами одного фото — насколько результату модели можно верить.
function formatSummary(models: string[], results: Array<{ meal: Meal; runs: Run[] }>): string {
  const lines = [
    "## Сводка",
    "",
    "Ошибка — среднее |Δ ккал| от эталона по всем прогонам; БЖУ — среднее |ΔБ|+|ΔЖ|+|ΔУ| в граммах; " +
      "разброс — (макс − мин) / среднее ккал между повторами одного фото, среднее по фото.",
    "",
    "| Модель | Ошибка ккал | Ошибка БЖУ, г | Разброс | Время, с | ₽ за фото | Сбоев |",
    "|---|---|---|---|---|---|---|",
  ];
  const rows = models.map((model) => {
    const kcalErrors: number[] = [];
    const macroErrors: number[] = [];
    const spreads: number[] = [];
    const seconds: number[] = [];
    const costs: number[] = [];
    let failures = 0;
    for (const { meal, runs } of results) {
      const reference = references[meal.name];
      const baseline = reference ?? (runs[0] ? totalsOf(runs[0]) : null);
      const kcals: number[] = [];
      for (const run of runs.filter((r) => r.model === model)) {
        seconds.push(run.seconds);
        if (run.costRub !== null) costs.push(run.costRub);
        const totals = totalsOf(run);
        if (!totals) {
          failures += 1;
          continue;
        }
        kcals.push(totals.kcal);
        if (!baseline || baseline.kcal === 0) continue;
        kcalErrors.push(Math.abs(totals.kcal - baseline.kcal) / baseline.kcal);
        macroErrors.push(
          Math.abs(totals.proteinG - baseline.proteinG) +
            Math.abs(totals.fatG - baseline.fatG) +
            Math.abs(totals.carbG - baseline.carbG),
        );
      }
      if (kcals.length > 1) spreads.push((Math.max(...kcals) - Math.min(...kcals)) / mean(kcals));
    }
    return { model, kcalErrors, macroErrors, spreads, seconds, costs, failures };
  });
  rows.sort((a, b) => (a.kcalErrors.length ? mean(a.kcalErrors) : 9) - (b.kcalErrors.length ? mean(b.kcalErrors) : 9));
  const percent = (values: number[]) => (values.length ? `${Math.round(mean(values) * 100)}%` : "—");
  for (const row of rows) {
    lines.push(
      `| ${row.model} | ${percent(row.kcalErrors)} | ` +
        `${row.macroErrors.length ? Math.round(mean(row.macroErrors)) : "—"} | ${percent(row.spreads)} | ` +
        `${row.seconds.length ? mean(row.seconds).toFixed(1) : "—"} | ` +
        `${row.costs.length ? mean(row.costs).toFixed(2) : "—"} | ${row.failures} |`,
    );
  }
  lines.push("");
  return lines.join("\n");
}

const { images, models, repeat } = parseArgs(process.argv.slice(2));
const meals = collectMeals(images);
if (meals.length === 0) {
  console.error(`Нет фото: положите их в ${PHOTOS_DIR} или передайте --image <path>.`);
  process.exit(1);
}

const references = loadReferences();
const prices = await loadPrices();
const sections: string[] = [];
const results: Array<{ meal: Meal; runs: Run[] }> = [];

for (const meal of meals) {
  const mealImages = meal.files.map(loadImage);
  const runs: Run[] = [];
  // Повторы идут по кругу моделей, а не подряд: кэш прокси и колебания нагрузки
  // распределяются между моделями поровну.
  for (let attempt = 1; attempt <= repeat; attempt += 1) {
    for (const model of models) {
      const label = repeat > 1 ? ` #${attempt}` : "";
      process.stdout.write(`${meal.name} · ${model}${label} … `);
      const run = await runModel(model, mealImages, prices.get(model));
      const totals = totalsOf(run);
      console.log(
        totals
          ? `${totals.kcal} ккал за ${run.seconds.toFixed(1)} с`
          : `⚠️ ${run.error ?? "еда не распознана"}`,
      );
      runs.push(run);
    }
  }
  // В таблице блюда прогоны одной модели — рядом.
  runs.sort((a, b) => models.indexOf(a.model) - models.indexOf(b.model));
  results.push({ meal, runs });
  sections.push(formatMeal(meal, runs, references[meal.name]));
}

const report = [
  `# Сравнение моделей на фото еды — ${new Date().toLocaleString("ru-RU")}`,
  "",
  `Endpoint: ${config.anthropicBaseUrl ?? "Anthropic"}. Цена — по каталогу RouterAI, ` +
    "выходные токены включают рассуждения (thinking)." +
    (repeat > 1 ? ` Каждое фото — ${repeat} прогона каждой модели.` : ""),
  "",
  ...(meals.length > 1 || repeat > 1 ? [formatSummary(models, results)] : []),
  ...sections,
].join("\n");

console.log(`\n${report}`);
mkdirSync(DATA_DIR, { recursive: true });
const reportPath = join(DATA_DIR, `${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.md`);
writeFileSync(reportPath, report);
console.log(`Отчёт: ${reportPath}`);
