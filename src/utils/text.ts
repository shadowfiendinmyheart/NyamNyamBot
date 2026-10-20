// Обрезает текст до maxLength символов по границе последнего законченного предложения
// или строки — чтобы оборванный ответ ИИ не заканчивался на полуслове. Если границы
// нет, режет по слову и ставит многоточие.
export function trimToLastSentence(text: string, maxLength = text.length): string {
  if (!text.trim()) return "";
  const slice = text.slice(0, maxLength).trimEnd();
  if (slice.length === text.trimEnd().length) {
    // Текст не обрезан по длине, но мог оборваться сам (max_tokens) — проверяем
    // только если последний символ не завершает предложение.
    if (/[.!?…)»"]$/u.test(slice) || /\p{Extended_Pictographic}$/u.test(slice)) return slice;
  }

  let cut = -1;
  for (const match of slice.matchAll(/[.!?…](?=\s|$)|\n/g)) {
    cut = match.index + (match[0] === "\n" ? 0 : 1);
  }
  // Граница слишком близко к началу — лучше оборванное слово, чем пустой ответ.
  if (cut >= slice.length * 0.3) return slice.slice(0, cut).trimEnd();

  const lastSpace = slice.lastIndexOf(" ");
  return `${(lastSpace > 0 ? slice.slice(0, lastSpace) : slice).trimEnd()}…`;
}

// Эмодзи перед текстом ставит бот (светофор, 💡, 🎯) — свой эмодзи модели в начале его
// задвоил бы.
const LEADING_EMOJI = /^[\p{Extended_Pictographic}️‍\s]+/u;

// Короткая фраза модели (поле инструмента) для строки под эмодзи бота: без своего эмодзи
// в начале, не длиннее maxLength. Короткий текст — как есть: trimToLastSentence без
// превышения длины «дорезал» бы фразу без точки в конце как оборванную.
export function clampPhrase(value: unknown, maxLength: number): string {
  const text = typeof value === "string" ? value.replace(LEADING_EMOJI, "").trim() : "";
  return text.length > maxLength ? trimToLastSentence(text, maxLength) : text;
}

// Короткая подпись для кнопки или строки: первая строка текста, не длиннее maxLength
// символов (с многоточием, если обрезана).
export function shortLabel(text: string, maxLength: number): string {
  const line = text.trim().split("\n")[0].trim();
  const chars = [...line];
  return chars.length <= maxLength
    ? line
    : `${chars.slice(0, Math.max(1, maxLength - 1)).join("").trimEnd()}…`;
}
