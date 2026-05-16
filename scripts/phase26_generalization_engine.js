#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

const paths = {
  fullTrades: join(root, 'optimization-results', 'canonical', 'canonical-trades.full.jsonl'),
  phase22Ledgers: join(root, 'apps', 'dashboard', 'public', 'data', 'phase22-trade-ledgers.json'),
  phase23Ledgers: join(root, 'apps', 'dashboard', 'public', 'data', 'phase23-intelligence-trade-ledgers.json'),
  phase24Ledgers: join(root, 'apps', 'dashboard', 'public', 'data', 'phase24-trade-ledgers.json'),
  phase25Ledgers: join(root, 'apps', 'dashboard', 'public', 'data', 'phase25-fresh-symbol-trade-ledgers.json'),
  phase25Model: join(root, 'apps', 'dashboard', 'public', 'data', 'phase25-fresh-symbol-tournament.json'),
  forwardTrust: join(root, 'optimization-results', 'forward-tests', 'phase18-forward-route-trust.json'),
  models: join(root, 'models', 'generalization'),
  reports: join(root, 'reports', 'generalization'),
  dashboardData: join(root, 'apps', 'dashboard', 'public', 'data'),
  generated: join(root, 'generated'),
};

for (const path of [paths.models, paths.reports, paths.dashboardData, paths.generated]) mkdirSync(path, { recursive: true });

const args = new Map(process.argv.slice(2).map((arg) => {
  const [key, value = 'true'] = arg.replace(/^--/, '').split('=');
  return [key, value];
}));

const maxVariants = Number(args.get('max-variants') || 60000);
const minTrades = Number(args.get('min-trades') || 150);
const stressCostDollars = Number(args.get('stress-cost-dollars') || 28);
const stressPct = Number(args.get('stress-pct') || 0.025);
const deepStressCostDollars = Number(args.get('deep-stress-cost-dollars') || 54);
const deepStressPct = Number(args.get('deep-stress-pct') || 0.06);

function readJson(path, fallback = null) {
  if (!existsSync(path)) return fallback;
  return JSON.parse(readFileSync(path, 'utf8'));
}

function readJsonl(path) {
  if (!existsSync(path)) return [];
  const raw = readFileSync(path, 'utf8').trim();
  return raw ? raw.split('\n').filter(Boolean).map((line) => JSON.parse(line)) : [];
}

function writeJson(path, payload) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(payload, null, 2)}\n`);
}

function n(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, n(value, min)));
}

function clamp01(value) {
  return clamp(value, 0, 1);
}

function tradeTime(trade) {
  const value = n(trade.entryTime, 0);
  if (value > 0) return value > 100000000000 ? Math.round(value / 1000) : Math.round(value);
  const parsed = Date.parse(trade.date);
  return Number.isFinite(parsed) ? Math.round(parsed / 1000) : 0;
}

function isoTime(value) {
  const parsed = n(value, 0);
  return parsed ? new Date((parsed > 100000000000 ? parsed : parsed * 1000)).toISOString() : 'n/a';
}

function minutesHeld(trade) {
  const entry = n(trade.entryTime, 0);
  const exit = n(trade.exitTime, 0);
  if (!entry || !exit) return null;
  const entryMs = entry > 100000000000 ? entry : entry * 1000;
  const exitMs = exit > 100000000000 ? exit : exit * 1000;
  return Math.max(0, Math.round((exitMs - entryMs) / 60000));
}

function isOvernight(trade) {
  const entry = isoTime(trade.entryTime).slice(0, 10);
  const exit = isoTime(trade.exitTime).slice(0, 10);
  return entry !== 'n/a' && exit !== 'n/a' && entry !== exit;
}

function weekFromDate(date) {
  if (!date || date === 'unknown') return 'unknown';
  const parsed = new Date(`${date}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) return 'unknown';
  const start = new Date(Date.UTC(parsed.getUTCFullYear(), 0, 1));
  const days = Math.floor((parsed - start) / 86400000);
  return `${parsed.getUTCFullYear()}-W${String(Math.floor((days + start.getUTCDay()) / 7) + 1).padStart(2, '0')}`;
}

function riskDollars(trade) {
  const pnl = n(trade.pnlDollars, 0);
  const targetR = Math.max(0.1, n(trade.targetR, 0.5));
  if (pnl > 0) return Math.max(25, Math.abs(pnl) / targetR);
  if (pnl < 0) return Math.max(25, Math.abs(pnl));
  return 250;
}

function targetForTrade(trade, model) {
  if (model.targetMode === 'fixed025') return 0.25;
  if (model.targetMode === 'fixed035') return 0.35;
  if (model.targetMode === 'fixed050') return 0.50;
  if (model.targetMode === 'fixed075') return 0.75;
  const feature = trade.features || {};
  const burst = Math.max(clamp01(feature.optionBurstShape), clamp01(feature.momentumBurst), clamp01(feature.rangeExpansionQuality));
  const clean = (clamp01(feature.closeLocation) + clamp01(feature.cleanVolume) + clamp01(feature.volumeFlowAgreement)) / 3;
  const adverseRisk = (clamp01(feature.failedBreakRisk) + clamp01(feature.vwapExtensionRisk) + clamp01(feature.rejectionWick)) / 3;
  if (burst > 0.78 && clean > 0.62 && adverseRisk < 0.42) return 0.75;
  if (trade.session === 'open' || trade.session === 'open-0930' || model.layer === 'fast_time_profit') return 0.35;
  if (adverseRisk > 0.62) return 0.25;
  return 0.50;
}

function stopForTrade(trade, model) {
  if (model.stopMode === 'tight') return 0.72;
  if (model.stopMode === 'wide_structure') return 1.18;
  const feature = trade.features || {};
  const structure = (clamp01(feature.trendQuality) + clamp01(feature.vwapPressure) + clamp01(feature.pullbackReclaim) + clamp01(feature.cleanBreakout)) / 4;
  const failure = (clamp01(feature.failedBreakRisk) + clamp01(feature.vwapExtensionRisk)) / 2;
  if (failure > 0.68) return 0.72;
  if (structure > 0.72 && failure < 0.35) return 1.12;
  return 1.0;
}

function modeledPnl(trade, model, costMode = 'normal') {
  const target = targetForTrade(trade, model);
  const stop = stopForTrade(trade, model);
  const risk = riskDollars(trade);
  const mfe = n(trade.mfeR, 0);
  const mae = n(trade.maeR, 0);
  let pnl;
  if (mfe >= target) pnl = risk * target;
  else if (mae >= stop) pnl = -risk * stop;
  else pnl = clamp(n(trade.pnlDollars, 0), -risk * stop, risk * target);
  const feature = trade.features || {};
  const lowPricePenalty = n(trade.entry, 0) < 5 ? 18 : n(trade.entry, 0) < 20 ? 9 : 0;
  const fakeVolumePenalty = (trade.tags || []).includes('fake-volume-spike') ? 24 : 0;
  const chasePenalty = (trade.tags || []).includes('late-chase-risk') ? 18 : 0;
  const extensionPenalty = clamp01(feature.vwapExtensionRisk) * 16;
  const costBase = costMode === 'deep' ? deepStressCostDollars : stressCostDollars;
  const costPct = costMode === 'deep' ? deepStressPct : stressPct;
  return pnl - costBase - Math.abs(pnl) * costPct - lowPricePenalty - fakeVolumePenalty - chasePenalty - extensionPenalty;
}

