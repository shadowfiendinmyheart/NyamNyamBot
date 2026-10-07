import type { ApiClientOptions } from "grammy";
import { config } from "../config.js";
import { proxyDispatcher, proxyHttpAgent } from "./proxy.js";

export const telegramClientOptions: ApiClientOptions | undefined = proxyHttpAgent
  ? { baseFetchConfig: { agent: proxyHttpAgent, compress: true } }
  : undefined;

export async function downloadTelegramFile(filePath: string): Promise<Buffer> {
  const fileUrl = `https://api.telegram.org/file/bot${config.botToken}/${filePath}`;
  // Без таймаута зависшее соединение держало бы обработку сообщения бесконечно.
  const response = await fetch(fileUrl, {
    signal: AbortSignal.timeout(30_000),
    // dispatcher — расширение undici, в типах RequestInit его нет.
    ...(proxyDispatcher ? { dispatcher: proxyDispatcher } : {}),
  } as RequestInit);
  if (!response.ok) {
    throw new Error(`Не удалось скачать файл из Telegram: ${response.status}`);
  }
  return Buffer.from(await response.arrayBuffer());
}
