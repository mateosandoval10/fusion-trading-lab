#!/usr/bin/env node
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const playbooksDir = join(root, 'optimization-results', 'models', 'playbooks');
const generatedDir = join(root, 'generated');
for (const dir of [playbooksDir, generatedDir]) mkdirSync(dir, { recursive: true });

const args = new Map(process.argv.slice(2).map((arg) => {
  const [key, value = 'true'] = arg.replace(/^--/, '').split('=');
  return [key, value];
}));

const minChampionTrades = Number(args.get('min-champion-trades') || 150);
const minSpecialistWin = Number(args.get('min-specialist-win') || 84);
const minSpecialistTrades = Number(args.get('min-specialist-trades') || 5);
const maxRoutes = Number(args.get('max-routes') || 180);
const projectionCapital = Number(args.get('projection-capital') || 10000);
const capital = Number(args.get('capital') || 100000);

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function maybeRead(path) {
  return existsSync(path) ? readJson(path) : null;
}

function routeKey(route) {
  return route.id || `${route.symbol}|${route.session}|${route.direction}|${route.triggerMode}|${route.combo?.targetR}|${route.combo?.timeStopBars}`;
}

function conflictKey(route) {
  return `${route.symbol}|${route.session}|${route.direction}`;
}

function routeTrustKey(route) {
  return `${route.symbol}|${route.session || 'all'}|${route.direction || 'both'}|${route.triggerMode}`;
}

function extractRoutes(source, sourceModule) {
  if (!source) return [];
  const routes = Array.isArray(source.champion?.routes)
    ? source.champion.routes
    : Array.isArray(source.routes)
      ? source.routes
      : Array.isArray(source.bestPortfolio?.selectedRoutes)
        ? source.bestPortfolio.selectedRoutes
        : [];
  return routes.map((route) => ({ ...route, sourceModule }));
}

function phase5Routes(phase5, variantName) {
  const variant = phase5?.variants?.find((item) => item.name === variantName);
  return (variant?.routes || []).map((route) => ({ ...route, sourceModule: `phase5:${variantName}` }));
}

function forwardTrust(route, trustBook) {
  const direct = trustBook.routes?.[routeTrustKey(route)];
  if (direct) return direct;
  return Object.entries(trustBook.routes || {}).find(([key]) => (
    key.startsWith(`${route.symbol}|`) && key.endsWith(`|${route.triggerMode}`)
  ))?.[1] || { trades: 0, winRate: 0, netDollars: 0, profitFactor: 0 };
}

function routeProfitFactor(route) {
  const grossWin = route.test?.grossWin ?? Math.max(route.test?.netDollars || 0, 0);
  const grossLoss = route.test?.grossLoss ?? Math.abs(Math.min(route.test?.netDollars || 0, 0));
  return grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? 999 : 0);
}

function specialistType(sourceModule) {
  if (sourceModule === 'main') return 'main-default';
  if (sourceModule.includes('phase5')) return 'profit-expansion';
  if (sourceModule.includes('phase4')) return 'context-confirmed';
  if (sourceModule.includes('phase3')) return 'exit-optimized';
  if (sourceModule.includes('phase2')) return 'weight-optimized';
  return 'specialist';
}

function routeQuality(route, trustBook) {
  const test = route.test || {};
  const robustness = route.robustness || {};
  const trust = forwardTrust(route, trustBook);
  const forwardBoost = trust.trades >= 3 && trust.netDollars > 0 ? 25 + Math.min(trust.winRate, 100) * 0.15 : 0;
  const forwardPenalty = trust.trades >= 3 && trust.netDollars <= 0 ? 45 : 0;
  const overfitPenalty = Math.max(0, route.overfitPenalty || 0);
  return (test.winRate || 0) * 1.75
    + Math.min(test.avgDollars || 0, 1600) / 12
    + Math.min(routeProfitFactor(route), 14) * 8
    + Math.min(robustness.monteCarloSurvivalRate || 0, 100) * 0.35
    + Math.min(robustness.profitConsistencyScore || 0, 100) * 0.2
    + Math.min(robustness.optionWorthyScore || 0, 100) * 0.12
    + forwardBoost
    - forwardPenalty
    - overfitPenalty;
}

function qualifies(route, sourceModule, policy, trustBook) {
  const test = route.test || {};
  const robustness = route.robustness || {};
  const trust = forwardTrust(route, trustBook);
  if ((test.trades || 0) < minSpecialistTrades) return false;
  if ((test.netDollars || 0) <= 0) return false;
  if ((test.winRate || 0) < minSpecialistWin && sourceModule !== 'main') return false;
  if ((robustness.uniqueDays || 0) < 3 && sourceModule !== 'main') return false;
  if ((robustness.monteCarloSurvivalRate || 0) < 85 && sourceModule !== 'main') return false;
  if (trust.trades >= 3 && trust.netDollars <= 0 && sourceModule !== 'main') return false;
  if (policy === 'high_win_router') return sourceModule === 'main' || (test.winRate >= 90 && routeProfitFactor(route) >= 6);
  if (policy === 'profit_expansion_router') return sourceModule === 'main' || (test.winRate >= 84 && (test.avgDollars || 0) >= 600 && routeProfitFactor(route) >= 4);
  if (policy === 'context_router') return sourceModule === 'main' || sourceModule.includes('phase4') || (test.winRate >= 88 && (robustness.relativeStrengthProxy || 0) >= 70);
  if (policy === 'forward_priority_router') return sourceModule === 'main' || (trust.trades >= 3 && trust.netDollars > 0);
  return sourceModule === 'main' || (test.winRate >= 88 && routeProfitFactor(route) >= 5);
}