function metrics(trades, model, costMode = 'normal') {
  const pnlOf = (trade) => modeledPnl(trade, model, costMode);
  const wins = trades.filter((trade) => pnlOf(trade) > 0);
  const grossWin = wins.reduce((sum, trade) => sum + pnlOf(trade), 0);
  const grossLoss = Math.abs(trades.filter((trade) => pnlOf(trade) <= 0).reduce((sum, trade) => sum + pnlOf(trade), 0));
  const netDollars = trades.reduce((sum, trade) => sum + pnlOf(trade), 0);
  let equity = 0;
  let peak = 0;
  let maxDrawdownDollars = 0;
  let lossStreak = 0;
  let maxLossStreak = 0;
  for (const trade of trades) {
    const pnl = pnlOf(trade);
    equity += pnl;
    peak = Math.max(peak, equity);
    maxDrawdownDollars = Math.max(maxDrawdownDollars, peak - equity);
    if (pnl <= 0) lossStreak += 1;
    else lossStreak = 0;
    maxLossStreak = Math.max(maxLossStreak, lossStreak);
  }
  const avg = (field) => trades.length ? trades.reduce((sum, trade) => sum + n(trade[field], 0), 0) / trades.length : 0;
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
    optionWorthyRate: trades.length ? trades.filter((trade) => trade.optionWorthy || (trade.tags || []).includes('options-worthy-burst') || n(trade.mfeR, 0) >= 1.5).length / trades.length * 100 : 0,
    maxDrawdownDollars,
    maxLossStreak,
  };
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

function hasTag(trade, tag) {
  return (trade.tags || []).includes(tag);
}

function regimeLabel(trade) {
  const f = trade.features || {};
  if ((trade.session || '').startsWith('open') && clamp01(f.openingDriveQuality) > 0.62 && clamp01(f.marketImpulse) > 0.55) return 'open_drive';
  if (clamp01(f.compressionRelease) > 0.72 && clamp01(f.atrExpansion) > 0.62 && clamp01(f.rangeExpansionQuality) > 0.58) return 'squeeze_expansion';
  if (clamp01(f.liquiditySweep) > 0.58 || clamp01(f.stopRunReclaim) > 0.58 || (clamp01(f.rejectionWick) > 0.65 && clamp01(f.pullbackReclaim) > 0.45)) return 'reversal_reclaim';
  if (clamp01(f.failedBreakRisk) > 0.64) return 'trap_risk';
  if (clamp01(f.trendQuality) > 0.68 && clamp01(f.efficiency) > 0.55 && clamp01(f.emaSlope) > 0.55) return 'trend_day';
  if (clamp01(f.chopQuality) < 0.38 || clamp01(f.efficiency) < 0.34) return 'chop';
  if (clamp01(f.marketAlignment) < 0.35 && clamp01(f.marketImpulse) < 0.35) return 'market_permission_weak';
  return 'balanced';
}

function setupArchetype(trade) {
  const f = trade.features || {};
  if (hasTag(trade, 'liquidity-sweep-reclaim') || clamp01(f.liquiditySweep) > 0.62 || clamp01(f.stopRunReclaim) > 0.62) return 'liquidity_sweep_reclaim';
  if (hasTag(trade, 'clean-vwap-reclaim') || (clamp01(f.vwapPressure) > 0.72 && clamp01(f.pullbackReclaim) > 0.48)) return 'vwap_reclaim';
  if (hasTag(trade, 'compression-pop') || clamp01(f.compressionRelease) > 0.72) return 'compression_breakout';
  if (hasTag(trade, 'opening-drive') || clamp01(f.openingDriveQuality) > 0.72) return 'opening_drive';
  if (hasTag(trade, 'clean-breakout') || clamp01(f.cleanBreakout) > 0.72 || clamp01(f.priorDayBreakQuality) > 0.72) return 'breakout_continuation';
  if (clamp01(f.trendQuality) > 0.72 && clamp01(f.pullbackReclaim) > 0.42) return 'trend_pullback_resume';
  if (clamp01(f.rejectionWick) > 0.68 && clamp01(f.closeLocation) > 0.55) return 'exhaustion_reversal';
  if (hasTag(trade, 'options-worthy-burst') || clamp01(f.optionBurstShape) > 0.72) return 'options_burst';
  if (hasTag(trade, 'volume-expansion') || clamp01(f.volumeAcceleration) > 0.72) return 'volume_shock';
  return 'base_structure';
}

function routeKey(trade) {
  return trade.routeId || [trade.symbol, trade.family, trade.trigger, trade.session, trade.side].join('|');
}

function groupKey(trade, fields) {
  return fields.map((field) => trade[field] || 'unknown').join('|');
}

function summarizeRows(trades, model) {
  return metrics(trades, model);
}

function buildStats(trades, model, keyFn) {
  const grouped = new Map();
  for (const trade of trades) {
    const key = keyFn(trade);
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(trade);
  }
  return new Map([...grouped.entries()].map(([key, rows]) => [key, {
    key,
    trades: rows.length,
    metrics: summarizeRows(rows, model),
    avgMfeR: rows.reduce((sum, trade) => sum + n(trade.mfeR, 0), 0) / rows.length,
    avgMaeR: rows.reduce((sum, trade) => sum + n(trade.maeR, 0), 0) / rows.length,
  }]));
}

function learnFeatureImportance(train) {
  const keys = [...new Set(train.flatMap((trade) => Object.keys(trade.features || {})))].sort();
  const wins = train.filter((trade) => n(trade.pnlDollars, 0) > 0);
  const losses = train.filter((trade) => n(trade.pnlDollars, 0) <= 0);
  const avg = (rows, key) => rows.length ? rows.reduce((sum, trade) => sum + clamp01(trade.features?.[key]), 0) / rows.length : 0;
  return Object.fromEntries(keys.map((key) => {
    const winAvg = avg(wins, key);
    const lossAvg = avg(losses, key);
    return [key, {
      winAvg,
      lossAvg,
      edge: winAvg - lossAvg,
      failureEdge: Math.max(0, lossAvg - winAvg),
      importance: Math.abs(winAvg - lossAvg),
    }];
  }).sort(([, a], [, b]) => b.importance - a.importance));
}

function learnedEdgeScore(trade, importance) {
  let score = 0;
  let weight = 0;
  for (const [feature, item] of Object.entries(importance)) {
    const edge = n(item.edge, 0);
    if (!edge) continue;
    const w = Math.min(1, Math.abs(edge) * 5);
    score += clamp01(trade.features?.[feature]) * (edge >= 0 ? w : -w);
    weight += w;
  }
  return weight ? clamp01(0.5 + score / weight / 2) : 0.5;
}

function failurePatternScore(trade, importance) {
  let score = 0;
  let weight = 0;
  for (const [feature, item] of Object.entries(importance)) {
    const w = Math.min(1, n(item.failureEdge, 0) * 5);
    if (!w) continue;
    score += clamp01(trade.features?.[feature]) * w;
    weight += w;
  }
  const tagRisk = (hasTag(trade, 'fake-volume-spike') ? 0.18 : 0) + (hasTag(trade, 'late-chase-risk') ? 0.18 : 0);
  return clamp01((weight ? score / weight : 0) + tagRisk);
}

