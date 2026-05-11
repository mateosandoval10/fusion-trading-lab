#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

const paths = {
  fullTrades: join(root, 'optimization-results', 'canonical', 'canonical-trades.full.jsonl'),
  sampleTrades: join(root, 'data', 'canonical', 'canonical-trades.sample.jsonl'),
  routeManifest: join(root, 'data', 'canonical', 'route-manifest.json'),
  symbolManifest: join(root, 'data', 'canonical', 'symbol-manifest.json'),
  canonicalSummary: join(root, 'data', 'canonical', 'canonical-summary.json'),
  factory: join(root, 'models', 'specialists', 'phase21-specialist-factory.json'),
  phase19: join(root, 'models', 'champions', 'current-phase19-champion-council-fusion.json'),
  champions: join(root, 'models', 'champions'),
  specialists: join(root, 'models', 'specialists'),
  registry: join(root, 'models', 'registry'),
  reports: join(root, 'reports'),
  phase22Runs: join(root, 'optimization-results', 'phase22'),
  dashboardData: join(root, 'apps', 'dashboard', 'public', 'data'),
  generated: join(root, 'generated'),
};

for (const path of [paths.champions, paths.specialists, paths.registry, paths.reports, paths.phase22Runs, paths.dashboardData, paths.generated]) {
  mkdirSync(path, { recursive: true });
}

const args = new Map(process.argv.slice(2).map((arg) => {
  const [key, value = 'true'] = arg.replace(/^--/, '').split('=');
  return [key, value];
}));

const maxVariants = Number(args.get('max-variants') || 24000);
const topKeep = Number(args.get('top-keep') || 120);
const minMainTrades = Number(args.get('min-main-trades') || 150);
const stressCostDollars = Number(args.get('stress-cost-dollars') || 22);
const stressPct = Number(args.get('stress-pct') || 0.018);
const monteCarloRuns = Number(args.get('monte-carlo-runs') || 160);

function readJson(path, fallback = null) {
  if (!existsSync(path)) return fallback;
  return JSON.parse(readFileSync(path, 'utf8'));
}

