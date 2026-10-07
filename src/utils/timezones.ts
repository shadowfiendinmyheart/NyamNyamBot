// Часовые пояса пользователей: частые пояса для кнопок, разбор ответа текстом
// («Екатеринбург», «UTC+5», «МСК+2», «Europe/Berlin») и подписи «Москва (UTC+3)».

// Частые пояса — кнопками в анкете и в профиле.
export const COMMON_TIMEZONES: Record<string, string> = {
  "Europe/Kaliningrad": "Калининград",
  "Europe/Moscow": "Москва",
  "Europe/Samara": "Самара",
  "Asia/Yekaterinburg": "Екатеринбург",
  "Asia/Omsk": "Омск",
  "Asia/Novosibirsk": "Новосибирск",
  "Asia/Irkutsk": "Иркутск",
  "Asia/Yakutsk": "Якутск",
  "Asia/Vladivostok": "Владивосток",
  "Asia/Magadan": "Магадан",
  "Asia/Kamchatka": "Камчатка",
};

// Города, которые можно написать словами: начало слова в нижнем регистре, «ё» → «е».
// Слова до четырёх букв — только целиком: «чита» — не «читаю», «рим» — не «римма».
const CITY_WORDS: Record<string, string[]> = {
  "Europe/Kaliningrad": ["калининград"],
  "Europe/Moscow": [
    "москв", "питер", "петербург", "спб", "казан", "новгород", "воронеж", "ростов", "краснодар",
    "сочи", "волгоград", "ярославл", "мск", "крым", "крыму", "симферопол", "севастопол",
  ],
  "Europe/Samara": ["самар", "ижевск", "ульяновск"],
  "Asia/Yekaterinburg": [
    "екатеринбург", "екб", "челябинск", "пермь", "перми", "уфа", "уфе", "уфы", "тюмен",
    "оренбург", "сургут",
  ],
  "Asia/Omsk": ["омск", "омске"],
  "Asia/Novosibirsk": [
    "новосибирск", "нск", "красноярск", "томск", "барнаул", "кемерово", "новокузнецк",
  ],
  "Asia/Irkutsk": ["иркутск", "улан-удэ", "улан"],
  "Asia/Yakutsk": ["якутск", "чита", "чите", "читы"],
  "Asia/Vladivostok": ["владивосток", "хабаровск"],
  "Asia/Magadan": ["магадан", "сахалин", "южно-сахалинск"],
  "Asia/Kamchatka": ["камчатк", "петропавловск-камчатск"],
  "Europe/Minsk": ["минск", "беларус"],
  "Europe/Kyiv": ["киев", "киеве", "киив", "украин"],
  "Asia/Almaty": ["алмат", "астан", "казахстан"],
  "Asia/Tashkent": ["ташкент", "узбекистан"],
  "Asia/Bishkek": ["бишкек", "киргиз"],
  "Asia/Tbilisi": ["тбилиси", "грузи"],
  "Asia/Yerevan": ["ереван", "армени"],
  "Asia/Baku": ["баку", "азербайджан"],
  "Europe/Istanbul": ["стамбул", "анталь", "турци"],
  "Asia/Dubai": ["дубай", "дубае", "оаэ", "эмират"],
  "Asia/Bangkok": ["бангкок", "пхукет", "таиланд", "тайланд"],
  "Asia/Makassar": ["бали"],
  "Europe/Berlin": ["берлин", "германи", "мюнхен", "вена", "вене", "австри"],
  "Europe/Paris": ["париж", "франци"],
  "Europe/Madrid": ["мадрид", "барселон", "испани"],
  "Europe/Rome": ["рим", "риме", "итали", "милан"],
  "Europe/Prague": ["прага", "праге", "чехия", "чехии"],
  "Europe/Warsaw": ["варшав", "польш"],
  "Europe/Riga": ["рига", "риге", "латви"],
  "Europe/Vilnius": ["вильнюс", "литва", "литве"],
  "Europe/Tallinn": ["таллин", "эстони"],
  "Europe/Helsinki": ["хельсинки", "финлянди"],
  "Europe/Belgrade": ["белград", "серби", "черногори"],
  "Europe/London": ["лондон", "англи", "британи"],
  "Asia/Jerusalem": ["израил", "тель-авив", "тель", "иерусалим", "хайфа", "хайфе"],
  "America/New_York": ["нью-йорк"],
};