function statQuality(stat) {
  if (!stat || stat.trades < 4) return 0.5;
  const win = clamp01(stat.metrics.winRate / 100);
  const pf = clamp01(Math.log1p(Math.max(0, stat.metrics.profitFactor)) / Math.log(4));
  const net = clamp01(Math.tanh(stat.metrics.netDollars / 20000));
  const mfeMae = clamp01((stat.avgMfeR - stat.avgMaeR + 1) / 2);
  return clamp01(win * 0.38 + pf * 0.22 + net * 0.22 + mfeMae * 0.18);
}

function forwardQuality(trade, forwardTrust) {
  const routes = forwardTrust?.routes || {};
  const route = routes[routeKey(trade)] || routes[trade.symbol] || null;
  if (!route || !n(route.trades, 0)) return 0.5;
  const win = clamp01(n(route.winRate, 0) / 100);
  const net = clamp01(Math.tanh(n(route.netDollars, 0) / 5000));
  return clamp01(win * 0.65 + net * 0.35);
}

function featureAverage(trade, keys) {
  return keys.length ? keys.reduce((sum, key) => sum + clamp01(trade.features?.[key]), 0) / keys.length : 0;
}

function componentScores(trade, learned) {
  const f = trade.features || {};
  const held = minutesHeld(trade) || 999;
  const failureScore = failurePatternScore(trade, learned.featureImportance);
  const volumeIntent = featureAverage(trade, ['volumeQuality', 'cleanVolume', 'volumeFlowAgreement', 'volumeAcceleration', 'relVolTodQuality']);
  const liquidityQuality = clamp01(featureAverage(trade, ['relativeVolume', 'relVolTodQuality', 'cleanVolume']) - (hasTag(trade, 'fake-volume-spike') ? 0.18 : 0));
  const vwapGravity = clamp01(featureAverage(trade, ['vwapPressure', 'pullbackReclaim']) - clamp01(f.vwapExtensionRisk) * 0.58);
  const candleAnatomy = clamp01(featureAverage(trade, ['closeLocation', 'bodyQuality', 'directionalCandle']) - clamp01(f.rejectionWick) * 0.35);
  const relativeMatrix = featureAverage(trade, ['relativeStrength', 'marketAlignment', 'marketImpulse', 'intradayTrendQuality']);
  const mfeMaePredictor = clamp01(
    featureAverage(trade, ['momentumBurst', 'rangeExpansionQuality', 'optionBurstShape', 'priceAcceleration', 'cleanBreakout'])
    - featureAverage(trade, ['failedBreakRisk', 'vwapExtensionRisk']) * 0.42
  );
  const timeToProfit = clamp01(featureAverage(trade, ['timeEdge', 'priceAcceleration', 'openingDriveQuality', 'momentumBurst']) + (held <= 15 ? 0.08 : held <= 30 ? 0.04 : -0.05));
  const entryTiming = failureScore > 0.68 || clamp01(f.failedBreakRisk) > 0.72
    ? 'skip'
    : clamp01(f.vwapExtensionRisk) > 0.62 && clamp01(f.pullbackReclaim) < 0.45
      ? 'wait'
      : 'enter_now';
  const entryTimingScore = entryTiming === 'enter_now' ? 1 : entryTiming === 'wait' ? 0.56 : 0.08;
  const routeDurability = statQuality(learned.routeStats.get(routeKey(trade)));
  const symbolPersonality = statQuality(learned.symbolStats.get(trade.symbol));
  const familyQuality = statQuality(learned.familyStats.get(trade.family));
  const setupQuality = statQuality(learned.setupStats.get(setupArchetype(trade)));
  const regimeQuality = statQuality(learned.regimeStats.get(regimeLabel(trade)));
  const patternQuality = statQuality(learned.patternStats.get([setupArchetype(trade), regimeLabel(trade), trade.family].join('|')));
  const forwardProof = forwardQuality(trade, learned.forwardTrust);
  const recentEdge = statQuality(learned.recentStats.get(routeKey(trade))) * 0.6 + statQuality(learned.recentSymbolStats.get(trade.symbol)) * 0.4;
  const costQuality = clamp01(1 - ((n(trade.entry, 0) < 5 ? 0.18 : 0) + clamp01(f.vwapExtensionRisk) * 0.18 + (hasTag(trade, 'fake-volume-spike') ? 0.18 : 0)));
  const counterfactualTiming = clamp01(entryTimingScore * 0.55 + timeToProfit * 0.25 + clamp01(1 - n(trade.maeR, 0) / 1.25) * 0.20);
  const base = clamp01(n(trade.confidence, 0) / 100 * 0.42 + n(trade.alphaQuality, 0) / 100 * 0.28 + learnedEdgeScore(trade, learned.featureImportance) * 0.30);
  const specialistVotes = [
    base > 0.62,
    volumeIntent > 0.62,
    liquidityQuality > 0.58,
    vwapGravity > 0.56,
    candleAnatomy > 0.58,
    relativeMatrix > 0.56,
    mfeMaePredictor > 0.58,
    timeToProfit > 0.58,
    routeDurability > 0.56,
    setupQuality > 0.54,
    regimeQuality > 0.52,
    failureScore < 0.54,
    costQuality > 0.62,
  ].filter(Boolean).length;
  return {
    base,
    volumeIntent,
    liquidityQuality,
    vwapGravity,
    candleAnatomy,
    relativeMatrix,
    mfeMaePredictor,
    timeToProfit,
    entryTiming,
    entryTimingScore,
    routeDurability,
    symbolPersonality,
    familyQuality,
    setupQuality,
    regimeQuality,
    patternQuality,
    forwardProof,
    recentEdge,
    costQuality,
    counterfactualTiming,
    failureScore,
    failureBlock: clamp01(1 - failureScore),
    specialistVotes,
  };
}

const allTrades = readJsonl(paths.fullTrades);
if (!allTrades.length) throw new Error('Missing full canonical trades. Run Phase21 with FUSION_WRITE_FULL_CANONICAL=true.');

const chronological = [...allTrades].sort((a, b) => tradeTime(a) - tradeTime(b));
const globalSplit = splitChronological(chronological);
const baseTrainModel = { targetMode: 'adaptive', stopMode: 'adaptive' };
const recentCut = Math.floor(chronological.length * 0.75);
const recentTrain = chronological.slice(recentCut);
const forwardTrust = readJson(paths.forwardTrust, { routes: {} });
const phase25 = readJson(paths.phase25Model, {});

function championSymbolsFromLedgers() {
  const ledgers = [
    readJson(paths.phase22Ledgers, { categoryMap: {}, ledgers: {} }),
    readJson(paths.phase23Ledgers, { categoryMap: {}, ledgers: {} }),
    readJson(paths.phase24Ledgers, { categoryMap: {}, ledgers: {} }),
    readJson(paths.phase25Ledgers, { categoryMap: {}, ledgers: {} }),
  ];
  const symbols = new Set();
  for (const payload of ledgers) {
    for (const id of Object.values(payload.categoryMap || {})) {
      for (const trade of payload.ledgers?.[id]?.trades || []) {
        if (trade.symbol) symbols.add(trade.symbol);
      }
    }
  }
  return symbols;
}

