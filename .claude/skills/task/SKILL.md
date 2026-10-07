---
name: task
description: Алиас для /ticket — взять тикет из docs/BACKLOG.md и довести его до коммита.
argument-hint: "[номер тикета]"
disable-model-invocation: true
---

# Алиас /ticket

Прочитай `.claude/skills/ticket/SKILL.md` и выполни его инструкции целиком, как если бы
пользователь вызвал `/ticket $ARGUMENTS`. Вместо `$ARGUMENTS` в том файле подставь:
`$ARGUMENTS` (пусто — значит номер не указан).
