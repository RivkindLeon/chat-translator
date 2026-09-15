#!/usr/bin/env bash
# Deploys the plugin from the repository into OpenClaw's working directory and restarts the gateway.
# Verifies the plugin actually loaded — otherwise it rolls back.
set -euo pipefail

DEST="$HOME/.openclaw/extensions/hebrew-bridge"
SRC="$(cd "$(dirname "$0")" && pwd)"
BACKUP="$(mktemp -d)"

echo "Tests…"
node "$SRC/test.mjs" >/dev/null

if [ -d "$DEST" ]; then
  cp -r "$DEST"/. "$BACKUP"/
  echo "Backup of the current version: $BACKUP"
fi

echo "Copying…"
mkdir -p "$DEST"
rm -rf "$DEST/src" "$DEST/tools"
cp -r "$SRC"/src "$DEST"/src
cp -r "$SRC"/tools "$DEST"/tools
cp "$SRC"/index.js "$SRC"/openclaw.plugin.json "$SRC"/package.json "$DEST/"
# the tools are also needed next to the plugin — that is the short path people use
cp "$SRC"/tools/*.mjs "$DEST/"

# Count the load errors already in today's log BEFORE restarting: only new ones
# mean this deploy broke something. Without this baseline any earlier failure
# in the same day's log would trigger a rollback of a perfectly good deploy.
LOG="/tmp/openclaw/openclaw-$(date -u +%F).log"
FAILURE="hebrew-bridge failed to load\|hebrew-bridge invalid config"
ERRORS_BEFORE="$(grep -c "$FAILURE" "$LOG" 2>/dev/null || true)"
ERRORS_BEFORE="${ERRORS_BEFORE:-0}"
echo "  load errors in the log before deploy: $ERRORS_BEFORE"

echo "Restarting the gateway…"
systemctl --user reset-failed openclaw-gateway || true
systemctl --user restart openclaw-gateway
curl -s --retry 50 --retry-delay 3 --retry-all-errors -o /dev/null -w "  gateway: %{http_code}\n" http://127.0.0.1:18789/
sleep 20

# The real check: the plugin must load, not merely the gateway come up
ERRORS_AFTER="$(grep -c "$FAILURE" "$LOG" 2>/dev/null || true)"
ERRORS_AFTER="${ERRORS_AFTER:-0}"
if [ "$ERRORS_AFTER" -gt "$ERRORS_BEFORE" ]; then
  echo "PLUGIN FAILED TO LOAD — rolling back"
  rm -rf "$DEST"
  mkdir -p "$DEST"
  cp -r "$BACKUP"/. "$DEST"/
  systemctl --user restart openclaw-gateway
  echo "Rollback done. Reason is in the log: $LOG"
  exit 1
fi

echo "  routes:"
PATH="$HOME/npm-global/bin:$PATH" openclaw plugins inspect hebrew-bridge 2>/dev/null | grep -E "^Status" | sed 's/^/    /'
tail -1 "$HOME/.openclaw/hebrew-bridge/logs/$(date -u +%F).log" 2>/dev/null | sed 's/^/    /'