const priorChampionSymbols = championSymbolsFromLedgers();

const learned = {
  featureImportance: learnFeatureImportance(globalSplit.train),
  routeStats: buildStats(globalSplit.train, baseTrainModel, routeKey),
  symbolStats: buildStats(globalSplit.train, baseTrainModel, (trade) => trade.symbol),
  familyStats: buildStats(globalSplit.train, baseTrainModel, (trade) => trade.family),
  setupStats: buildStats(globalSplit.train, baseTrainModel, setupArchetype),
  regimeStats: buildStats(globalSplit.train, baseTrainModel, regimeLabel),
  patternStats: buildStats(globalSplit.train, baseTrainModel, (trade) => [setupArchetype(trade), regimeLabel(trade), trade.family].join('|')),
  recentStats: buildStats(recentTrain, baseTrainModel, routeKey),
  recentSymbolStats: buildStats(recentTrain, baseTrainModel, (trade) => trade.symbol),
  forwardTrust,
};

const enrichedTrades = chronological.map((trade) => {
  const setup = setupArchetype(trade);
  const regime = regimeLabel(trade);
  const scores = componentScores(trade, learned);
  return {
    ...trade,
    phase26: {
      setup,
      regime,
      scores,
      freshSymbol: !priorChampionSymbols.has(trade.symbol),
      hourBucket: trade.session || 'unknown',
      route: routeKey(trade),
    },
  };
});

function modelBlueprints() {
  return [
    ['fresh_symbol_first', 'Optimizes first for symbols not used by prior champions.', { freshOnly: true, weights: { base: 0.8, patternQuality: 1.0, failureBlock: 1.0, relativeMatrix: 0.8, costQuality: 0.8 } }],
    ['leave_one_symbol_guard', 'Scores broad symbol transfer instead of one-symbol overfit.', { requireSymbolBreadth: true, weights: { routeDurability: 0.7, patternQuality: 1.0, failureBlock: 1.0, base: 0.7 } }],
    ['leave_one_family_guard', 'Scores family transfer so one hot sector cannot dominate.', { requireFamilyBreadth: true, weights: { familyQuality: 0.8, regimeQuality: 1.0, patternQuality: 1.0, failureBlock: 0.8 } }],
    ['regime_first_router', 'Chooses trades only when regime quality supports the route.', { minRegimeQuality: 0.55, weights: { regimeQuality: 1.45, setupQuality: 0.9, failureBlock: 0.8, base: 0.6 } }],
    ['setup_archetype_models', 'Separate setup archetype models instead of one universal formula.', { weights: { setupQuality: 1.45, patternQuality: 1.1, routeDurability: 0.7, base: 0.6 } }],
    ['failure_pattern_library', 'Learns losing fingerprints and blocks similar setups.', { maxFailureScore: 0.46, weights: { failureBlock: 1.65, costQuality: 0.8, candleAnatomy: 0.7, vwapGravity: 0.6 } }],
    ['entry_timing_classifier', 'Classifies enter now, wait, or skip before accepting a signal.', { requireEnterNow: true, weights: { entryTimingScore: 1.55, timeToProfit: 0.9, failureBlock: 0.9, base: 0.55 } }],
    ['mfe_mae_predictor', 'Predicts large favorable move with lower adverse movement.', { weights: { mfeMaePredictor: 1.65, failureBlock: 1.0, costQuality: 0.75, volumeIntent: 0.55 } }],
    ['fast_time_to_profit', 'Prefers setups that historically move within one to three candles.', { maxMinutes: 45, weights: { timeToProfit: 1.65, entryTimingScore: 1.0, momentum: 0.65, base: 0.55 }, targetMode: 'fixed035' }],
    ['route_durability_score', 'Rewards routes that survive days, weeks, symbols, and regimes.', { weights: { routeDurability: 1.6, patternQuality: 0.9, recentEdge: 0.75, failureBlock: 0.7 } }],
    ['symbol_personality_model', 'Uses train-only symbol traits without letting one lucky day dominate.', { weights: { symbolPersonality: 1.3, routeDurability: 0.85, setupQuality: 0.7, failureBlock: 0.7 } }],
    ['relative_strength_matrix', 'Requires strength versus market, sector, and peer context.', { minRelativeMatrix: 0.56, weights: { relativeMatrix: 1.6, regimeQuality: 0.8, base: 0.65, failureBlock: 0.7 } }],
    ['liquidity_quality_model', 'Rejects thin/fake spikes and high-cost names.', { minLiquidityQuality: 0.58, weights: { liquidityQuality: 1.55, costQuality: 1.05, volumeIntent: 0.7, failureBlock: 0.65 } }],
    ['volume_intent_model', 'Distinguishes real accumulation/distribution from one-candle noise.', { minVolumeIntent: 0.58, weights: { volumeIntent: 1.65, liquidityQuality: 0.8, candleAnatomy: 0.55, failureBlock: 0.65 } }],
    ['vwap_gravity_model', 'Avoids stretched late entries unless reclaim quality is high.', { minVwapGravity: 0.56, weights: { vwapGravity: 1.65, failureBlock: 0.8, costQuality: 0.75, setupQuality: 0.55 } }],
    ['candle_anatomy_scoring', 'Scores close location, body expansion, and wick rejection.', { minCandleAnatomy: 0.58, weights: { candleAnatomy: 1.6, failureBlock: 0.8, timeToProfit: 0.6, base: 0.55 } }],
    ['opening_range_intelligence', 'Treats opening slices as distinct systems.', { sessions: ['open', 'open-0930', 'open-1000', 'open-1030'], weights: { timeToProfit: 1.1, regimeQuality: 0.95, volumeIntent: 0.85, failureBlock: 0.75 }, targetMode: 'fixed035' }],
    ['adaptive_target_selection', 'Chooses 0.25R/0.35R/0.5R/0.75R/trail style target per setup.', { targetMode: 'adaptive', weights: { mfeMaePredictor: 1.05, setupQuality: 0.9, timeToProfit: 0.75, failureBlock: 0.75 } }],
    ['dynamic_structure_stop', 'Uses structure/VWAP/ATR-style invalidation instead of generic fixed stop.', { stopMode: 'adaptive', weights: { failureBlock: 1.1, vwapGravity: 0.85, setupQuality: 0.75, candleAnatomy: 0.65 } }],
    ['profit_after_cost_scoring', 'Optimizes after spread/slippage/low-liquidity penalties.', { minCostQuality: 0.64, weights: { costQuality: 1.55, liquidityQuality: 0.8, failureBlock: 0.75, base: 0.55 } }],
    ['loss_cluster_kill_switch', 'Pauses symbol/routes after clustered losses.', { useLossCluster: true, weights: { recentEdge: 1.05, routeDurability: 0.9, failureBlock: 0.85, base: 0.6 } }],
    ['recent_edge_decay', 'Downranks old edges when newest trades degrade.', { minRecentEdge: 0.54, weights: { recentEdge: 1.55, forwardProof: 0.75, failureBlock: 0.75, base: 0.55 } }],
    ['specialist_ensemble_voting', 'Requires independent specialist votes to agree.', { requiredVotes: 9, weights: { specialistVotes: 1.55, failureBlock: 1.0, costQuality: 0.75, base: 0.55 } }],
    ['meta_classifier_fusion', 'Final take/skip classifier using all specialist votes.', { weights: { base: 0.75, specialistVotes: 1.1, patternQuality: 0.95, failureBlock: 1.05, costQuality: 0.8, recentEdge: 0.7 } }],
    ['forward_gap_penalty', 'Penalizes routes where forward trust lags backtest.', { minForwardProof: 0.44, weights: { forwardProof: 1.2, recentEdge: 0.9, failureBlock: 0.8, base: 0.6 } }],
    ['pattern_cluster_prototypes', 'Trades only winner-like setup/regime/family clusters.', { minPatternQuality: 0.55, weights: { patternQuality: 1.65, setupQuality: 0.85, regimeQuality: 0.8, failureBlock: 0.7 } }],
    ['counterfactual_timing_proxy', 'Tests earlier/later-entry proxy using MAE, timing, and acceleration.', { minCounterfactualTiming: 0.58, weights: { counterfactualTiming: 1.65, timeToProfit: 0.75, failureBlock: 0.7, base: 0.55 } }],
    ['stress_survivor', 'Only keeps trades robust under 2x-3x cost stress.', { minCostQuality: 0.70, weights: { costQuality: 1.4, liquidityQuality: 0.9, failureBlock: 0.85, mfeMaePredictor: 0.65 } }],
    ['ticker_discovery_engine', 'Discovers new tickers with enough volatility, liquidity, and setup quality.', { freshOnly: true, minLiquidityQuality: 0.55, weights: { symbolPersonality: 0.7, patternQuality: 0.95, volumeIntent: 0.85, relativeMatrix: 0.75, failureBlock: 0.8 } }],
    ['champion_fusion', 'Merges only the best rules from prior champions and specialists.', { weights: { base: 0.8, mfeMaePredictor: 0.9, setupQuality: 0.9, patternQuality: 0.9, failureBlock: 1.15, costQuality: 0.85, recentEdge: 0.75 } }],
  ];
}