function portfolioMetrics(routes) {
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
  };
}

function buildRouter(allRoutes, policy, trustBook) {
  const candidates = allRoutes
    .map((route) => ({
      ...route,
      routerType: specialistType(route.sourceModule),
      forwardTrust: forwardTrust(route, trustBook),
      routerScore: routeQuality(route, trustBook),
      profitFactor: routeProfitFactor(route),
    }))
    .filter((route) => qualifies(route, route.sourceModule, policy, trustBook))
    .sort((a, b) => b.routerScore - a.routerScore);

  const picked = [];
  const seen = new Set();
  const conflicts = new Map();
  for (const route of candidates) {
    const key = routeKey(route);
    const cKey = conflictKey(route);
    if (seen.has(key)) continue;
    const existing = conflicts.get(cKey);
    if (existing && existing.sourceModule === 'main' && route.sourceModule !== 'main' && route.routerScore < existing.routerScore + 10) continue;
    if (existing && existing.sourceModule !== 'main' && route.routerScore <= existing.routerScore) continue;
    if (existing) {
      const index = picked.findIndex((item) => routeKey(item) === routeKey(existing));
      if (index >= 0) picked.splice(index, 1);
    }
    picked.push(route);
    seen.add(key);
    conflicts.set(cKey, route);
    if (picked.length >= maxRoutes) break;
  }
  return { name: policy, metrics: portfolioMetrics(picked), routes: picked };
}

function routerScore(router, currentMain) {
  const metrics = router.metrics || {};
  if (!metrics.trades) return 0;
  const tradeFloorBonus = metrics.trades >= minChampionTrades ? 35 : -80;
  const mainWinGuard = metrics.winRate >= (currentMain.winRate || 0) - 3 ? 25 : -35;
  return metrics.winRate * 1.3
    + Math.min(metrics.projectedNet / 100, 330)
    + Math.min(metrics.trades, 700) * 0.12
    + Math.min(metrics.profitFactor, 14) * 7
    + tradeFloorBonus
    + mainWinGuard;
}

const mainPath = join(playbooksDir, 'current-master-scalp-champion.json');
const phase2Path = maybeRead(join(playbooksDir, 'current-phase2-specialist-candidate.json'))?.best?.snapshotPath;
const phase3Path = maybeRead(join(playbooksDir, 'current-phase3-specialist-candidate.json'))?.best?.snapshotPath;
const phase4Path = maybeRead(join(playbooksDir, 'current-phase4-specialist-candidate.json'))?.best?.snapshotPath;
const phase5Path = join(playbooksDir, 'current-phase5-merge-tournament.json');
const trustPath = join(root, 'optimization-results', 'forward-tests', 'route-forward-trust.json');

const main = maybeRead(mainPath);
const phase2 = phase2Path ? maybeRead(phase2Path) : null;
const phase3 = phase3Path ? maybeRead(phase3Path) : null;
const phase4 = phase4Path ? maybeRead(phase4Path) : null;
const phase5 = maybeRead(phase5Path);
const trustBook = maybeRead(trustPath) || { routes: {} };

const allRoutes = [
  ...extractRoutes(main, 'main'),
  ...extractRoutes(phase2, 'phase2:weight-optimized'),
  ...extractRoutes(phase3, 'phase3:exit-optimized'),
  ...extractRoutes(phase4, 'phase4:context-confirmed'),
  ...phase5Routes(phase5, 'main_plus_exit'),
  ...phase5Routes(phase5, 'main_plus_context'),
  ...phase5Routes(phase5, 'main_plus_phase5_runs'),
  ...phase5Routes(phase5, 'main_plus_all_specialists'),
];

const policies = [
  'high_win_router',
  'profit_expansion_router',
  'balanced_router',
  'context_router',
  'forward_priority_router',
];
const currentMain = main?.champion?.metrics || {};
const routers = policies.map((policy) => {
  const router = buildRouter(allRoutes, policy, trustBook);
  return { ...router, routerScore: routerScore(router, currentMain) };
}).sort((a, b) => b.routerScore - a.routerScore);

const best = routers[0];
const promoteRouter = best.metrics.trades >= minChampionTrades
  && best.metrics.winRate >= (currentMain.winRate || 0) - 3.25
  && best.metrics.netDollars >= (currentMain.netDollars || 0) * 1.05
  && best.metrics.profitFactor >= Math.min(currentMain.profitFactor || 0, 10) * 0.78;
