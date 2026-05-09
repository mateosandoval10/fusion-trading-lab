#!/usr/bin/env node
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const playbooksDir = join(root, 'optimization-results', 'models', 'playbooks');
if (!existsSync(playbooksDir)) mkdirSync(playbooksDir, { recursive: true });

const args = new Map(process.argv.slice(2).map((arg) => {
  const [key, value = 'true'] = arg.replace(/^--/, '').split('=');
  return [key, value];
}));

const runId = new Date().toISOString().replace(/[:.]/g, '-');
const symbolFile = args.get('symbol-file') || join(root, 'config', 'scalp-symbols-expanded.txt');
const text = args.get('symbols') || (existsSync(symbolFile) ? readFileSync(symbolFile, 'utf8') : 'NVDA,AMD,TSLA,COIN,QQQ,SPY');
const maxSymbols = Number(args.get('max-symbols') || 75);
const symbols = text.split(/[\s,]+/).map((symbol) => symbol.trim().toUpperCase()).filter(Boolean)
  .filter((symbol, index, all) => all.indexOf(symbol) === index).slice(0, maxSymbols);
const range = args.get('range') || '60d';
const capital = Number(args.get('capital') || 100000);
const minChampionTrades = Number(args.get('min-champion-trades') || 150);
const fast = args.get('fast') === 'true';
const skipDiscovery = args.get('skip-discovery') === 'true';

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function maybeRead(path) {
  return existsSync(path) ? readJson(path) : null;
}

function runNode(script, scriptArgs, label) {
  console.log(`\n=== ${label} ===`);
  const output = execFileSync('node', [script, ...scriptArgs], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024 * 260,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  process.stdout.write(output.split('\n').slice(-18).join('\n'));
  if (!output.endsWith('\n')) process.stdout.write('\n');
  return output;
}

function score(metrics = {}) {
  if (!metrics.trades) return 0;
  return metrics.winRate * 1.25
    + Math.min(metrics.projectedNet / 100, 320)
    + Math.min(metrics.trades, 900) * 0.13
    + Math.min(metrics.profitFactor, 14) * 7
    + Math.min(metrics.avgMonteCarloSurvival || 0, 100) * 0.22
    - Math.max(0, (metrics.maxLossStreak || 0) - 2) * 8;
}

function positionScale(route) {
  if (Number.isFinite(route.positionScale)) return route.positionScale;
  const quality = (route.score || 200) / 380;
  const consistency = (route.robustness?.profitConsistencyScore || 70) / 100;
  const drawdownDrag = Math.min((route.robustness?.monteCarloMedianDrawdown || 0) / 2500, 0.35);
  return Math.max(0.25, Math.min(1.35, 0.45 + quality * 0.35 + consistency * 0.25 - drawdownDrag));
}

function routeKey(route) {
  return route.id || `${route.symbol}|${route.session}|${route.direction}|${route.triggerMode}|${route.combo?.targetR}|${route.combo?.timeStopBars}`;
}

function conflictKey(route) {
  return `${route.symbol}|${route.session}|${route.direction}|${route.triggerMode}`;
}

function extractRoutes(source) {
  if (!source) return [];
  if (Array.isArray(source.champion?.routes)) return source.champion.routes;
  if (Array.isArray(source.routes)) return source.routes;
  return [];
}

function portfolioMetrics(routes, projectionCapital = 10000) {
  const trades = routes.reduce((sum, route) => sum + (route.test?.trades || 0), 0);
  const wins = routes.reduce((sum, route) => sum + (route.test?.wins ?? (route.test?.trades || 0) * (route.test?.winRate || 0) / 100), 0);
  const netDollars = routes.reduce((sum, route) => sum + (route.test?.netDollars || 0), 0);
  const grossWin = routes.reduce((sum, route) => sum + (route.test?.grossWin ?? Math.max(route.test?.netDollars || 0, 0)), 0);
  const grossLoss = routes.reduce((sum, route) => sum + (route.test?.grossLoss ?? Math.abs(Math.min(route.test?.netDollars || 0, 0))), 0);
  return {
    routes: routes.length,
    trades,
    winRate: trades ? wins / trades * 100 : 0,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? 999 : 0),
    netDollars,
    projectedNet: netDollars * projectionCapital / capital,
    projectedAvgDollars: trades ? (netDollars * projectionCapital / capital) / trades : 0,
    avgDollars: trades ? netDollars / trades : 0,
    avgPositionScale: routes.length ? routes.reduce((sum, route) => sum + positionScale(route), 0) / routes.length : 0,
    avgMonteCarloSurvival: routes.length ? routes.reduce((sum, route) => sum + (route.robustness?.monteCarloSurvivalRate || 0), 0) / routes.length : 0,
    avgUniqueDays: routes.length ? routes.reduce((sum, route) => sum + (route.robustness?.uniqueDays || 0), 0) / routes.length : 0,
  };
}