export function isValidTimeZone(timeZone: string): boolean {
  return canonicalTimeZone(timeZone) !== undefined;
}

// «europe/berlin» → «Europe/Berlin»; undefined — такого пояса нет.
function canonicalTimeZone(timeZone: string): string | undefined {
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone }).resolvedOptions().timeZone;
  } catch {
    return undefined;
  }
}

// Смещение от UTC в целых часах → пояс Etc/GMT (у них знак наоборот: UTC+5 = Etc/GMT-5).
function offsetTimeZone(hours: number): string | undefined {
  if (!Number.isInteger(hours) || hours < -12 || hours > 14) return undefined;
  if (hours === 0) return "UTC";
  return `Etc/GMT${hours > 0 ? "-" : "+"}${Math.abs(hours)}`;
}

function matchesCityWord(word: string, prefix: string): boolean {
  return prefix.length <= 4 ? word === prefix : word.startsWith(prefix);
}

const MOSCOW_OFFSET_HOURS = 3;

// Пояс из ответа текстом: смещение («UTC+5», «+5», «GMT-3», «МСК+2»), IANA-имя
// («Europe/Berlin») или город словами. undefined — не поняли или вариантов несколько.
export function parseTimeZoneText(text: string): string | undefined {
  const answer = text.trim().toLowerCase().replace(/ё/g, "е").replace(/−/g, "-");
  if (!answer) return undefined;

  const offset = /^(utc|gmt|мск|msk)?\s*([+-])\s*(\d{1,2})(?::00)?$/.exec(answer);
  if (offset) {
    const sign = offset[2] === "-" ? -1 : 1;
    const isMoscow = offset[1] === "мск" || offset[1] === "msk";
    return offsetTimeZone((isMoscow ? MOSCOW_OFFSET_HOURS : 0) + sign * Number(offset[3]));
  }
  if (answer === "utc" || answer === "gmt") return "UTC";
  if (/^[a-z_]+\/[a-z_\-/]+$/.test(answer)) return canonicalTimeZone(text.trim());

  const words = answer.split(/[^a-zа-я0-9-]+/).filter(Boolean);
  const matched = new Set<string>();
  for (const [timeZone, prefixes] of Object.entries(CITY_WORDS)) {
    if (words.some((word) => prefixes.some((prefix) => matchesCityWord(word, prefix)))) {
      matched.add(timeZone);
    }
  }
  return matched.size === 1 ? [...matched][0] : undefined;
}

// «UTC+3», «UTC+5:30», «UTC+0».
export function formatUtcOffset(timeZone: string, now: Date = new Date()): string {
  const name =
    new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "shortOffset" })
      .formatToParts(now)
      .find((part) => part.type === "timeZoneName")?.value ?? "GMT";
  return name.replace(/^GMT/, "UTC");
}

// «Москва (UTC+3)», «Europe/Berlin (UTC+2)», «UTC+5».
export function formatTimeZone(timeZone: string, now: Date = new Date()): string {
  const offset = formatUtcOffset(timeZone, now);
  const name = COMMON_TIMEZONES[timeZone] ?? (/^(Etc\/|UTC$)/.test(timeZone) ? undefined : timeZone);
  return name ? `${name} (${offset})` : offset;
}

// «14:05» — текущее время в поясе: по нему удобно проверить, что пояс выбран верно.
export function formatLocalTime(timeZone: string, now: Date = new Date()): string {
  return new Intl.DateTimeFormat("ru-RU", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(now);
}
