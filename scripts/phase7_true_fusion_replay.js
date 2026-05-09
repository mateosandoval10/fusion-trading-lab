#!/usr/bin/env node
import { createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync, appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const playbooksDir = join(root, 'optimization-results', 'models', 'playbooks');
const ledgerDir = join(root, 'optimization-results', 'trade-ledger');
const generatedDir = join(root, 'generated');
for (const dir of [playbooksDir, generatedDir]) mkdirSync(dir, { recursive: true });

const args = new Map(process.argv.slice(2).map((arg) => {
  const [key, value = 'true'] = arg.replace(/^--/, '').split('=');
  return [key, value];
}));

const minTrades = Number(args.get('min-trades') || 150);
const capital = Number(args.get('capital') || 100000);
const projectionCapital = Number(args.get('projection-capital') || 10000);
const ledgerLimit = Number(args.get('ledger-limit') || 8);
const maxConcurrent = Number(args.get('max-concurrent') || 3);
const maxHoldMinutes = Number(args.get('max-hold-minutes') || 90);
const freshReplay = args.get('fresh-replay') === 'true';
const freshRange = args.get('range') || '60d';

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function maybeRead(path) {
  return existsSync(path) ? readJson(path) : null;
}

function extractRoutes(source, sourceModule) {
  if (!source) return [];
  const routes = Array.isArray(source.champion?.routes)
    ? source.champion.routes
    : Array.isArray(source.active?.routes)
      ? source.active.routes
      : Array.isArray(source.routes)
        ? source.routes
        : Array.isArray(source.bestPortfolio?.selectedRoutes)
          ? source.bestPortfolio.selectedRoutes
          : [];
  return routes.map((route) => ({ ...route, sourceModule: route.sourceModule || sourceModule }));
}

function phase5Routes(phase5, variantName) {
  const variant = phase5?.variants?.find((item) => item.name === variantName);
  return (variant?.routes || []).map((route) => ({ ...route, sourceModule: route.sourceModule || `phase5:${variantName}` }));
}

function comboSignature(combo = {}) {
  const keys = [
    'triggerMode',
    'session',
    'direction',
    'targetR',
    'timeStopBars',
    'trailR',
    'partialR',
    'confidenceDrop',
    'structureExit',
    'minConf',
    'minAlphaQuality',
    'marketMode',
    'peerMode',
    'relVolMode',
  ];
  return keys.map((key) => `${key}:${combo[key] ?? ''}`).join('|');
}

function looseRouteKey(route) {
  return `${route.symbol}|${route.triggerMode || route.combo?.triggerMode}|${route.session || route.combo?.session}|${route.direction || route.combo?.direction}`;
}

function exactRouteKey(route) {
  return `${route.symbol}|${comboSignature(route.combo || route)}`;
}

function tradeExactKey(record) {
  return `${record.symbol}|${comboSignature(record.combo)}`
}

function routeQuality(route) {
  const test = route.test || {};
  const robustness = route.robustness || {};
  const pf = test.profitFactor || 0;
  return (test.winRate || 0) * 1.7
    + Math.min(test.avgDollars || 0, 1600) / 12
    + Math.min(pf, 14) * 8
    + Math.min(robustness.monteCarloSurvivalRate || 0, 100) * 0.25
    + Math.min(robustness.profitConsistencyScore || 0, 100) * 0.18;
}

function normalizeRoutes(routes) {
  const map = new Map();
  for (const route of routes) {
    const normalized = {
      ...route,
      symbol: route.symbol,
      triggerMode: route.triggerMode || route.combo?.triggerMode,
      session: route.session || route.combo?.session,
      direction: route.direction || route.combo?.direction,
      replayScore: route.routerScore || route.score || routeQuality(route),
    };
    const key = exactRouteKey(normalized);
    const previous = map.get(key);
    if (!previous || normalized.replayScore > previous.replayScore) map.set(key, normalized);
  }
  return [...map.values()];
}

function replayVariant(name, routes, tradeBook, options = {}) {
  const exactKeys = new Set(routes.map(exactRouteKey));
  const looseKeys = new Set(routes.map(looseRouteKey));
  const routeByLoose = new Map(routes.map((route) => [looseRouteKey(route), route]));
  const raw = [];
  for (const row of tradeBook) {
    const exact = tradeExactKey(row);
    const loose = `${row.symbol}|${row.combo.triggerMode}|${row.combo.session}|${row.combo.direction}`;
    if (!exactKeys.has(exact) && !looseKeys.has(loose)) continue;
    const route = routeByLoose.get(loose) || routes.find((item) => exactRouteKey(item) === exact);
    raw.push({
      ...row.trade,
      symbol: row.symbol,
      combo: row.combo,
      route,
      replayScore: route?.replayScore || 0,
      sourceModule: route?.sourceModule || 'unknown',
      uniqueKey: `${row.symbol}|${row.combo.triggerMode}|${row.combo.session}|${row.combo.direction}|${row.trade.entryTime}|${row.trade.exitTime}|${row.trade.side}|${Math.round(row.trade.entry * 10000)}|${Math.round(row.trade.exit * 10000)}`,
    });
  }
  raw.sort((a, b) => (a.entryTime - b.entryTime) || (b.replayScore - a.replayScore));

  const accepted = [];
  const seen = new Set();
  for (const trade of raw) {
    if (seen.has(trade.uniqueKey)) continue;
    seen.add(trade.uniqueKey);
    if ((trade.exitTime - trade.entryTime) / 60 > maxHoldMinutes) continue;
    const openAtEntry = accepted.filter((item) => item.exitTime > trade.entryTime);
    if (openAtEntry.some((item) => item.symbol === trade.symbol)) continue;
    if (openAtEntry.length >= (options.maxConcurrent || maxConcurrent)) continue;
    if (options.requireOptionWorthy && !trade.optionWorthy && (trade.mfeR || 0) < 0.75) continue;
    if (options.minReplayScore && trade.replayScore < options.minReplayScore) continue;
    accepted.push(trade);
  }
  return {
    name,
    routeCount: routes.length,
    metrics: metrics(accepted),
    trades: accepted,
    sourceMix: accepted.reduce((acc, trade) => {
      acc[trade.sourceModule] = (acc[trade.sourceModule] || 0) + 1;
      return acc;
    }, {}),
  };
}

function metrics(trades) {
  const wins = trades.filter((trade) => trade.pnlDollars > 0);
  const losses = trades.filter((trade) => trade.pnlDollars <= 0);
  const grossWin = wins.reduce((sum, trade) => sum + trade.pnlDollars, 0);
  const grossLoss = Math.abs(losses.reduce((sum, trade) => sum + trade.pnlDollars, 0));
  let equity = 0;
  let peak = 0;
  let maxDrawdownDollars = 0;
  let currentLossStreak = 0;
  let maxLossStreak = 0;
  for (const trade of trades) {
    equity += trade.pnlDollars;
    peak = Math.max(peak, equity);
    maxDrawdownDollars = Math.max(maxDrawdownDollars, peak - equity);
    if (trade.pnlDollars <= 0) {
      currentLossStreak += 1;
      maxLossStreak = Math.max(maxLossStreak, currentLossStreak);
    } else {
      currentLossStreak = 0;
    }
  }
  return {
    trades: trades.length,
    wins: wins.length,
    losses: losses.length,
    winRate: trades.length ? wins.length / trades.length * 100 : 0,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? 999 : 0),
    netDollars: equity,
    projectedNet: equity * projectionCapital / capital,
    avgDollars: trades.length ? equity / trades.length : 0,
    projectedAvgDollars: trades.length ? (equity * projectionCapital / capital) / trades.length : 0,
    maxDrawdownDollars,
    maxLossStreak,
    avgMfeR: trades.length ? trades.reduce((sum, trade) => sum + (trade.mfeR || 0), 0) / trades.length : 0,
    avgMaeR: trades.length ? trades.reduce((sum, trade) => sum + (trade.maeR || 0), 0) / trades.length : 0,
    optionWorthyRate: trades.length ? trades.filter((trade) => trade.optionWorthy).length / trades.length * 100 : 0,
  };
}

