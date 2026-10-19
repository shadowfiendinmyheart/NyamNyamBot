# food-calculator — Telegram-бот для подсчёта калорий по фото

Telegram-бот для закрытого круга (друзья/семья, доступ по инвайт-коду). Пользователь
присылает фото еды или текстовое описание → Claude (vision) оценивает КБЖУ → бот ведёт
дневник питания: дневная норма калорий/БЖУ (формула Миффлина-Сан Жеора), история приёмов
пищи, ручная коррекция оценок, трекинг веса, ежедневные/еженедельные отчёты.

Этот файл — краткая шпаргалка для разработки, список фич по итерациям — в
[docs/BACKLOG.md](docs/BACKLOG.md).

## Стек

- **Рантайм:** Node.js + TypeScript, ESM (`"type": "module"` в package.json).
- **Бот:** [grammY](https://grammy.dev/) + `@grammyjs/conversations` (пошаговые диалоги:
  онбординг, коррекция). Long polling, без вебхука.
- **ИИ:** `@anthropic-ai/sdk`, модель `claude-sonnet-5` (vision). Ответ — строго через
  tool use / JSON-схему, не парсинг свободного текста. Остальной код зависит от
  провайдер-независимого контракта в `src/ai/foodAnalyzer.ts`, а не от Anthropic SDK
  напрямую — это даёт возможность заменить ИИ-провайдера, поменяв только `src/claude/`.
- **Голос → текст:** `openai` SDK (`src/openai/transcribeAudio.ts`) за контрактом
  `src/ai/transcriber.ts`; ключ `OPENAI_API_KEY`, опционально `OPENAI_BASE_URL`.
- **Прокси:** `PROXY_URL` (`src/utils/proxy.ts`) — для Telegram и внешних API.
- **БД:** SQLite (`better-sqlite3`) + Drizzle ORM. Файл БД — в `data/` (не в git). Фото еды на диск не сохраняются:
  источник — только Telegram, в `meals.telegram_file_id` хранится `file_id`, по нему фото
  при необходимости скачивается заново.
- **Планировщик:** `node-cron` для сводок/напоминаний.
- **Деплой:** Docker + docker-compose на VPS, один контейнер, volume `data/`.

## Структура кода

```
src/
  bot.ts                  # точка входа, регистрация всех хендлеров
  config.ts                # чтение .env (уже готово)
  context.ts               # MyContext = ConversationFlavor<Context>
  db/
    schema.ts               # Drizzle-схема: users, profiles, weight_log, meals, meal_items,
                            # workouts, reminders
    client.ts                # инициализация better-sqlite3 + drizzle
    migrate.ts               # прогон миграций
  ai/
    foodAnalyzer.ts          # контракт (типы + FoodAnalyzer) — остальной код зовёт
                              # analyzeFood отсюда, не из конкретного провайдера
    messageAnalyzer.ts       # контракт разбора текста/голоса: еда + тренировки
    coach.ts                  # контракт коуча Ням-Ням: askCoach, commentOnPeriod
                              # (оценка рациона в сводках: светофор + совет),
                              # CoachDataSource (чтение данных пользователя)
    transcriber.ts            # контракт расшифровки голоса
    productLookup.ts          # контракт базы продуктов: КБЖУ на 100 г брендового продукта
  claude/
    client.ts                 # общий Anthropic-клиент и классификация ошибок API
    analyzeFood.ts           # реализация FoodAnalyzer поверх Anthropic API
    analyzeMessage.ts        # реализация MessageAnalyzer (tool log_diary_entry)
    prompts.ts                # системные промпты и tool-схема Claude
    coach.ts, coachPrompts.ts # коуч: цикл tool use, промпты и инструменты
  features/
    onboarding.ts            # инвайт-код + анкета профиля (+ «зачем вам бот» для коуча)
    motivation.ts            # правка ответа «зачем вам бот» из профиля
    mealLogging.ts            # обработка фото (альбом — одна запись)/текста/голоса → meal
    productData.ts            # КБЖУ брендовых продуктов из базы (📦) вместо оценки ИИ
    dayProgress.ts            # «📊 За день: съедено / норма, осталось» под записью еды
    mealTime.ts               # кнопка «🕐 Время»: тип приёма пищи и день записи
    correction.ts             # диалог правки оценки (старые кнопки «✏️ Изменить»)
    mealCorrection.ts         # сохранение нового состава записи: «✅ Обновила запись:
                              # было … ккал, стало …» и «↩️ Отменить правку»
    voiceConfirm.ts           # расшифровка голосового с кнопками ✅ / ✏️ / ❌ — в ИИ
                              # уходит только после ✅ (еда, коуч, правка, мотивация)
    reports.ts                 # тексты дневного отчёта, вечерней сводки, недельного отчёта,
                               # оценки рациона под ними (formatPeriodComment)
    history.ts                 # «📋 Сегодня» / /today: дни ◀️ ▶️, у записей ✏️ 🗑 🔁
    deletedEntries.ts          # удаление с «↩️ Вернуть» (копия удалённого — в памяти)
    weight.ts                  # /weight, «78.5» / «вес 78.5» текстом, пересчёт нормы КБЖУ
    smallTalk.ts               # «привет»/«спасибо»/«ок» — ответ без вызова ИИ
    timezone.ts                # «🕐 Часовой пояс» в профиле и /timezone
    notifications.ts           # «🔔 Уведомления» в профиле: время сводки, вкл/выкл
                               # сводки, недельного отчёта, напоминаний (колонки users)
    workout.ts                 # /workout, запись и «✏️ Изменить» тренировок
                               # (workoutFormat.ts — подписи)
    coach/                     # «🐱 Спросить Ням-Ням» и «💬 Поправить или спросить» под
                               # записью еды (коуч возвращает новый состав — correct_meal):
                               # режим разговора со своей клавиатурой
                               # (coach.ts), сессии в памяти (session.ts), данные для ИИ
                               # (dataSource.ts), «📝 Записать в дневник» (diaryOffers.ts)
  cron/
    scheduler.ts              # node-cron, поминутный тик: сводки и напоминания в локальное
                              # время каждого пользователя + комментарий коуча
  openai/
    transcribeAudio.ts        # реализация Transcriber (OpenAI)
  openfoodfacts/
    lookup.ts                 # реализация ProductLookup: поиск Open Food Facts, сопоставление
                              # бренда и названия, кэш в памяти
  utils/
    dates.ts                  # границы дня/недели в таймзоне пользователя
    timezones.ts              # частые пояса, разбор «Екатеринбург» / «UTC+5» / «МСК+2»
    mealTime.ts               # тип и время приёма пищи: по часам или «вчера на ужин»
    mediaGroupBuffer.ts       # сбор частей альбома (media_group_id) в одну пачку
    proxy.ts                  # proxyDispatcher для PROXY_URL
  nutrition/
    calculations.ts           # формула Миффлина-Сан Жеора + распределение БЖУ,
                              # расход тренировок по MET; КБЖУ порции из КБЖУ на 100 г
                              # (ИИ отдаёт значения на 100 г, умножает бот)
docker-compose.yml
Dockerfile
.env.example
```

