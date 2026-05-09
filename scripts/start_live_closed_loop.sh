#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LIVE_DIR="$ROOT/optimization-results/live-alerts"
PORT="${FUSION_ALERT_PORT:-8787}"
HOST="${FUSION_ALERT_HOST:-127.0.0.1}"
mkdir -p "$LIVE_DIR"

SERVER_LOG="$LIVE_DIR/live-alert-server.log"
TUNNEL_LOG="$LIVE_DIR/live-alert-tunnel.log"
STATUS_JSON="$LIVE_DIR/live-closed-loop-status.json"
SERVER_PID_FILE="$LIVE_DIR/live-alert-server.pid"
TUNNEL_PID_FILE="$LIVE_DIR/live-alert-tunnel.pid"
CLOUDFLARED_BIN="$ROOT/bin/cloudflared"
TUNNEL_PROVIDER="${FUSION_TUNNEL_PROVIDER:-cloudflared}"
SERVER_SCREEN="fusion-alert-server"
TUNNEL_SCREEN="fusion-alert-tunnel"

stop_pid_file() {
  local file="$1"
  if [[ -f "$file" ]]; then
    local pid
    pid="$(cat "$file" || true)"
    if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null || true
      sleep 1
    fi
    rm -f "$file"
  fi
}

stop_pid_file "$SERVER_PID_FILE"
stop_pid_file "$TUNNEL_PID_FILE"
if command -v screen >/dev/null 2>&1; then
  screen -S "$SERVER_SCREEN" -X quit >/dev/null 2>&1 || true
  screen -S "$TUNNEL_SCREEN" -X quit >/dev/null 2>&1 || true
fi

if lsof -ti "tcp:$PORT" >/dev/null 2>&1; then
  lsof -ti "tcp:$PORT" | xargs -r kill 2>/dev/null || true
  sleep 1
fi

cd "$ROOT"
: > "$SERVER_LOG"
: > "$TUNNEL_LOG"

if command -v screen >/dev/null 2>&1; then
  screen -dmS "$SERVER_SCREEN" bash -lc "cd '$ROOT' && node scripts/live_alert_server.js --host='$HOST' --port='$PORT' >> '$SERVER_LOG' 2>&1"
else
  nohup node scripts/live_alert_server.js --host="$HOST" --port="$PORT" >> "$SERVER_LOG" 2>&1 &
  echo "$!" > "$SERVER_PID_FILE"
fi

for _ in {1..30}; do
  if grep -q "Fusion live alert server listening" "$SERVER_LOG"; then
    break
  fi
  sleep 1
done

if ! grep -q "Fusion live alert server listening" "$SERVER_LOG"; then
  echo "Alert server did not start. Log: $SERVER_LOG" >&2
  tail -80 "$SERVER_LOG" >&2 || true
  exit 1
fi
SERVER_PID="$(lsof -ti "tcp:$PORT" | tail -1 || true)"
echo "${SERVER_PID:-0}" > "$SERVER_PID_FILE"

if [[ "$TUNNEL_PROVIDER" == "cloudflared" && -x "$CLOUDFLARED_BIN" ]]; then
  if command -v screen >/dev/null 2>&1; then
    screen -dmS "$TUNNEL_SCREEN" bash -lc "'$CLOUDFLARED_BIN' tunnel --url 'http://$HOST:$PORT' --no-autoupdate >> '$TUNNEL_LOG' 2>&1"
  else
    nohup "$CLOUDFLARED_BIN" tunnel --url "http://$HOST:$PORT" --no-autoupdate >> "$TUNNEL_LOG" 2>&1 &
    echo "$!" > "$TUNNEL_PID_FILE"
  fi
else
  TUNNEL_PROVIDER="localtunnel"
  if command -v screen >/dev/null 2>&1; then
    screen -dmS "$TUNNEL_SCREEN" bash -lc "cd '$ROOT' && npx --yes localtunnel --port '$PORT' --local-host '$HOST' >> '$TUNNEL_LOG' 2>&1"
  else
    nohup npx --yes localtunnel --port "$PORT" --local-host "$HOST" >> "$TUNNEL_LOG" 2>&1 &
    echo "$!" > "$TUNNEL_PID_FILE"
  fi
fi

PUBLIC_URL=""
for _ in {1..90}; do
  if [[ "$TUNNEL_PROVIDER" == "cloudflared" ]]; then
    PUBLIC_URL="$(grep -Eo 'https://[a-zA-Z0-9.-]+\.trycloudflare\.com' "$TUNNEL_LOG" | tail -1 || true)"
  else
    PUBLIC_URL="$(grep -Eo 'https://[a-zA-Z0-9.-]+\.loca\.lt' "$TUNNEL_LOG" | tail -1 || true)"
  fi
  if [[ -n "$PUBLIC_URL" ]]; then
    break
  fi
  sleep 1
done

if [[ -z "$PUBLIC_URL" ]]; then
  echo "Tunnel did not expose a URL yet. Log: $TUNNEL_LOG" >&2
  tail -120 "$TUNNEL_LOG" >&2 || true
  exit 1
fi
TUNNEL_PID="$(pgrep -f "cloudflared.*http://$HOST:$PORT|localtunnel.*--port $PORT" | tail -1 || true)"
if [[ -z "$TUNNEL_PID" ]]; then
  TUNNEL_PID="$(pgrep -f "$TUNNEL_SCREEN|$CLOUDFLARED_BIN|localtunnel" | tail -1 || true)"
fi
echo "${TUNNEL_PID:-0}" > "$TUNNEL_PID_FILE"

WEBHOOK_URL="$PUBLIC_URL/tradingview-alert"

cat > "$STATUS_JSON" <<JSON
{
  "updatedAt": "$(date -u +"%Y-%m-%dT%H:%M:%SZ")",
  "host": "$HOST",
  "port": $PORT,
  "serverPid": $(cat "$SERVER_PID_FILE"),
  "tunnelPid": $(cat "$TUNNEL_PID_FILE"),
  "tunnelProvider": "$TUNNEL_PROVIDER",
  "processManager": "$(command -v screen >/dev/null 2>&1 && echo screen || echo nohup)",
  "publicUrl": "$PUBLIC_URL",
  "webhookUrl": "$WEBHOOK_URL",
  "serverLog": "$SERVER_LOG",
  "tunnelLog": "$TUNNEL_LOG",
  "ledgerPath": "$LIVE_DIR/tradingview-alert-ledger.jsonl",
  "tradingViewCondition": "Any alert() function call"
}
JSON

echo "Fusion closed loop is running."
echo "Webhook URL: $WEBHOOK_URL"
echo "Status: $STATUS_JSON"
echo "Server log: $SERVER_LOG"
echo "Tunnel log: $TUNNEL_LOG"