const cleanUpgrade = routers.find((router) => (
  router.metrics.trades >= Math.max(minChampionTrades, currentMain.trades || 0)
  && router.metrics.winRate >= (currentMain.winRate || 0)
  && router.metrics.netDollars >= (currentMain.netDollars || 0)
  && router.metrics.profitFactor >= (currentMain.profitFactor || 0) * 0.98
));

const activeRouter = cleanUpgrade || (promoteRouter ? best : routers.find((router) => router.name === 'high_win_router') || best);
const payload = {
  updatedAt: new Date().toISOString(),
  phase: 'phase6-specialist-router',
  rules: {
    mainDefault: true,
    minChampionTrades,
    minSpecialistTrades,
    minSpecialistWin,
    promotion: 'router can become active expansion layer, but main champion remains protected unless net/trades improve without a large win/PF haircut',
  },
  sourcePaths: {
    mainPath,
    phase2Path,
    phase3Path,
    phase4Path,
    phase5Path,
    trustPath: existsSync(trustPath) ? trustPath : null,
  },
  currentMain,
  routers: routers.map((router) => ({
    name: router.name,
    metrics: router.metrics,
    routerScore: router.routerScore,
    routeSources: router.routes.reduce((acc, route) => {
      acc[route.sourceModule] = (acc[route.sourceModule] || 0) + 1;
      return acc;
    }, {}),
    routes: router.routes.slice(0, 100),
  })),
  best: {
    name: best.name,
    metrics: best.metrics,
    routerScore: best.routerScore,
  },
  active: {
    name: activeRouter.name,
    reason: cleanUpgrade ? 'router improved trades, win rate, net, and held profit factor' : promoteRouter ? 'profit expansion router passed guardrails' : 'main/high-win router remains active; expansion saved as specialist',
    metrics: activeRouter.metrics,
    routes: activeRouter.routes,
  },
  promotion: {
    promoteRouter: Boolean(cleanUpgrade || promoteRouter),
    decision: cleanUpgrade ? 'activate-clean-router-upgrade' : promoteRouter ? 'activate-profit-expansion-router' : 'retain-main-with-specialist-watchlist',
  },
};

const outPath = join(playbooksDir, 'current-phase6-specialist-router.json');
writeFileSync(outPath, `${JSON.stringify(payload, null, 2)}\n`);
appendFileSync(join(playbooksDir, 'phase6-specialist-router-history.jsonl'), `${JSON.stringify(payload)}\n`);

const pinePayload = {
  generatedAt: payload.updatedAt,
  activeRouter: payload.active.name,
  decision: payload.promotion.decision,
  currentMain,
  activeMetrics: payload.active.metrics,
  specialists: routers.map((router) => ({
    name: router.name,
    trades: router.metrics.trades,
    winRate: router.metrics.winRate,
    profitFactor: router.metrics.profitFactor,
    projectedNet: router.metrics.projectedNet,
  })),
  routes: payload.active.routes.map((route) => ({
    symbol: route.symbol,
    session: route.session,
    direction: route.direction,
    triggerMode: route.triggerMode,
    routerType: route.routerType,
    sourceModule: route.sourceModule,
    routeName: `${route.symbol} ${route.triggerMode} ${route.direction} ${route.session}`,
    labelText: `${route.routerType} · ${route.triggerMode} · ${Number(route.combo?.targetR || 0).toFixed(2)}R`,
    targetMode: `T${Number(route.combo?.targetR || 0).toFixed(2)}R · stop ${route.combo?.timeStopBars || '?'} bars`,
    backtestWinRate: route.test?.winRate || 0,
    forwardWinRate: route.forwardTrust?.winRate || null,
    forwardTrades: route.forwardTrust?.trades || 0,
    profitFactor: route.profitFactor,
    routerScore: route.routerScore,
    noTradeReason: route.forwardTrust?.trades >= 3 && route.forwardTrust.netDollars <= 0 ? 'forward trust weak' : 'route active',
  })),
};
const pinePath = join(generatedDir, 'specialist_router_export.json');
writeFileSync(pinePath, `${JSON.stringify(pinePayload, null, 2)}\n`);

console.log('\n=== phase 6 specialist router ===');
console.log(`Router saved: ${outPath}`);
console.log(`Pine/router metadata: ${pinePath}`);
console.log(`Best=${best.name} trades=${best.metrics.trades} win=${best.metrics.winRate.toFixed(2)} pf=${best.metrics.profitFactor.toFixed(2)} net=$${best.metrics.netDollars.toFixed(0)} projected=$${best.metrics.projectedNet.toFixed(0)}`);
console.log(`Active=${payload.active.name} trades=${payload.active.metrics.trades} win=${payload.active.metrics.winRate.toFixed(2)} pf=${payload.active.metrics.profitFactor.toFixed(2)} net=$${payload.active.metrics.netDollars.toFixed(0)} projected=$${payload.active.metrics.projectedNet.toFixed(0)}`);
console.log(`Decision=${payload.promotion.decision}`);
