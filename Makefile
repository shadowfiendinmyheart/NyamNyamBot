COMPOSE := docker compose
SERVICE := bot

.DEFAULT_GOAL := help
.PHONY: help up down restart rebuild logs ps shell build

help: ## Показать список команд
	@grep -E '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "} {printf "  \033[36m%-10s\033[0m %s\n", $$1, $$2}'

up: ## Собрать образ и запустить бота в фоне
	$(COMPOSE) up -d --build

down: ## Остановить и удалить контейнер
	$(COMPOSE) down

restart: ## Перезапустить контейнер без пересборки
	$(COMPOSE) restart $(SERVICE)

rebuild: ## Пересобрать образ с нуля (без кэша) и перезапустить
	$(COMPOSE) build --no-cache $(SERVICE)
	$(COMPOSE) up -d

build: ## Только собрать образ
	$(COMPOSE) build $(SERVICE)

logs: ## Смотреть логи бота (follow)
	$(COMPOSE) logs -f --tail=100 $(SERVICE)

ps: ## Статус контейнера
	$(COMPOSE) ps

shell: ## Открыть shell внутри контейнера
	$(COMPOSE) exec $(SERVICE) sh
