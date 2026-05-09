#!/usr/bin/env node
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const outDir = join(root, 'optimization-results', 'forward-tests');
const playbooksDir = join(root, 'optimization-results', 'models', 'playbooks');
for (const dir of [outDir, playbooksDir]) mkdirSync(dir, { recursive: true });

const args = new Map(process.argv.slice(2).map((arg) => {
  const [key, value = 'true'] = arg.replace(/^--/, '').split('=');
  return [key, value];
}));

function readJson(path, fallback = null) {
  if (!existsSync(path)) return fallback;
  return JSON.parse(readFileSync(path, 'utf8'));
}

function dateET(timestamp) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(timestamp * 1000));
}

function fmtEt(timestampMs) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(timestampMs));
}

function marketMinutesET(timestamp) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(new Date(timestamp * 1000));
  const hour = Number(parts.find((part) => part.type === 'hour')?.value || 0);
  const minute = Number(parts.find((part) => part.type === 'minute')?.value || 0);
  return (hour === 24 ? 0 : hour) * 60 + minute;
}

function parseEtMinute(value, fallback) {
  if (!value) return fallback;
  const match = value.match(/^(\d{1,2}):(\d{2})$/);
  if (!match) throw new Error(`Expected HH:MM ET, got ${value}`);
  return Number(match[1]) * 60 + Number(match[2]);
}

function minuteLabel(minute) {
  return `${Math.floor(minute / 60)}:${String(minute % 60).padStart(2, '0')}`;
}

function summaryPathFrom(output) {
  return output.match(/Summary: (.*\.json)/)?.[1] || null;
}

function tradesPathFrom(output, summaryPath) {
  const direct = output.match(/Trades: (.*\.jsonl)/)?.[1];
  if (direct) return direct;
  const summary = summaryPath ? readJson(summaryPath, null) : null;
  return summary?.paths?.trades || null;
}

function routeKey(route) {
  return [
    route.symbol,
    route.archetype || route.combo?.archetype || 'route',
    route.triggerMode,
    route.session,
    route.direction,
    route.targetR,
    route.combo?.timeStopBars,
    route.combo?.structureExit,
  ].join('|');
}

function metrics(rows, projectionCapital, capital) {
  const wins = rows.filter((row) => (row.trade.pnlDollars || 0) > 0);
  const losses = rows.filter((row) => (row.trade.pnlDollars || 0) <= 0);
  const grossWin = wins.reduce((sum, row) => sum + (row.trade.pnlDollars || 0), 0);
  const grossLoss = Math.abs(losses.reduce((sum, row) => sum + (row.trade.pnlDollars || 0), 0));
  let equity = 0;
  let peak = 0;
  let maxDrawdownDollars = 0;
  let maxLossStreak = 0;
  let lossStreak = 0;
  for (const row of rows) {
    equity += row.trade.pnlDollars || 0;
    if ((row.trade.pnlDollars || 0) > 0) {
      lossStreak = 0;
    } else {
      lossStreak += 1;
      maxLossStreak = Math.max(maxLossStreak, lossStreak);
    }
    peak = Math.max(peak, equity);
    maxDrawdownDollars = Math.max(maxDrawdownDollars, peak - equity);
  }
  const netDollars = rows.reduce((sum, row) => sum + (row.trade.pnlDollars || 0), 0);
  const scale = projectionCapital / capital;
  return {
    trades: rows.length,
    wins: wins.length,
    losses: losses.length,
    winRate: rows.length ? wins.length / rows.length * 100 : 0,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? 999 : 0,
    netDollars,
    projectedNet: netDollars * scale,
    avgDollars: rows.length ? netDollars / rows.length : 0,
    projectedAvgDollars: rows.length ? netDollars * scale / rows.length : 0,
    maxDrawdownDollars,
    maxLossStreak,
    avgMfeR: rows.length ? rows.reduce((sum, row) => sum + (row.trade.mfeR || 0), 0) / rows.length : 0,
    avgMaeR: rows.length ? rows.reduce((sum, row) => sum + (row.trade.maeR || 0), 0) / rows.length : 0,
    optionWorthyRate: rows.length ? rows.filter((row) => row.trade.optionWorthy).length / rows.length * 100 : 0,
  };
}

function canonicalSignalKey(row) {
  return [
    row.symbol,
    row.combo?.phase17RouteId,
    row.trade?.side,
    row.trade?.entryTime,
  ].join('|');
}

