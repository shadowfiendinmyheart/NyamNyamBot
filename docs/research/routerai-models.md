# RouterAI: модели для оценки еды по фото

Исследование каталога https://routerai.ru/models — 12.10.2026. Цены на сайте меняются;
перед решением перепроверить нужные строки. Используется в тикете №33.

## Что важно знать

- Бот **уже работает через RouterAI**: в `.env` `ANTHROPIC_BASE_URL=https://routerai.ru`,
  `ANTHROPIC_MODEL=anthropic/claude-sonnet-5.5` (по умолчанию в `config.ts` —
  `claude-sonnet-5`, но `.env` его переопределяет).
- API: OpenAI-совместимый `https://routerai.ru/api/v1/chat/completions`; Anthropic-
  совместимый — тот, через который ходит бот (SDK дописывает `/v1/messages` к
  `https://routerai.ru/api`). Имена моделей — с префиксом провайдера
  (`anthropic/claude-sonnet-5.5`, `openai/whisper-1`). Принимает ли Anthropic-endpoint
  не-Anthropic модели — **не проверено**; формат id для не-Claude моделей в документации
  не нашёлся.
- Каталог: 559 моделей, 38 страниц по 15, пагинация `?page=N`. Изображения на вход
  принимают ~200, но многие из них — генерация картинок/видео; LLM с vision, которые
  годятся для КБЖУ через tool use, — список ниже.
- Точность оценки еды в каталоге **не указана** — только цены. Сравнение по точности
  возможно только прогоном реальных фото (тикет №33).
- У Sonnet 5.5, Opus 5.5 и Fable thinking не выключается (`hasMandatoryThinking` в
  `claude/client.ts`) — рассуждения оплачиваются как исходящие токены, реальная цена
  запроса выше прикидки.

## Прикидка цены одного фото

~4,5 тыс. входящих токенов (фото + системный промпт + tool-схема) и ~500 исходящих
(без учёта thinking). Цена = 4,5 × вход/1000 + 0,5 × выход/1000.

| Модель | Вход / выход, ₽ за 1M | ≈ ₽ за фото |
|---|---|---|
| Claude Fable 5.1 | 1269 / 6346 | 8,9 |
| Claude Opus 5.5 | 441 / 2207 | 3,1 |
| Claude Sonnet 5.5 (текущая) | 220 / 1103 | 1,5 |
| Gemini 3.8 Flash | 82 / 413 | 0,6 |
| Claude Haiku 5.5 | 11 / 55 | 0,08 |
| GPT-6 Luna | 11 / 55 | 0,08 |
| Qwen3.8 Flash | 16 / 51 | 0,1 |

## LLM с изображениями на вход (кандидаты)

Цены — ₽ за 1M токенов, вход / выход. Контекст — как на сайте.

**Anthropic**
| Модель | Контекст | Цена |
|---|---|---|
| Claude Fable 5.1 / Fable Latest | 1M | 1269 / 6346 |
| Claude Fable 5 | 1M | 1269 / 6346 |
| Claude Opus 5.5 / Opus Latest | 1M | 441 / 2207 |
| Claude Opus 5 | 1M | 551 / 2759 |
| Claude Opus 4.8 / 4.7 / 4.6 | 1M | 551 / 2759 |
| Claude Opus 4.5 | 200K | 551 / 2759 |
| Claude Sonnet 5.5 / Sonnet Latest | 1M | 220 / 1103 |
| Claude Sonnet 5 | 1M | 220 / 1103 |
| Claude Sonnet 4.6 / 4.5 | 1M | 331 / 1655 |
| Claude Haiku 5.5 / Haiku Latest | 1M | 11 / 55 |
| Claude Haiku 4.5 | 200K | 110 / 551 |

**OpenAI**
| Модель | Контекст | Цена |
|---|---|---|
| GPT-6 Astra / Astra Pro | 1M | 1103 / 5518 |
| GPT-6.1 Sol / Sol Pro, GPT-6 Sol / Sol Pro, GPT Latest | 1M | 220 / 1103 |
| GPT-5.6 Sol | 1M | 220 / 1103 |
| GPT-5.6 Terra | 1M | 220 / 1324 |
| GPT-5.6 Luna / Luna Pro | 1M | 22 / 132 |
| GPT-6 Luna / Luna Pro | 1M | 11 / 55 |
| GPT-5.4 Mini | 400K | 82 / 496 |
| GPT-5.4 Nano | 400K | 23 / 144 |
| GPT-4.1 Mini / Nano | 1M | 44 / 176, 11 / 44 |

