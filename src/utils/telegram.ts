import type { ApiClientOptions } from "grammy";
import { HttpsProxyAgent } from "https-proxy-agent";
import { ProxyAgent } from "undici";
import { config } from "../config.js";

// Прокси нужен, когда api.telegram.org напрямую недоступен, а VPN на хосте не
// перехватывает трафик Docker/WSL. Агентов два: grammY ходит в сеть через node-fetch
// (ему нужен http.Agent), а скачивание файлов — через встроенный fetch (undici-dispatcher).
const proxyUrl = config.telegramProxyUrl;
const downloadDispatcher = proxyUrl ? new ProxyAgent(proxyUrl) : undefined;

export const telegramClientOptions: ApiClientOptions | undefined = proxyUrl
  ? { baseFetchConfig: { agent: new HttpsProxyAgent(proxyUrl), compress: true } }
  : undefined;

export async function downloadTelegramFile(filePath: string): Promise<Buffer> {
  const fileUrl = `https://api.telegram.org/file/bot${config.botToken}/${filePath}`;
  // Без таймаута зависшее соединение держало бы обработку сообщения бесконечно.
  const response = await fetch(fileUrl, {
    signal: AbortSignal.timeout(30_000),
    // dispatcher — расширение undici, в типах RequestInit его нет.
    ...(downloadDispatcher ? { dispatcher: downloadDispatcher } : {}),
  } as RequestInit);
  if (!response.ok) {
    throw new Error(`Не удалось скачать файл из Telegram: ${response.status}`);
  }
  return Buffer.from(await response.arrayBuffer());
}