function writeJson(path, payload) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(payload, null, 2)}\n`);
}

function readJsonl(path) {
  if (!existsSync(path)) return [];
  const raw = readFileSync(path, 'utf8').trim();
  if (!raw) return [];
  return raw.split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

function number(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function safeName(value) {
  return String(value || 'all').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'all';
}

function tradeTime(trade) {
  const value = number(trade.entryTime, 0);
  if (value > 0) return value > 100000000000 ? Math.round(value / 1000) : Math.round(value);
  const parsed = Date.parse(trade.date);
  return Number.isFinite(parsed) ? Math.round(parsed / 1000) : 0;
}

function weekFromDate(date) {
  if (!date || date === 'unknown') return 'unknown';
  const parsed = new Date(`${date}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) return 'unknown';
  const start = new Date(Date.UTC(parsed.getUTCFullYear(), 0, 1));
  const days = Math.floor((parsed - start) / 86400000);
  const week = Math.floor((days + start.getUTCDay()) / 7) + 1;
  return `${parsed.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

function grossMetrics(trades, pnlFn = (trade) => number(trade.pnlDollars, 0)) {
  const wins = trades.filter((trade) => pnlFn(trade) > 0);
  const grossWin = wins.reduce((sum, trade) => sum + pnlFn(trade), 0);
  const grossLoss = Math.abs(trades.filter((trade) => pnlFn(trade) <= 0).reduce((sum, trade) => sum + pnlFn(trade), 0));
  const netDollars = trades.reduce((sum, trade) => sum + pnlFn(trade), 0);
  let equity = 0;
  let peak = 0;
  let maxDrawdownDollars = 0;
  let lossStreak = 0;
  let maxLossStreak = 0;
  for (const trade of trades) {
    const pnl = pnlFn(trade);
    equity += pnl;
    peak = Math.max(peak, equity);
    maxDrawdownDollars = Math.max(maxDrawdownDollars, peak - equity);
    if (pnl <= 0) lossStreak += 1;
    else lossStreak = 0;
    maxLossStreak = Math.max(maxLossStreak, lossStreak);
  }
  const avg = (field) => trades.length ? trades.reduce((sum, trade) => sum + number(trade[field], 0), 0) / trades.length : 0;
  return {
    trades: trades.length,
    wins: wins.length,
    losses: trades.length - wins.length,
    winRate: trades.length ? wins.length / trades.length * 100 : 0,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? 999 : 0,
    netDollars,
    avgDollars: trades.length ? netDollars / trades.length : 0,
    avgMfeR: avg('mfeR'),
    avgMaeR: avg('maeR'),
    optionWorthyRate: trades.length ? trades.filter((trade) => trade.optionWorthy || number(trade.mfeR, 0) >= 1.5).length / trades.length * 100 : 0,
    maxDrawdownDollars,
    maxLossStreak,
  };
}

function consistency(trades) {
  const byDay = new Map();
  const byWeek = new Map();
  let grossWin = 0;
  let largestWin = 0;
  for (const trade of trades) {
    byDay.set(trade.date, (byDay.get(trade.date) || 0) + number(trade.pnlDollars, 0));
    byWeek.set(weekFromDate(trade.date), (byWeek.get(weekFromDate(trade.date)) || 0) + number(trade.pnlDollars, 0));
    if (number(trade.pnlDollars, 0) > 0) {
      grossWin += number(trade.pnlDollars, 0);
      largestWin = Math.max(largestWin, number(trade.pnlDollars, 0));
    }
  }
  const days = [...byDay.entries()].filter(([date]) => date && date !== 'unknown');
  const weeks = [...byWeek.entries()].filter(([week]) => week && week !== 'unknown');
  return {
    uniqueDays: days.length,
    uniqueWeeks: weeks.length,
    profitableDays: days.filter(([, pnl]) => pnl > 0).length,
    profitableWeeks: weeks.filter(([, pnl]) => pnl > 0).length,
    dayConsistency: days.length ? days.filter(([, pnl]) => pnl > 0).length / days.length * 100 : 0,
    weekConsistency: weeks.length ? weeks.filter(([, pnl]) => pnl > 0).length / weeks.length * 100 : 0,
    outlierProfitShare: grossWin > 0 ? largestWin / grossWin * 100 : 0,
  };
}

function stressPnl(trade) {
  return number(trade.pnlDollars, 0) - stressCostDollars - Math.abs(number(trade.pnlDollars, 0)) * stressPct;
}

function splitChronological(trades) {
  const sorted = [...trades].sort((a, b) => tradeTime(a) - tradeTime(b));
  const trainEnd = Math.floor(sorted.length * 0.50);
  const testEnd = Math.floor(sorted.length * 0.75);
  return {
    train: sorted.slice(0, trainEnd),
    test: sorted.slice(trainEnd, testEnd),
    holdout: sorted.slice(testEnd),
  };
}

function oddEvenMetrics(trades) {
  const odd = [];
  const even = [];
  for (const trade of trades) {
    const day = Number(String(trade.date || '').slice(-2));
    if (Number.isFinite(day) && day % 2 === 0) even.push(trade);
    else odd.push(trade);
  }
  return { odd: grossMetrics(odd), even: grossMetrics(even) };
}

function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (1664525 * state + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

function monteCarlo(trades, runs = monteCarloRuns) {
  if (!trades.length) return { runs: 0, p05NetDollars: 0, medianNetDollars: 0, p95MaxDrawdownDollars: 0, worstLossStreak: 0 };
  const nets = [];
  const drawdowns = [];
  let worstLossStreak = 0;
  for (let run = 0; run < runs; run += 1) {
    const random = seededRandom(9001 + run);
    const shuffled = [...trades];
    for (let i = shuffled.length - 1; i > 0; i -= 1) {
      const j = Math.floor(random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    const metrics = grossMetrics(shuffled);
    nets.push(metrics.netDollars);
    drawdowns.push(metrics.maxDrawdownDollars);
    worstLossStreak = Math.max(worstLossStreak, metrics.maxLossStreak);
  }
  nets.sort((a, b) => a - b);
  drawdowns.sort((a, b) => a - b);
  return {
    runs,
    p05NetDollars: nets[Math.floor(runs * 0.05)] || 0,
    medianNetDollars: nets[Math.floor(runs * 0.50)] || 0,
    p95MaxDrawdownDollars: drawdowns[Math.floor(runs * 0.95)] || 0,
    worstLossStreak,
  };
}

function routeScore(route, profile) {
  const metrics = route.metrics || {};
  const c = route.consistency || {};
  const weights = profile.weights;
  const profitFactorScore = Math.min(100, number(metrics.profitFactor, 0) / 4 * 100);
  const avgScore = Math.max(0, Math.min(100, number(metrics.avgDollars, 0) / 600 * 100));
  const tradeDepth = Math.min(100, number(metrics.trades, 0) / 80 * 100);
  const drawdownPenalty = number(metrics.netDollars, 0) > 0
    ? Math.min(35, number(metrics.maxDrawdownDollars, 0) / Math.max(number(metrics.netDollars, 1), 1) * 20)
    : 35;
  const outlierPenalty = Math.max(0, number(c.outlierProfitShare, 0) - 45) * 0.4;
  return (
    number(metrics.winRate, 0) * weights.win +
    number(route.qualityScore, 0) * weights.quality +
    profitFactorScore * weights.profitFactor +
    avgScore * weights.avg +
    tradeDepth * weights.depth +
    number(c.dayConsistency, 0) * weights.consistency +
    number(metrics.optionWorthyRate, 0) * weights.options -
    drawdownPenalty * weights.drawdownPenalty -
    outlierPenalty * weights.outlierPenalty
  );
}

function routePass(route, config) {
  const metrics = route.metrics || {};
  const c = route.consistency || {};
  if (number(metrics.trades, 0) < config.minRouteTrades) return false;
  if (number(metrics.winRate, 0) < config.minRouteWinRate) return false;
  if (number(route.qualityScore, 0) < config.minQuality) return false;
  if (number(c.uniqueDays, 0) < config.minDays) return false;
  if (number(c.uniqueWeeks, 0) < config.minWeeks) return false;
  if (number(c.outlierProfitShare, 0) > config.maxOutlierShare) return false;
  if (number(metrics.netDollars, 0) <= 0) return false;
  if (number(metrics.profitFactor, 0) < config.minProfitFactor) return false;
  if (config.families.length && !config.families.includes(route.family)) return false;
  if (config.sessions.length && !config.sessions.includes(route.session)) return false;
  if (config.triggers.length && !config.triggers.includes(route.trigger)) return false;
  if (config.nonBaseOnly && route.trigger === 'base') return false;
  if (config.sides.length && !config.sides.includes(route.side)) return false;
  if (config.requireFactoryPromotable && route.factoryStatus !== 'factory-promotable') return false;
  return true;
}

function conflictKey(trade) {
  return [
    trade.symbol,
    trade.side,
    trade.entryTime,
    trade.exitTime,
    Number(trade.entry || 0).toFixed(4),
    Number(trade.exit || 0).toFixed(4),
  ].join('|');
}

function featureEdgePass(trade, route, config) {
  if (!config.useFeatureEdges) return true;
  const features = trade.features || {};
  const boosts = (route.featureBoosts || route.featureEdges || []).filter((edge) => number(edge.edge, 0) > 0).slice(0, config.featureEdgeCount);
  if (!boosts.length) return true;
  let hits = 0;
  for (const edge of boosts) {
    const featureValue = number(features[edge.feature], 0);
    const threshold = Math.max(0.35, Math.min(0.9, number(edge.winner, 0.65) * config.featureEdgeRatio));
    if (featureValue >= threshold) hits += 1;
  }
  return hits >= Math.min(config.minFeatureHits, boosts.length);
}

function optionShapePass(trade, config) {
  if (!config.requireOptionsShape) return true;
  const tags = trade.tags || [];
  const features = trade.features || {};
  return tags.includes('options-worthy-burst')
    || number(trade.mfeR, 0) >= 1.25
    || number(features.optionBurstShape, 0) >= 0.60
    || number(features.momentumBurst, 0) >= 0.62;
}

function selectTrades(config, routeScores, routeById, tradesByRoute) {
  const chosenRoutes = config.routes;
  const seen = new Map();
  for (const route of chosenRoutes) {
    for (const trade of tradesByRoute.get(route.key) || []) {
      if (config.confidenceFloor > 0 && number(trade.confidence, 0) > 0 && number(trade.confidence, 0) < config.confidenceFloor) continue;
      if (!optionShapePass(trade, config)) continue;
      if (!featureEdgePass(trade, route, config)) continue;
      const key = config.resolveConflicts ? conflictKey(trade) : trade.canonicalId;
      const existing = seen.get(key);
      const score = routeScores.get(route.key) || 0;
      if (!existing || score > existing.score || (score === existing.score && number(trade.confidence, 0) > number(existing.trade.confidence, 0))) {
        seen.set(key, { trade, route, score });
      }
    }
  }
  let selected = [...seen.values()].map(({ trade, route, score }) => ({
    ...trade,
    selectedRouteKey: route.key,
    selectedRouteQuality: route.qualityScore,
    selectedRouteScore: Number(score.toFixed(3)),
  })).sort((a, b) => tradeTime(a) - tradeTime(b));

  if (config.maxPerSymbolDay > 0) {
    const bucketed = new Map();
    for (const trade of selected) {
      const key = `${trade.date}|${trade.symbol}`;
      if (!bucketed.has(key)) bucketed.set(key, []);
      bucketed.get(key).push(trade);
    }
    selected = [...bucketed.values()].flatMap((bucket) => bucket
      .sort((a, b) => b.selectedRouteScore - a.selectedRouteScore || number(b.confidence, 0) - number(a.confidence, 0))
      .slice(0, config.maxPerSymbolDay))
      .sort((a, b) => tradeTime(a) - tradeTime(b));
  }
  return selected;
}

function scorePortfolio(config, selected) {
  const splits = splitChronological(selected);
  const all = grossMetrics(selected);
  const train = grossMetrics(splits.train);
  const test = grossMetrics(splits.test);
  const holdout = grossMetrics(splits.holdout);
  const stress = grossMetrics(selected, stressPnl);
  const holdoutStress = grossMetrics(splits.holdout, stressPnl);
  const oddEven = oddEvenMetrics(selected);
  const c = consistency(selected);
  const profile = config.profile;
  const netScore = Math.tanh(all.netDollars / profile.netScale) * 100;
  const holdoutNetScore = Math.tanh(holdout.netDollars / Math.max(profile.netScale * 0.25, 25000)) * 100;
  const avgScore = Math.max(0, Math.min(100, all.avgDollars / profile.avgScale * 100));
  const tradeScore = Math.min(100, all.trades / profile.tradeScale * 100);
  const stressScore = Math.tanh(stress.netDollars / Math.max(profile.netScale * 0.75, 25000)) * 100;
  const drawdownPenalty = all.netDollars > 0 ? Math.min(40, all.maxDrawdownDollars / Math.max(all.netDollars, 1) * 70) : 40;
  const lossPenalty = Math.min(35, all.maxLossStreak * profile.lossStreakPenalty);
  const dataPenalty = all.trades < config.minPortfolioTrades ? (config.minPortfolioTrades - all.trades) / config.minPortfolioTrades * 70 : 0;
  const holdoutPenalty = holdout.trades < Math.max(20, config.minPortfolioTrades * 0.15)
    ? (Math.max(20, config.minPortfolioTrades * 0.15) - holdout.trades) * 0.8
    : 0;
  const oddEvenGap = Math.abs(number(oddEven.odd.winRate, 0) - number(oddEven.even.winRate, 0));
  const score =
    all.winRate * profile.weights.win +
    test.winRate * profile.weights.testWin +
    holdout.winRate * profile.weights.holdoutWin +
    netScore * profile.weights.net +
    holdoutNetScore * profile.weights.holdoutNet +
    avgScore * profile.weights.avg +
    tradeScore * profile.weights.trades +
    stressScore * profile.weights.stress +
    c.dayConsistency * profile.weights.consistency +
    all.optionWorthyRate * profile.weights.options -
    drawdownPenalty * profile.weights.drawdown -
    lossPenalty -
    dataPenalty -
    holdoutPenalty -
    oddEvenGap * profile.oddEvenPenalty;

  return {
    score: Number(score.toFixed(3)),
    metrics: all,
    train,
    test,
    holdout,
    stress,
    holdoutStress,
    oddEven,
    consistency: c,
    diagnostics: {
      dataPenalty: Number(dataPenalty.toFixed(3)),
      holdoutPenalty: Number(holdoutPenalty.toFixed(3)),
      drawdownPenalty: Number(drawdownPenalty.toFixed(3)),
      lossPenalty: Number(lossPenalty.toFixed(3)),
      oddEvenGap: Number(oddEvenGap.toFixed(3)),
    },
  };
}

const profiles = [
  {
    name: 'balanced_fusion',
    minPortfolioTrades: minMainTrades,
    netScale: 350000,
    avgScale: 550,
    tradeScale: 700,
    lossStreakPenalty: 1.25,
    oddEvenPenalty: 0.08,
    weights: { win: 0.11, testWin: 0.14, holdoutWin: 0.18, net: 0.13, holdoutNet: 0.12, avg: 0.08, trades: 0.08, stress: 0.10, consistency: 0.08, options: 0.03, drawdown: 0.90, quality: 0.24, profitFactor: 0.14, depth: 0.08, drawdownPenalty: 0.65, outlierPenalty: 0.55 },
  },
  {
    name: 'high_win_strict',
    minPortfolioTrades: Math.max(80, Math.floor(minMainTrades * 0.55)),
    netScale: 220000,
    avgScale: 450,
    tradeScale: 350,
    lossStreakPenalty: 1.8,
    oddEvenPenalty: 0.12,
    weights: { win: 0.18, testWin: 0.18, holdoutWin: 0.24, net: 0.06, holdoutNet: 0.09, avg: 0.07, trades: 0.04, stress: 0.08, consistency: 0.12, options: 0.02, drawdown: 1.15, quality: 0.30, profitFactor: 0.17, depth: 0.05, drawdownPenalty: 0.95, outlierPenalty: 0.80 },
  },
  {
    name: 'profit_max',
    minPortfolioTrades: minMainTrades,
    netScale: 600000,
    avgScale: 750,
    tradeScale: 900,
    lossStreakPenalty: 0.85,
    oddEvenPenalty: 0.04,
    weights: { win: 0.06, testWin: 0.09, holdoutWin: 0.11, net: 0.24, holdoutNet: 0.17, avg: 0.13, trades: 0.10, stress: 0.11, consistency: 0.04, options: 0.05, drawdown: 0.65, quality: 0.16, profitFactor: 0.16, depth: 0.12, drawdownPenalty: 0.45, outlierPenalty: 0.35 },
  },
  {
    name: 'low_drawdown',
    minPortfolioTrades: Math.max(100, Math.floor(minMainTrades * 0.7)),
    netScale: 260000,
    avgScale: 500,
    tradeScale: 450,
    lossStreakPenalty: 2.15,
    oddEvenPenalty: 0.12,
    weights: { win: 0.13, testWin: 0.15, holdoutWin: 0.20, net: 0.09, holdoutNet: 0.10, avg: 0.07, trades: 0.04, stress: 0.11, consistency: 0.13, options: 0.02, drawdown: 1.45, quality: 0.26, profitFactor: 0.19, depth: 0.05, drawdownPenalty: 1.25, outlierPenalty: 0.95 },
  },
  {
    name: 'options_worthy',
    minPortfolioTrades: 45,
    netScale: 180000,
    avgScale: 900,
    tradeScale: 180,
    lossStreakPenalty: 1.25,
    oddEvenPenalty: 0.07,
    weights: { win: 0.08, testWin: 0.11, holdoutWin: 0.14, net: 0.15, holdoutNet: 0.13, avg: 0.17, trades: 0.03, stress: 0.09, consistency: 0.06, options: 0.13, drawdown: 0.75, quality: 0.20, profitFactor: 0.15, depth: 0.04, drawdownPenalty: 0.55, outlierPenalty: 0.45 },
  },
  {
    name: 'high_trade_count',
    minPortfolioTrades: Math.max(500, minMainTrades),
    netScale: 650000,
    avgScale: 350,
    tradeScale: 1400,
    lossStreakPenalty: 0.75,
    oddEvenPenalty: 0.04,
    weights: { win: 0.08, testWin: 0.10, holdoutWin: 0.12, net: 0.17, holdoutNet: 0.11, avg: 0.05, trades: 0.20, stress: 0.08, consistency: 0.06, options: 0.03, drawdown: 0.50, quality: 0.14, profitFactor: 0.10, depth: 0.22, drawdownPenalty: 0.40, outlierPenalty: 0.32 },
  },
];

const universes = [
  { name: 'all', families: [] },
  { name: 'low-priced', families: ['low-priced'] },
  { name: 'high-beta-growth', families: ['high-beta-growth'] },
  { name: 'crypto-proxy', families: ['crypto-proxy'] },
  { name: 'semis-ai', families: ['semis-ai'] },
  { name: 'ev-auto', families: ['ev-auto'] },
  { name: 'etf-macro', families: ['etf-macro'] },
  { name: 'momentum-basket', families: ['low-priced', 'high-beta-growth', 'crypto-proxy', 'ev-auto', 'semis-ai'] },
  { name: 'general', families: ['general'] },
];

const sessionSets = [
  { name: 'all-sessions', sessions: [] },
  { name: 'open-complex', sessions: ['open', 'open-0930', 'open-1000', 'open-1030'] },
  { name: 'open-0930', sessions: ['open-0930'] },
  { name: 'morning', sessions: ['morning'] },
  { name: 'afternoon', sessions: ['afternoon'] },
  { name: 'powerhour', sessions: ['powerhour'] },
  { name: 'all-route-only', sessions: ['all'] },
];

const triggerSets = [
  { name: 'all-triggers', triggers: [], nonBaseOnly: false },
  { name: 'base', triggers: ['base'], nonBaseOnly: false },
  { name: 'nonbase', triggers: [], nonBaseOnly: true },
  { name: 'hybrid', triggers: ['hybrid-consensus'], nonBaseOnly: false },
  { name: 'options-burst', triggers: ['options-burst'], nonBaseOnly: false, requireOptionsShape: true },
  { name: 'vwap-reclaim', triggers: ['vwap-reclaim', 'relative-strength-reclaim'], nonBaseOnly: false },
  { name: 'breakout-volume', triggers: ['breakout', 'volume-shock', 'opening-drive-continuation', 'opening-range'], nonBaseOnly: false },
  { name: 'compression-momentum', triggers: ['compression-pop', 'squeeze-expansion', 'momentum-acceleration', 'ema-pullback'], nonBaseOnly: false },
  { name: 'confirmed', triggers: ['confirmed-no-repaint'], nonBaseOnly: false },
];

const sides = [
  { name: 'both', sides: [] },
  { name: 'long', sides: ['long'] },
  { name: 'short', sides: ['short'] },
];

const strictness = [
  { name: 'wide', minQuality: 55, minRouteWinRate: 62, minRouteTrades: 5, minDays: 2, minWeeks: 1, maxOutlierShare: 75, minProfitFactor: 1.10, confidenceFloor: 0, topN: 500, maxPerSymbolDay: 3, minFeatureHits: 1, featureEdgeRatio: 0.62, featureEdgeCount: 4 },
  { name: 'balanced', minQuality: 65, minRouteWinRate: 68, minRouteTrades: 8, minDays: 3, minWeeks: 2, maxOutlierShare: 60, minProfitFactor: 1.20, confidenceFloor: 0, topN: 300, maxPerSymbolDay: 2, minFeatureHits: 1, featureEdgeRatio: 0.68, featureEdgeCount: 5 },
  { name: 'strict', minQuality: 74, minRouteWinRate: 76, minRouteTrades: 12, minDays: 4, minWeeks: 2, maxOutlierShare: 50, minProfitFactor: 1.35, confidenceFloor: 65, topN: 180, maxPerSymbolDay: 2, minFeatureHits: 2, featureEdgeRatio: 0.72, featureEdgeCount: 6 },
  { name: 'elite', minQuality: 82, minRouteWinRate: 84, minRouteTrades: 18, minDays: 5, minWeeks: 3, maxOutlierShare: 42, minProfitFactor: 1.65, confidenceFloor: 70, topN: 90, maxPerSymbolDay: 1, minFeatureHits: 2, featureEdgeRatio: 0.76, featureEdgeCount: 6 },
  { name: 'factory-only', minQuality: 70, minRouteWinRate: 72, minRouteTrades: 10, minDays: 3, minWeeks: 2, maxOutlierShare: 55, minProfitFactor: 1.25, confidenceFloor: 0, topN: 220, maxPerSymbolDay: 2, minFeatureHits: 1, featureEdgeRatio: 0.70, featureEdgeCount: 5, requireFactoryPromotable: true },
];

function makeConfig(profile, universe, sessionSet, triggerSet, sideSet, strict) {
  return {
    id: [
      'phase22',
      profile.name,
      universe.name,
      sessionSet.name,
      triggerSet.name,
      sideSet.name,
      strict.name,
    ].map(safeName).join('__'),
    profile,
    universe: universe.name,
    sessionGroup: sessionSet.name,
    triggerGroup: triggerSet.name,
    directionGroup: sideSet.name,
    strictness: strict.name,
    families: universe.families,
    sessions: sessionSet.sessions,
    triggers: triggerSet.triggers,
    nonBaseOnly: triggerSet.nonBaseOnly,
    sides: sideSet.sides,
    requireOptionsShape: Boolean(triggerSet.requireOptionsShape || profile.name === 'options_worthy'),
    useFeatureEdges: strict.name !== 'wide',
    resolveConflicts: true,
    minPortfolioTrades: profile.minPortfolioTrades,
    ...strict,
  };
}

function generateConfigs() {
  const configs = [];
  for (const profile of profiles) {
    for (const universe of universes) {
      for (const sessionSet of sessionSets) {
        for (const triggerSet of triggerSets) {
          for (const sideSet of sides) {
            for (const strict of strictness) {
              if (profile.name === 'options_worthy' && !['options-burst', 'breakout-volume', 'compression-momentum', 'all-triggers', 'nonbase'].includes(triggerSet.name)) continue;
              if (profile.name === 'high_trade_count' && strict.name === 'elite') continue;
              if (triggerSet.name === 'confirmed' && strict.name === 'wide') continue;
              configs.push(makeConfig(profile, universe, sessionSet, triggerSet, sideSet, strict));
              if (configs.length >= maxVariants) return configs;
            }
          }
        }
      }
    }
  }
  return configs;
}

function compactTrade(trade) {
  return {
    canonicalId: trade.canonicalId,
    symbol: trade.symbol,
    family: trade.family,
    side: trade.side,
    trigger: trade.trigger,
    session: trade.session,
    date: trade.date,
    entryTime: trade.entryTime,
    exitTime: trade.exitTime,
    entry: trade.entry,
    exit: trade.exit,
    pnlDollars: trade.pnlDollars,
    mfeR: trade.mfeR,
    maeR: trade.maeR,
    confidence: trade.confidence,
    selectedRouteKey: trade.selectedRouteKey,
    selectedRouteQuality: trade.selectedRouteQuality,
  };
}

function summarizeSymbols(trades, limit = 25) {
  const bySymbol = new Map();
  for (const trade of trades) {
    if (!bySymbol.has(trade.symbol)) bySymbol.set(trade.symbol, []);
    bySymbol.get(trade.symbol).push(trade);
  }
  return [...bySymbol.entries()]
    .map(([symbol, rows]) => ({ symbol, family: rows[0]?.family, metrics: grossMetrics(rows) }))
    .sort((a, b) => b.metrics.netDollars - a.metrics.netDollars)
    .slice(0, limit);
}

function summarizeRoutes(trades, limit = 40) {
  const byRoute = new Map();
  for (const trade of trades) {
    const key = trade.selectedRouteKey || trade.routeId;
    if (!byRoute.has(key)) byRoute.set(key, []);
    byRoute.get(key).push(trade);
  }
  return [...byRoute.entries()]
    .map(([key, rows]) => ({ key, metrics: grossMetrics(rows), consistency: consistency(rows) }))
    .sort((a, b) => b.metrics.netDollars - a.metrics.netDollars)
    .slice(0, limit);
}

const tradesPath = existsSync(paths.fullTrades) ? paths.fullTrades : paths.sampleTrades;
const rawTrades = readJsonl(tradesPath);
const routeManifest = readJson(paths.routeManifest, { routes: [] });
const factory = readJson(paths.factory, { candidates: [] });
const canonicalSummary = readJson(paths.canonicalSummary, null);
const phase19 = readJson(paths.phase19, null);

const factoryByRoute = new Map(factory.candidates.map((candidate) => [candidate.routeKey, candidate]));
const routeById = new Map();
for (const route of routeManifest.routes || []) {
  const factoryCandidate = factoryByRoute.get(route.key);
  routeById.set(route.key, {
    ...route,
    factoryStatus: factoryCandidate?.status || null,
    featureBoosts: factoryCandidate?.featureBoosts || route.featureEdges || [],
    suggestedRules: factoryCandidate?.suggestedRules || {},
  });
}

const tradesByRoute = new Map();
for (const trade of rawTrades) {
  const routeKeyValue = trade.routeId || [trade.symbol, trade.family, trade.trigger, trade.session, trade.side].join('|');
  if (!tradesByRoute.has(routeKeyValue)) tradesByRoute.set(routeKeyValue, []);
  tradesByRoute.get(routeKeyValue).push(trade);
}

const routes = [...routeById.values()].filter((route) => tradesByRoute.has(route.key));
const configs = generateConfigs();
const variants = [];
let evaluated = 0;

for (const config of configs) {
  const eligible = routes
    .filter((route) => routePass(route, config))
    .map((route) => ({ route, score: routeScore(route, config.profile) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, config.topN);
  if (!eligible.length) continue;
  const routeScores = new Map(eligible.map((item) => [item.route.key, item.score]));
  const selectedConfig = { ...config, routes: eligible.map((item) => item.route) };
  const selectedTrades = selectTrades(selectedConfig, routeScores, routeById, tradesByRoute);
  if (selectedTrades.length < Math.max(20, config.minPortfolioTrades * 0.25)) continue;
  const scored = scorePortfolio(selectedConfig, selectedTrades);
  evaluated += 1;
  variants.push({
    id: config.id,
    profile: config.profile.name,
    universe: config.universe,
    sessionGroup: config.sessionGroup,
    triggerGroup: config.triggerGroup,
    directionGroup: config.directionGroup,
    strictness: config.strictness,
    routeCount: eligible.length,
    score: scored.score,
    metrics: scored.metrics,
    train: scored.train,
    test: scored.test,
    holdout: scored.holdout,
    stress: scored.stress,
    holdoutStress: scored.holdoutStress,
    oddEven: scored.oddEven,
    consistency: scored.consistency,
    diagnostics: scored.diagnostics,
    selectedRouteKeys: eligible.map((item) => item.route.key).slice(0, 500),
    topRoutes: eligible.slice(0, 30).map((item) => ({
      key: item.route.key,
      symbol: item.route.symbol,
      family: item.route.family,
      trigger: item.route.trigger,
      session: item.route.session,
      side: item.route.side,
      routeScore: Number(item.score.toFixed(3)),
      qualityScore: item.route.qualityScore,
      metrics: item.route.metrics,
      consistency: item.route.consistency,
    })),
    topSymbols: summarizeSymbols(selectedTrades, 20),
    topTrades: selectedTrades
      .filter((trade) => number(trade.pnlDollars, 0) > 0)
      .sort((a, b) => number(b.pnlDollars, 0) - number(a.pnlDollars, 0))
      .slice(0, 20)
      .map(compactTrade),
    _selectedTrades: selectedTrades,
  });
}

variants.sort((a, b) => b.score - a.score || b.holdout.netDollars - a.holdout.netDollars);
const refined = variants.slice(0, Math.min(topKeep, variants.length)).map((variant) => {
  return {
    ...variant,
    monteCarlo: monteCarlo(variant._selectedTrades),
    selectedTradeSample: variant._selectedTrades.slice(0, 40).map(compactTrade),
  };
});

function bestFor(predicate) {
  return variants.find(predicate) || null;
}

const categoryChampions = {
  overall: variants[0] || null,
  mainMinimum150: bestFor((variant) => variant.metrics.trades >= minMainTrades),
  highWin150: [...variants].filter((variant) => variant.metrics.trades >= minMainTrades).sort((a, b) => b.metrics.winRate - a.metrics.winRate || b.metrics.netDollars - a.metrics.netDollars)[0] || null,
  profitMax: [...variants].filter((variant) => variant.metrics.trades >= minMainTrades).sort((a, b) => b.metrics.netDollars - a.metrics.netDollars || b.metrics.winRate - a.metrics.winRate)[0] || null,
  lowDrawdown: [...variants].filter((variant) => variant.metrics.trades >= minMainTrades).sort((a, b) => a.metrics.maxDrawdownDollars - b.metrics.maxDrawdownDollars || b.metrics.netDollars - a.metrics.netDollars)[0] || null,
  optionsWorthy: bestFor((variant) => variant.profile === 'options_worthy' && variant.metrics.trades >= 40),
  highTradeCount: bestFor((variant) => variant.profile === 'high_trade_count' && variant.metrics.trades >= 500),
  lowPriced: bestFor((variant) => variant.universe === 'low-priced' && variant.metrics.trades >= 60),
  semisAi: bestFor((variant) => variant.universe === 'semis-ai' && variant.metrics.trades >= 40),
  cryptoProxy: bestFor((variant) => variant.universe === 'crypto-proxy' && variant.metrics.trades >= 40),
};

function compactVariant(variant) {
  if (!variant) return null;
  return {
    id: variant.id,
    profile: variant.profile,
    universe: variant.universe,
    sessionGroup: variant.sessionGroup,
    triggerGroup: variant.triggerGroup,
    directionGroup: variant.directionGroup,
    strictness: variant.strictness,
    routeCount: variant.routeCount,
    score: variant.score,
    metrics: variant.metrics,
    train: variant.train,
    test: variant.test,
    holdout: variant.holdout,
    stress: variant.stress,
    holdoutStress: variant.holdoutStress,
    consistency: variant.consistency,
    monteCarlo: refined.find((item) => item.id === variant.id)?.monteCarlo || null,
    topRoutes: variant.topRoutes,
    topSymbols: variant.topSymbols,
    topTrades: variant.topTrades,
    selectedTradeSample: variant.selectedTradeSample || variant._selectedTrades?.slice(0, 25).map(compactTrade) || [],
    selectedRouteKeys: variant.selectedRouteKeys.slice(0, 250),
  };
}

const recommendedChampion = categoryChampions.mainMinimum150 || categoryChampions.overall;
const phase19Record = phase19?.variants?.[phase19?.bestVariant]?.portfolio || null;
const runId = `phase22-${new Date().toISOString().replace(/[:.]/g, '-')}`;
const output = {
  updatedAt: new Date().toISOString(),
  runId,
  phase: 'Phase22 Deep Specialist Tournament',
  goal: 'Fuse Phase21 canonical factory routes into the best validated scalp specialists without duplicate trade inflation.',
  source: 'canonical-trade-spine + phase21-specialist-factory',
  config: {
    maxVariants,
    configsGenerated: configs.length,
    variantsEvaluated: evaluated,
    tradesPath: tradesPath.replace(root, '.'),
    rawTradesLoaded: rawTrades.length,
    routeCandidates: routes.length,
    minMainTrades,
    stressCostDollars,
    stressPct,
    monteCarloRuns,
  },
  baseline: phase19Record ? {
    phase: phase19.phase,
    bestVariant: phase19.bestVariant,
    metrics: phase19Record.metrics,
    holdout: phase19Record.holdout,
    stress: phase19Record.stress,
  } : null,
  canonical: canonicalSummary ? {
    stats: canonicalSummary.stats,
    globalMetrics: canonicalSummary.globalMetrics,
  } : null,
  recommendedChampion: compactVariant(recommendedChampion),
  categoryChampions: Object.fromEntries(Object.entries(categoryChampions).map(([key, variant]) => [key, compactVariant(variant)])),
  rankedVariants: refined.map(compactVariant),
};

writeJson(join(paths.phase22Runs, `${runId}.json`), output);
writeJson(join(paths.champions, 'current-phase22-deep-specialist-tournament.json'), output);
writeJson(join(paths.reports, 'phase22-deep-specialist-tournament-report.json'), output);
writeJson(join(paths.dashboardData, 'phase22-deep-specialist-tournament.json'), output);
writeJson(join(paths.registry, 'phase22-deep-specialist-registry.json'), {
  updatedAt: output.updatedAt,
  runId,
  recommendedChampion: output.recommendedChampion,
  categoryChampions: output.categoryChampions,
  topVariants: output.rankedVariants.slice(0, 25),
});
writeJson(join(paths.generated, 'phase22_deep_specialist_export.json'), {
  updatedAt: output.updatedAt,
  runId,
  recommendedChampion: output.recommendedChampion,
  pineCandidateModes: Object.entries(output.categoryChampions)
    .filter(([, variant]) => variant)
    .map(([name, variant]) => ({
      name,
      id: variant.id,
      profile: variant.profile,
      universe: variant.universe,
      sessionGroup: variant.sessionGroup,
      triggerGroup: variant.triggerGroup,
      directionGroup: variant.directionGroup,
      winRate: variant.metrics.winRate,
      netDollars: variant.metrics.netDollars,
      trades: variant.metrics.trades,
      routeCount: variant.routeCount,
      topSymbols: variant.topSymbols?.slice(0, 12).map((item) => item.symbol) || [],
      topRoutes: variant.selectedRouteKeys?.slice(0, 30) || [],
    })),
});

console.log('Phase22 Deep Specialist Tournament complete');
console.log(`Trades loaded=${rawTrades.length} routes=${routes.length} configs=${configs.length} evaluated=${evaluated}`);
if (recommendedChampion) {
  console.log(`Recommended=${recommendedChampion.id}`);
  console.log(`Trades=${recommendedChampion.metrics.trades} win=${recommendedChampion.metrics.winRate.toFixed(2)}% net=$${recommendedChampion.metrics.netDollars.toFixed(0)} avg=$${recommendedChampion.metrics.avgDollars.toFixed(0)} holdout=${recommendedChampion.holdout.winRate.toFixed(2)}% stress=$${recommendedChampion.stress.netDollars.toFixed(0)}`);
}
console.log(`Report: ${join(paths.reports, 'phase22-deep-specialist-tournament-report.json')}`);
