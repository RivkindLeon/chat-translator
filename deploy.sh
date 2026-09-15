#!/usr/bin/env bash
# Выкладывает плагин из репозитория в рабочий каталог OpenClaw и перезапускает шлюз.
# Проверяет, что плагин действительно загрузился — иначе откатывает.
set -euo pipefail

DEST="$HOME/.openclaw/extensions/hebrew-bridge"
SRC="$(cd "$(dirname "$0")" && pwd)"
BACKUP="$(mktemp -d)"

echo "Тесты…"
node "$SRC/test.mjs" >/dev/null

if [ -d "$DEST" ]; then
  cp -r "$DEST"/. "$BACKUP"/
  echo "Копия текущей версии: $BACKUP"
fi

echo "Копирую…"
mkdir -p "$DEST"
rm -rf "$DEST/src" "$DEST/tools"
cp -r "$SRC"/src "$DEST"/src
cp -r "$SRC"/tools "$DEST"/tools
cp "$SRC"/index.js "$SRC"/openclaw.plugin.json "$SRC"/package.json "$DEST/"
# инструменты нужны и рядом с плагином — ими пользуются по короткому пути
cp "$SRC"/tools/*.mjs "$DEST/"

echo "Перезапускаю шлюз…"
systemctl --user reset-failed openclaw-gateway || true
systemctl --user restart openclaw-gateway
curl -s --retry 50 --retry-delay 3 --retry-all-errors -o /dev/null -w "  шлюз: %{http_code}\n" http://127.0.0.1:18789/
sleep 20

# Главная проверка: плагин должен загрузиться, а не просто шлюз подняться
LOG="/tmp/openclaw/openclaw-$(date -u +%F).log"
if grep -q "hebrew-bridge failed to load\|hebrew-bridge invalid config" "$LOG" 2>/dev/null &&
   [ "$(grep -c "hebrew-bridge failed to load\|hebrew-bridge invalid config" "$LOG")" -gt "${ERRORS_BEFORE:-0}" ]; then
  echo "ПЛАГИН НЕ ЗАГРУЗИЛСЯ — откатываю"
  rm -rf "$DEST"
  mkdir -p "$DEST"
  cp -r "$BACKUP"/. "$DEST"/
  systemctl --user restart openclaw-gateway
  echo "Откат выполнен. Причина в логе: $LOG"
  exit 1
fi

echo "  маршруты:"
PATH="$HOME/npm-global/bin:$PATH" openclaw plugins inspect hebrew-bridge 2>/dev/null | grep -E "^Status" | sed 's/^/    /'
tail -1 "$HOME/.openclaw/hebrew-bridge/logs/$(date -u +%F).log" 2>/dev/null | sed 's/^/    /'
