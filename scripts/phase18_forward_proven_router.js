#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const outDir = join(root, 'optimization-results');
const liveDir = join(outDir, 'live-alerts');
const forwardDir = join(outDir, 'forward-tests');
const dataCacheDir = join(outDir, 'data-cache');
for (const dir of [liveDir, forwardDir, dataCacheDir]) mkdirSync(dir, { recursive: true });

const args = new Map(process.argv.slice(2).map((arg) => {
  const [key, value = 'true'] = arg.replace(/^--/, '').split('=');
  return [key, value];
}));

const ledgerPath = args.get('ledger') || join(liveDir, 'tradingview-alert-ledger.jsonl');
const outcomesPath = args.get('outcomes') || join(forwardDir, 'phase18-forward-outcomes.jsonl');
const trustPath = args.get('trust') || join(forwardDir, 'phase18-forward-route-trust.json');
const phase17TrustPath = args.get('phase17-trust') || join(forwardDir, 'phase17-forward-route-trust.json');
const interval = args.get('interval') || '5m';
const range = args.get('range') || '5d';
const capital = Number(args.get('capital') || 100000);
const minAgeMinutes = Number(args.get('min-age-minutes') || 20);
const defaultTimeStopBars = Number(args.get('time-stop-bars') || 12);
const writePhase17Trust = args.get('write-phase17-trust') !== 'false';

function readJson(path, fallback) {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return fallback;
  }
}

