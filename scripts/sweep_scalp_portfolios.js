#!/usr/bin/env node
import { createReadStream, existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
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

const routesPath = args.get('routes') || join(playbooksDir, 'current-walk-forward-scalp-routes.json');
const projectionCapital = Number(args.get('projection-capital') || 10000);
const routeBook = JSON.parse(readFileSync(routesPath, 'utf8'));

function comboKey(symbol, combo) {
  return `${symbol}|${JSON.stringify(combo)}`;
}

function routePasses(route, name) {
  if (name === 'allValidated') return true;
  if (name === 'highWin') return route.test.winRate >= 70 && route.test.trades >= 5;
  if (name === 'elite') return route.test.winRate >= 80 && route.test.trades >= 5;
  if (name === 'profitFirst') return route.test.trades >= 5 && route.test.avgDollars >= 350 && route.test.winRate >= 60;
  if (name === 'profitFirstElite') return route.test.trades >= 5 && route.test.avgDollars >= 400 && route.test.winRate >= 75;
  if (name === 'recentStableElite') return route.test.trades >= 5 && route.test.winRate >= 75 && route.recent?.trades >= 2 && route.recent.winRate >= 75 && route.recent.netDollars > 0;
  if (name === 'recentProfitElite') return route.test.trades >= 5 && route.test.winRate >= 75 && route.test.avgDollars >= 400 && route.recent?.trades >= 2 && route.recent.winRate >= 75 && route.recent.netDollars > 0;
  if (name === 'qualityElite') return route.qualityScore >= 185 && route.test.trades >= 5 && route.recent?.trades >= 2;
  return false;
}

function routePriority(route) {
  const optionBonus = Math.min(route.test.optionWorthyRate || 0, 40) * 0.7 + Math.min(route.test.greatTradeRate || 0, 25);
  const decayPenalty = route.recent?.trades > 0 ? Math.max(0, route.test.winRate - route.recent.winRate) * 1.2 : 0;
  return route.test.winRate * 1.2
    + Math.min(route.test.avgDollars / 10, 100)
    + Math.min(route.test.trades, 30)
    + (route.recent?.winRate || 0) * 0.4
    + (route.qualityScore || 0) * 0.25
    + optionBonus
    - (route.test.maxLossStreak || 0) * 6
    - decayPenalty;
}

function routeScale(route, sizingMode) {
  if (sizingMode === 'fixed') return 1;
  const quality = Math.max(0, Math.min(1, ((route.qualityScore || 150) - 150) / 100));
  const recent = Math.max(0, Math.min(1, ((route.recent?.winRate || route.test.winRate) - 60) / 40));
  const drawdown = Math.max(0, Math.min(1, 1 - (route.test.maxDrawdownDollars || 0) / 5000));
  return Math.max(0.35, Math.min(1.35, 0.45 + quality * 0.45 + recent * 0.30 + drawdown * 0.15));
}

function barBucket(timestamp, minutes = 5) {
  return Math.floor(timestamp / (minutes * 60));
}

function isOverlapping(candidate, active) {
  return active.some((trade) => candidate.symbol === trade.symbol
    && candidate.trade.entryTime <= trade.trade.exitTime
    && candidate.trade.exitTime >= trade.trade.entryTime);
}

function settleActive(active, currentEntryTime) {
  return active.filter((trade) => trade.trade.exitTime >= currentEntryTime);
}

function pnlFor(row) {
  return (row.trade.pnlDollars || 0) * (row.sizeScale || 1);
}

function metrics(trades, sourceCapital = 100000) {
  const wins = trades.filter((row) => pnlFor(row) > 0);
  const losses = trades.filter((row) => pnlFor(row) <= 0);
  const netDollars = trades.reduce((sum, row) => sum + pnlFor(row), 0);
  const grossWin = wins.reduce((sum, row) => sum + pnlFor(row), 0);
  const grossLoss = Math.abs(losses.reduce((sum, row) => sum + pnlFor(row), 0));
  let equity = 0;
  let peak = 0;
  let maxDrawdownDollars = 0;
  let lossStreak = 0;
  let maxLossStreak = 0;
  for (const row of [...trades].sort((a, b) => a.trade.entryTime - b.trade.entryTime)) {
    equity += pnlFor(row);
    peak = Math.max(peak, equity);
    maxDrawdownDollars = Math.max(maxDrawdownDollars, peak - equity);
    if ((row.trade.pnlDollars || 0) > 0) lossStreak = 0;
    else {
      lossStreak += 1;
      maxLossStreak = Math.max(maxLossStreak, lossStreak);
    }
  }
  const scale = sourceCapital > 0 ? projectionCapital / sourceCapital : 0.1;
  return {
    trades: trades.length,
    wins: wins.length,
    losses: losses.length,
    winRate: trades.length ? wins.length / trades.length * 100 : 0,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? 999 : 0),
    netDollars,
    avgDollars: trades.length ? netDollars / trades.length : 0,
    maxDrawdownDollars,
    maxLossStreak,
    projectionCapital,
    projectedNet: netDollars * scale,
    projectedReturnPct: projectionCapital > 0 ? (netDollars * scale) / projectionCapital * 100 : 0,
    projectedAvgDollars: trades.length ? (netDollars * scale) / trades.length : 0,
  };
}