**Google**
| Модель | Контекст | Цена |
|---|---|---|
| Gemini 3.1 Pro Preview / Pro Latest | 1M | 220 / 1324 |
| Gemini 3.8 / 3.7 / 3.6 Flash, Flash Latest | 1M | 82 / 413 |
| Gemini 3.5 Flash | 1M | 165 / 993 |
| Gemini 3.5 Flash Lite | 1M | 33 / 275 |
| Gemini 3.1 Flash Lite | 1M | 27 / 165 |
| Gemma 4 31B / 26B A4B | 262K | 9 / 37, 4,64 / 24 |

**Остальные**
| Модель | Провайдер | Контекст | Цена |
|---|---|---|---|
| Qwen3.8 Max Prime | Qwen | 1M | 441 / 1324 |
| Qwen3.8 Max | Qwen | 1M | 220 / 662 |
| Qwen3.8 Flash / Omni Flash | Qwen | 1M | 16 / 51 |
| Qwen3.7 Plus | Qwen | 1M | 35 / 141 |
| Qwen3.7 Flash | Qwen | 1M | 3,31 / 14 |
| Grok 4.7 / Latest | SpaceXAI | 500K | 220 / 662 |
| Grok 4.20 | SpaceXAI | 2M | 137 / 275 |
| Kimi K3 / Latest | Moonshot AI | 1M | 80 / 1103 |
| Muse Spark 1.3 | Meta | 1M | 137 / 469 |
| MiMo-V2.6-Pro | Xiaomi | 1M | 47 / 96 |
| MiMo-V2.6-Flash | Xiaomi | 1M | 11 / 30 |
| DeepSeek V4 Flash Vision Exp | DeepSeek | 1M | 23 / 71 |
| DeepSeek V4.1 Flash | DeepSeek | 1M | 4,04 / 16 |
| GLM 5.3 FlashX | Z AI | 1M | 44 / 151 |
| GLM 5V Turbo | Z AI | 203K | 132 / 441 |
| Mistral Large 4 | Mistral AI | 1M | 75 / 230 |
| Mistral Medium 3.5 | Mistral AI | 262K | 165 / 827 |
| MiniMax M3 | Minimax | 1M | 25 / 105 |
| Pareto 26.10 Preview | Unbiased | 1M | 88 / 353 |

Без поддержки изображений, но встречаются в обсуждениях: DeepSeek V4 Pro (38 / 115),
GigaChat 3 Pro (87 / 211), YandexGPT — для фото не подходят.

## Расшифровка голоса

Сейчас — `OPENAI_TRANSCRIBE_MODEL` (по умолчанию `whisper-1`, на RouterAI —
`openai/whisper-1`, 0,66 ₽/мин).

| Модель | Провайдер | Цена |
|---|---|---|
| Whisper Large V3 Turbo | OpenAI | 0,02 ₽/мин |
| Whisper Large V3 | OpenAI | 0,05 ₽/мин |
| Qwen3 ASR 0.6B / 1.7B | Qwen | 0,02 / 0,05 ₽/мин |
| Nemotron 3.5 ASR Streaming Multilingual | NVIDIA | 0,02 ₽/мин |
| Voxtral Mini 3B | Mistral AI | 0,11 ₽/мин |
| MAI-Transcribe 2 | Microsoft | 0,18 ₽/мин |
| Grok STT 1.0 | SpaceXAI | 0,18 ₽/мин |
| Scribe v2 | ElevenLabs | 0,20 ₽/мин |
| GPT Transcribe | OpenAI | 0,50 ₽/мин |
| Whisper 1 (текущая) | OpenAI | 0,66 ₽/мин |

Whisper Large V3 Turbo — в 30 раз дешевле текущей; переход — смена
`OPENAI_TRANSCRIBE_MODEL`, если RouterAI отдаёт её через тот же
`/audio/transcriptions` (не проверено), и проверка качества на русской речи.