function routePriority(row, route) {
  return (route?.selectionScore || 0)
    + (route?.holdout?.winRate || 0) * 100
    + Math.max(route?.holdout?.avgDollars || 0, 0)
    + (route?.recent?.winRate || 0) * 50
    + Math.max(route?.recent?.avgDollars || 0, 0) * 0.5;
}

function canonicalize(rows, routeById) {
  const bestBySignal = new Map();
  for (const row of rows) {
    const key = canonicalSignalKey(row);
    const current = bestBySignal.get(key);
    const route = routeById.get(row.combo?.phase17RouteId);
    const currentRoute = current ? routeById.get(current.combo?.phase17RouteId) : null;
    if (!current || routePriority(row, route) > routePriority(current, currentRoute)) bestBySignal.set(key, row);
  }
  return [...bestBySignal.values()].sort((a, b) => (a.trade?.entryTime || 0) - (b.trade?.entryTime || 0));
}

function replayPortfolio(rows, routeById, mode, maxConcurrent) {
  const accepted = [];
  const blocked = [];
  const recentSymbolLosses = new Map();
  for (const row of rows) {
    const route = routeById.get(row.combo?.phase17RouteId);
    const open = accepted.filter((item) => item.trade.exitTime > row.trade.entryTime);
    if (open.length >= maxConcurrent) {
      blocked.push({ row, reason: 'max-concurrent' });
      continue;
    }
    if (open.some((item) => item.symbol === row.symbol)) {
      blocked.push({ row, reason: 'same-symbol-open' });
      continue;
    }
    if (mode !== 'profit_max' && open.some((item) => {
      const openRoute = routeById.get(item.combo?.phase17RouteId);
      return openRoute?.cluster && route?.cluster && openRoute.cluster === route.cluster;
    })) {
      blocked.push({ row, reason: 'cluster-conflict' });
      continue;
    }
    const losses = recentSymbolLosses.get(row.symbol) || [];
    const recentLossCount = losses.filter((time) => row.trade.entryTime - time <= 3 * 86400).length;
    if (mode === 'high_win' && recentLossCount >= 1) {
      blocked.push({ row, reason: 'recent-loss-guard' });
      continue;
    }
    accepted.push(row);
    if ((row.trade.pnlDollars || 0) <= 0) recentSymbolLosses.set(row.symbol, [...losses, row.trade.entryTime].slice(-5));
  }
  return { accepted, blocked };
}

function loadRoutes(phase17, mode, maxRoutes) {
  const bestMode = mode === 'best' ? phase17.bestMode : mode;
  const record = phase17.champions?.[bestMode];
  if (!record?.selectedRoutes?.length) throw new Error(`No selected routes for Phase17 mode: ${bestMode}`);
  return {
    bestMode,
    qualified: Boolean(phase17.bestModeQualified),
    routes: record.selectedRoutes.slice(0, maxRoutes),
    sourceMetrics: record.portfolio,
  };
}

const nowSec = Math.floor(Date.now() / 1000);
const nowMinute = marketMinutesET(nowSec);
const defaultEnd = nowMinute < 9 * 60 + 30 ? 10 * 60 + 30 : Math.min(nowMinute > 16 * 60 ? 16 * 60 : nowMinute, 16 * 60);
const startMinute = parseEtMinute(args.get('start-et'), 9 * 60 + 30);
const endMinute = parseEtMinute(args.get('end-et'), defaultEnd);
const targetDate = args.get('date') || dateET(nowSec);
const interval = args.get('interval') || '5m';
const range = args.get('range') || '5d';
const capital = Number(args.get('capital') || 100000);
const projectionCapital = Number(args.get('projection-capital') || 10000);
const maxRoutes = Number(args.get('max-routes') || 50);
const maxConcurrent = Number(args.get('max-concurrent') || 5);
const maxSymbols = Number(args.get('max-symbols') || 0);
const freshData = args.get('fresh-data') !== 'false';
const modeArg = args.get('mode') || 'best';
const phase17Path = args.get('phase17') || join(playbooksDir, 'current-phase17-specialist-tournament.json');
const phase17 = readJson(phase17Path);
if (!phase17) throw new Error(`Missing Phase17 tournament file: ${phase17Path}`);

