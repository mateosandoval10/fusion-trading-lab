#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LIVE_DIR="$ROOT/optimization-results/live-alerts"
PORT="${FUSION_ALERT_PORT:-8787}"
SERVER_SCREEN="fusion-alert-server"
TUNNEL_SCREEN="fusion-alert-tunnel"

stop_pid_file() {
  local file="$1"
  if [[ -f "$file" ]]; then
    local pid
    pid="$(cat "$file" || true)"
    if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null || true
      echo "Stopped PID $pid from $file"
    fi
    rm -f "$file"
  fi
}

stop_pid_file "$LIVE_DIR/live-alert-server.pid"
stop_pid_file "$LIVE_DIR/live-alert-tunnel.pid"

if command -v screen >/dev/null 2>&1; then
  screen -S "$SERVER_SCREEN" -X quit >/dev/null 2>&1 || true
  screen -S "$TUNNEL_SCREEN" -X quit >/dev/null 2>&1 || true
fi

if lsof -ti "tcp:$PORT" >/dev/null 2>&1; then
  lsof -ti "tcp:$PORT" | xargs -r kill 2>/dev/null || true
  echo "Cleared processes on port $PORT"
fi

pgrep -f "cloudflared.*http://127.0.0.1:$PORT|localtunnel.*--port $PORT" | xargs -r kill 2>/dev/null || true

echo "Fusion closed loop stopped."
