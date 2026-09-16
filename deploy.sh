#!/usr/bin/env bash
# Deploys the plugin from the repository into OpenClaw's working directory and restarts the gateway.
# Verifies the plugin actually loaded — otherwise it rolls back.
#
# Every path below can be overridden from the environment, because none of them
# are the same on another machine:
#
#   OPENCLAW_EXTENSIONS   where the gateway looks for plugins
#   OPENCLAW_SERVICE      systemd --user unit to restart
#   OPENCLAW_RESTART_CMD  a full restart command, when there is no systemd
#   OPENCLAW_GATEWAY_URL  health endpoint to wait on
#   OPENCLAW_LOG_DIR      where the gateway writes its own log
#   OPENCLAW_CLI          path to the openclaw binary
set -euo pipefail

EXTENSIONS="${OPENCLAW_EXTENSIONS:-$HOME/.openclaw/extensions}"
SERVICE="${OPENCLAW_SERVICE:-openclaw-gateway}"
GATEWAY_URL="${OPENCLAW_GATEWAY_URL:-http://127.0.0.1:18789/}"
GATEWAY_LOGS="${OPENCLAW_LOG_DIR:-/tmp/openclaw}"
CLI="${OPENCLAW_CLI:-$(command -v openclaw || echo "$HOME/npm-global/bin/openclaw")}"

DEST="$EXTENSIONS/hebrew-bridge"
SRC="$(cd "$(dirname "$0")" && pwd)"
BACKUP="$(mktemp -d)"

restart_gateway() {
  if [ -n "${OPENCLAW_RESTART_CMD:-}" ]; then
    sh -c "$OPENCLAW_RESTART_CMD"
  elif command -v systemctl >/dev/null 2>&1; then
    systemctl --user reset-failed "$SERVICE" || true
    systemctl --user restart "$SERVICE"
  else
    echo "No systemctl here. Set OPENCLAW_RESTART_CMD to whatever restarts your gateway." >&2
    exit 1
  fi
}

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
LOG="$GATEWAY_LOGS/openclaw-$(date -u +%F).log"
FAILURE="hebrew-bridge failed to load\|hebrew-bridge invalid config"
ERRORS_BEFORE="$(grep -c "$FAILURE" "$LOG" 2>/dev/null || true)"
ERRORS_BEFORE="${ERRORS_BEFORE:-0}"
echo "  load errors in the log before deploy: $ERRORS_BEFORE"

echo "Restarting the gateway…"
restart_gateway
curl -s --retry 50 --retry-delay 3 --retry-all-errors -o /dev/null -w "  gateway: %{http_code}\n" "$GATEWAY_URL"
sleep 20

# The real check: the plugin must load, not merely the gateway come up
ERRORS_AFTER="$(grep -c "$FAILURE" "$LOG" 2>/dev/null || true)"
ERRORS_AFTER="${ERRORS_AFTER:-0}"
if [ "$ERRORS_AFTER" -gt "$ERRORS_BEFORE" ]; then
  echo "PLUGIN FAILED TO LOAD — rolling back"
  rm -rf "$DEST"
  mkdir -p "$DEST"
  cp -r "$BACKUP"/. "$DEST"/
  restart_gateway
  echo "Rollback done. Reason is in the log: $LOG"
  exit 1
fi

echo "  routes:"
"$CLI" plugins inspect hebrew-bridge 2>/dev/null | grep -E "^Status" | sed 's/^/    /'
tail -1 "$HOME/.openclaw/hebrew-bridge/logs/$(date -u +%F).log" 2>/dev/null | sed 's/^/    /'