## Конвенции

- Код (имена переменных/функций/файлов) — на английском. Все сообщения бота
  пользователю и комментарии в промптах Claude — на русском (интерфейс только русский).
  Бот говорит голосом Ням-Ням: от первого лица, женский род («записала», «не поняла»);
  в подсказках — кнопки, а не `/команды`; «нет профиля» — через `noProfileReply`
  (кнопка «📝 Заполнить анкету»).
- Все ответы Claude по еде — строго структурированные (tool use), без парсинга
  произвольного текста.
- Любая денежная/числовая величина КБЖУ — целые ккал, граммы БЖУ с одним знаком после
  запятой.
- Время/даты — храним в UTC, отображаем в таймзоне пользователя (`users.timezone`,
  `null` — `DEFAULT_TIMEZONE`); пояс пользователя — через `getUserTimeZone`, не
  `config.defaultTimezone`.
- Новая функциональность добавляется по одному тикету из `docs/BACKLOG.md` за раз —
  каждый тикет должен собираться (`npm run build`) и, где применимо, покрываться тестом
  (`npm test`) до перехода к следующему.

## Как запускать

```bash
cp .env.example .env   # заполнить BOT_TOKEN, ANTHROPIC_API_KEY, INVITE_CODES
npm install
npm run db:migrate
npm run dev             # long polling локально
npm run db:generate     # после правки src/db/schema.ts — сгенерировать миграцию
npm run build && npm test   # проверка перед закрытием тикета (tsc + vitest)
```

## Claude Code

- `/fuck-tokens [лимит|фильтр]` — автопилот: тикеты из бэклога один за другим, каждый
  в свежем субагенте по `/ticket`, до пустого бэклога или первой ошибки; прерванный
  тикет (кончились лимиты) возобновляет по `.claude/fuck-tokens.json`.
- `/ticket [N]` — тикет из бэклога до коммита + code-review с фиксами, затем предлагает
  следующий тикет; `/backlog` — обзор бэклога и 2–3 рекомендованных следующих тикета;
  `/migration` — изменение схемы БД.
- Хуки (`.claude/hooks/`): правка `.env`, `drizzle/**`, `package-lock.json` заблокирована;
  при изменённых `.ts` перед завершением ответа прогоняется `tsc --noEmit`.
- MCP `context7` (`.mcp.json`) — актуальная документация grammY/Drizzle/SDK.

## Текущий статус

Прогресс по тикетам — в [docs/BACKLOG.md](docs/BACKLOG.md) и в git log (коммиты с префиксом `[N]`).