function selectRoutes({ tier, familyMode, maxRoutesPerSymbol, maxRoutesPerFamily }) {
  let routes = routeBook.validated
    .filter((route) => routePasses(route, tier))
    .map((route) => ({ ...route, priority: routePriority(route) }))
    .sort((a, b) => b.priority - a.priority);
  if (familyMode === 'best') {
    const familyScores = new Map();
    for (const route of routes) {
      const item = familyScores.get(route.family) || { routes: 0, priority: 0 };
      item.routes += 1;
      item.priority += route.priority;
      familyScores.set(route.family, item);
    }
    const bestFamily = [...familyScores.entries()].map(([family, item]) => [family, item.priority / item.routes]).sort((a, b) => b[1] - a[1])[0]?.[0];
    if (bestFamily) routes = routes.filter((route) => route.family === bestFamily);
  }
  const symbolCounts = new Map();
  const familyCounts = new Map();
  return routes.filter((route) => {
    const symbolCount = symbolCounts.get(route.symbol) || 0;
    const familyCount = familyCounts.get(route.family) || 0;
    if (symbolCount >= maxRoutesPerSymbol) return false;
    if (maxRoutesPerFamily > 0 && familyCount >= maxRoutesPerFamily) return false;
    symbolCounts.set(route.symbol, symbolCount + 1);
    familyCounts.set(route.family, familyCount + 1);
    return true;
  });
}

const allRouteKeys = new Set(routeBook.validated.map((route) => comboKey(route.symbol, route.combo)));
const tradeRowsByKey = new Map();
const testSummary = JSON.parse(readFileSync(routeBook.testSummaryPath, 'utf8'));
const tradesPath = testSummary.paths?.trades;
if (!tradesPath) throw new Error(`${routeBook.testSummaryPath} has no trade log`);
const lines = createInterface({ input: createReadStream(tradesPath, { encoding: 'utf8' }), crlfDelay: Infinity });
for await (const line of lines) {
  if (!line) continue;
  const row = JSON.parse(line);
  const key = comboKey(row.symbol, row.combo);
  if (!allRouteKeys.has(key)) continue;
  const list = tradeRowsByKey.get(key) || [];
  list.push(row);
  tradeRowsByKey.set(key, list);
}

function buildPortfolio(settings) {
  const selectedRoutes = selectRoutes(settings);
  const routeByKey = new Map(selectedRoutes.map((route) => [comboKey(route.symbol, route.combo), route]));
  const testTrades = [];
  for (const [key, rows] of tradeRowsByKey.entries()) {
    const route = routeByKey.get(key);
    if (!route) continue;
    for (const row of rows) testTrades.push({ ...row, route });
  }
  testTrades.sort((a, b) => (a.trade.entryTime - b.trade.entryTime) || (b.route.priority - a.route.priority));
  const accepted = [];
  const rejected = [];
  let active = [];
  const lastSymbolBucket = new Map();
  for (const row of testTrades) {
    active = settleActive(active, row.trade.entryTime);
    const bucket = barBucket(row.trade.entryTime);
    const lastBucket = lastSymbolBucket.get(row.symbol);
    const sameSymbolTooSoon = lastBucket != null && bucket - lastBucket < settings.minGapBars;
    const overlap = isOverlapping(row, active);
    const tooMany = active.length >= settings.maxConcurrent;
    if (sameSymbolTooSoon || overlap || tooMany) {
      rejected.push({ symbol: row.symbol, reason: sameSymbolTooSoon ? 'same-symbol-gap' : overlap ? 'same-symbol-overlap' : 'max-concurrent' });
      continue;
    }
    row.sizeScale = routeScale(row.route, settings.sizingMode);
    accepted.push(row);
    active.push(row);
    lastSymbolBucket.set(row.symbol, bucket);
  }
  const sourceCapital = testTrades[0]?.capital || 100000;
  return {
    updatedAt: new Date().toISOString(),
    routesPath,
    tier: settings.tier,
    settings,
    selectedRoutes: selectedRoutes.length,
    rawCandidates: metrics(testTrades, sourceCapital),
    portfolio: metrics(accepted, sourceCapital),
    rejected: {
      trades: rejected.length,
      byReason: rejected.reduce((acc, row) => {
        acc[row.reason] = (acc[row.reason] || 0) + 1;
        return acc;
      }, {}),
    },
    acceptedTrades: accepted.map((row) => ({
      symbol: row.symbol,
      session: row.route.session,
      direction: row.route.direction,
      triggerMode: row.route.combo.triggerMode,
      entryTime: row.trade.entryTime,
      exitTime: row.trade.exitTime,
      side: row.trade.side,
      entry: row.trade.entry,
      exit: row.trade.exit,
      reason: row.trade.reason,
      pnlDollars: row.trade.pnlDollars,
      adjustedPnlDollars: pnlFor(row),
      sizeScale: row.sizeScale || 1,
      pnlR: row.trade.pnlR,
      routeWinRate: row.route.test.winRate,
      routeAvgDollars: row.route.test.avgDollars,
    })),
  };
}