const { bestMode, qualified, routes, sourceMetrics } = loadRoutes(phase17, modeArg, maxRoutes);
const routeById = new Map(routes.map((route) => [route.id || routeKey(route), route]));
const symbols = [...new Set(routes.map((route) => route.symbol))].sort();
const runSymbols = maxSymbols > 0 ? symbols.slice(0, maxSymbols) : symbols;
const runSymbolSet = new Set(runSymbols);
const routeCombos = routes
  .filter((route) => runSymbolSet.has(route.symbol))
  .map((route) => ({
    ...route.combo,
    playbook: route.combo?.playbook || 'Scalp',
    symbolFilter: route.symbol,
    phase17RouteId: route.id || routeKey(route),
    phase17Mode: bestMode,
    phase17HoldoutWinRate: route.holdout?.winRate || 0,
    phase17HoldoutNetDollars: route.holdout?.netDollars || 0,
    phase17RecentWinRate: route.recent?.winRate || 0,
  }));

if (!routeCombos.length) throw new Error('No Phase17 route combos to run');

const runId = new Date().toISOString().replace(/[:.]/g, '-');
const comboPath = join(outDir, `phase17-forward-combos-${targetDate}-${runId}.json`);
writeFileSync(comboPath, `${JSON.stringify(routeCombos, null, 2)}\n`);

console.log(`Running Phase17 forward paper test for ${targetDate}`);
console.log(`Window: ${minuteLabel(startMinute)}-${minuteLabel(endMinute)} ET`);
console.log(`Generated at ET: ${fmtEt(Date.now())}`);
console.log(`Mode: ${bestMode}${qualified ? ' survival-qualified' : ' paper-only'}; routes=${routeCombos.length}; symbols=${runSymbols.length}`);
console.log(`Combo file: ${comboPath}`);

const output = execFileSync('node', [
  'scripts/local_fusion_backtest.js',
  `--symbols=${runSymbols.join(',')}`,
  `--combo-file=${comboPath}`,
  `--range=${range}`,
  `--interval=${interval}`,
  `--capital=${capital}`,
  `--fresh-data=${freshData ? 'true' : 'false'}`,
  '--promote=false',
  '--sample=all',
  '--save-trades=true',
  '--min-trades=0',
  '--min-symbols=1',
], {
  cwd: root,
  encoding: 'utf8',
  maxBuffer: 1024 * 1024 * 220,
  stdio: ['ignore', 'pipe', 'pipe'],
});
process.stdout.write(output.split('\n').slice(-12).join('\n'));
if (!output.endsWith('\n')) process.stdout.write('\n');

const summaryPath = summaryPathFrom(output);
const tradesPath = tradesPathFrom(output, summaryPath);
if (!summaryPath || !tradesPath) throw new Error('local_fusion_backtest did not emit summary/trades paths');