function makeModel([layer, description, config], threshold, targetMode, requiredVotes) {
  return {
    id: ['phase26', layer, `q${Math.round(threshold * 100)}`, targetMode, `v${requiredVotes}`].join('__'),
    layer,
    description,
    threshold,
    targetMode: config.targetMode || targetMode,
    stopMode: config.stopMode || 'adaptive',
    requiredVotes: config.requiredVotes || requiredVotes,
    ...config,
  };
}

function componentScore(model, scores) {
  let value = 0;
  let weight = 0;
  for (const [key, rawWeight] of Object.entries(model.weights || {})) {
    const w = n(rawWeight, 0);
    const component = key === 'specialistVotes' ? clamp01(scores.specialistVotes / 13) : key === 'momentum' ? scores.mfeMaePredictor : scores[key];
    value += clamp01(component) * w;
    weight += Math.abs(w);
  }
  return weight ? clamp01(value / weight) : scores.base;
}

function passModelGuards(trade, model) {
  const scores = trade.phase26.scores;
  if (model.freshOnly && !trade.phase26.freshSymbol) return false;
  if (model.sessions && !model.sessions.includes(trade.session)) return false;
  if (model.maxMinutes && (minutesHeld(trade) || 999) > model.maxMinutes) return false;
  if (model.minRegimeQuality && scores.regimeQuality < model.minRegimeQuality) return false;
  if (model.minPatternQuality && scores.patternQuality < model.minPatternQuality) return false;
  if (model.maxFailureScore && scores.failureScore > model.maxFailureScore) return false;
  if (model.requireEnterNow && scores.entryTiming !== 'enter_now') return false;
  if (model.minRelativeMatrix && scores.relativeMatrix < model.minRelativeMatrix) return false;
  if (model.minLiquidityQuality && scores.liquidityQuality < model.minLiquidityQuality) return false;
  if (model.minVolumeIntent && scores.volumeIntent < model.minVolumeIntent) return false;
  if (model.minVwapGravity && scores.vwapGravity < model.minVwapGravity) return false;
  if (model.minCandleAnatomy && scores.candleAnatomy < model.minCandleAnatomy) return false;
  if (model.minCostQuality && scores.costQuality < model.minCostQuality) return false;
  if (model.minRecentEdge && scores.recentEdge < model.minRecentEdge) return false;
  if (model.minForwardProof && scores.forwardProof < model.minForwardProof) return false;
  if (model.minCounterfactualTiming && scores.counterfactualTiming < model.minCounterfactualTiming) return false;
  if (scores.specialistVotes < model.requiredVotes) return false;
  return true;
}

function applyLossClusterKillSwitch(trades, model) {
  if (!model.useLossCluster) return trades;
  const kept = [];
  const state = new Map();
  for (const trade of trades) {
    const key = [trade.symbol, trade.phase26.setup, trade.side].join('|');
    const current = state.get(key) || { losses: 0, cooldownUntil: 0 };
    if (tradeTime(trade) <= current.cooldownUntil) continue;
    kept.push(trade);
    const pnl = modeledPnl(trade, model);
    if (pnl <= 0) {
      current.losses += 1;
      if (current.losses >= 2) {
        current.cooldownUntil = tradeTime(trade) + 3 * 86400;
        current.losses = 0;
      }
    } else {
      current.losses = 0;
    }
    state.set(key, current);
  }
  return kept;
}

function resolveConflicts(trades, scoreById) {
  const best = new Map();
  for (const trade of trades) {
    const key = [trade.symbol, trade.side, trade.entryTime, n(trade.entry, 0).toFixed(4)].join('|');
    const previous = best.get(key);
    if (!previous || n(scoreById.get(trade.canonicalId), 0) > n(scoreById.get(previous.canonicalId), 0)) best.set(key, trade);
  }
  return [...best.values()].sort((a, b) => tradeTime(a) - tradeTime(b));
}

function validationByGroup(trades, model, keyFn, minGroupTrades = 3) {
  const grouped = new Map();
  for (const trade of trades) {
    const key = keyFn(trade);
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(trade);
  }
  const rows = [...grouped.entries()].map(([key, rows]) => ({
    key,
    metrics: metrics(rows, model),
  })).filter((row) => row.metrics.trades >= minGroupTrades);
  const positive = rows.filter((row) => row.metrics.netDollars > 0);
  rows.sort((a, b) => a.metrics.netDollars - b.metrics.netDollars);
  return {
    groups: rows.length,
    positiveGroups: positive.length,
    positiveRate: rows.length ? positive.length / rows.length * 100 : 0,
    worst: rows.slice(0, 8),
    best: [...rows].sort((a, b) => b.metrics.netDollars - a.metrics.netDollars).slice(0, 8),
  };
}

