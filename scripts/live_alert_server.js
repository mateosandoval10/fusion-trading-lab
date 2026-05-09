#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const liveDir = join(root, 'optimization-results', 'live-alerts');
mkdirSync(liveDir, { recursive: true });

const args = new Map(process.argv.slice(2).map((arg) => {
  const [key, value = 'true'] = arg.replace(/^--/, '').split('=');
  return [key, value];
}));

const host = args.get('host') || '127.0.0.1';
const port = Number(args.get('port') || process.env.FUSION_ALERT_PORT || 8787);
const ledgerPath = args.get('ledger') || join(liveDir, 'tradingview-alert-ledger.jsonl');
const latestPath = join(liveDir, 'latest-tradingview-alert.json');
const statusPath = join(liveDir, 'live-alert-server-status.json');

function readBody(request) {
  return new Promise((resolve, reject) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => {
      body += chunk;
      if (body.length > 1024 * 1024) {
        reject(new Error('Request body too large'));
        request.destroy();
      }
    });
    request.on('end', () => resolve(body));
    request.on('error', reject);
  });
}

function readJson(path, fallback) {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return fallback;
  }
}

function parseAlert(raw) {
  const trimmed = String(raw || '').trim();
  if (!trimmed) return {};
  try {
    return JSON.parse(trimmed);
  } catch {
    return { event: 'raw_tradingview_alert', message: trimmed };
  }
}

function normalizeSymbol(symbol = '') {
  return String(symbol).toUpperCase().replace(/^.*:/, '').trim();
}

function signalId(alert, receivedAt) {
  const key = [
    alert.event || 'fusion_signal',
    normalizeSymbol(alert.symbol || alert.tickerid),
    alert.side || '',
    alert.routeKey || '',
    alert.barTime || '',
    alert.entry || '',
    receivedAt.slice(0, 16),
  ].join('|');
  return createHash('sha256').update(key).digest('hex').slice(0, 24);
}

function normalizeAlert(alert, raw, request) {
  const receivedAt = new Date().toISOString();
  const id = signalId(alert, receivedAt);
  const symbol = normalizeSymbol(alert.symbol || alert.tickerid);
  const normalized = {
    id,
    receivedAt,
    source: 'tradingview-webhook',
    remoteAddress: request.socket.remoteAddress,
    event: alert.event || 'fusion_signal',
    schema: alert.schema || 'unknown',
    model: alert.model || 'unknown',
    symbol,
    tickerid: alert.tickerid || symbol,
    side: String(alert.side || '').toUpperCase(),
    mode: alert.mode || 'unknown',
    triggerMode: alert.triggerMode || 'unknown',
    archetype: alert.archetype || 'unknown',
    session: alert.session || 'unknown',
    direction: alert.direction || 'unknown',
    routeKey: alert.routeKey || '',
    regime: alert.regime || 'unknown',
    confidence: Number(alert.confidence || 0),
    bullPct: Number(alert.bullPct || 0),
    bearPct: Number(alert.bearPct || 0),
    alphaBuy: Number(alert.alphaBuy || 0),
    alphaSell: Number(alert.alphaSell || 0),
    entry: Number(alert.entry || 0),
    sl: Number(alert.sl || 0),
    tp1: Number(alert.tp1 || 0),
    targetR: Number(alert.targetR || 0),
    timeStopBars: Number(alert.timeStopBars || 12),
    barTime: Number(alert.barTime || 0),
    timeframe: alert.timeframe || '5',
    status: alert.status || 'unknown',
    noTradeReason: alert.noTradeReason || '',
    raw,
  };
  if (!normalized.routeKey && normalized.symbol) {
    normalized.routeKey = [
      normalized.symbol,
      normalized.archetype,
      normalized.triggerMode,
      normalized.session,
      normalized.direction,
      normalized.targetR,
      normalized.timeStopBars,
      normalized.triggerMode === 'Hybrid Consensus' || normalized.triggerMode === 'Confirmed No-Repaint' ? 'strict' : 'loose',
    ].join('|');
  }
  return normalized;
}

function updateStatus(extra = {}) {
  const prior = readJson(statusPath, { totalAlerts: 0 });
  const status = {
    ...prior,
    ...extra,
    updatedAt: new Date().toISOString(),
    host,
    port,
    ledgerPath,
    latestPath,
    webhookPath: '/tradingview-alert',
    localWebhookUrl: `http://${host}:${port}/tradingview-alert`,
  };
  writeFileSync(statusPath, `${JSON.stringify(status, null, 2)}\n`);
  return status;
}

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    'content-type': 'application/json',
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'access-control-allow-headers': 'content-type',
  });
  response.end(`${JSON.stringify(payload, null, 2)}\n`);
}

const server = createServer(async (request, response) => {
  try {
    if (request.method === 'OPTIONS') {
      sendJson(response, 200, { ok: true });
      return;
    }
    if (request.method === 'GET' && (request.url === '/' || request.url === '/health')) {
      sendJson(response, 200, {
        ok: true,
        ...updateStatus(),
        instructions: [
          'In TradingView, create an alert on the Fusion indicator.',
          'Condition: Any alert() function call.',
          `Webhook URL: http://${host}:${port}/tradingview-alert`,
          'This stores paper-learning signals only; it does not place trades.',
        ],
      });
      return;
    }
    if (request.method !== 'POST' || !request.url?.startsWith('/tradingview-alert')) {
      sendJson(response, 404, { ok: false, error: 'Use POST /tradingview-alert' });
      return;
    }
    const raw = await readBody(request);
    const parsed = parseAlert(raw);
    const alert = normalizeAlert(parsed, raw, request);
    appendFileSync(ledgerPath, `${JSON.stringify(alert)}\n`);
    writeFileSync(latestPath, `${JSON.stringify(alert, null, 2)}\n`);
    const status = updateStatus({
      totalAlerts: (readJson(statusPath, { totalAlerts: 0 }).totalAlerts || 0) + 1,
      lastAlertAt: alert.receivedAt,
      lastSignalId: alert.id,
      lastSymbol: alert.symbol,
      lastMode: alert.mode,
    });
    sendJson(response, 200, { ok: true, alert, status });
  } catch (error) {
    sendJson(response, 500, { ok: false, error: error.message });
  }
});

server.listen(port, host, () => {
  const status = updateStatus({ startedAt: new Date().toISOString() });
  console.log(`Fusion live alert server listening: ${status.localWebhookUrl}`);
  console.log(`Ledger: ${ledgerPath}`);
  console.log('TradingView alert condition: Any alert() function call');
});
