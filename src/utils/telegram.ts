import { config } from "../config.js";

export async function downloadTelegramFile(filePath: string): Promise<Buffer> {
  const fileUrl = `https://api.telegram.org/file/bot${config.botToken}/${filePath}`;
  const response = await fetch(fileUrl);
  if (!response.ok) {
    throw new Error(`Не удалось скачать файл из Telegram: ${response.status}`);
  }
  return Buffer.from(await response.arrayBuffer());
}
