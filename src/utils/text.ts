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