function pickMergedPortfolio(routeSets, maxRoutes = 140) {
  const seen = new Set();
  const conflicts = new Map();
  const picked = [];
  const candidates = routeSets.flatMap(({ source, routes }) => routes.map((route) => ({ ...route, sourceModule: source })))
    .filter((route) => (route.test?.trades || 0) >= 5 && (route.test?.netDollars || 0) > 0)
    .sort((a, b) => (
      (b.score || 0) + (b.test?.winRate || 0) * 2 + Math.min(b.test?.avgDollars || 0, 1500) / 12
    ) - (
      (a.score || 0) + (a.test?.winRate || 0) * 2 + Math.min(a.test?.avgDollars || 0, 1500) / 12
    ));
  for (const route of candidates) {
    const key = routeKey(route);
    const cKey = conflictKey(route);
    const existing = conflicts.get(cKey);
    if (seen.has(key)) continue;
    if (existing && (existing.test?.winRate || 0) >= (route.test?.winRate || 0) && (existing.test?.netDollars || 0) >= (route.test?.netDollars || 0)) continue;
    picked.push(route);
    seen.add(key);
    conflicts.set(cKey, route);
    if (picked.length >= maxRoutes) break;
  }
  return picked;
}

const fullProfiles = [
  {
    name: 'dense_merge_discovery',
    args: [
      '--quick=true',
      '--focused=true',
      '--trigger-mode=base|ema-cross|score-cross|vwap-reclaim|breakout|momentum-acceleration|volume-shock|confirmed-no-repaint|hybrid-consensus',
      '--session=open-0930|open-1000|morning',
      '--direction=both|long|short',
      '--target-r=0.35|0.5',
      '--trail-r=0.35|0.5',
      '--partial-r=0.5|1',
      '--time-stop-bars=6|9',
      '--confidence-drop=18|25',
      '--structure-exit=loose|strict',
    ],
  },
  {
    name: 'profit_route_expansion',
    args: [
      '--quick=true',
      '--focused=true',
      '--trigger-mode=options-burst|momentum-acceleration|volume-shock|breakout|relative-strength-reclaim|opening-drive-continuation',
      '--session=open-0930|open-1000',
      '--direction=both|long|short',
      '--target-r=0.5|0.75',
      '--trail-r=0.5|0.75',
      '--partial-r=0.75|1',
      '--time-stop-bars=6|9',
      '--confidence-drop=18|25',
      '--structure-exit=loose|strict',
    ],
  },
  {
    name: 'soft_context_overlay',
    args: [
      '--quick=true',
      '--focused=true',
      '--trigger-mode=momentum-acceleration|breakout|relative-strength-reclaim|volume-shock|hybrid-consensus',
      '--session=open-0930|open-1000',
      '--direction=both|long|short',
      '--target-r=0.35|0.5',
      '--trail-r=0.35|0.5',
      '--partial-r=0.5|1',
      '--time-stop-bars=6',
      '--confidence-drop=18|25',
      '--structure-exit=loose|strict',
      '--market-mode=off',
      '--peer-mode=off',
      '--rel-vol-mode=off',
      '--daily-context=trend-day',
    ],
  },
];
const fastProfiles = [
  {
    name: 'fast_merge_probe',
    args: [
      '--quick=true',
      '--focused=true',
      '--trigger-mode=momentum-acceleration|volume-shock|hybrid-consensus',
      '--session=open-0930|open-1000',
      '--direction=both|long|short',
      '--target-r=0.35|0.5',
      '--trail-r=0.35',
      '--partial-r=0.5',
      '--time-stop-bars=6',
      '--confidence-drop=18',
      '--structure-exit=loose',
    ],
  },
];
const profiles = skipDiscovery ? [] : (fast ? fastProfiles : fullProfiles);

const runResults = [];
for (const profile of profiles) {
  runNode('scripts/master_scalp_learning_sprint.js', [
    `--symbols=${symbols.join(',')}`,
    `--range=${range}`,
    `--capital=${capital}`,
    `--min-champion-trades=${minChampionTrades}`,
    '--min-route-trades=5',
    '--min-route-days=3',
    '--min-route-weeks=2',
    ...profile.args,
  ], `phase5 ${profile.name}`);
  const registry = readJson(join(playbooksDir, 'master-scalp-champion-registry.json'));
  const latest = registry.challengers?.[0];
  runResults.push({ profile: profile.name, latest });
}