const rawTrades = existsSync(tradesPath) && readFileSync(tradesPath, 'utf8').trim()
  ? readFileSync(tradesPath, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
  : [];

const matched = rawTrades.filter((row) => {
  const trade = row.trade || {};
  const minutes = marketMinutesET(trade.entryTime);
  return row.combo?.phase17RouteId
    && routeById.has(row.combo.phase17RouteId)
    && dateET(trade.entryTime) === targetDate
    && minutes >= startMinute
    && minutes < endMinute;
});
const canonical = canonicalize(matched, routeById);
const portfolio = replayPortfolio(canonical, routeById, bestMode, maxConcurrent);
const accepted = portfolio.accepted;
const blocked = portfolio.blocked;
const resultMetrics = metrics(accepted, projectionCapital, capital);

function mapTrade(row) {
  const route = routeById.get(row.combo?.phase17RouteId);
  return {
    symbol: row.symbol,
    routeId: row.combo?.phase17RouteId,
    archetype: route?.archetype,
    family: route?.family,
    cluster: route?.cluster,
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
    routeHoldoutWinRate: route?.holdout?.winRate || 0,
    routeHoldoutNetDollars: route?.holdout?.netDollars || 0,
    routeRecentWinRate: route?.recent?.winRate || 0,
  };
}

const payload = {
  generatedAt: new Date().toISOString(),
  targetDate,
  mode: 'phase17-forward-paper-test',
  phase17Mode: bestMode,
  phase17Qualified: qualified,
  window: `${minuteLabel(startMinute)}-${minuteLabel(endMinute)} ET`,
  phase17Path,
  comboPath,
  summaryPath,
  tradesPath,
  universe: {
    symbols: runSymbols.length,
    routes: routeCombos.length,
    maxConcurrent,
    sourceHoldout: sourceMetrics?.holdout,
    sourceHoldoutStress: sourceMetrics?.holdoutStress,
  },
  guardrails: {
    paperOnly: true,
    dataSource: 'local_fusion_backtest fresh 5m data',
    matchedTrades: matched.length,
    canonicalTrades: canonical.length,
    blockedTrades: blocked.length,
    conflictPolicy: bestMode === 'profit_max' ? 'max concurrent + one symbol at a time' : 'max concurrent + one symbol at a time + cluster conflict',
  },
  metrics: resultMetrics,
  trades: accepted.map(mapTrade),
  blockedTrades: blocked.slice(0, 100).map(({ row, reason }) => ({ reason, ...mapTrade(row) })),
};

const outPath = join(outDir, `phase17-forward-paper-${targetDate}-${runId}.json`);
const latestPath = join(outDir, 'latest-phase17-forward-paper-test.json');
const ledgerPath = join(outDir, 'phase17-forward-paper-ledger.jsonl');
writeFileSync(outPath, `${JSON.stringify(payload, null, 2)}\n`);
writeFileSync(latestPath, `${JSON.stringify(payload, null, 2)}\n`);
appendFileSync(ledgerPath, `${JSON.stringify({
  generatedAt: payload.generatedAt,
  targetDate: payload.targetDate,
  window: payload.window,
  phase17Mode: payload.phase17Mode,
  metrics: payload.metrics,
  guardrails: payload.guardrails,
  outputPath: outPath,
})}\n`);

const trustPath = join(outDir, 'phase17-forward-route-trust.json');
const trust = readJson(trustPath, { updatedAt: null, routes: {} });
for (const trade of payload.trades) {
  const signalId = `${payload.targetDate}|${trade.routeId}|${trade.symbol}|${trade.side}|${trade.entryTime}`;
  const item = trust.routes[trade.routeId] || {
    routeId: trade.routeId,
    symbol: trade.symbol,
    triggerMode: trade.triggerMode,
    session: trade.session,
    direction: trade.direction,
    trades: 0,
    wins: 0,
    netDollars: 0,
    grossWin: 0,
    grossLoss: 0,
    lastSeen: null,
    signalIds: [],
  };
  if (!Array.isArray(item.signalIds)) item.signalIds = [];
  if (item.signalIds.includes(signalId)) continue;
  item.trades += 1;
  if ((trade.pnlDollars || 0) > 0) {
    item.wins += 1;
    item.grossWin += trade.pnlDollars || 0;
  } else {
    item.grossLoss += Math.abs(trade.pnlDollars || 0);
  }
  item.netDollars += trade.pnlDollars || 0;
  item.lastSeen = payload.generatedAt;
  item.signalIds = [...item.signalIds, signalId].slice(-500);
  item.winRate = item.trades ? item.wins / item.trades * 100 : 0;
  item.profitFactor = item.grossLoss > 0 ? item.grossWin / item.grossLoss : item.grossWin > 0 ? 999 : 0;
  trust.routes[trade.routeId] = item;
}
trust.updatedAt = payload.generatedAt;
writeFileSync(trustPath, `${JSON.stringify(trust, null, 2)}\n`);

console.log(`\nPhase17 forward paper saved: ${outPath}`);
console.log(`Latest saved: ${latestPath}`);
console.log(`Ledger: ${ledgerPath}`);
console.log(`Route trust: ${trustPath}`);
console.log(`Phase17 paper trades=${payload.metrics.trades} win=${payload.metrics.winRate.toFixed(2)}% pf=${payload.metrics.profitFactor.toFixed(2)} net=$${payload.metrics.netDollars.toFixed(0)} projected=$${payload.metrics.projectedNet.toFixed(0)} avg=$${payload.metrics.projectedAvgDollars.toFixed(2)}`);
console.log(`Guardrails matched=${payload.guardrails.matchedTrades} canonical=${payload.guardrails.canonicalTrades} blocked=${payload.guardrails.blockedTrades}`);
for (const trade of payload.trades.slice(0, 30)) {
  console.log(`${trade.symbol} ${trade.side} ${trade.triggerMode} ${trade.entryTime} -> ${trade.reason} pnl=$${trade.pnlDollars.toFixed(0)} R=${trade.pnlR.toFixed(2)} holdout=${trade.routeHoldoutWinRate.toFixed(1)}%`);
}