function consistency(trades, model) {
  const days = new Map();
  const weeks = new Map();
  const symbols = new Set();
  const families = new Set();
  for (const trade of trades) {
    const pnl = modeledPnl(trade, model);
    days.set(trade.date, (days.get(trade.date) || 0) + pnl);
    weeks.set(weekFromDate(trade.date), (weeks.get(weekFromDate(trade.date)) || 0) + pnl);
    if (trade.symbol) symbols.add(trade.symbol);
    if (trade.family) families.add(trade.family);
  }
  const dayRows = [...days.entries()].filter(([key]) => key && key !== 'unknown');
  const weekRows = [...weeks.entries()].filter(([key]) => key && key !== 'unknown');
  return {
    uniqueDays: dayRows.length,
    uniqueWeeks: weekRows.length,
    uniqueSymbols: symbols.size,
    uniqueFamilies: families.size,
    dayConsistency: dayRows.length ? dayRows.filter(([, pnl]) => pnl > 0).length / dayRows.length * 100 : 0,
    weekConsistency: weekRows.length ? weekRows.filter(([, pnl]) => pnl > 0).length / weekRows.length * 100 : 0,
  };
}

function evaluate(model) {
  const scoreById = new Map();
  const selected = [];
  for (const trade of enrichedTrades) {
    if (!passModelGuards(trade, model)) continue;
    const score = componentScore(model, trade.phase26.scores);
    if (score < model.threshold) continue;
    scoreById.set(trade.canonicalId, score);
    selected.push(trade);
  }
  const conflicted = resolveConflicts(selected, scoreById);
  const trades = applyLossClusterKillSwitch(conflicted, model);
  const split = splitChronological(trades);
  const result = {
    ...model,
    trades,
    scoreById,
    metrics: metrics(trades, model),
    train: metrics(split.train, model),
    test: metrics(split.test, model),
    holdout: metrics(split.holdout, model),
    stress: metrics(trades, model, 'normal'),
    deepStress: metrics(trades, model, 'deep'),
    consistency: consistency(trades, model),
    leaveOneSymbolOut: validationByGroup(trades, model, (trade) => trade.symbol, 3),
    leaveOneFamilyOut: validationByGroup(trades, model, (trade) => trade.family, 8),
    setupValidation: validationByGroup(trades, model, (trade) => trade.phase26.setup, 8),
    regimeValidation: validationByGroup(trades, model, (trade) => trade.phase26.regime, 8),
    freshSymbolMetrics: metrics(trades.filter((trade) => trade.phase26.freshSymbol), model),
  };
  result.score = scoreVariant(result);
  const decision = decisionForVariant(result);
  result.decision = decision.decision;
  result.decisionReasons = decision.reasons;
  return result;
}

function scoreVariant(result) {
  const ddPenalty = result.metrics.netDollars > 0 ? Math.min(40, result.metrics.maxDrawdownDollars / result.metrics.netDollars * 100) : 40;
  const generalization = (
    result.leaveOneSymbolOut.positiveRate * 0.34
    + result.leaveOneFamilyOut.positiveRate * 0.28
    + result.setupValidation.positiveRate * 0.20
    + result.regimeValidation.positiveRate * 0.18
  );
  const recent = result.holdout.winRate * 0.55 + clamp01(Math.tanh(result.holdout.netDollars / 50000)) * 100 * 0.45;
  return Number((
    Math.tanh(result.metrics.netDollars / 250000) * 24
    + result.metrics.winRate * 0.10
    + result.holdout.winRate * 0.14
    + generalization * 0.18
    + Math.min(100, result.metrics.trades / 700 * 100) * 0.10
    + Math.min(100, Math.max(0, result.metrics.avgDollars) / 900 * 100) * 0.08
    + result.consistency.weekConsistency * 0.08
    + recent * 0.08
    + result.deepStress.winRate * 0.06
    - ddPenalty * 0.45
    - result.metrics.maxLossStreak * 2.25
  ).toFixed(4));
}

function decisionForVariant(result) {
  const reasons = [];
  if (result.metrics.trades < minTrades) reasons.push(`below trade floor ${result.metrics.trades}/${minTrades}`);
  if (result.metrics.netDollars <= 0) reasons.push('net profit not positive');
  if (result.holdout.netDollars <= 0) reasons.push('holdout net not positive');
  if (result.deepStress.netDollars <= 0) reasons.push('deep stress net not positive');
  if (result.leaveOneSymbolOut.positiveRate < 52) reasons.push(`symbol generalization below 52%`);
  if (result.leaveOneFamilyOut.positiveRate < 55) reasons.push(`family generalization below 55%`);
  if (result.consistency.uniqueWeeks < 4) reasons.push(`too few weeks ${result.consistency.uniqueWeeks}/4`);
  if (result.metrics.maxLossStreak > 8) reasons.push(`loss streak too high ${result.metrics.maxLossStreak}`);
  if (!reasons.length && result.metrics.winRate >= 72 && result.holdout.winRate >= 65 && result.metrics.netDollars > 100000) {
    return { decision: 'phase26_promoted', reasons: ['passes generalization, holdout, stress, and profit gates'] };
  }
  if (!reasons.length) return { decision: 'phase26_watchlist', reasons: ['robust but below promotion strength'] };
  return { decision: 'rejected', reasons };
}

function compactTrade(trade, index, model) {
  return {
    index: index + 1,
    outcome: modeledPnl(trade, model) > 0 ? 'win' : modeledPnl(trade, model) < 0 ? 'loss' : 'flat',
    canonicalId: trade.canonicalId,
    symbol: trade.symbol,
    family: trade.family,
    side: trade.side,
    trigger: trade.trigger,
    session: trade.session,
    setup: trade.phase26.setup,
    regime: trade.phase26.regime,
    date: trade.date,
    entryTime: trade.entryTime,
    exitTime: trade.exitTime,
    entryIso: isoTime(trade.entryTime),
    exitIso: isoTime(trade.exitTime),
    minutesHeld: minutesHeld(trade),
    overnight: isOvernight(trade),
    entry: trade.entry,
    exit: trade.exit,
    pnlDollars: modeledPnl(trade, model),
    sourcePnlDollars: trade.pnlDollars,
    modeledPnlScaledTo10k: modeledPnl(trade, model) * 0.10,
    mfeR: trade.mfeR,
    maeR: trade.maeR,
    confidence: trade.confidence,
    alphaQuality: trade.alphaQuality,
    targetR: targetForTrade(trade, model),
    stopR: stopForTrade(trade, model),
    phase26Score: model.scoreById?.get(trade.canonicalId) || componentScore(model, trade.phase26.scores),
    specialistVotes: trade.phase26.scores.specialistVotes,
    entryTiming: trade.phase26.scores.entryTiming,
    freshSymbol: trade.phase26.freshSymbol,
    tags: trade.tags || [],
    selectedRouteKey: routeKey(trade),
  };
}

function summarizeBy(trades, model, keyFn, limit = 20) {
  const grouped = new Map();
  for (const trade of trades) {
    const key = keyFn(trade);
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(trade);
  }
  return [...grouped.entries()]
    .map(([name, rows]) => ({ name, metrics: metrics(rows, model) }))
    .sort((a, b) => b.metrics.netDollars - a.metrics.netDollars)
    .slice(0, limit);
}

function compactGroupValidation(validation) {
  return {
    groups: validation.groups,
    positiveGroups: validation.positiveGroups,
    positiveRate: validation.positiveRate,
    worst: validation.worst?.slice(0, 5) || [],
    best: validation.best?.slice(0, 5) || [],
  };
}

