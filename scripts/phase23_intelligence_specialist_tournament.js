#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

const paths = {
  fullTrades: join(root, 'optimization-results', 'canonical', 'canonical-trades.full.jsonl'),
  phase22: join(root, 'models', 'champions', 'current-phase22-deep-specialist-tournament.json'),
  phase22Ledgers: join(root, 'apps', 'dashboard', 'public', 'data', 'phase22-trade-ledgers.json'),
  champions: join(root, 'models', 'champions'),
  registry: join(root, 'models', 'registry'),
  reports: join(root, 'reports'),
  dashboardData: join(root, 'apps', 'dashboard', 'public', 'data'),
  generated: join(root, 'generated'),
};

for (const path of [paths.champions, paths.registry, paths.reports, paths.dashboardData, paths.generated]) mkdirSync(path, { recursive: true });

const args = new Map(process.argv.slice(2).map((arg) => {
  const [key, value = 'true'] = arg.replace(/^--/, '').split('=');
  return [key, value];
}));

const maxVariants = Number(args.get('max-variants') || 18000);
const stressCostDollars = Number(args.get('stress-cost-dollars') || 24);
const stressPct = Number(args.get('stress-pct') || 0.02);
const minTrades = Number(args.get('min-trades') || 150);

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

function n(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clamp01(value) {
  return Math.max(0, Math.min(1, n(value, 0)));
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
  return Math.max(0, Math.round(((exit > 100000000000 ? exit : exit * 1000) - (entry > 100000000000 ? entry : entry * 1000)) / 60000));
}

function weekFromDate(date) {
  if (!date || date === 'unknown') return 'unknown';
  const parsed = new Date(`${date}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) return 'unknown';
  const start = new Date(Date.UTC(parsed.getUTCFullYear(), 0, 1));
  const days = Math.floor((parsed - start) / 86400000);
  return `${parsed.getUTCFullYear()}-W${String(Math.floor((days + start.getUTCDay()) / 7) + 1).padStart(2, '0')}`;
}

function metrics(trades, pnlFn = (trade) => n(trade.pnlDollars, 0)) {
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
    optionWorthyRate: trades.length ? trades.filter((trade) => trade.optionWorthy || n(trade.mfeR, 0) >= 1.5).length / trades.length * 100 : 0,
    maxDrawdownDollars,
    maxLossStreak,
  };
}

function stressPnl(trade) {
  return n(trade.pnlDollars, 0) - stressCostDollars - Math.abs(n(trade.pnlDollars, 0)) * stressPct;
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

function consistency(trades) {
  const days = new Map();
  const weeks = new Map();
  for (const trade of trades) {
    days.set(trade.date, (days.get(trade.date) || 0) + n(trade.pnlDollars, 0));
    weeks.set(weekFromDate(trade.date), (weeks.get(weekFromDate(trade.date)) || 0) + n(trade.pnlDollars, 0));
  }
  const dayRows = [...days.entries()].filter(([key]) => key && key !== 'unknown');
  const weekRows = [...weeks.entries()].filter(([key]) => key && key !== 'unknown');
  return {
    uniqueDays: dayRows.length,
    uniqueWeeks: weekRows.length,
    dayConsistency: dayRows.length ? dayRows.filter(([, pnl]) => pnl > 0).length / dayRows.length * 100 : 0,
    weekConsistency: weekRows.length ? weekRows.filter(([, pnl]) => pnl > 0).length / weekRows.length * 100 : 0,
  };
}

function conflictKey(trade) {
  return [trade.symbol, trade.side, trade.entryTime, trade.exitTime, n(trade.entry, 0).toFixed(4), n(trade.exit, 0).toFixed(4)].join('|');
}

function featureScore(features, weights) {
  let positive = 0;
  let positiveWeight = 0;
  let penalty = 0;
  let penaltyWeight = 0;
  for (const [feature, weight] of Object.entries(weights)) {
    const value = clamp01(features[feature]);
    if (weight >= 0) {
      positive += value * weight;
      positiveWeight += weight;
    } else {
      penalty += value * Math.abs(weight);
      penaltyWeight += Math.abs(weight);
    }
  }
  const good = positiveWeight ? positive / positiveWeight : 0;
  const bad = penaltyWeight ? penalty / penaltyWeight : 0;
  return Math.max(0, Math.min(1, good - bad * 0.72));
}

const featureBlueprints = {
  liquiditySweep: {
    description: 'Stop-run below/above structure followed by reclaim; useful for reversal scalps.',
    weights: { liquiditySweep: 1.3, stopRunReclaim: 1.2, pullbackReclaim: 0.75, rejectionWick: 0.55, closeLocation: 0.45, failedBreakRisk: -0.85, vwapExtensionRisk: -0.35 },
  },
  vwapReclaimQuality: {
    description: 'Clean VWAP reclaim/loss with real volume, strong close, and limited rejection.',
    weights: { vwapPressure: 1.25, pullbackReclaim: 0.9, closeLocation: 0.75, volumeFlowAgreement: 0.65, cleanVolume: 0.55, rejectionWick: -0.45, vwapExtensionRisk: -0.95, failedBreakRisk: -0.75 },
  },
  compressionBreakout: {
    description: 'ATR/compression release into clean range expansion and volume confirmation.',
    weights: { compressionRelease: 1.35, rangeExpansionQuality: 1.05, cleanBreakout: 0.95, relVolTodQuality: 0.8, volumeAcceleration: 0.65, closeLocation: 0.5, failedBreakRisk: -1.05, vwapExtensionRisk: -0.55 },
  },
  trendPullback: {
    description: 'HTF/EMA trend intact, pullback to EMA/VWAP, then continuation.',
    weights: { trendQuality: 1.2, pullbackReclaim: 1.0, emaSlope: 0.85, vwapPressure: 0.65, relativeStrength: 0.65, priceAcceleration: 0.45, failedBreakRisk: -0.8, vwapExtensionRisk: -0.8 },
  },
  exhaustionReversal: {
    description: 'Extended move, wick rejection, volume climax, and reclaim risk/reward.',
    weights: { rejectionWick: 0.9, liquiditySweep: 0.85, stopRunReclaim: 0.8, closeLocation: 0.65, volumeQuality: 0.55, pullbackReclaim: 0.55, failedBreakRisk: -0.65, vwapExtensionRisk: -0.35 },
  },
  failedBreakoutTrapGuard: {
    description: 'Blocks breakouts/reclaims with failed-breakout fingerprints.',
    weights: { cleanBreakout: 0.95, breakoutQuality: 0.85, rangeExpansionQuality: 0.65, volumeFlowAgreement: 0.55, failedBreakRisk: -1.45, rejectionWick: -0.55, vwapExtensionRisk: -0.55 },
  },
  relativeStrength: {
    description: 'Ticker must show relative strength versus market/peer context.',
    weights: { relativeStrength: 1.35, marketAlignment: 0.95, marketImpulse: 0.75, intradayTrendQuality: 0.7, dayPositionQuality: 0.45, failedBreakRisk: -0.55 },
  },
  volumeQuality: {
    description: 'Real accumulation/participation instead of a one-off volume spike.',
    weights: { cleanVolume: 1.05, volumeFlowAgreement: 1.05, volumeAcceleration: 0.8, relVolTodQuality: 0.75, volumeQuality: 0.55, rejectionWick: -0.45 },
  },
  candleLocation: {
    description: 'Close location and candle body quality; close near high/low matters most.',
    weights: { closeLocation: 1.25, bodyQuality: 0.9, directionalCandle: 0.7, priceAcceleration: 0.45, rejectionWick: -0.75 },
  },
  vwapDistancePenalty: {
    description: 'Avoids late chase too far from VWAP unless breakout quality is exceptional.',
    weights: { vwapPressure: 0.95, cleanBreakout: 0.55, rangeExpansionQuality: 0.45, vwapExtensionRisk: -1.45, failedBreakRisk: -0.75 },
  },
};

const modelProfiles = [
  {
    name: 'phase23_high_win_guard',
    goal: 'Improve Phase22 high-win specialist by requiring clean structure and anti-chase filters.',
    blend: { liquiditySweep: 0.08, vwapReclaimQuality: 0.14, compressionBreakout: 0.10, trendPullback: 0.14, exhaustionReversal: 0.05, failedBreakoutTrapGuard: 0.16, relativeStrength: 0.11, volumeQuality: 0.12, candleLocation: 0.12, vwapDistancePenalty: 0.16 },
    minTrades: 150,
    netScale: 260000,
  },
  {
    name: 'phase23_profit_guard',
    goal: 'Keep profit high while removing fake breakouts and fake volume.',
    blend: { liquiditySweep: 0.05, vwapReclaimQuality: 0.10, compressionBreakout: 0.16, trendPullback: 0.09, exhaustionReversal: 0.04, failedBreakoutTrapGuard: 0.14, relativeStrength: 0.12, volumeQuality: 0.16, candleLocation: 0.10, vwapDistancePenalty: 0.10 },
    minTrades: 250,
    netScale: 520000,
  },
  {
    name: 'phase23_vwap_reclaim',
    goal: 'Specialize in clean VWAP/EMA reclaim with close-location and no-chase checks.',
    blend: { liquiditySweep: 0.07, vwapReclaimQuality: 0.24, compressionBreakout: 0.06, trendPullback: 0.14, exhaustionReversal: 0.06, failedBreakoutTrapGuard: 0.12, relativeStrength: 0.08, volumeQuality: 0.10, candleLocation: 0.13, vwapDistancePenalty: 0.20 },
    minTrades: 80,
    netScale: 180000,
  },
  {
    name: 'phase23_compression_pop',
    goal: 'Specialize in squeeze/compression releases with volume and trap protection.',
    blend: { liquiditySweep: 0.04, vwapReclaimQuality: 0.08, compressionBreakout: 0.30, trendPullback: 0.06, exhaustionReversal: 0.03, failedBreakoutTrapGuard: 0.15, relativeStrength: 0.08, volumeQuality: 0.16, candleLocation: 0.10, vwapDistancePenalty: 0.10 },
    minTrades: 60,
    netScale: 160000,
  },
  {
    name: 'phase23_sweep_reversal',
    goal: 'Specialize in stop-run reclaim and exhaustion reversal setups.',
    blend: { liquiditySweep: 0.26, vwapReclaimQuality: 0.12, compressionBreakout: 0.04, trendPullback: 0.06, exhaustionReversal: 0.22, failedBreakoutTrapGuard: 0.12, relativeStrength: 0.05, volumeQuality: 0.08, candleLocation: 0.12, vwapDistancePenalty: 0.10 },
    minTrades: 45,
    netScale: 110000,
  },
];

const thresholdGrid = [0.44, 0.48, 0.52, 0.56, 0.60, 0.64, 0.68, 0.72];
const failedBreakCaps = [0.50, 0.60, 0.70, 0.82, 1.0];
const vwapExtensionCaps = [0.52, 0.64, 0.76, 0.90, 1.0];
const minVolumeScores = [0.00, 0.35, 0.45, 0.55];
const minRelativeScores = [0.00, 0.30, 0.42, 0.55];
const routeSets = ['phase22-main', 'phase22-profit', 'phase22-union'];
const guardRecipes = [
  {
    name: 'phase23_elite_chop_vwap_guard',
    goal: 'Ultra-high-win overlay: avoid the Phase22 loss cluster caused by high chop/late VWAP pressure.',
    minTrades: 120,
    routeSet: 'phase22-main',
    guards: [
      { feature: 'chopQuality', op: '<=', value: 0.90 },
      { feature: 'vwapPressure', op: '<=', value: 0.90 },
    ],
  },
  {
    name: 'phase23_elite_efficiency_vwap_guard',
    goal: 'Ultra-high-win overlay: avoid high-efficiency exhaustion and overextended VWAP pressure.',
    minTrades: 120,
    routeSet: 'phase22-main',
    guards: [
      { feature: 'efficiency', op: '<=', value: 0.75 },
      { feature: 'vwapPressure', op: '<=', value: 0.90 },
    ],
  },
  {
    name: 'phase23_highwin_vwap_compression_guard',
    goal: 'Higher-trade high-win overlay: prefer compression releases without stretched VWAP pressure.',
    minTrades: 150,
    routeSet: 'phase22-main',
    guards: [
      { feature: 'vwapPressure', op: '<=', value: 0.80 },
      { feature: 'compressionRelease', op: '>=', value: 0.50 },
    ],
  },
  {
    name: 'phase23_highwin_day_position_guard',
    goal: 'Favor strong day-position structure while suppressing choppy loss clusters.',
    minTrades: 120,
    routeSet: 'phase22-main',
    guards: [
      { feature: 'chopQuality', op: '<=', value: 0.95 },
      { feature: 'dayPositionQuality', op: '>=', value: 0.70 },
    ],
  },
  {
    name: 'phase23_highwin_close_compression_guard',
    goal: 'Require strong close location and compression release before accepting the Phase22 signal.',
    minTrades: 120,
    routeSet: 'phase22-main',
    guards: [
      { feature: 'closeLocation', op: '>=', value: 0.85 },
      { feature: 'compressionRelease', op: '>=', value: 0.50 },
    ],
  },
];

function engineScores(trade) {
  const features = trade.features || {};
  return Object.fromEntries(Object.entries(featureBlueprints).map(([key, blueprint]) => [key, featureScore(features, blueprint.weights)]));
}

function blendedScore(scores, blend) {
  let total = 0;
  let weight = 0;
  for (const [key, value] of Object.entries(blend)) {
    total += (scores[key] || 0) * value;
    weight += value;
  }
  return weight ? total / weight : 0;
}

function passVariant(trade, scores, config) {
  const features = trade.features || {};
  const score = blendedScore(scores, config.profile.blend);
  if (score < config.threshold) return false;
  if (clamp01(features.failedBreakRisk) > config.maxFailedBreak) return false;
  if (clamp01(features.vwapExtensionRisk) > config.maxVwapExtension) return false;
  if (scores.volumeQuality < config.minVolumeScore) return false;
  if (scores.relativeStrength < config.minRelativeScore) return false;
  if (config.requireCleanVwap && scores.vwapReclaimQuality < config.threshold * 0.95) return false;
  if (config.requireTrapGuard && scores.failedBreakoutTrapGuard < config.threshold * 0.90) return false;
  return true;
}

function passGuards(trade, guards) {
  const features = trade.features || {};
  return guards.every((guard) => {
    const value = clamp01(features[guard.feature]);
    return guard.op === '>=' ? value >= guard.value : value <= guard.value;
  });
}

function pickRouteKeys(phase22, routeSet) {
  const categories = phase22.categoryChampions || {};
  const keys = new Set();
  const add = (variant) => (variant?.selectedRouteKeys || []).forEach((key) => keys.add(key));
  if (routeSet === 'phase22-main') add(phase22.recommendedChampion);
  if (routeSet === 'phase22-profit') add(categories.profitMax);
  if (routeSet === 'phase22-union') {
    add(phase22.recommendedChampion);
    add(categories.highWin150);
    add(categories.profitMax);
    add(categories.lowDrawdown);
    add(categories.lowPriced);
    add(categories.cryptoProxy);
    add(categories.semisAi);
  }
  return keys;
}

function pickExactTradeIds(phase22Ledgers, routeSet) {
  const ids = new Set();
  const addCategory = (category) => {
    const variantId = phase22Ledgers?.categoryMap?.[category];
    const ledger = phase22Ledgers?.ledgers?.[variantId];
    for (const trade of ledger?.trades || []) ids.add(trade.canonicalId);
  };
  if (routeSet === 'phase22-main') addCategory('mainMinimum150');
  if (routeSet === 'phase22-profit') addCategory('profitMax');
  if (routeSet === 'phase22-union') {
    for (const category of Object.keys(phase22Ledgers?.categoryMap || {})) addCategory(category);
  }
  return ids;
}

function resolveConflicts(trades) {
  const byKey = new Map();
  for (const trade of trades) {
    const key = conflictKey(trade);
    const existing = byKey.get(key);
    if (!existing || trade.phase23Score > existing.phase23Score || (trade.phase23Score === existing.phase23Score && n(trade.confidence, 0) > n(existing.confidence, 0))) {
      byKey.set(key, trade);
    }
  }
  return [...byKey.values()].sort((a, b) => tradeTime(a) - tradeTime(b));
}

function evaluate(trades, config) {
  const selected = [];
  for (const trade of trades) {
    const scores = engineScores(trade);
    if (!passVariant(trade, scores, config)) continue;
    selected.push({
      ...trade,
      phase23Score: Number(blendedScore(scores, config.profile.blend).toFixed(4)),
      phase23Engines: Object.fromEntries(Object.entries(scores).map(([key, value]) => [key, Number(value.toFixed(4))])),
    });
  }
  const finalTrades = resolveConflicts(selected);
  const split = splitChronological(finalTrades);
  const all = metrics(finalTrades);
  const train = metrics(split.train);
  const test = metrics(split.test);
  const holdout = metrics(split.holdout);
  const stress = metrics(finalTrades, stressPnl);
  const c = consistency(finalTrades);
  const profile = config.profile;
  const netScore = Math.tanh(all.netDollars / profile.netScale) * 100;
  const holdoutNetScore = Math.tanh(holdout.netDollars / Math.max(profile.netScale * 0.25, 50000)) * 100;
  const tradePenalty = all.trades < profile.minTrades ? (profile.minTrades - all.trades) / profile.minTrades * 90 : 0;
  const drawdownPenalty = all.netDollars > 0 ? Math.min(45, all.maxDrawdownDollars / all.netDollars * 85) : 45;
  const score =
    all.winRate * 0.16 +
    test.winRate * 0.18 +
    holdout.winRate * 0.22 +
    netScore * 0.14 +
    holdoutNetScore * 0.11 +
    Math.min(100, all.trades / Math.max(profile.minTrades * 2.2, 1) * 100) * 0.06 +
    c.dayConsistency * 0.08 +
    stress.winRate * 0.08 +
    Math.min(100, all.avgDollars / 650 * 100) * 0.07 -
    drawdownPenalty -
    Math.min(30, all.maxLossStreak * 2.0) -
    tradePenalty;
  return {
    score: Number(score.toFixed(3)),
    metrics: all,
    train,
    test,
    holdout,
    stress,
    consistency: c,
    trades: finalTrades,
    diagnostics: {
      tradePenalty: Number(tradePenalty.toFixed(3)),
      drawdownPenalty: Number(drawdownPenalty.toFixed(3)),
    },
  };
}

function compactTrade(trade, index) {
  return {
    index: index + 1,
    outcome: n(trade.pnlDollars, 0) > 0 ? 'win' : n(trade.pnlDollars, 0) < 0 ? 'loss' : 'flat',
    canonicalId: trade.canonicalId,
    symbol: trade.symbol,
    family: trade.family,
    side: trade.side,
    trigger: trade.trigger,
    session: trade.session,
    date: trade.date,
    entryTime: trade.entryTime,
    exitTime: trade.exitTime,
    entryIso: isoTime(trade.entryTime),
    exitIso: isoTime(trade.exitTime),
    minutesHeld: minutesHeld(trade),
    entry: trade.entry,
    exit: trade.exit,
    pnlDollars: trade.pnlDollars,
    modeledPnlScaledTo10k: n(trade.pnlDollars, 0) * 0.10,
    mfeR: trade.mfeR,
    maeR: trade.maeR,
    confidence: trade.confidence,
    phase23Score: trade.phase23Score,
    phase23Engines: trade.phase23Engines,
    selectedRouteKey: trade.routeId,
  };
}

function summarizeBy(trades, field, limit = 25) {
  const grouped = new Map();
  for (const trade of trades) {
    const key = trade[field] || 'unknown';
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(trade);
  }
  return [...grouped.entries()]
    .map(([key, rows]) => ({ name: key, metrics: metrics(rows) }))
    .sort((a, b) => b.metrics.netDollars - a.metrics.netDollars)
    .slice(0, limit);
}

function engineAverages(trades) {
  const totals = Object.fromEntries(Object.keys(featureBlueprints).map((key) => [key, 0]));
  if (!trades.length) return totals;
  for (const trade of trades) {
    const scores = trade.phase23Engines || engineScores(trade);
    for (const key of Object.keys(totals)) totals[key] += scores[key] || 0;
  }
  return Object.fromEntries(Object.entries(totals).map(([key, value]) => [key, Number((value / trades.length).toFixed(4))]));
}

function compactVariant(variant) {
  if (!variant) return null;
  return {
    id: variant.id,
    profile: variant.profile.name,
    goal: variant.profile.goal,
    routeSet: variant.routeSet,
    threshold: variant.threshold,
    maxFailedBreak: variant.maxFailedBreak,
    maxVwapExtension: variant.maxVwapExtension,
    minVolumeScore: variant.minVolumeScore,
    minRelativeScore: variant.minRelativeScore,
    requireCleanVwap: variant.requireCleanVwap,
    requireTrapGuard: variant.requireTrapGuard,
    score: variant.score,
    metrics: variant.metrics,
    train: variant.train,
    test: variant.test,
    holdout: variant.holdout,
    stress: variant.stress,
    consistency: variant.consistency,
    diagnostics: variant.diagnostics,
    engineAverages: engineAverages(variant.trades),
    topSymbols: summarizeBy(variant.trades, 'symbol', 20),
    topFamilies: summarizeBy(variant.trades, 'family', 12),
    topTriggers: summarizeBy(variant.trades, 'trigger', 12),
    topRoutes: summarizeBy(variant.trades, 'routeId', 35),
    topTrades: [...variant.trades].sort((a, b) => n(b.pnlDollars, 0) - n(a.pnlDollars, 0)).slice(0, 25).map(compactTrade),
    tradeSample: variant.trades.slice(0, 40).map(compactTrade),
  };
}

const phase22 = readJson(paths.phase22);
if (!phase22) throw new Error('Missing Phase22 champion; run npm run scalp:phase22 first.');
const phase22Ledgers = readJson(paths.phase22Ledgers, null);
const allTrades = readJsonl(paths.fullTrades);
if (!allTrades.length) throw new Error('Missing full canonical trades. Run Phase21 locally with FUSION_WRITE_FULL_CANONICAL=true.');

const variants = [];
let evaluated = 0;
for (const routeSet of routeSets) {
  const exactIds = pickExactTradeIds(phase22Ledgers, routeSet);
  const routeKeys = pickRouteKeys(phase22, routeSet);
  const routeTrades = exactIds.size
    ? allTrades.filter((trade) => exactIds.has(trade.canonicalId))
    : allTrades.filter((trade) => routeKeys.has(trade.routeId));
  if (!routeTrades.length) continue;
  for (const profile of modelProfiles) {
    for (const threshold of thresholdGrid) {
      for (const maxFailedBreak of failedBreakCaps) {
        for (const maxVwapExtension of vwapExtensionCaps) {
          for (const minVolumeScore of minVolumeScores) {
            for (const minRelativeScore of minRelativeScores) {
              for (const requireCleanVwap of [false, true]) {
                for (const requireTrapGuard of [true, false]) {
                  if (variants.length >= maxVariants) break;
                  const config = { profile, routeSet, threshold, maxFailedBreak, maxVwapExtension, minVolumeScore, minRelativeScore, requireCleanVwap, requireTrapGuard };
                  const result = evaluate(routeTrades, config);
                  evaluated += 1;
                  if (result.metrics.trades < Math.max(30, profile.minTrades * 0.35)) continue;
                  variants.push({
                    id: [
                      'phase23',
                      profile.name,
                      routeSet,
                      `q${String(Math.round(threshold * 100)).padStart(2, '0')}`,
                      `fb${Math.round(maxFailedBreak * 100)}`,
                      `vw${Math.round(maxVwapExtension * 100)}`,
                      `vol${Math.round(minVolumeScore * 100)}`,
                      `rs${Math.round(minRelativeScore * 100)}`,
                      requireCleanVwap ? 'cleanvwap' : 'anyvwap',
                      requireTrapGuard ? 'trapguard' : 'looseguard',
                    ].join('__'),
                    ...config,
                    ...result,
                  });
                }
              }
            }
          }
        }
      }
    }
  }
}

for (const recipe of guardRecipes) {
  const exactIds = pickExactTradeIds(phase22Ledgers, recipe.routeSet);
  const routeKeys = pickRouteKeys(phase22, recipe.routeSet);
  const routeTrades = allTrades.filter((trade) => (exactIds.size ? exactIds.has(trade.canonicalId) : routeKeys.has(trade.routeId)) && passGuards(trade, recipe.guards));
  const finalTrades = resolveConflicts(routeTrades.map((trade) => {
    const scores = engineScores(trade);
    return {
      ...trade,
      phase23Score: Number(blendedScore(scores, modelProfiles[0].blend).toFixed(4)),
      phase23Engines: Object.fromEntries(Object.entries(scores).map(([key, value]) => [key, Number(value.toFixed(4))])),
    };
  }));
  const split = splitChronological(finalTrades);
  const all = metrics(finalTrades);
  if (all.trades < Math.max(30, recipe.minTrades * 0.70)) continue;
  const train = metrics(split.train);
  const test = metrics(split.test);
  const holdout = metrics(split.holdout);
  const stress = metrics(finalTrades, stressPnl);
  const c = consistency(finalTrades);
  const netScore = Math.tanh(all.netDollars / 180000) * 100;
  const holdoutNetScore = Math.tanh(holdout.netDollars / 50000) * 100;
  const tradePenalty = all.trades < recipe.minTrades ? (recipe.minTrades - all.trades) / recipe.minTrades * 50 : 0;
  const drawdownPenalty = all.netDollars > 0 ? Math.min(35, all.maxDrawdownDollars / all.netDollars * 65) : 35;
  const score = all.winRate * 0.22 + test.winRate * 0.20 + holdout.winRate * 0.23 + netScore * 0.10 + holdoutNetScore * 0.08 + c.dayConsistency * 0.08 + stress.winRate * 0.07 + Math.min(100, all.avgDollars / 650 * 100) * 0.05 - drawdownPenalty - Math.min(30, all.maxLossStreak * 2.4) - tradePenalty;
  variants.push({
    id: ['phase23', recipe.name, recipe.routeSet, ...recipe.guards.map((guard) => `${guard.feature}${guard.op}${guard.value}`)].join('__').replaceAll(/[^\w|.-]+/g, '_'),
    profile: {
      name: recipe.name,
      goal: recipe.goal,
      blend: modelProfiles[0].blend,
      minTrades: recipe.minTrades,
      netScale: 180000,
    },
    routeSet: recipe.routeSet,
    threshold: null,
    maxFailedBreak: null,
    maxVwapExtension: null,
    minVolumeScore: null,
    minRelativeScore: null,
    requireCleanVwap: false,
    requireTrapGuard: true,
    guardRecipe: recipe,
    score: Number(score.toFixed(3)),
    metrics: all,
    train,
    test,
    holdout,
    stress,
    consistency: c,
    trades: finalTrades,
    diagnostics: {
      tradePenalty: Number(tradePenalty.toFixed(3)),
      drawdownPenalty: Number(drawdownPenalty.toFixed(3)),
      guards: recipe.guards,
    },
  });
}

variants.sort((a, b) => b.score - a.score || b.holdout.netDollars - a.holdout.netDollars);

const highWin = [...variants].filter((variant) => variant.metrics.trades >= minTrades).sort((a, b) => b.metrics.winRate - a.metrics.winRate || b.metrics.netDollars - a.metrics.netDollars)[0] || null;
const profit = [...variants].filter((variant) => variant.metrics.trades >= minTrades).sort((a, b) => b.metrics.netDollars - a.metrics.netDollars || b.metrics.winRate - a.metrics.winRate)[0] || null;
const balanced = variants.find((variant) => variant.metrics.trades >= minTrades) || variants[0] || null;
const vwap = variants.find((variant) => variant.profile.name === 'phase23_vwap_reclaim' && variant.metrics.trades >= 50) || null;
const compression = variants.find((variant) => variant.profile.name === 'phase23_compression_pop' && variant.metrics.trades >= 40) || null;
const sweep = variants.find((variant) => variant.profile.name === 'phase23_sweep_reversal' && variant.metrics.trades >= 30) || null;
const elitePrecision = [...variants].filter((variant) => variant.profile.name.includes('elite') && variant.metrics.trades >= 100).sort((a, b) => b.metrics.winRate - a.metrics.winRate || b.metrics.netDollars - a.metrics.netDollars)[0] || null;
const highWinGuarded = [...variants].filter((variant) => variant.profile.name.includes('highwin') && variant.metrics.trades >= 140).sort((a, b) => b.metrics.winRate - a.metrics.winRate || b.metrics.netDollars - a.metrics.netDollars)[0] || null;

const champion = balanced;
const runId = `phase23-${new Date().toISOString().replace(/[:.]/g, '-')}`;
const output = {
  updatedAt: new Date().toISOString(),
  runId,
  phase: 'Phase23 Intelligence Specialist Tournament',
  goal: 'Apply explicit market-structure intelligence to the Phase22 winner: liquidity sweep, VWAP quality, compression breakout, trend pullback, exhaustion reversal, failed-breakout guard, relative strength, volume quality, candle location, and VWAP distance penalty.',
  config: {
    maxVariants,
    variantsEvaluated: evaluated,
    variantsKept: variants.length,
    fullTradesLoaded: allTrades.length,
    minTrades,
    stressCostDollars,
    stressPct,
    routeSets,
  },
  baselinePhase22: {
    id: phase22.recommendedChampion?.id,
    metrics: phase22.recommendedChampion?.metrics,
    holdout: phase22.recommendedChampion?.holdout,
    stress: phase22.recommendedChampion?.stress,
  },
  featureBlueprints,
  recommendedChampion: compactVariant(champion),
  categoryChampions: {
    balanced: compactVariant(balanced),
    highWin: compactVariant(highWin),
    profit: compactVariant(profit),
    vwapReclaim: compactVariant(vwap),
    compressionPop: compactVariant(compression),
    sweepReversal: compactVariant(sweep),
    elitePrecision: compactVariant(elitePrecision),
    highWinGuarded: compactVariant(highWinGuarded),
  },
  rankedVariants: variants.slice(0, 80).map(compactVariant),
  machineLearningDraft: {
    status: 'drafted',
    nextStep: 'Train route-family logistic/gradient models on canonical features, compare against Phase23 rule engine, and only promote rules that win on chronological holdout plus forward paper.',
    featureGroups: Object.keys(featureBlueprints),
    labelTargets: ['winLoss', 'mfeR', 'maeR', 'optionWorthy', 'timeToProfit', 'forwardGap'],
    promotionGuards: ['chronologicalHoldout', 'stressCosts', 'minTrades', 'uniqueDays', 'forwardPaperTrust', 'driftDetection'],
  },
};

const ledger = {
  updatedAt: output.updatedAt,
  runId,
  ledgers: {},
  categoryMap: {},
};
for (const [category, variant] of Object.entries({ balanced, highWin, profit, vwapReclaim: vwap, compressionPop: compression, sweepReversal: sweep, elitePrecision, highWinGuarded })) {
  if (!variant) continue;
  ledger.categoryMap[category] = variant.id;
  if (!ledger.ledgers[variant.id]) {
    ledger.ledgers[variant.id] = {
      id: variant.id,
      categories: [],
      profile: variant.profile.name,
      routeSet: variant.routeSet,
      metrics: variant.metrics,
      holdout: variant.holdout,
      stress: variant.stress,
      engineAverages: engineAverages(variant.trades),
      trades: variant.trades.map(compactTrade),
    };
  }
  ledger.ledgers[variant.id].categories.push(category);
}

function dashboardVariant(variant) {
  if (!variant) return null;
  return {
    ...variant,
    topSymbols: variant.topSymbols?.slice(0, 12) || [],
    topFamilies: variant.topFamilies?.slice(0, 10) || [],
    topTriggers: variant.topTriggers?.slice(0, 10) || [],
    topRoutes: variant.topRoutes?.slice(0, 12) || [],
    topTrades: variant.topTrades?.slice(0, 8) || [],
    tradeSample: variant.tradeSample?.slice(0, 5) || [],
  };
}

const dashboardOutput = {
  ...output,
  recommendedChampion: dashboardVariant(output.recommendedChampion),
  categoryChampions: Object.fromEntries(Object.entries(output.categoryChampions).map(([key, variant]) => [key, dashboardVariant(variant)])),
  rankedVariants: output.rankedVariants.slice(0, 40).map(dashboardVariant),
};

writeJson(join(paths.champions, 'current-phase23-intelligence-specialist.json'), output);
writeJson(join(paths.registry, 'phase23-intelligence-registry.json'), {
  updatedAt: output.updatedAt,
  runId,
  recommendedChampion: output.recommendedChampion,
  categoryChampions: output.categoryChampions,
  topVariants: output.rankedVariants.slice(0, 25),
});
writeJson(join(paths.reports, 'phase23-intelligence-specialist-report.json'), output);
writeJson(join(paths.reports, 'phase23-intelligence-trade-ledgers.json'), ledger);
writeJson(join(paths.dashboardData, 'phase23-intelligence-specialist.json'), dashboardOutput);
writeJson(join(paths.dashboardData, 'phase23-intelligence-trade-ledgers.json'), ledger);
writeJson(join(paths.generated, 'phase23_intelligence_export.json'), {
  updatedAt: output.updatedAt,
  runId,
  recommendedChampion: output.recommendedChampion,
  categoryChampions: output.categoryChampions,
  pineInputs: {
    modelId: 'fusionv3-phase23-intelligence',
    defaultMode: 'Phase23 Intelligence Specialist',
    whitelist: output.recommendedChampion?.topSymbols?.slice(0, 40).map((item) => item.name).join(',') || '',
    triggerMode: 'Hybrid Consensus',
    backtestWr: output.recommendedChampion?.metrics?.winRate || 0,
    holdoutWr: output.recommendedChampion?.holdout?.winRate || 0,
  },
});

console.log('Phase23 Intelligence Specialist Tournament complete');
console.log(`Trades loaded=${allTrades.length} evaluated=${evaluated} kept=${variants.length}`);
if (champion) {
  console.log(`Recommended=${champion.id}`);
  console.log(`Trades=${champion.metrics.trades} win=${champion.metrics.winRate.toFixed(2)}% net=$${champion.metrics.netDollars.toFixed(0)} avg=$${champion.metrics.avgDollars.toFixed(0)} holdout=${champion.holdout.winRate.toFixed(2)}% stress=$${champion.stress.netDollars.toFixed(0)}`);
}