function readJsonl(path) {
  if (!existsSync(path)) return [];
  const raw = readFileSync(path, 'utf8').trim();
  if (!raw) return [];
  return raw.split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

function writeJson(path, payload) {
  writeFileSync(path, `${JSON.stringify(payload, null, 2)}\n`);
}

function normalizeSymbol(symbol = '') {
  return String(symbol).toUpperCase().replace(/^.*:/, '').trim();
}

function tvTriggerToRoute(trigger = '') {
  return String(trigger)
    .trim()
    .replace(/([a-z])([A-Z])/g, '$1-$2')
    .replace(/\s+/g, '-')
    .toLowerCase();
}

function tvSessionToRoute(session = '') {
  const value = String(session).toLowerCase();
  if (value.includes('power')) return 'powerhour';
  if (value.includes('9:30-10')) return 'open-0930';
  if (value.includes('10-10:30')) return 'open-1000';
  if (value.includes('10:30')) return 'open-1030';
  if (value.includes('morning')) return 'morning';
  if (value.includes('midday')) return 'midday';
  if (value.includes('afternoon')) return 'afternoon';
  return 'all';
}

function tvDirectionToRoute(direction = '', side = '') {
  const value = String(direction).toLowerCase();
  if (value.includes('long')) return 'long';
  if (value.includes('short')) return 'short';
  if (value.includes('both')) return 'both';
  return String(side).toUpperCase() === 'SELL' ? 'short' : 'long';
}

function inferArchetype(triggerMode = '') {
  const trigger = tvTriggerToRoute(triggerMode);
  if (['options-burst', 'volume-shock', 'momentum-acceleration'].includes(trigger)) return 'profit_momentum';
  if (['breakout', 'opening-range', 'opening-drive-continuation', 'squeeze-expansion', 'compression-pop'].includes(trigger)) return 'breakout_expansion';
  if (['vwap-reclaim', 'ema-pullback', 'relative-strength-reclaim'].includes(trigger)) return 'structure_reclaim';
  if (['liquidity-sweep', 'mean-reversion', 'failed-reversal'].includes(trigger)) return 'reversal_sweep';
  return 'high_win_confirmed';
}

function phase17RouteId(alert) {
  if (alert.routeKey && String(alert.routeKey).split('|').length >= 8) {
    const [symbol, archetype, triggerMode, session, direction, targetR, timeStopBars, structureExit] = String(alert.routeKey).split('|');
    return [
      normalizeSymbol(symbol),
      archetype || inferArchetype(alert.triggerMode),
      tvTriggerToRoute(triggerMode || alert.triggerMode),
      tvSessionToRoute(session || alert.session),
      tvDirectionToRoute(direction || alert.direction, alert.side),
      Number(targetR || alert.targetR || 0.5),
      Number(timeStopBars || alert.timeStopBars || defaultTimeStopBars),
      structureExit || (String(alert.triggerMode).includes('Confirmed') || String(alert.triggerMode).includes('Hybrid') ? 'strict' : 'loose'),
    ].join('|');
  }
  return [
    normalizeSymbol(alert.symbol || alert.tickerid),
    alert.archetype && alert.archetype !== 'unknown' ? alert.archetype : inferArchetype(alert.triggerMode),
    tvTriggerToRoute(alert.triggerMode),
    tvSessionToRoute(alert.session),
    tvDirectionToRoute(alert.direction, alert.side),
    Number(alert.targetR || 0.5),
    Number(alert.timeStopBars || defaultTimeStopBars),
    String(alert.triggerMode).includes('Confirmed') || String(alert.triggerMode).includes('Hybrid') ? 'strict' : 'loose',
  ].join('|');
}

function signalTime(alert) {
  if (Number(alert.barTime) > 0) {
    const value = Number(alert.barTime);
    return value > 100000000000 ? Math.floor(value / 1000) : value;
  }
  return Math.floor(new Date(alert.receivedAt).getTime() / 1000);
}

function cachePath(symbol) {
  return join(dataCacheDir, `${symbol.replace(/[^A-Z0-9.-]/gi, '_')}-${range}-${interval}-phase18.json`);
}

async function fetchBars(symbol) {
  const clean = normalizeSymbol(symbol);
  const path = cachePath(clean);
  const cached = readJson(path, null);
  if (cached?.fetchedAt && Date.now() - new Date(cached.fetchedAt).getTime() < 60_000 && Array.isArray(cached.bars)) return cached.bars;
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(clean)}?interval=${encodeURIComponent(interval)}&range=${encodeURIComponent(range)}&includePrePost=false`;
  const response = await fetch(url, { headers: { 'user-agent': 'fusion-phase18-forward-router' } });
  if (!response.ok) throw new Error(`${clean} Yahoo fetch failed ${response.status}`);
  const json = await response.json();
  const result = json.chart?.result?.[0];
  const timestamps = result?.timestamp || [];
  const quote = result?.indicators?.quote?.[0] || {};
  const bars = timestamps.map((time, index) => ({
    time,
    open: quote.open?.[index],
    high: quote.high?.[index],
    low: quote.low?.[index],
    close: quote.close?.[index],
    volume: quote.volume?.[index],
  })).filter((bar) => Number.isFinite(bar.open) && Number.isFinite(bar.high) && Number.isFinite(bar.low) && Number.isFinite(bar.close));
  writeJson(path, { fetchedAt: new Date().toISOString(), symbol: clean, interval, range, bars });
  return bars;
}

function scoreAlert(alert, bars) {
  const side = String(alert.side || '').toUpperCase();
  const entry = Number(alert.entry || 0);
  const sl = Number(alert.sl || 0);
  const tp1 = Number(alert.tp1 || 0);
  if (!['BUY', 'SELL'].includes(side) || entry <= 0 || sl <= 0 || tp1 <= 0) return null;
  const start = signalTime(alert);
  const startIndex = bars.findIndex((bar) => bar.time >= start);
  if (startIndex < 0) return null;
  const horizon = Math.max(1, Number(alert.timeStopBars || defaultTimeStopBars));
  const endIndex = Math.min(bars.length - 1, startIndex + horizon);
  if (endIndex <= startIndex) return null;
  const risk = Math.abs(entry - sl);
  if (risk <= 0) return null;
  let exit = bars[endIndex].close;
  let exitTime = bars[endIndex].time;
  let reason = 'time-stop';
  let maxHigh = -Infinity;
  let minLow = Infinity;
  for (let index = startIndex; index <= endIndex; index += 1) {
    const bar = bars[index];
    maxHigh = Math.max(maxHigh, bar.high);
    minLow = Math.min(minLow, bar.low);
    if (side === 'BUY') {
      const touchSL = bar.low <= sl;
      const touchTP = bar.high >= tp1;
      if (touchSL && touchTP) {
        exit = sl;
        exitTime = bar.time;
        reason = 'same-bar-sl-first';
        break;
      }
      if (touchSL) {
        exit = sl;
        exitTime = bar.time;
        reason = 'stop';
        break;
      }
      if (touchTP) {
        exit = tp1;
        exitTime = bar.time;
        reason = 'target';
        break;
      }
    } else {
      const touchSL = bar.high >= sl;
      const touchTP = bar.low <= tp1;
      if (touchSL && touchTP) {
        exit = sl;
        exitTime = bar.time;
        reason = 'same-bar-sl-first';
        break;
      }
      if (touchSL) {
        exit = sl;
        exitTime = bar.time;
        reason = 'stop';
        break;
      }
      if (touchTP) {
        exit = tp1;
        exitTime = bar.time;
        reason = 'target';
        break;
      }
    }
  }
  const pnlPerShare = side === 'BUY' ? exit - entry : entry - exit;
  const pnlR = pnlPerShare / risk;
  const pnlDollars = capital * pnlPerShare / entry;
  const mfeR = side === 'BUY' ? (maxHigh - entry) / risk : (entry - minLow) / risk;
  const maeR = side === 'BUY' ? (entry - minLow) / risk : (maxHigh - entry) / risk;
  return {
    signalId: alert.id,
    routeId: phase17RouteId(alert),
    symbol: normalizeSymbol(alert.symbol || alert.tickerid),
    side,
    mode: alert.mode,
    triggerMode: alert.triggerMode,
    session: alert.session,
    direction: alert.direction,
    entryTime: new Date(start * 1000).toISOString(),
    exitTime: new Date(exitTime * 1000).toISOString(),
    entry,
    sl,
    tp1,
    exit,
    reason,
    pnlR,
    pnlDollars,
    mfeR,
    maeR,
    confidence: Number(alert.confidence || 0),
    targetR: Number(alert.targetR || 0),
    timeStopBars: horizon,
    scoredAt: new Date().toISOString(),
  };
}

function mergeTrust(trust, outcome) {
  const item = trust.routes[outcome.routeId] || {
    routeId: outcome.routeId,
    symbol: outcome.symbol,
    triggerMode: tvTriggerToRoute(outcome.triggerMode),
    session: tvSessionToRoute(outcome.session),
    direction: tvDirectionToRoute(outcome.direction, outcome.side),
    trades: 0,
    wins: 0,
    netDollars: 0,
    grossWin: 0,
    grossLoss: 0,
    lastSeen: null,
    signalIds: [],
  };
  if (!Array.isArray(item.signalIds)) item.signalIds = [];
  if (item.signalIds.includes(outcome.signalId)) return;
  item.trades += 1;
  if (outcome.pnlDollars > 0) {
    item.wins += 1;
    item.grossWin += outcome.pnlDollars;
  } else {
    item.grossLoss += Math.abs(outcome.pnlDollars);
  }
  item.netDollars += outcome.pnlDollars;
  item.lastSeen = outcome.scoredAt;
  item.signalIds = [...item.signalIds, outcome.signalId].slice(-500);
  item.winRate = item.trades ? item.wins / item.trades * 100 : 0;
  item.profitFactor = item.grossLoss > 0 ? item.grossWin / item.grossLoss : item.grossWin > 0 ? 999 : 0;
  trust.routes[outcome.routeId] = item;
}

const alerts = readJsonl(ledgerPath)
  .filter((alert) => alert.event === 'fusion_signal')
  .filter((alert) => alert.schema !== 'test' && alert.mode !== 'Tunnel Smoke Test')
  .filter((alert) => Date.now() - signalTime(alert) * 1000 >= minAgeMinutes * 60_000);
const existingOutcomes = readJsonl(outcomesPath);
const scoredIds = new Set(existingOutcomes.map((outcome) => outcome.signalId));
const pending = alerts.filter((alert) => !scoredIds.has(alert.id));

const outcomes = [];
for (const alert of pending) {
  try {
    const bars = await fetchBars(alert.symbol || alert.tickerid);
    const outcome = scoreAlert(alert, bars);
    if (outcome) outcomes.push(outcome);
  } catch (error) {
    outcomes.push({
      signalId: alert.id,
      routeId: phase17RouteId(alert),
      symbol: normalizeSymbol(alert.symbol || alert.tickerid),
      error: error.message,
      scoredAt: new Date().toISOString(),
    });
  }
}

for (const outcome of outcomes) appendFileSync(outcomesPath, `${JSON.stringify(outcome)}\n`);

const cleanOutcomes = outcomes.filter((outcome) => Number.isFinite(outcome.pnlDollars));
const phase18Trust = readJson(trustPath, { updatedAt: null, source: 'phase18-forward-proven-router', routes: {} });
const phase17Trust = readJson(phase17TrustPath, { updatedAt: null, source: 'phase17-forward-route-trust', routes: {} });
for (const outcome of cleanOutcomes) {
  mergeTrust(phase18Trust, outcome);
  if (writePhase17Trust) mergeTrust(phase17Trust, outcome);
}
phase18Trust.updatedAt = new Date().toISOString();
phase18Trust.outcomesPath = outcomesPath;
writeJson(trustPath, phase18Trust);
if (writePhase17Trust) {
  phase17Trust.updatedAt = new Date().toISOString();
  phase17Trust.outcomesPath = outcomesPath;
  writeJson(phase17TrustPath, phase17Trust);
}

const wins = cleanOutcomes.filter((outcome) => outcome.pnlDollars > 0);
const grossWin = wins.reduce((sum, outcome) => sum + outcome.pnlDollars, 0);
const grossLoss = Math.abs(cleanOutcomes.filter((outcome) => outcome.pnlDollars <= 0).reduce((sum, outcome) => sum + outcome.pnlDollars, 0));
const summary = {
  updatedAt: new Date().toISOString(),
  ledgerPath,
  outcomesPath,
  trustPath,
  phase17TrustPath: writePhase17Trust ? phase17TrustPath : null,
  alerts: alerts.length,
  pending: pending.length,
  scored: cleanOutcomes.length,
  errors: outcomes.filter((outcome) => outcome.error).length,
  metrics: {
    trades: cleanOutcomes.length,
    wins: wins.length,
    losses: cleanOutcomes.length - wins.length,
    winRate: cleanOutcomes.length ? wins.length / cleanOutcomes.length * 100 : 0,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? 999 : 0,
    netDollars: cleanOutcomes.reduce((sum, outcome) => sum + outcome.pnlDollars, 0),
    avgDollars: cleanOutcomes.length ? cleanOutcomes.reduce((sum, outcome) => sum + outcome.pnlDollars, 0) / cleanOutcomes.length : 0,
  },
};
writeJson(join(forwardDir, 'latest-phase18-forward-proven-summary.json'), summary);

console.log('Phase18 forward-proven router complete');
console.log(`Alerts mature=${summary.alerts} pending=${summary.pending} scored=${summary.scored} errors=${summary.errors}`);
console.log(`Forward metrics trades=${summary.metrics.trades} win=${summary.metrics.winRate.toFixed(2)}% pf=${summary.metrics.profitFactor.toFixed(2)} net=$${summary.metrics.netDollars.toFixed(0)} avg=$${summary.metrics.avgDollars.toFixed(0)}`);
console.log(`Outcomes: ${outcomesPath}`);
console.log(`Trust: ${trustPath}`);
if (writePhase17Trust) console.log(`Phase17 trust updated: ${phase17TrustPath}`);