function scoreVariant(variant, mainMetrics) {
  const m = variant.metrics;
  if (!m.trades) return -999;
  return m.winRate * 1.35
    + Math.min(m.projectedNet / 100, 360)
    + Math.min(m.trades, 700) * 0.12
    + Math.min(m.profitFactor, 14) * 7
    - Math.min(m.maxDrawdownDollars / 1000, 50) * 1.5
    - Math.max(0, m.maxLossStreak - 2) * 10
    + (m.trades >= minTrades ? 35 : -80)
    + (m.winRate >= (mainMetrics.winRate || 0) ? 20 : 0);
}

async function loadTrades(ledgerPaths, allRoutes) {
  const exactKeys = new Set(allRoutes.map(exactRouteKey));
  const looseKeys = new Set(allRoutes.map(looseRouteKey));
  const rows = [];
  const dedupe = new Set();
  for (const ledgerPath of ledgerPaths) {
    if (!existsSync(ledgerPath)) continue;
    const input = createReadStream(ledgerPath, { encoding: 'utf8' });
    const lines = createInterface({ input, crlfDelay: Infinity });
    for await (const line of lines) {
      if (!line.trim()) continue;
      let row;
      try {
        row = JSON.parse(line);
      } catch {
        continue;
      }
      if (!row.symbol || !row.combo || !row.trade) continue;
      const exact = tradeExactKey(row);
      const loose = `${row.symbol}|${row.combo.triggerMode}|${row.combo.session}|${row.combo.direction}`;
      if (!exactKeys.has(exact) && !looseKeys.has(loose)) continue;
      const key = `${exact}|${row.trade.entryTime}|${row.trade.exitTime}|${row.trade.side}|${Math.round(row.trade.entry * 10000)}|${Math.round(row.trade.exit * 10000)}`;
      if (dedupe.has(key)) continue;
      dedupe.add(key);
      rows.push(row);
    }
  }
  return rows;
}

