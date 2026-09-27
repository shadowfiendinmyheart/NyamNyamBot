# --- build: компиляция TypeScript + сборка нативного better-sqlite3 под Linux ---
FROM node:22-bookworm-slim AS build
WORKDIR /app

# На случай, если для платформы нет готового бинарника better-sqlite3 — собрать из исходников.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

# --- runtime: только то, что нужно для запуска ---
FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production

COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY drizzle ./drizzle

# Миграции идемпотентны — прогоняем при каждом старте, затем запускаем бота.
CMD ["sh", "-c", "node dist/db/migrate.js && exec node dist/bot.js"]
