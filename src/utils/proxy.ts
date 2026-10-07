import { HttpsProxyAgent } from "https-proxy-agent";
import { ProxyAgent } from "undici";
import { config } from "../config.js";

// Прокси для всех внешних запросов бота (Telegram, ИИ, распознавание голоса) — нужен,
// когда сервисы напрямую недоступны, а VPN на хосте не перехватывает трафик Docker/WSL.
// Клиенты ходят в сеть по-разному, поэтому агентов два: node-fetch (grammY, Anthropic
// SDK) принимает http.Agent, а встроенный fetch (скачивание файлов, OpenAI SDK) —
// undici-dispatcher.
const proxyUrl = config.proxyUrl;

export const proxyHttpAgent = proxyUrl
  ? new HttpsProxyAgent(proxyUrl, { keepAlive: true })
  : undefined;

export const proxyDispatcher = proxyUrl ? new ProxyAgent(proxyUrl) : undefined;
