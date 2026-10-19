import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearProductCache, lookupProduct, pickProduct, type OffHit } from "./lookup.js";

// Как отвечает search.openfoodfacts.org (поля сокращены).
const greekYogurt: OffHit = {
  code: "4600605033951",
  brands: ["Простоквашино"],
  product_name: "Простоквашино ГРЕЧЕСКИЙ ГУСТОЙ ЙОГУРТ",
  nutriments: {
    "energy-kcal_100g": 63,
    proteins_100g: 8.7,
    fat_100g: 2,
    carbohydrates_100g: 2.5,
  },
};
const otherBrandYogurt: OffHit = {
  brands: ["Сернур"],
  product_name: "Йогурт греческий",
  nutriments: { "energy-kcal_100g": 70.6, proteins_100g: 5.8, fat_100g: 3, carbohydrates_100g: 5.1 },
};
const yogurtPer100g = { kcal: 63, proteinG: 8.7, fatG: 2, carbG: 2.5 };

describe("openfoodfacts pickProduct", () => {
  it("находит продукт того же бренда с теми же словами в названии", () => {
    expect(
      pickProduct([otherBrandYogurt, greekYogurt], "Простоквашино йогурт греческий", "Простоквашино"),
    ).toEqual({
      name: "Простоквашино ГРЕЧЕСКИЙ ГУСТОЙ ЙОГУРТ",
      brand: "Простоквашино",
      per100g: yogurtPer100g,
      source: "openfoodfacts",
    });
  });

  it("бренд сравнивается без регистра, кавычек и «ъ» на конце", () => {
    const topping: OffHit = {
      brands: "МАХЕЕВ, Эссен Продакшн",
      product_name: "Топпинг «Мягкая карамель»",
      nutriments: { "energy-kcal_100g": 290, proteins_100g: 0.5, fat_100g: 0, carbohydrates_100g: 72 },
    };
    expect(pickProduct([topping], "Махеевъ топпинг мягкая карамель", "«Махеевъ»")).toMatchObject({
      brand: "МАХЕЕВ",
      per100g: { kcal: 290 },
    });
  });

  it("чужой бренд не подставляет", () => {
    expect(pickProduct([otherBrandYogurt], "Простоквашино йогурт греческий", "Простоквашино")).toBeNull();
  });

  it("тот же бренд, но другой продукт — не подходит", () => {
    const drinkingYogurt: OffHit = {
      ...greekYogurt,
      product_name: "Йогурт питьевой клубника",
    };
    expect(pickProduct([drinkingYogurt], "Простоквашино йогурт греческий", "Простоквашино")).toBeNull();
  });

  it("другая жирность — другой продукт", () => {
    const curd = (fat: string): OffHit => ({
      brands: ["Светаево"],
      product_name: `Творог ${fat}`,
      nutriments: { "energy-kcal_100g": 121, proteins_100g: 17, fat_100g: 5, carbohydrates_100g: 1.8 },
    });
    expect(pickProduct([curd("9%")], "Светаево творог 5%", "Светаево")).toBeNull();
    expect(pickProduct([curd("5%")], "Светаево творог 5%", "Светаево")).not.toBeNull();
    expect(pickProduct([curd("9%")], "Светаево творог", "Светаево")).not.toBeNull();
  });

  it("неполные или неправдоподобные КБЖУ не берёт", () => {
    const noFat: OffHit = { ...greekYogurt, nutriments: { "energy-kcal_100g": 63, proteins_100g: 8.7 } };
    const wrongKcal: OffHit = {
      ...greekYogurt,
      nutriments: { ...greekYogurt.nutriments, "energy-kcal_100g": 263 },
    };
    expect(pickProduct([noFat, wrongKcal], "Простоквашино йогурт греческий", "Простоквашино")).toBeNull();
  });

  it("запрос из одного бренда — не поиск продукта", () => {
    expect(pickProduct([greekYogurt], "Простоквашино", "Простоквашино")).toBeNull();
  });
});

describe("openfoodfacts lookupProduct", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    clearProductCache();
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const okResponse = (hits: OffHit[]) =>
    ({ ok: true, status: 200, json: async () => ({ hits }) }) as Response;

  it("ищет по запросу и кэширует результат", async () => {
    fetchMock.mockResolvedValue(okResponse([greekYogurt]));

    const first = await lookupProduct("Простоквашино йогурт греческий", "Простоквашино");
    const second = await lookupProduct("простоквашино  йогурт греческий", "Простоквашино");

    expect(first?.per100g).toEqual(yogurtPer100g);
    expect(second).toEqual(first);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(url.toString()).toContain("search.openfoodfacts.org/search");
    expect(url.searchParams.get("q")).toBe("Простоквашино йогурт греческий");
    expect((init.headers as Record<string, string>)["User-Agent"]).toMatch(/NyamNyamBot/);
  });

  it("сбой или таймаут базы — null, и он не кэшируется", async () => {
    fetchMock.mockRejectedValueOnce(new DOMException("timeout", "TimeoutError"));
    fetchMock.mockResolvedValueOnce({ ok: false, status: 503 } as Response);
    fetchMock.mockResolvedValueOnce(okResponse([greekYogurt]));

    expect(await lookupProduct("Простоквашино йогурт греческий", "Простоквашино")).toBeNull();
    expect(await lookupProduct("Простоквашино йогурт греческий", "Простоквашино")).toBeNull();
    expect(await lookupProduct("Простоквашино йогурт греческий", "Простоквашино")).not.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
