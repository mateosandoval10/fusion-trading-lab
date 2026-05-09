#!/usr/bin/env node
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const outDir = join(root, 'optimization-results', 'forward-tests');
const playbooksDir = join(root, 'optimization-results', 'models', 'playbooks');
if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

const args = new Map(process.argv.slice(2).map((arg) => {
  const [key, value = 'true'] = arg.replace(/^--/, '').split('=');
  return [key, value];
}));

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function fmtEt(timestampMs) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date(timestampMs));
}

function dateET(timestamp) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(timestamp * 1000));
}

function marketMinutesET(timestamp) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', hour12: false, hour: '2-digit', minute: '2-digit',
  }).formatToParts(new Date(timestamp * 1000));
  const hour = Number(parts.find((part) => part.type === 'hour')?.value || 0);
  const minute = Number(parts.find((part) => part.type === 'minute')?.value || 0);
  return (hour === 24 ? 0 : hour) * 60 + minute;
}

function summaryPathFrom(output) {
  return output.match(/Summary: (.*\.json)/)?.[1] || null;
}

function parseEtMinute(value, fallback) {
  if (!value) return fallback;
  const match = value.match(/^(\d{1,2}):(\d{2})$/);
  if (!match) throw new Error(`Expected HH:MM ET, got ${value}`);
  return Number(match[1]) * 60 + Number(match[2]);
}

function currentEtMinute() {
  return marketMinutesET(Math.floor(Date.now() / 1000));
}

const nowMinute = currentEtMinute();
const startMinute = parseEtMinute(args.get('start-et'), nowMinute);
const requestedEndMinute = parseEtMinute(args.get('end-et'), startMinute + Number(args.get('minutes') || 60));
const endMinute = Math.min(requestedEndMinute, 16 * 60);
const targetDate = args.get('date') || dateET(Math.floor(Date.now() / 1000));
const capital = Number(args.get('capital') || 100000);
const projectionCapital = Number(args.get('projection-capital') || 10000);
const lateSessionMode = args.get('late-session-mode') || 'block';
const lateSessionStart = parseEtMinute(args.get('late-session-start-et'), 15 * 60);
const championPath = args.get('champion') || join(playbooksDir, 'current-trigger-champion.json');
if (!existsSync(championPath)) throw new Error(`Missing champion file: ${championPath}`);
const champion = readJson(championPath).champion;
function acceptedFromChampion(champion) {
  if (champion?.acceptedTrades?.length) return champion.acceptedTrades;
  if (!champion?.routes?.length) return [];
  return champion.routes.map((route) => ({
    symbol: route.symbol,
    triggerMode: route.triggerMode,
    direction: route.direction,
    session: route.session,
    routeWinRate: route.test?.winRate || route.backtestWinRate || 0,
    routeAvgDollars: route.test?.avgDollars || route.test?.avgTrade || 0,
    combo: route.combo || {},
  }));
}
const accepted = acceptedFromChampion(champion);
if (!accepted.length) throw new Error(`${championPath} has no champion.acceptedTrades`);

const routeKeys = new Set(accepted.flatMap((trade) => [
  `${trade.symbol}|${trade.triggerMode}|${trade.direction}`,
  `${trade.symbol}|${trade.triggerMode}|${trade.direction || 'both'}`,
]));
const routeStats = new Map();
for (const trade of accepted) {
  const key = `${trade.symbol}|${trade.triggerMode}|${trade.direction}`;
  const item = routeStats.get(key) || { routeWinRate: [], routeAvgDollars: [], samples: 0 };
  if (Number.isFinite(trade.routeWinRate)) item.routeWinRate.push(trade.routeWinRate);
  if (Number.isFinite(trade.routeAvgDollars)) item.routeAvgDollars.push(trade.routeAvgDollars);
  item.samples += 1;
  routeStats.set(key, item);
}
for (const [key, item] of routeStats.entries()) {
  item.routeWinRate = item.routeWinRate.length ? item.routeWinRate.reduce((sum, value) => sum + value, 0) / item.routeWinRate.length : 0;
  item.routeAvgDollars = item.routeAvgDollars.length ? item.routeAvgDollars.reduce((sum, value) => sum + value, 0) / item.routeAvgDollars.length : 0;
  routeStats.set(key, item);
}
const symbols = [...new Set(accepted.map((trade) => trade.symbol))].sort();
const triggerModes = [...new Set(accepted.map((trade) => trade.triggerMode).filter(Boolean))].sort();
const directions = [...new Set(accepted.map((trade) => trade.direction).filter(Boolean))].sort();
const maxSymbols = Number(args.get('max-symbols') || 0);
const runSymbols = maxSymbols > 0 ? symbols.slice(0, maxSymbols) : symbols;

