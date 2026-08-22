import { readFileSync } from "node:fs";
import { extname } from "node:path";
import { analyzeFood, type ImageMimeType } from "../src/ai/foodAnalyzer.js";

const MIME_BY_EXT: Record<string, ImageMimeType> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

function parseArgs(argv: string[]) {
  const result: { image?: string; text?: string } = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--image") result.image = argv[++i];
    if (argv[i] === "--text") result.text = argv[++i];
  }
  return result;
}

const { image, text } = parseArgs(process.argv.slice(2));

if (!image && !text) {
  console.error("Использование: npm run analyze:manual -- --image <path> --text \"...\"");
  process.exit(1);
}

const input: Parameters<typeof analyzeFood>[0] = {};
if (image) {
  const mimeType = MIME_BY_EXT[extname(image).toLowerCase()];
  if (!mimeType) {
    console.error(`Неподдерживаемое расширение файла: ${image}`);
    process.exit(1);
  }
  input.imageBase64 = readFileSync(image).toString("base64");
  input.mimeType = mimeType;
}
if (text) {
  input.text = text;
}

const result = await analyzeFood(input);
console.log(JSON.stringify(result, null, 2));
