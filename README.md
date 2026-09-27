# food-calculator

Telegram-бот для подсчёта калорий по фото. Закрытый круг (друзья/семья), доступ по
инвайт-коду. Пользователь присылает фото еды или текстовое описание → Claude (vision)
оценивает КБЖУ → бот ведёт дневник питания.

Полное архитектурное решение — в `/Users/garfield/.claude/plans/merry-hugging-kahn.md`.
Список фич по итерациям — в [docs/BACKLOG.md](docs/BACKLOG.md). Конвенции разработки —
в [CLAUDE.md](CLAUDE.md).

## Стек

- Node.js + TypeScript, ESM
- [grammY](https://grammy.dev/) + `@grammyjs/conversations` — Telegram-бот, long polling
- `@anthropic-ai/sdk`, модель `claude-sonnet-5` (vision) — распознавание еды, строго
  через tool use / JSON-схему
- SQLite (`better-sqlite3`) + Drizzle ORM
- `node-cron` — сводки/напоминания (пост-MVP)
- Docker + docker-compose на VPS (пост-MVP)

## Требования

- **Node.js 22** — обязательно через `nvm use 22`. Дефолтный nvm-Node (v19.2.0) не
  собирает `better-sqlite3`.

## Быстрый старт

```bash
nvm use 22
cp .env.example .env   # заполнить BOT_TOKEN, ANTHROPIC_API_KEY, INVITE_CODES
npm install
npm run db:migrate
npm run dev             # long polling локально
```

## Запуск через Docker (в т.ч. Windows 11)

Нужен только [Docker Desktop](https://www.docker.com/products/docker-desktop/) с
бэкендом WSL 2 — Node.js ставить не надо, `better-sqlite3` собирается внутри образа под
Linux.

```powershell
git clone <repo> food-calculator
cd food-calculator
copy .env.example .env      # заполнить BOT_TOKEN, ключи API, INVITE_CODES
docker compose up -d --build
docker compose logs -f bot  # смотреть логи
```

- Миграции БД применяются автоматически при каждом старте контейнера.
- БД хранится в `data\` рядом с проектом (монтируется в контейнер как
  `/app/data`). Чтобы перенести существующие данные — скопируйте `data/db.sqlite`
  с другой машины в `data\` до запуска.
- `DB_PATH` из `.env` в контейнере игнорируется — путь задаётся в
  `docker-compose.yml`.
- Обновление после `git pull`: `docker compose up -d --build`. Остановка:
  `docker compose down`.
- Если установлен Node.js, те же команды есть как npm-скрипты: `npm run docker:up`
  (сборка + запуск), `docker:down`, `docker:restart`, `docker:logs`, `docker:ps`.
- Бот должен работать в одном экземпляре на токен: если он уже запущен локально
  (`npm run dev`) или на другой машине, Telegram вернёт ошибку 409 Conflict.

## Переменные окружения (`.env`)

| Переменная             | Назначение                                      | Дефолт              |
|-------------------------|--------------------------------------------------|---------------------|
| `BOT_TOKEN`             | Токен Telegram-бота                              | обязателен          |
| `ANTHROPIC_API_KEY`     | Ключ Anthropic API                               | обязателен          |
| `INVITE_CODES`          | Инвайт-коды для доступа, через запятую           | —                   |
| `DB_PATH`               | Путь к файлу SQLite                              | `./data/db.sqlite`  |
| `DEFAULT_TIMEZONE`      | Таймзона по умолчанию для новых пользователей    | `Europe/Moscow`     |

Файл БД лежит в `data/` — каталог не коммитится в git (см. `.gitignore`).

## Скрипты

```bash
npm run dev          # бот с hot-reload (tsx watch)
npm run build        # сборка в dist/
npm start             # запуск собранного бота (dist/bot.js)
npm run db:generate   # сгенерировать миграцию из schema.ts (drizzle-kit)
npm run db:migrate    # применить миграции к data/db.sqlite
npm test               # тесты (vitest)
```

**Важно:** после любого изменения `src/db/schema.ts` — `npm run db:generate`, затем
`npm run db:migrate`. Если бот падает с ошибкой `SqliteError: no such table: ...` —
почти всегда это значит, что миграции не были применены к `data/db.sqlite`.

## Структура кода

```
src/
  bot.ts                  # точка входа, регистрация всех хендлеров
  config.ts                # чтение .env
  db/
    schema.ts               # Drizzle-схема: users, meals, meal_items (+ profiles,
                             # weight_log — пост-MVP)
    client.ts                # инициализация better-sqlite3 + drizzle
    migrate.ts               # прогон миграций
    users.ts                  # доступ к таблице users
    meals.ts                  # создание/удаление meal + meal_items
  features/
    accessGate.ts             # middleware проверки инвайт-кода
    mealLogging.ts            # обработка текста → meal + meal_items (фото — в разработке)
  ai/
    foodAnalyzer.ts           # провайдер-независимый контракт (типы + FoodAnalyzer)
  claude/
    analyzeFood.ts            # реализация FoodAnalyzer поверх Anthropic API
    prompts.ts                 # системные промпты и tool-схема Claude
  nutrition/
    calculations.ts            # формула Миффлина-Сан Жеора — пост-MVP
  cron/
    scheduler.ts                # node-cron задачи — пост-MVP
drizzle/                  # сгенерированные SQL-миграции
docs/BACKLOG.md            # бэклог фич по тикетам
```

## Текущий статус

MVP в разработке, идём по тикетам из [docs/BACKLOG.md](docs/BACKLOG.md) по порядку:

- ✅ Тикет 0 — каркас проекта
- ✅ Тикет 1 — схема БД и миграции (`users`, `meals`, `meal_items`)
- ✅ Тикет 2 — каркас бота и инвайт-код (`src/bot.ts`, `accessGate.ts`)
- ✅ Тикет 4 — интеграция с Claude (анализ еды) (`src/ai/foodAnalyzer.ts`, `src/claude/`)
- ⬜ Тикет 5 — логирование приёма пищи по фото
- ✅ Тикет 6 — логирование приёма пищи текстом (`src/features/mealLogging.ts`,
  `src/db/meals.ts`)
- ⬜ Тикет 8 — `/today`

Формула нормы КБЖУ, коррекция оценок, трекинг веса, cron-отчёты и Docker-деплой —
пост-MVP, добавляются по одному тикету после того, как основной цикл (фото → КБЖУ →
дневник) проверен на себе.

## Конвенции

- Код — на английском, сообщения бота и промпты Claude — на русском.
- Ответы Claude по еде — строго структурированные (tool use), без парсинга свободного
  текста.
- КБЖУ: целые ккал, граммы БЖУ с одним знаком после запятой.
- Время — храним в UTC, отображаем в таймзоне пользователя.
- Один тикет из бэклога за раз, каждый должен собираться (`npm run build`) и по
  возможности покрываться тестом (`npm test`) до перехода к следующему.

Подробности — в [CLAUDE.md](CLAUDE.md).