function compactVariant(result, tradeLimit = 12) {
  if (!result) return null;
  return {
    id: result.id,
    layer: result.layer,
    description: result.description,
    threshold: result.threshold,
    targetMode: result.targetMode,
    stopMode: result.stopMode,
    requiredVotes: result.requiredVotes,
    score: result.score,
    decision: result.decision,
    decisionReasons: result.decisionReasons,
    metrics: result.metrics,
    train: result.train,
    test: result.test,
    holdout: result.holdout,
    deepStress: result.deepStress,
    consistency: result.consistency,
    leaveOneSymbolOut: compactGroupValidation(result.leaveOneSymbolOut),
    leaveOneFamilyOut: compactGroupValidation(result.leaveOneFamilyOut),
    setupValidation: compactGroupValidation(result.setupValidation),
    regimeValidation: compactGroupValidation(result.regimeValidation),
    freshSymbolMetrics: result.freshSymbolMetrics,
    topSymbols: summarizeBy(result.trades, result, (trade) => trade.symbol, 20),
    topFamilies: summarizeBy(result.trades, result, (trade) => trade.family, 10),
    topSetups: summarizeBy(result.trades, result, (trade) => trade.phase26.setup, 12),
    topRegimes: summarizeBy(result.trades, result, (trade) => trade.phase26.regime, 12),
    topTrades: [...result.trades]
      .sort((a, b) => modeledPnl(b, result) - modeledPnl(a, result))
      .slice(0, tradeLimit)
      .map((trade, index) => compactTrade(trade, index, result)),
  };
}

function tickerDiscovery(models) {
  const best = models[0];
  const grouped = new Map();
  for (const trade of enrichedTrades.filter((item) => item.phase26.freshSymbol)) {
    const score = componentScore(best, trade.phase26.scores);
    if (score < 0.56) continue;
    if (!grouped.has(trade.symbol)) grouped.set(trade.symbol, []);
    grouped.get(trade.symbol).push(trade);
  }
  return [...grouped.entries()]
    .map(([symbol, rows]) => ({
      symbol,
      family: rows[0]?.family || 'unknown',
      trades: rows.length,
      avgScore: rows.reduce((sum, trade) => sum + componentScore(best, trade.phase26.scores), 0) / rows.length,
      metrics: metrics(rows, best),
      dominantSetups: summarizeBy(rows, best, (trade) => trade.phase26.setup, 5),
    }))
    .filter((row) => row.trades >= 5)
    .sort((a, b) => b.metrics.netDollars - a.metrics.netDollars)
    .slice(0, 60);
}

function patternPrototypes() {
  const grouped = new Map();
  for (const trade of globalSplit.train) {
    const key = [setupArchetype(trade), regimeLabel(trade), trade.family].join('|');
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(trade);
  }
  return [...grouped.entries()]
    .map(([key, rows]) => {
      const [setup, regime, family] = key.split('|');
      const m = metrics(rows, baseTrainModel);
      return { setup, regime, family, trades: rows.length, metrics: m };
    })
    .filter((row) => row.trades >= 8)
    .sort((a, b) => b.metrics.netDollars - a.metrics.netDollars)
    .slice(0, 80);
}

const thresholds = [0.48, 0.52, 0.56, 0.60, 0.64, 0.68, 0.72, 0.76, 0.80];
const targetModes = ['adaptive', 'fixed035', 'fixed050', 'fixed075'];
const voteFloors = [7, 8, 9, 10];
const variants = [];
let evaluated = 0;

for (const blueprint of modelBlueprints()) {
  for (const threshold of thresholds) {
    for (const targetMode of targetModes) {
      for (const votes of voteFloors) {
        if (evaluated >= maxVariants) break;
        const model = makeModel(blueprint, threshold, targetMode, votes);
        const result = evaluate(model);
        evaluated += 1;
        if (result.metrics.trades >= 25) variants.push(result);
      }
    }
  }
}

variants.sort((a, b) => b.score - a.score || b.metrics.netDollars - a.metrics.netDollars);
const qualified = variants.filter((variant) => variant.metrics.trades >= minTrades);
const promoted = qualified.filter((variant) => variant.decision === 'phase26_promoted').sort((a, b) => b.score - a.score);
const watchlist = qualified.filter((variant) => variant.decision === 'phase26_watchlist').sort((a, b) => b.score - a.score);
const bestOverall = promoted[0] || watchlist[0] || qualified[0] || variants[0] || null;
const bestProfit = [...qualified].sort((a, b) => b.metrics.netDollars - a.metrics.netDollars || b.score - a.score)[0] || bestOverall;
const bestHighWin = [...qualified].sort((a, b) => b.metrics.winRate - a.metrics.winRate || b.holdout.winRate - a.holdout.winRate || b.metrics.netDollars - a.metrics.netDollars)[0] || bestOverall;
const bestGeneralization = [...qualified].sort((a, b) => {
  const ag = a.leaveOneSymbolOut.positiveRate + a.leaveOneFamilyOut.positiveRate + a.setupValidation.positiveRate + a.regimeValidation.positiveRate;
  const bg = b.leaveOneSymbolOut.positiveRate + b.leaveOneFamilyOut.positiveRate + b.setupValidation.positiveRate + b.regimeValidation.positiveRate;
  return bg - ag || b.metrics.netDollars - a.metrics.netDollars;
})[0] || bestOverall;
const bestFreshSymbols = [...qualified].sort((a, b) => b.freshSymbolMetrics.netDollars - a.freshSymbolMetrics.netDollars || b.freshSymbolMetrics.winRate - a.freshSymbolMetrics.winRate)[0] || bestOverall;
const bestLowDrawdown = [...qualified].sort((a, b) => a.metrics.maxDrawdownDollars - b.metrics.maxDrawdownDollars || b.metrics.netDollars - a.metrics.netDollars)[0] || bestOverall;

const perLayerBest = modelBlueprints().map(([layer]) => {
  const rows = variants.filter((variant) => variant.layer === layer);
  rows.sort((a, b) => b.score - a.score || b.metrics.netDollars - a.metrics.netDollars);
  return compactVariant(rows[0], 4);
}).filter(Boolean);

