#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LAUNCH_DIR="$HOME/Library/LaunchAgents"
mkdir -p "$LAUNCH_DIR" "$ROOT/logs"

install_one() {
  local template="$1"
  local label="$2"
  local target="$LAUNCH_DIR/${label}.plist"
  sed "s#__ROOT__#${ROOT//\\/\\\\}#g" "$ROOT/launchd/${label}.plist.template" > "$target"
  launchctl bootout "gui/$(id -u)" "$target" >/dev/null 2>&1 || true
  launchctl bootstrap "gui/$(id -u)" "$target"
  launchctl enable "gui/$(id -u)/${label}"
  echo "Installed ${label} -> ${target}"
}

install_one "$ROOT/launchd/com.tradingview-mcp.scalp-improver.plist.template" "com.tradingview-mcp.scalp-improver"
install_one "$ROOT/launchd/com.tradingview-mcp.morning-watchlist.plist.template" "com.tradingview-mcp.morning-watchlist"

echo ""
echo "Nightly optimizer runs daily at 23:30 local time."
echo "Morning watchlist runs daily at 06:20 local time."
echo "Logs:"
echo "  $ROOT/logs/nightly-scalp-improver.log"
echo "  $ROOT/logs/morning-scalp-watchlist.log"
