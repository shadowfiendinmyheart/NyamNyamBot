import type { ProductLookup, ProductNutrition } from "../ai/productLookup.js";
import { config } from "../config.js";
import { kcalMatchesMacros, type Nutrition } from "../nutrition/calculations.js";
import { proxyDispatcher } from "../utils/proxy.js";

// Open Food Facts — открытая база упакованных товаров, российские тоже есть (но не все).
// Поиск — search.openfoodfacts.org: без ключа, OFF просит только свой User-Agent.
const SEARCH_URL = "https://search.openfoodfacts.org/search";
const USER_AGENT = "NyamNyamBot/1.0 (Telegram calorie bot)";
const PAGE_SIZE = 10;
// Запись еды ждёт поиск — дольше ждать не стоит, без базы останется оценка ИИ.
const TIMEOUT_MS = 3_000;
// Продукты в базе меняются редко, а одно и то же пользователи едят часто.
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const CACHE_MAX_SIZE = 500;

export interface OffHit {
  code?: string;
  product_name?: string;
  brands?: string[] | string;
  nutriments?: Record<string, unknown>;
}

const cache = new Map<string, { value: ProductNutrition | null; expiresAt: number }>();

export function clearProductCache(): void {
  cache.clear();
}

export const lookupProduct: ProductLookup = async (query, brand) => {
  if (!config.offLookupEnabled) return null;
  const key = `${normalize(brand)}|${normalize(query)}`;
  const cached = cache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  let value: ProductNutrition | null;
  try {
    value = pickProduct(await search(query), query, brand);
  } catch (err) {
    // Сбой базы не кэшируем: в следующий раз она может ответить.
    console.warn(`openfoodfacts: поиск «${query}» не удался:`, err);
    return null;
  }

  if (cache.size >= CACHE_MAX_SIZE) cache.clear();
  cache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
  console.log(
    `openfoodfacts: «${query}» → ${value ? `«${value.brand} ${value.name}»` : "нет совпадения"}`,
  );
  return value;
};

async function search(query: string): Promise<OffHit[]> {
  const url = new URL(SEARCH_URL);
  url.searchParams.set("q", query);
  url.searchParams.set("page_size", String(PAGE_SIZE));
  url.searchParams.set("fields", "code,product_name,brands,nutriments");
  const response = await fetch(url, {
    headers: { "User-Agent": USER_AGENT },
    signal: AbortSignal.timeout(TIMEOUT_MS),
    // dispatcher — расширение undici, в типах RequestInit его нет.
    ...(proxyDispatcher ? { dispatcher: proxyDispatcher } : {}),
  } as RequestInit);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const body = (await response.json()) as { hits?: unknown };
  return Array.isArray(body.hits) ? (body.hits as OffHit[]) : [];
}

// Первый по релевантности товар, который точно тот же продукт: тот же бренд, те же
// слова в названии, та же жирность, полные и правдоподобные КБЖУ на 100 г. Лучше
// оставить оценку ИИ, чем подставить чужой продукт.
export function pickProduct(hits: OffHit[], query: string, brand: string): ProductNutrition | null {
  const brandWords = words(brand);
  if (brandWords.length === 0) return null;
  const queryStems = words(query)
    .filter((word) => !brandWords.includes(word))
    .map(stem);
  if (queryStems.length === 0) return null;
  const needed = Math.ceil((queryStems.length * 2) / 3);
  const queryPercents = percents(query);

  for (const hit of hits) {
    const name = hit.product_name?.trim();
    const hitBrands = (Array.isArray(hit.brands) ? hit.brands : (hit.brands ?? "").split(","))
      .map((value) => value.trim())
      .filter(Boolean);
    if (!name) continue;
    const hitBrand = hitBrands.find((value) => sameBrand(words(value), brandWords));
    if (!hitBrand) continue;

    const nameStems = new Set(words(name).map(stem));
    const matched = queryStems.filter((value) => nameStems.has(value)).length;
    if (matched < needed) continue;

    // «творог 5%» и «творог 9%» — разные продукты.
    const hitPercents = percents(name);
    if (
      queryPercents.length > 0 &&
      hitPercents.length > 0 &&
      !queryPercents.some((value) => hitPercents.includes(value))
    ) {
      continue;
    }

    const per100g = parseNutriments(hit.nutriments);
    if (!per100g || !kcalMatchesMacros(per100g)) continue;

    return { name, brand: hitBrand, per100g, source: "openfoodfacts" };
  }
  return null;
}

function parseNutriments(nutriments: Record<string, unknown> | undefined): Nutrition | null {
  if (!nutriments) return null;
  const values = {
    kcal: nutriments["energy-kcal_100g"],
    proteinG: nutriments.proteins_100g,
    fatG: nutriments.fat_100g,
    carbG: nutriments.carbohydrates_100g,
  };
  const valid = Object.values(values).every(
    (value) => typeof value === "number" && Number.isFinite(value) && value >= 0,
  );
  if (!valid || (values.kcal as number) === 0) return null;
  return values as Nutrition;
}

// Бренд «Махеевъ» = «Махеев», «Простоквашино» = «Простоквашино Danone».
function sameBrand(hitWords: string[], brandWords: string[]): boolean {
  if (hitWords.length === 0) return false;
  const [shorter, longer] =
    hitWords.length <= brandWords.length ? [hitWords, brandWords] : [brandWords, hitWords];
  return shorter.every((word) => longer.includes(word));
}

function normalize(value: string): string {
  return value
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/[«»"'“”„`]/g, "")
    .replace(/[^\p{L}\p{N}%.,]+/gu, " ")
    .trim();
}

// Значимые слова: без чисел и коротких предлогов, «ъ» на конце снят.
function words(value: string): string[] {
  return normalize(value)
    .split(" ")
    .map((word) => word.replace(/[.,]+$/, "").replace(/ъ$/, ""))
    .filter((word) => word.length >= 3 && !/\d/.test(word));
}

// Грубая основа слова для русских окончаний: «греческий» и «греческого», «творог» и
// «творожный».
function stem(word: string): string {
  return word.slice(0, 5);
}

function percents(value: string): string[] {
  return [...value.matchAll(/(\d+(?:[.,]\d+)?)\s*%/g)].map((match) =>
    String(Number(match[1].replace(",", "."))),
  );
}
