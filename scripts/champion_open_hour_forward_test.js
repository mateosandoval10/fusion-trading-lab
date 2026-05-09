#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

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
    routeWinRate: route.test?.winRate || 0,
    routeAvgDollars: route.test?.avgDollars || 0,
    combo: route.combo || {},
  }));
}
const accepted = acceptedFromChampion(champion);
if (!accepted.length) throw new Error(`${championPath} has no champion.acceptedTrades`);

const routeKeys = new Set(accepted.map((trade) => `${trade.symbol}|${trade.triggerMode}|${trade.direction}`));
const symbols = [...new Set(accepted.map((trade) => trade.symbol))].sort();
const triggerModes = [...new Set(accepted.map((trade) => trade.triggerMode).filter(Boolean))].sort();
const directions = [...new Set(accepted.map((trade) => trade.direction).filter(Boolean))].sort();
const maxSymbols = Number(args.get('max-symbols') || 0);
const runSymbols = maxSymbols > 0 ? symbols.slice(0, maxSymbols) : symbols;
const targetDate = args.get('date') || dateET(Math.floor(Date.now() / 1000));
const capital = Number(args.get('capital') || 100000);
const projectionCapital = Number(args.get('projection-capital') || 10000);

const localArgs = [
  `--symbols=${runSymbols.join(',')}`,
  '--interval=5m',
  '--range=5d',
  `--capital=${capital}`,
  '--playbook=Scalp',
  `--trigger-mode=${triggerModes.join('|')}`,
  '--min-conf=65|70',
  '--target-r=0.35|0.5',
  '--exit-mode=smart',
  '--trail-r=0.5',
  '--time-stop-bars=6|9',
  '--min-lead=65',
  '--min-edge=12',
  '--min-atr-ratio=0.9',
  '--min-adx=14',
  '--min-er=0.10',
  '--vol-mult=1.2',
  '--session=open-0930|open-1000',
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
  '--min-alpha-quality=0|55|65',
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

console.log(`Running current champion first-hour forward test for ${targetDate}`);
console.log(`Universe: ${runSymbols.length} symbols, ${triggerModes.length} trigger families, sessions 9:30-10:30 ET`);
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

const trades = rawTrades.filter((row) => {
  const trade = row.trade || {};
  const minutes = marketMinutesET(trade.entryTime);
  const simpleKey = `${row.symbol}|${row.combo?.triggerMode}|${row.combo?.direction}`;
  const bothKey = `${row.symbol}|${row.combo?.triggerMode}|both`;
  return dateET(trade.entryTime) === targetDate
    && minutes >= 570 && minutes < 630
    && (routeKeys.has(simpleKey) || routeKeys.has(bothKey));
});

const wins = trades.filter((row) => (row.trade.pnlDollars || 0) > 0);
const losses = trades.filter((row) => (row.trade.pnlDollars || 0) <= 0);
const netDollars = trades.reduce((sum, row) => sum + (row.trade.pnlDollars || 0), 0);
const grossWin = wins.reduce((sum, row) => sum + (row.trade.pnlDollars || 0), 0);
const grossLoss = Math.abs(losses.reduce((sum, row) => sum + (row.trade.pnlDollars || 0), 0));
const scale = projectionCapital / capital;
const payload = {
  generatedAt: new Date().toISOString(),
  targetDate,
  mode: 'current-champion-open-hour-forward-test',
  window: '9:30-10:30 ET',
  championPath,
  summaryPath,
  tradesPath,
  universe: { symbols: runSymbols.length, triggers: triggerModes, directions, championRouteKeys: routeKeys.size },
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
  })),
};
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const outPath = join(outDir, `champion-open-hour-${targetDate}-${stamp}.json`);
const latestPath = join(outDir, 'latest-champion-open-hour-forward-test.json');
writeFileSync(outPath, `${JSON.stringify(payload, null, 2)}\n`);
writeFileSync(latestPath, `${JSON.stringify(payload, null, 2)}\n`);
console.log(`\nForward test saved: ${outPath}`);
console.log(`Latest saved: ${latestPath}`);
console.log(`Champion open-hour trades=${payload.metrics.trades} win=${payload.metrics.winRate.toFixed(2)}% pf=${payload.metrics.profitFactor.toFixed(2)} net=$${payload.metrics.netDollars.toFixed(0)} projected=$${payload.metrics.projectedNet.toFixed(0)} avg=$${payload.metrics.projectedAvgDollars.toFixed(2)}`);
for (const trade of payload.trades.slice(0, 20)) {
  console.log(`${trade.symbol} ${trade.side} ${trade.triggerMode} ${trade.entryTime} -> ${trade.reason} pnl=$${trade.pnlDollars.toFixed(0)} R=${trade.pnlR.toFixed(2)}`);
}