const mainPath = join(playbooksDir, 'current-master-scalp-champion.json');
const main = maybeRead(mainPath);
const modules = [
  { source: 'main', path: mainPath, data: main },
  { source: 'phase2_weight_specialist', path: maybeRead(join(playbooksDir, 'current-phase2-specialist-candidate.json'))?.best?.snapshotPath },
  { source: 'phase3_exit_specialist', path: maybeRead(join(playbooksDir, 'current-phase3-specialist-candidate.json'))?.best?.snapshotPath },
  { source: 'phase4_context_specialist', path: maybeRead(join(playbooksDir, 'current-phase4-specialist-candidate.json'))?.best?.snapshotPath },
  ...runResults.map((run) => ({ source: `phase5_${run.profile}`, path: run.latest?.path })),
].map((module) => ({
  ...module,
  data: module.data || (module.path && existsSync(module.path) ? readJson(module.path) : null),
})).filter((module) => module.data);

const routeSets = modules.map((module) => ({ source: module.source, path: module.path, routes: extractRoutes(module.data) }));
const variants = [
  { name: 'main_only', sources: ['main'] },
  { name: 'main_plus_exit', sources: ['main', 'phase3_exit_specialist'] },
  { name: 'main_plus_context', sources: ['main', 'phase4_context_specialist'] },
  { name: 'main_plus_weight', sources: ['main', 'phase2_weight_specialist'] },
  { name: 'main_plus_phase5_runs', sources: ['main', ...runResults.map((run) => `phase5_${run.profile}`)] },
  { name: 'main_plus_all_specialists', sources: routeSets.map((set) => set.source) },
];

const evaluated = variants.map((variant) => {
  const selectedSets = routeSets.filter((set) => variant.sources.includes(set.source));
  const routes = pickMergedPortfolio(selectedSets, variant.name === 'main_only' ? 140 : 160);
  const metrics = portfolioMetrics(routes);
  return {
    name: variant.name,
    sources: variant.sources,
    metrics,
    score: score(metrics),
    eligible: metrics.trades >= minChampionTrades,
    routes,
  };
}).sort((a, b) => b.score - a.score);

const current = main?.champion?.metrics || {};
const best = evaluated[0];
const beatsMain = best.eligible
  && best.metrics.winRate >= (current.winRate || 0) - 1.0
  && best.metrics.profitFactor >= Math.min(current.profitFactor || 0, 10) * 0.9
  && best.metrics.netDollars > (current.netDollars || 0) * 1.03;

const payload = {
  updatedAt: new Date().toISOString(),
  runId,
  phase: 'phase5-champion-merge',
  rules: {
    minChampionTrades,
    promotion: 'must beat main after merged route conflict optimization; specialists below floor are saved but cannot replace main',
  },
  symbols: symbols.length,
  range,
  currentMain: current,
  runResults,
  modules: routeSets.map((set) => ({ source: set.source, path: set.path, routes: set.routes.length })),
  variants: evaluated.map((variant) => ({
    name: variant.name,
    sources: variant.sources,
    metrics: variant.metrics,
    score: variant.score,
    eligible: variant.eligible,
    routeSources: variant.routes.reduce((acc, route) => {
      acc[route.sourceModule] = (acc[route.sourceModule] || 0) + 1;
      return acc;
    }, {}),
    routes: variant.routes.slice(0, 80),
  })),
  best: {
    name: best.name,
    metrics: best.metrics,
    score: best.score,
    eligible: best.eligible,
  },
  promotion: {
    beatsMain,
    decision: beatsMain ? 'promote-merged-main' : best.eligible ? 'retain-main-save-merged-specialist' : 'research-only',
  },
};

const outPath = join(playbooksDir, 'current-phase5-merge-tournament.json');
writeFileSync(outPath, `${JSON.stringify(payload, null, 2)}\n`);
appendFileSync(join(playbooksDir, 'phase5-merge-tournament-history.jsonl'), `${JSON.stringify(payload)}\n`);

if (beatsMain) {
  const mergedChampion = {
    updatedAt: payload.updatedAt,
    source: outPath,
    champion: {
      name: best.name,
      metrics: best.metrics,
      routes: best.routes.map((route) => ({ ...route, positionScale: positionScale(route) })),
    },
    runScore: best.score,
    indicatorMetadata: {
      badge: best.routes.some((route) => route.forward?.trades > 0) ? 'Forward Proven' : 'Backtest Only',
      noTradeZones: [
        `minimum ${minChampionTrades} trades for main champion promotion`,
        'merged routes passed source conflict optimizer',
        'small specialists retained only as modules',
      ],
      dashboardRows: ['Route', 'Target Mode', 'Backtest WR', 'Forward WR', 'Why Fired', 'Why Blocked'],
    },
  };
  writeFileSync(mainPath, `${JSON.stringify(mergedChampion, null, 2)}\n`);
}

console.log('\n=== phase 5 complete ===');
console.log(`Saved: ${outPath}`);
console.log(`Best=${best.name} trades=${best.metrics.trades} win=${best.metrics.winRate.toFixed(2)} pf=${best.metrics.profitFactor.toFixed(2)} net=$${best.metrics.netDollars.toFixed(0)} projected=$${best.metrics.projectedNet.toFixed(0)}`);
console.log(`Decision=${payload.promotion.decision}`);