function scorePortfolio(payload) {
  const m = payload.portfolio;
  return m.winRate * 2.2
    + Math.min(m.profitFactor, 20) * 10
    + Math.min(m.projectedNet / 100, 250)
    + Math.min(m.trades, 800) * 0.12
    - Math.min(m.maxDrawdownDollars / 100, 80)
    - m.maxLossStreak * 16;
}

const variants = [];
for (const tier of ['recentProfitElite', 'qualityElite', 'profitFirstElite', 'elite', 'highWin', 'allValidated']) {
  for (const maxConcurrent of [1, 2, 3, 5, 8]) {
    for (const sizingMode of ['quality', 'fixed']) {
      for (const familyMode of ['all', 'best']) {
        for (const maxRoutesPerSymbol of [1, 2, 3]) {
          variants.push({ tier, maxConcurrent, sizingMode, familyMode, maxRoutesPerSymbol, maxRoutesPerFamily: 0, minGapBars: 1, projectionCapital, optionsMode: 'bonus', decayGuard: true });
        }
      }
    }
  }
}

const leaderboard = variants
  .map((settings) => {
    const portfolio = buildPortfolio(settings);
    return { score: scorePortfolio(portfolio), settings, portfolio };
  })
  .sort((a, b) => b.score - a.score);

const best = leaderboard[0];
const out = join(playbooksDir, 'current-scalp-portfolio.json');
const championPath = join(playbooksDir, 'current-trigger-champion.json');
const leaderboardPath = join(playbooksDir, 'trigger-challenger-leaderboard.json');
const historyPath = join(playbooksDir, 'trigger-champion-history.jsonl');
writeFileSync(out, `${JSON.stringify(best.portfolio, null, 2)}\n`);
writeFileSync(championPath, `${JSON.stringify({
  updatedAt: new Date().toISOString(),
  routesPath,
  testSummaryPath: routeBook.testSummaryPath,
  trainSummaryPath: routeBook.trainSummaryPath,
  stressSummaryPath: routeBook.stressSummaryPath,
  champion: {
    score: best.score,
    ...best.settings,
    selectedRoutes: best.portfolio.selectedRoutes,
    rawCandidates: best.portfolio.rawCandidates,
    portfolio: best.portfolio.portfolio,
    acceptedTrades: best.portfolio.acceptedTrades,
  },
  topChallengers: leaderboard.slice(0, 25).map((row) => ({
    score: row.score,
    settings: row.settings,
    selectedRoutes: row.portfolio.selectedRoutes,
    portfolio: row.portfolio.portfolio,
    rawCandidates: row.portfolio.rawCandidates,
  })),
}, null, 2)}\n`);
writeFileSync(leaderboardPath, `${JSON.stringify(leaderboard.slice(0, 100).map((row) => ({
  score: row.score,
  settings: row.settings,
  selectedRoutes: row.portfolio.selectedRoutes,
  portfolio: row.portfolio.portfolio,
  rawCandidates: row.portfolio.rawCandidates,
})), null, 2)}\n`);
appendFileSync(historyPath, `${JSON.stringify({ event: 'promoted', updatedAt: new Date().toISOString(), score: best.score, settings: best.settings, portfolio: best.portfolio.portfolio })}\n`);

console.log(`Portfolio sweep saved: ${leaderboardPath}`);
console.log(`Champion saved: ${championPath}`);
console.log(`Current portfolio saved: ${out}`);
console.log(`Best: tier=${best.settings.tier} concurrent=${best.settings.maxConcurrent} sizing=${best.settings.sizingMode} family=${best.settings.familyMode} cap=${best.settings.maxRoutesPerSymbol}`);
console.log(`Trades=${best.portfolio.portfolio.trades} win=${best.portfolio.portfolio.winRate.toFixed(2)} pf=${best.portfolio.portfolio.profitFactor.toFixed(2)} net=$${best.portfolio.portfolio.netDollars.toFixed(0)} projected=$${best.portfolio.portfolio.projectedNet.toFixed(0)} avg=$${best.portfolio.portfolio.projectedAvgDollars.toFixed(2)} maxDD=$${best.portfolio.portfolio.maxDrawdownDollars.toFixed(0)} score=${best.score.toFixed(2)}`);
