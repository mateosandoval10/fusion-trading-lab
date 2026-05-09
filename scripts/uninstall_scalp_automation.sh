#!/usr/bin/env bash
set -euo pipefail

LAUNCH_DIR="$HOME/Library/LaunchAgents"

uninstall_one() {
  local label="$1"
  local target="$LAUNCH_DIR/${label}.plist"
  launchctl bootout "gui/$(id -u)" "$target" >/dev/null 2>&1 || true
  rm -f "$target"
  echo "Uninstalled ${label}"
}

uninstall_one "com.tradingview-mcp.scalp-improver"
uninstall_one "com.tradingview-mcp.morning-watchlist"
