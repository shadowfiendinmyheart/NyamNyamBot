# food-calculator — Telegram-бот для подсчёта калорий по фото

Telegram-бот для закрытого круга (друзья/семья, доступ по инвайт-коду). Пользователь
присылает фото еды или текстовое описание → Claude (vision) оценивает КБЖУ → бот ведёт
дневник питания: дневная норма калорий/БЖУ (формула Миффлина-Сан Жеора), история приёмов
пищи, ручная коррекция оценок, трекинг веса, ежедневные/еженедельные отчёты.

Полное архитектурное решение и обоснования — в
`/Users/garfield/.claude/plans/merry-hugging-kahn.md` (там же контекст всех решений,
согласованных с пользователем). Этот файл — краткая шпаргалка для разработки, список
фич по итерациям — в [docs/BACKLOG.md](docs/BACKLOG.md).

## Стек

- **Рантайм:** Node.js + TypeScript, ESM (`"type": "module"` в package.json).
- **Бот:** [grammY](https://grammy.dev/) + `@grammyjs/conversations` (пошаговые диалоги:
  онбординг, коррекция). Long polling, без вебхука.
- **ИИ:** `@anthropic-ai/sdk`, модель `claude-sonnet-5` (vision). Ответ — строго через
  tool use / JSON-схему, не парсинг свободного текста. Остальной код зависит от
  провайдер-независимого контракта в `src/ai/foodAnalyzer.ts`, а не от Anthropic SDK
  напрямую — это даёт возможность заменить ИИ-провайдера, поменяв только `src/claude/`.
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
  db/
    schema.ts               # Drizzle-схема: users, profiles, weight_log, meals, meal_items,
                            # workouts, reminders
    client.ts                # инициализация better-sqlite3 + drizzle
    migrate.ts               # прогон миграций
  ai/
    foodAnalyzer.ts          # контракт (типы + FoodAnalyzer) — остальной код зовёт
                              # analyzeFood отсюда, не из конкретного провайдера
    messageAnalyzer.ts       # контракт разбора текста/голоса: еда + тренировки
    coach.ts                  # контракт коуча Ням-Ням: askCoach, commentOnPeriod,
                              # CoachDataSource (чтение данных пользователя)
  claude/
    client.ts                 # общий Anthropic-клиент и классификация ошибок API
    analyzeFood.ts           # реализация FoodAnalyzer поверх Anthropic API
    analyzeMessage.ts        # реализация MessageAnalyzer (tool log_diary_entry)
    prompts.ts                # системные промпты и tool-схема Claude
    coach.ts, coachPrompts.ts # коуч: цикл tool use, промпты и инструменты
  features/
    onboarding.ts            # инвайт-код + анкета профиля (+ «зачем вам бот» для коуча)
    motivation.ts            # правка ответа «зачем вам бот» из профиля
    mealLogging.ts            # обработка фото/текста → meal + meal_items
    correction.ts             # inline-кнопки и диалог правки оценки
    reports.ts                 # /today, /week, вечерняя сводка, недельный отчёт
    weight.ts                  # /weight, пересчёт нормы КБЖУ
    workout.ts                 # /workout, запись тренировок (workoutFormat.ts — подписи)
    coach/                     # «🐱 Спросить Ням-Ням»: режим разговора (coach.ts),
                               # сессии в памяти (session.ts), данные для ИИ (dataSource.ts)
  cron/
    scheduler.ts              # node-cron: вечерняя сводка и недельный отчёт + комментарий коуча
  utils/
    dates.ts                  # границы дня/недели в таймзоне пользователя
  nutrition/
    calculations.ts           # формула Миффлина-Сан Жеора + распределение БЖУ,
                              # расход тренировок по MET
docker-compose.yml
Dockerfile
.env.example
```

## Конвенции

- Код (имена переменных/функций/файлов) — на английском. Все сообщения бота
  пользователю и комментарии в промптах Claude — на русском (интерфейс только русский).
- Все ответы Claude по еде — строго структурированные (tool use), без парсинга
  произвольного текста.
- Любая денежная/числовая величина КБЖУ — целые ккал, граммы БЖУ с одним знаком после
  запятой.
- Время/даты — храним в UTC, отображаем в таймзоне пользователя (`users.timezone`,
  дефолт из `DEFAULT_TIMEZONE`).
- Новая функциональность добавляется по одному тикету из `docs/BACKLOG.md` за раз —
  каждый тикет должен собираться (`npm run build`) и, где применимо, покрываться тестом
  (`npm test`) до перехода к следующему.

## Как запускать

```bash
cp .env.example .env   # заполнить BOT_TOKEN, ANTHROPIC_API_KEY, INVITE_CODES
npm install
npm run db:migrate
npm run dev             # long polling локально
```

## Текущий статус

Готово: `package.json`, `tsconfig.json`, `src/config.ts`, `.env.example`, `.gitignore`.
Дальше — по порядку тикетов в [docs/BACKLOG.md](docs/BACKLOG.md).
