// Дешёвый фильтр очевидной болтовни («привет», «спасибо», «ок») до вызова ИИ: такие
// сообщения не стоят запроса к Claude и не должны получать ответ «не распознала еду».
// Срабатывает, только если сообщение целиком состоит из реплики (плюс слова-связки
// вроде «большое», «Ням-Ням») — «спасибо, съел яблоко» по-прежнему уходит в разбор.

type SmallTalkKind = "greeting" | "thanks" | "ack" | "bye";

const PHRASES: Record<SmallTalkKind, string[]> = {
  greeting: [
    "привет",
    "приветик",
    "приветствую",
    "здравствуй",
    "здравствуйте",
    "здрасте",
    "здрасьте",
    "здарова",
    "хай",
    "хелло",
    "ку",
    "салют",
    "доброе утро",
    "добрый день",
    "добрый вечер",
    "hi",
    "hello",
    "hey",
  ],
  thanks: [
    "спасибо",
    "спасибки",
    "спс",
    "пасиб",
    "пасибо",
    "благодарю",
    "мерси",
    "сенкс",
    "thanks",
    "thank you",
    "thx",
  ],
  ack: [
    "ок",
    "окей",
    "ok",
    "okay",
    "хорошо",
    "понял",
    "поняла",
    "понятно",
    "ясно",
    "ага",
    "угу",
    "ладно",
    "отлично",
    "супер",
    "класс",
    "круто",
    "норм",
    "принято",
    "договорились",
  ],
  bye: ["пока", "до свидания", "до завтра", "спокойной ночи", "доброй ночи", "увидимся"],
};

// Слова, которые не меняют смысл реплики: «спасибо большое», «привет, Ням-Ням».
const FILLER = new Set([
  "ням",
  "нямням",
  "бот",
  "котик",
  "большое",
  "огромное",
  "очень",
  "тебе",
  "вам",
  "всем",
  "и",
]);

const REPLIES: Record<SmallTalkKind, string> = {
  greeting: "🐱 Мур, привет! Пришлите фото еды или напишите, что съели, — я посчитаю КБЖУ.",
  thanks: "🐱 Всегда пожалуйста! Мур 🐾",
  ack: "👌 Если что — присылайте фото еды или пишите, что съели.",
  bye: "🐱 До встречи! Не забывайте записывать еду 🐾",
};

const KIND_BY_PHRASE = new Map<string, SmallTalkKind>(
  (Object.entries(PHRASES) as [SmallTalkKind, string[]][]).flatMap(([kind, phrases]) =>
    phrases.map((phrase) => [phrase, kind] as const),
  ),
);

const REACTIONS = new Set([..."👍👌🙏❤♥😊🙂😀😁😃😄🤗😘🥰😍🔥💪✅🆗)"]);

function isReaction(text: string): boolean {
  // Без пробелов, знаков препинания, вариантов отображения (U+FE0F) и оттенков кожи.
  const chars = [...text.replace(/[\s!.,?(\u{FE0F}\u{1F3FB}-\u{1F3FF}]/gu, "")];
  return chars.length > 0 && chars.every((char) => REACTIONS.has(char));
}

// Больше слов — уже не «очевидная» реплика, пусть разбирает ИИ.
const MAX_WORDS = 5;

export function detectSmallTalk(text: string): SmallTalkKind | undefined {
  const words = text
    .toLowerCase()
    .replace(/ё/g, "е")
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);

  // Только реакция («👍», «❤️», «)))») — тоже реплика. Прочие эмодзи (🍎, 🍕) могут
  // означать еду — их разбирает ИИ.
  if (words.length === 0) return isReaction(text) ? "ack" : undefined;
  if (words.length > MAX_WORDS) return undefined;

  const meaningful = words.filter((word) => !FILLER.has(word));
  if (meaningful.length === 0) return undefined;

  // «привет привет», «ок, спасибо» — все части должны быть репликами; ответ — по первой.
  const kinds: SmallTalkKind[] = [];
  let rest = meaningful;
  while (rest.length > 0) {
    const two = rest.length >= 2 ? KIND_BY_PHRASE.get(`${rest[0]} ${rest[1]}`) : undefined;
    if (two) {
      kinds.push(two);
      rest = rest.slice(2);
      continue;
    }
    const one = KIND_BY_PHRASE.get(rest[0]);
    if (!one) return undefined;
    kinds.push(one);
    rest = rest.slice(1);
  }
  // Благодарность важнее «ок» в «ок, спасибо».
  return kinds.includes("thanks") ? "thanks" : kinds[0];
}

export function smallTalkReply(text: string): string | undefined {
  const kind = detectSmallTalk(text);
  return kind ? REPLIES[kind] : undefined;
}