function recentLedgers(limit) {
  return readdirSync(ledgerDir)
    .filter((file) => /^backtest-trades-.*\.jsonl$/.test(file))
    .map((file) => join(ledgerDir, file))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
    .slice(0, limit);
}

function ledgersFromArgs() {
  if (args.get('ledgers')) return args.get('ledgers').split(',').map((item) => resolve(root, item.trim()));
  return readdirSync(ledgerDir)
    .filter((file) => /^backtest-trades-.*\.jsonl$/.test(file))
    .map((file) => join(ledgerDir, file))
    .sort((a, b) => statSync(a).mtimeMs - statSync(b).mtimeMs)
    .slice(-ledgerLimit);
}

const main = maybeRead(join(playbooksDir, 'current-master-scalp-champion.json'));
const router = maybeRead(join(playbooksDir, 'current-phase6-specialist-router.json'));
const phase5 = maybeRead(join(playbooksDir, 'current-phase5-merge-tournament.json'));
const phase3Path = router?.sourcePaths?.phase3Path;
const phase4Path = router?.sourcePaths?.phase4Path;
const phase2Path = router?.sourcePaths?.phase2Path;
const phase2 = phase2Path ? maybeRead(phase2Path) : null;
const phase3 = phase3Path ? maybeRead(phase3Path) : null;
const phase4 = phase4Path ? maybeRead(phase4Path) : null;

const routeSets = {
  main: normalizeRoutes(extractRoutes(main, 'main')),
  phase2: normalizeRoutes(extractRoutes(phase2, 'phase2:weight-optimized')),
  phase3: normalizeRoutes(extractRoutes(phase3, 'phase3:exit-optimized')),
  phase4: normalizeRoutes(extractRoutes(phase4, 'phase4:context-confirmed')),
  phase5All: normalizeRoutes(phase5Routes(phase5, 'main_plus_all_specialists')),
  phase5Exit: normalizeRoutes(phase5Routes(phase5, 'main_plus_exit')),
  phase6Active: normalizeRoutes(extractRoutes(router, 'phase6:active-router')),
};

const variants = [
  { name: 'main_replay', routes: routeSets.main, options: { maxConcurrent: 1 } },
  { name: 'phase6_active_replay', routes: routeSets.phase6Active, options: { maxConcurrent: 1 } },
  { name: 'main_plus_exit_fusion', routes: normalizeRoutes([...routeSets.main, ...routeSets.phase3]), options: { maxConcurrent: 1 } },
  { name: 'main_plus_context_fusion', routes: normalizeRoutes([...routeSets.main, ...routeSets.phase4]), options: { maxConcurrent: 1 } },
  { name: 'full_specialist_fusion_strict', routes: normalizeRoutes([...routeSets.main, ...routeSets.phase2, ...routeSets.phase3, ...routeSets.phase4, ...routeSets.phase5All]), options: { maxConcurrent: 1, minReplayScore: 220 } },
  { name: 'full_specialist_fusion_profit', routes: normalizeRoutes([...routeSets.main, ...routeSets.phase2, ...routeSets.phase3, ...routeSets.phase4, ...routeSets.phase5All]), options: { maxConcurrent: 3, minReplayScore: 180 } },
  { name: 'options_worthy_fusion', routes: normalizeRoutes([...routeSets.main, ...routeSets.phase2, ...routeSets.phase3, ...routeSets.phase5All]), options: { maxConcurrent: 2, requireOptionWorthy: true } },
];