const localArgs = [
  `--symbols=${runSymbols.join(',')}`,
  '--interval=5m',
  '--range=5d',
  `--capital=${capital}`,
  '--fresh-data=true',
  '--playbook=Scalp',
  `--trigger-mode=${triggerModes.join('|')}`,
  `--min-conf=${args.get('min-conf') || 70}`,
  `--target-r=${args.get('target-r') || 0.35}`,
  '--exit-mode=smart',
  '--trail-r=0.5',
  `--time-stop-bars=${args.get('time-stop-bars') || 6}`,
  '--min-lead=65',
  '--min-edge=12',
  '--min-atr-ratio=0.9',
  '--min-adx=14',
  '--min-er=0.10',
  '--vol-mult=1.2',
  '--session=all',
  `--direction=${directions.join('|')}`,
  '--loss-cooldown-bars=0',
  '--max-vwap-atr=0',
  '--require-conf-rising=true',
  '--slippage-bps=1',
  '--spread-bps=2',
  '--min-move-to-cost=5',
  '--opening-range=off',
  '--htf-mode=not-against50',
  '--volume-quality=off',
  '--adaptive-target=false',
  '--max-consecutive-losses=0',
  '--cluster-cooldown-bars=0',
  '--min-price=1',
  '--max-price=0',
  '--min-dollar-volume=500000',
  '--gap-mode=off',
  '--daily-context=trend-day',
  '--pd-level-mode=off',
  '--market-mode=off',
  '--rel-vol-mode=off',
  '--min-rel-vol-tod=1',
  '--peer-mode=off',
  '--news-mode=off',
  `--min-alpha-quality=${args.get('min-alpha-quality') || 65}`,
  '--position-sizing=fixed',
  '--min-position-scale=1',
  '--max-position-scale=1',
  '--sample=all',
  '--train-pct=0.70',
  '--save-trades=true',
  '--promote=false',
  '--min-trades=0',
  '--min-symbols=1',
];

