#!/usr/bin/env bash
# Выкладывает плагин из репозитория в рабочий каталог OpenClaw и перезапускает шлюз.
set -euo pipefail

DEST="$HOME/.openclaw/extensions/hebrew-bridge"
SRC="$(cd "$(dirname "$0")" && pwd)"

echo "Тесты…"
node "$SRC/test.mjs" >/dev/null

echo "Копирую в $DEST…"
mkdir -p "$DEST/src"
cp "$SRC"/index.js "$SRC"/openclaw.plugin.json "$SRC"/package.json "$DEST/"
cp "$SRC"/test.mjs "$DEST/"
cp "$SRC"/src/*.js "$DEST/src/"
cp "$SRC"/tools/*.mjs "$DEST/"

echo "Перезапускаю шлюз…"
systemctl --user reset-failed openclaw-gateway || true
systemctl --user restart openclaw-gateway
curl -s --retry 50 --retry-delay 3 --retry-all-errors -o /dev/null -w "health:%{http_code}\n" http://127.0.0.1:18789/
sleep 20
tail -1 "$HOME/.openclaw/hebrew-bridge/logs/$(date -u +%F).log" 2>/dev/null || true