const allRoutes = normalizeRoutes(variants.flatMap((variant) => variant.routes));
let ledgerPaths = ledgersFromArgs();
if (freshReplay) {
  const comboPath = join(playbooksDir, `phase7-fusion-combos-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  const exactCombos = normalizeRoutes(allRoutes).map((route) => ({
    ...(route.combo || {}),
    playbook: route.combo?.playbook || 'Scalp',
    symbolFilter: route.symbol,
    triggerMode: route.triggerMode || route.combo?.triggerMode || 'base',
    session: route.session || route.combo?.session || 'all',
    direction: route.direction || route.combo?.direction || 'both',
  }));
  writeFileSync(comboPath, `${JSON.stringify(exactCombos, null, 2)}\n`);
  const symbols = [...new Set(exactCombos.map((combo) => combo.symbolFilter))];
  console.log(`Running fresh symbol-specific replay: ${symbols.length} symbols x ${exactCombos.length} route combos...`);
  const output = execFileSync('node', [
    'scripts/local_fusion_backtest.js',
    `--symbols=${symbols.join(',')}`,
    `--combo-file=${comboPath}`,
    `--range=${freshRange}`,
    '--interval=5m',
    `--capital=${capital}`,
    '--playbook=Scalp',
    '--sample=all',
    '--promote=false',
    '--save-trades=true',
    '--fresh-data=false',
  ], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024 * 120,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  process.stdout.write(output.split('\n').slice(-16).join('\n'));
  if (!output.endsWith('\n')) process.stdout.write('\n');
  const match = output.match(/Trades: (.*\.jsonl)/);
  if (match) ledgerPaths = [match[1]];
}
console.log(`Loading ${ledgerPaths.length} ledgers for ${allRoutes.length} fused routes...`);
const tradeBook = await loadTrades(ledgerPaths, allRoutes);
console.log(`Matched raw route trades: ${tradeBook.length}`);

const replayed = variants.map((variant) => replayVariant(variant.name, variant.routes, tradeBook, variant.options));
const mainReplay = replayed.find((variant) => variant.name === 'main_replay')?.metrics || main?.champion?.metrics || {};
for (const variant of replayed) variant.score = scoreVariant(variant, mainReplay);
replayed.sort((a, b) => b.score - a.score);
const best = replayed[0];
const promote = best.metrics.trades >= minTrades
  && best.metrics.winRate >= (mainReplay.winRate || 0) - 1
  && best.metrics.netDollars >= (mainReplay.netDollars || 0) * 1.05
  && best.metrics.profitFactor >= Math.min(mainReplay.profitFactor || 0, 10) * 0.9;

const payload = {
  updatedAt: new Date().toISOString(),
  phase: 'phase7-true-fusion-replay',
  rules: {
    minTrades,
    maxConcurrent,
    maxHoldMinutes,
    promotion: 'chronological replay must beat main replay after route conflicts and overlap limits',
  },
  sourceLedgers: ledgerPaths,
  routeSetCounts: Object.fromEntries(Object.entries(routeSets).map(([name, routes]) => [name, routes.length])),
  matchedRawTrades: tradeBook.length,
  variants: replayed.map((variant) => ({
    name: variant.name,
    routeCount: variant.routeCount,
    metrics: variant.metrics,
    score: variant.score,
    sourceMix: variant.sourceMix,
    sampleTrades: variant.trades.slice(0, 25).map((trade) => ({
      symbol: trade.symbol,
      side: trade.side,
      sourceModule: trade.sourceModule,
      triggerMode: trade.combo.triggerMode,
      session: trade.combo.session,
      entryTime: trade.entryTime,
      exitTime: trade.exitTime,
      entry: trade.entry,
      exit: trade.exit,
      pnlDollars: trade.pnlDollars,
      reason: trade.reason,
    })),
  })),
  best: {
    name: best.name,
    metrics: best.metrics,
    score: best.score,
  },
  promotion: {
    promote,
    decision: promote ? 'promote-true-fusion-replay' : 'retain-current-router',
  },
};

const outPath = join(playbooksDir, 'current-phase7-true-fusion-replay.json');
writeFileSync(outPath, `${JSON.stringify(payload, null, 2)}\n`);
appendFileSync(join(playbooksDir, 'phase7-true-fusion-replay-history.jsonl'), `${JSON.stringify(payload)}\n`);

const pinePath = join(generatedDir, 'true_fusion_replay_export.json');
writeFileSync(pinePath, `${JSON.stringify({
  generatedAt: payload.updatedAt,
  decision: payload.promotion.decision,
  best: payload.best,
  variants: payload.variants.map((variant) => ({
    name: variant.name,
    trades: variant.metrics.trades,
    winRate: variant.metrics.winRate,
    profitFactor: variant.metrics.profitFactor,
    projectedNet: variant.metrics.projectedNet,
    sourceMix: variant.sourceMix,
  })),
}, null, 2)}\n`);

console.log('\n=== phase 7 true fusion replay ===');
console.log(`Replay saved: ${outPath}`);
console.log(`Pine/replay metadata: ${pinePath}`);
for (const variant of replayed) {
  const m = variant.metrics;
  console.log(`${variant.name}: trades=${m.trades} win=${m.winRate.toFixed(2)} pf=${m.profitFactor.toFixed(2)} net=$${m.netDollars.toFixed(0)} projected=$${m.projectedNet.toFixed(0)} dd=$${m.maxDrawdownDollars.toFixed(0)} streak=${m.maxLossStreak}`);
}
console.log(`Decision=${payload.promotion.decision}`);