console.log(`Running current champion window paper test for ${targetDate}`);
console.log(`Window: ${Math.floor(startMinute / 60)}:${String(startMinute % 60).padStart(2, '0')}-${Math.floor(endMinute / 60)}:${String(endMinute % 60).padStart(2, '0')} ET`);
console.log(`Generated at ET: ${fmtEt(Date.now())}`);
console.log(`Universe: ${runSymbols.length} symbols, ${triggerModes.length} trigger families`);
const output = execFileSync('node', ['scripts/local_fusion_backtest.js', ...localArgs], {
  cwd: root,
  encoding: 'utf8',
  maxBuffer: 1024 * 1024 * 180,
  stdio: ['ignore', 'pipe', 'pipe'],
});
process.stdout.write(output.split('\n').slice(-12).join('\n'));
if (!output.endsWith('\n')) process.stdout.write('\n');
const summaryPath = summaryPathFrom(output);
if (!summaryPath) throw new Error('local_fusion_backtest did not emit a summary path');
const summary = readJson(summaryPath);
const tradesPath = summary.paths?.trades;
const rawTrades = tradesPath && existsSync(tradesPath)
  ? readFileSync(tradesPath, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
  : [];

const matchedTrades = rawTrades.filter((row) => {
  const trade = row.trade || {};
  const minutes = marketMinutesET(trade.entryTime);
  const simpleKey = `${row.symbol}|${row.combo?.triggerMode}|${row.combo?.direction}`;
  const bothKey = `${row.symbol}|${row.combo?.triggerMode}|both`;
  return dateET(trade.entryTime) === targetDate
    && minutes >= startMinute && minutes < endMinute
    && (routeKeys.has(simpleKey) || routeKeys.has(bothKey));
});

function routeStat(row) {
  const simpleKey = `${row.symbol}|${row.combo?.triggerMode}|${row.combo?.direction}`;
  const bothKey = `${row.symbol}|${row.combo?.triggerMode}|both`;
  return routeStats.get(simpleKey) || routeStats.get(bothKey) || { routeWinRate: 0, routeAvgDollars: 0, samples: 0 };
}

function signalKey(row) {
  return [
    row.symbol,
    row.combo?.triggerMode,
    row.trade?.side,
    row.trade?.entryTime,
  ].join('|');
}

function routePriority(row) {
  const stat = routeStat(row);
  const exactDirection = row.combo?.direction === row.trade?.side ? 1 : 0;
  const directionBoth = row.combo?.direction === 'both' ? 0.5 : 0;
  return exactDirection * 1_000_000
    + directionBoth * 500_000
    + (stat.routeWinRate || 0) * 10_000
    + Math.max(stat.routeAvgDollars || 0, 0)
    + Math.min(row.combo?.targetR || 0, 1);
}

function canonicalize(rows) {
  const bestBySignal = new Map();
  for (const row of rows) {
    const key = signalKey(row);
    const current = bestBySignal.get(key);
    if (!current || routePriority(row) > routePriority(current)) bestBySignal.set(key, row);
  }
  return [...bestBySignal.values()].sort((a, b) => (a.trade?.entryTime || 0) - (b.trade?.entryTime || 0));
}

function lateSessionAllowed(row) {
  if (lateSessionMode === 'off') return true;
  const minutes = marketMinutesET(row.trade?.entryTime);
  if (minutes < lateSessionStart) return true;
  if (lateSessionMode === 'strict') {
    const stat = routeStat(row);
    return (stat.routeWinRate || 0) >= 90
      && (stat.routeAvgDollars || 0) >= 500
      && (stat.samples || 0) >= 5
      && row.combo?.triggerMode !== 'momentum-acceleration';
  }
  return false;
}

const dedupedTrades = canonicalize(matchedTrades);
const blockedTrades = dedupedTrades.filter((row) => !lateSessionAllowed(row));
const trades = dedupedTrades.filter(lateSessionAllowed);
const wins = trades.filter((row) => (row.trade.pnlDollars || 0) > 0);
const losses = trades.filter((row) => (row.trade.pnlDollars || 0) <= 0);
const netDollars = trades.reduce((sum, row) => sum + (row.trade.pnlDollars || 0), 0);
const grossWin = wins.reduce((sum, row) => sum + (row.trade.pnlDollars || 0), 0);
const grossLoss = Math.abs(losses.reduce((sum, row) => sum + (row.trade.pnlDollars || 0), 0));
const scale = projectionCapital / capital;
const payload = {
  generatedAt: new Date().toISOString(),
  targetDate,
  mode: 'current-champion-current-window-forward-test',
  window: `${Math.floor(startMinute / 60)}:${String(startMinute % 60).padStart(2, '0')}-${Math.floor(endMinute / 60)}:${String(endMinute % 60).padStart(2, '0')} ET`,
  championPath,
  summaryPath,
  tradesPath,
  universe: { symbols: runSymbols.length, triggers: triggerModes, directions, championRouteKeys: routeKeys.size },
  guardrails: {
    duplicatePolicy: 'one canonical trade per symbol/trigger/side/entry-time',
    lateSessionMode,
    lateSessionStart: `${Math.floor(lateSessionStart / 60)}:${String(lateSessionStart % 60).padStart(2, '0')} ET`,
    matchedTrades: matchedTrades.length,
    canonicalTrades: dedupedTrades.length,
    blockedTrades: blockedTrades.length,
  },
  metrics: {
    trades: trades.length,
    wins: wins.length,
    losses: losses.length,
    winRate: trades.length ? wins.length / trades.length * 100 : 0,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? 999 : 0),
    netDollars,
    projectedNet: netDollars * scale,
    avgDollars: trades.length ? netDollars / trades.length : 0,
    projectedAvgDollars: trades.length ? netDollars * scale / trades.length : 0,
  },
  trades: trades.map((row) => ({
    symbol: row.symbol,
    triggerMode: row.combo?.triggerMode,
    session: row.combo?.session,
    direction: row.combo?.direction,
    side: row.trade.side,
    entryTime: new Date(row.trade.entryTime * 1000).toISOString(),
    exitTime: new Date(row.trade.exitTime * 1000).toISOString(),
    entry: row.trade.entry,
    exit: row.trade.exit,
    reason: row.trade.reason,
    pnlDollars: row.trade.pnlDollars,
    pnlR: row.trade.pnlR,
    mfeR: row.trade.mfeR,
    maeR: row.trade.maeR,
    confidence: row.trade.confidence,
    routeWinRate: routeStat(row).routeWinRate,
    routeAvgDollars: routeStat(row).routeAvgDollars,
  })),
  blockedTrades: blockedTrades.slice(0, 100).map((row) => ({
    symbol: row.symbol,
    triggerMode: row.combo?.triggerMode,
    direction: row.combo?.direction,
    side: row.trade.side,
    entryTime: new Date(row.trade.entryTime * 1000).toISOString(),
    reason: lateSessionMode === 'block' ? 'late-session-quarantine' : 'late-session-strict-filter',
    routeWinRate: routeStat(row).routeWinRate,
    routeAvgDollars: routeStat(row).routeAvgDollars,
  })),
};
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const outPath = join(outDir, `champion-current-window-${targetDate}-${stamp}.json`);
const latestPath = join(outDir, 'latest-champion-current-window-forward-test.json');
const ledgerPath = join(outDir, 'champion-forward-performance-ledger.jsonl');
writeFileSync(outPath, `${JSON.stringify(payload, null, 2)}\n`);
writeFileSync(latestPath, `${JSON.stringify(payload, null, 2)}\n`);
appendFileSync(ledgerPath, `${JSON.stringify({
  generatedAt: payload.generatedAt,
  targetDate: payload.targetDate,
  window: payload.window,
  mode: payload.mode,
  metrics: payload.metrics,
  guardrails: payload.guardrails,
  outputPath: outPath,
})}\n`);