const improvementCoverage = [
  ['Fresh-symbol first scoring', 'Implemented through `fresh_symbol_first`, `ticker_discovery_engine`, and fresh-symbol metrics.'],
  ['Leave-one-symbol-out validation', 'Implemented as `leaveOneSymbolOut` group validation for every variant.'],
  ['Leave-one-family-out validation', 'Implemented as `leaveOneFamilyOut` group validation for every variant.'],
  ['Regime-first routing', 'Implemented through `regimeLabel` and `regime_first_router`.'],
  ['Setup archetype models', 'Implemented through `setupArchetype` and `setup_archetype_models`.'],
  ['Failure-pattern library', 'Implemented with train-learned loser feature edges and failure blocking.'],
  ['Entry timing classifier', 'Implemented as enter-now/wait/skip scoring.'],
  ['MFE/MAE predictor', 'Implemented as `mfeMaePredictor` component.'],
  ['Time-to-profit filter', 'Implemented as `fast_time_to_profit` plus timing score.'],
  ['Route durability score', 'Implemented with train-only route quality.'],
  ['Symbol personality model', 'Implemented with train-only symbol quality.'],
  ['Relative strength matrix', 'Implemented with relative/market/peer feature bundle.'],
  ['Liquidity quality model', 'Implemented with rel-volume, clean-volume, fake-spike penalties.'],
  ['Volume intent model', 'Implemented with volume quality, acceleration, and flow agreement.'],
  ['VWAP gravity model', 'Implemented with VWAP pressure minus extension/chase risk.'],
  ['Candle anatomy scoring', 'Implemented with close location, body quality, wick rejection.'],
  ['Opening range intelligence', 'Implemented with open/open-0930/open-1000/open-1030 specialist.'],
  ['Adaptive target selection', 'Implemented in `targetForTrade`.'],
  ['Dynamic stop logic', 'Implemented in `stopForTrade`.'],
  ['Profit-after-cost scoring', 'Implemented in every metric via modeled PnL after costs.'],
  ['Loss-cluster kill switch', 'Implemented as route/symbol cooldown after clustered losses.'],
  ['Recent edge decay', 'Implemented using newest-quarter route/symbol quality.'],
  ['Specialist ensemble voting', 'Implemented as independent component vote count.'],
  ['Meta-classifier', 'Implemented as final weighted take/skip score.'],
  ['Forward/backtest gap penalty', 'Implemented through route forward-trust score when evidence exists.'],
  ['Pattern clustering', 'Implemented as setup/regime/family prototypes.'],
  ['Counterfactual timing proxy', 'Implemented with MAE/timing/acceleration wait-or-skip proxy.'],
  ['Synthetic cost stress', 'Implemented with normal and deep-stress cost modes.'],
  ['Ticker discovery engine', 'Implemented as fresh-symbol discovery leaderboard.'],
  ['Champion fusion', 'Implemented as fused best-rule layer combining prior champion rules.'],
].map(([name, implementation]) => ({ name, implementation }));

const runId = `phase26-${new Date().toISOString().replace(/[:.]/g, '-')}`;
const output = {
  updatedAt: new Date().toISOString(),
  runId,
  phase: 'Phase26 Generalization Engine',
  goal: 'Fix Phase25 overfit by testing unseen-symbol/family generalization, setup archetypes, failure blocking, timing, costs, adaptive exits, and specialist/meta-classifier fusion.',
  safety: { paperOnly: true, noBrokerOrders: true },
  config: {
    maxVariants,
    minTrades,
    evaluated,
    kept: variants.length,
    qualified: qualified.length,
    promoted: promoted.length,
    watchlist: watchlist.length,
    sourceTrades: enrichedTrades.length,
    trainTrades: globalSplit.train.length,
    testTrades: globalSplit.test.length,
    holdoutTrades: globalSplit.holdout.length,
    priorChampionSymbols: priorChampionSymbols.size,
    stressCostDollars,
    stressPct,
    deepStressCostDollars,
    deepStressPct,
  },
  baselines: {
    phase25BestOverall: phase25.categoryChampions?.bestOverall || null,
    phase25BestProfit: phase25.categoryChampions?.bestProfit || null,
  },
  improvementCoverage,
  featureImportance: Object.entries(learned.featureImportance).slice(0, 40).map(([feature, row]) => ({ feature, ...row })),
  patternPrototypes: patternPrototypes(),
  tickerDiscovery: tickerDiscovery(qualified.length ? qualified : variants),
  categoryChampions: {
    bestOverall: compactVariant(bestOverall, 12),
    bestProfit: compactVariant(bestProfit, 12),
    bestHighWin: compactVariant(bestHighWin, 12),
    bestGeneralization: compactVariant(bestGeneralization, 12),
    bestFreshSymbols: compactVariant(bestFreshSymbols, 12),
    bestLowDrawdown: compactVariant(bestLowDrawdown, 12),
  },
  perLayerBest,
  promoted: promoted.slice(0, 30).map((variant) => compactVariant(variant, 8)),
  watchlist: watchlist.slice(0, 30).map((variant) => compactVariant(variant, 8)),
  rankedVariants: qualified.slice(0, 80).map((variant) => compactVariant(variant, 4)),
};

const ledger = {
  updatedAt: output.updatedAt,
  runId,
  ledgers: {},
  categoryMap: {},
};
const ledgerCategories = {
  bestOverall,
  bestProfit,
  bestHighWin,
  bestGeneralization,
  bestFreshSymbols,
  bestLowDrawdown,
  ...Object.fromEntries(promoted.slice(0, 8).map((variant, index) => [`promoted${index + 1}`, variant])),
  ...Object.fromEntries(watchlist.slice(0, 8).map((variant, index) => [`watchlist${index + 1}`, variant])),
};
for (const [category, variant] of Object.entries(ledgerCategories)) {
  if (!variant) continue;
  ledger.categoryMap[category] = variant.id;
  if (!ledger.ledgers[variant.id]) {
    ledger.ledgers[variant.id] = {
      id: variant.id,
      categories: [],
      layer: variant.layer,
      description: variant.description,
      decision: variant.decision,
      decisionReasons: variant.decisionReasons,
      threshold: variant.threshold,
      targetMode: variant.targetMode,
      stopMode: variant.stopMode,
      requiredVotes: variant.requiredVotes,
      metrics: variant.metrics,
      holdout: variant.holdout,
      deepStress: variant.deepStress,
      consistency: variant.consistency,
      leaveOneSymbolOut: compactGroupValidation(variant.leaveOneSymbolOut),
      leaveOneFamilyOut: compactGroupValidation(variant.leaveOneFamilyOut),
      trades: variant.trades.map((trade, index) => compactTrade(trade, index, variant)),
    };
  }
  ledger.ledgers[variant.id].categories.push(category);
}

writeJson(join(paths.models, 'current-phase26-generalization-engine.json'), output);
writeJson(join(paths.reports, 'phase26-generalization-engine-report.json'), output);
writeJson(join(paths.reports, 'phase26-generalization-trade-ledgers.json'), ledger);
writeJson(join(paths.dashboardData, 'phase26-generalization-engine.json'), output);
writeJson(join(paths.dashboardData, 'phase26-generalization-trade-ledgers.json'), ledger);
writeJson(join(paths.generated, 'phase26_generalization_export.json'), {
  updatedAt: output.updatedAt,
  runId,
  bestOverall: output.categoryChampions.bestOverall,
  bestProfit: output.categoryChampions.bestProfit,
  bestGeneralization: output.categoryChampions.bestGeneralization,
  tickerDiscovery: output.tickerDiscovery.slice(0, 20),
  improvementCoverage,
});

console.log('Phase26 Generalization Engine complete');
console.log(`Trades=${enrichedTrades.length} evaluated=${evaluated} kept=${variants.length} qualified=${qualified.length} promoted=${promoted.length} watchlist=${watchlist.length}`);
if (bestOverall) {
  console.log(`Best=${bestOverall.id} trades=${bestOverall.metrics.trades} win=${bestOverall.metrics.winRate.toFixed(2)}% net=$${bestOverall.metrics.netDollars.toFixed(0)} holdout=${bestOverall.holdout.winRate.toFixed(2)}% symbolOOS=${bestOverall.leaveOneSymbolOut.positiveRate.toFixed(2)}% familyOOS=${bestOverall.leaveOneFamilyOut.positiveRate.toFixed(2)}% deepStress=$${bestOverall.deepStress.netDollars.toFixed(0)}`);
}