const trustPath = join(outDir, 'route-forward-trust.json');
const trust = existsSync(trustPath) ? readJson(trustPath) : { updatedAt: null, routes: {} };
for (const trade of payload.trades) {
  const key = `${trade.symbol}|${trade.session || 'all'}|${trade.direction || trade.side}|${trade.triggerMode}`;
  const item = trust.routes[key] || { trades: 0, wins: 0, netDollars: 0, grossWin: 0, grossLoss: 0, lastSeen: null };
  item.trades += 1;
  if ((trade.pnlDollars || 0) > 0) item.wins += 1;
  item.netDollars += trade.pnlDollars || 0;
  if ((trade.pnlDollars || 0) > 0) item.grossWin += trade.pnlDollars || 0;
  else item.grossLoss += Math.abs(trade.pnlDollars || 0);
  item.lastSeen = payload.generatedAt;
  item.winRate = item.trades ? item.wins / item.trades * 100 : 0;
  item.profitFactor = item.grossLoss > 0 ? item.grossWin / item.grossLoss : (item.grossWin > 0 ? 999 : 0);
  trust.routes[key] = item;
}
trust.updatedAt = payload.generatedAt;
writeFileSync(trustPath, `${JSON.stringify(trust, null, 2)}\n`);
console.log(`\nForward window test saved: ${outPath}`);
console.log(`Latest saved: ${latestPath}`);
console.log(`Forward ledger: ${ledgerPath}`);
console.log(`Forward trust: ${trustPath}`);
console.log(`Champion window trades=${payload.metrics.trades} win=${payload.metrics.winRate.toFixed(2)}% pf=${payload.metrics.profitFactor.toFixed(2)} net=$${payload.metrics.netDollars.toFixed(0)} projected=$${payload.metrics.projectedNet.toFixed(0)} avg=$${payload.metrics.projectedAvgDollars.toFixed(2)}`);
console.log(`Guardrails matched=${payload.guardrails.matchedTrades} canonical=${payload.guardrails.canonicalTrades} blocked=${payload.guardrails.blockedTrades} lateSessionMode=${lateSessionMode}`);
for (const trade of payload.trades.slice(0, 30)) {
  console.log(`${trade.symbol} ${trade.side} ${trade.triggerMode} ${trade.entryTime} -> ${trade.reason} pnl=$${trade.pnlDollars.toFixed(0)} R=${trade.pnlR.toFixed(2)}`);
}
