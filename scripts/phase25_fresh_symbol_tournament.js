#!/usr/bin/env node
import { createReadStream, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import readline from 'node:readline';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

const paths = {
  fullTrades: join(root, 'optimization-results', 'canonical', 'canonical-trades.full.jsonl'),
  phase22Ledgers: join(root, 'apps', 'dashboard', 'public', 'data', 'phase22-trade-ledgers.json'),
  phase23Ledgers: join(root, 'apps', 'dashboard', 'public', 'data', 'phase23-intelligence-trade-ledgers.json'),
  phase24Ledgers: join(root, 'apps', 'dashboard', 'public', 'data', 'phase24-trade-ledgers.json'),
  models: join(root, 'models', 'fresh-symbol'),
  reports: join(root, 'reports', 'fresh-symbol'),
  dashboardData: join(root, 'apps', 'dashboard', 'public', 'data'),
  generated: join(root, 'generated'),
};

for (const path of [paths.models, paths.reports, paths.dashboardData, paths.generated]) mkdirSync(path, { recursive: true });

const args = new Map(process.argv.slice(2).map((arg) => {
  const [key, value = 'true'] = arg.replace(/^--/, '').split('=');
  return [key, value];
}));

const maxVariants = Number(args.get('max-variants') || 30000);
const minTrades = Number(args.get('min-trades') || 80);
const stressCostDollars = Number(args.get('stress-cost-dollars') || 24);
const stressPct = Number(args.get('stress-pct') || 0.02);
const excludeMode = args.get('exclude-mode') || 'all-champion-symbols';

function readJson(path, fallback = null) {
  if (!existsSync(path)) return fallback;
  return JSON.parse(readFileSync(path, 'utf8'));
}

function writeJson(path, payload) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(payload, null, 2)}\n`);
}

async function readJsonl(path) {
  if (!existsSync(path)) return [];
  const rows = [];
  const rl = readline.createInterface({ input: createReadStream(path), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    rows.push(JSON.parse(line));
  }
  return rows;
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

function modeledPnlForTarget(trade, targetR) {
  const pnl = n(trade.pnlDollars, 0);
  const target = Math.max(0.1, n(targetR, n(trade.targetR, 0.5)));
  const risk = riskDollars(trade);
  const mfe = n(trade.mfeR, 0);
  const mae = n(trade.maeR, 0);
  if (mfe >= target) return risk * target;
  if (mae >= 1) return -risk;
  if (pnl > 0) return Math.min(pnl, risk * target);
  return pnl;
}

function metrics(trades, targetR = null, pnlFn = null) {
  const p = pnlFn || ((trade) => targetR ? modeledPnlForTarget(trade, targetR) : n(trade.pnlDollars, 0));
  const wins = trades.filter((trade) => p(trade) > 0);
  const grossWin = wins.reduce((sum, trade) => sum + p(trade), 0);
  const grossLoss = Math.abs(trades.filter((trade) => p(trade) <= 0).reduce((sum, trade) => sum + p(trade), 0));
  const netDollars = trades.reduce((sum, trade) => sum + p(trade), 0);
  let equity = 0;
  let peak = 0;
  let maxDrawdownDollars = 0;
  let lossStreak = 0;
  let maxLossStreak = 0;
  for (const trade of trades) {
    const pnl = p(trade);
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

function stressPnl(targetR) {
  return (trade) => {
    const pnl = modeledPnlForTarget(trade, targetR);
    return pnl - stressCostDollars - Math.abs(pnl) * stressPct;
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

function consistency(trades, targetR = null) {
  const days = new Map();
  const weeks = new Map();
  const symbols = new Set();
  for (const trade of trades) {
    const pnl = targetR ? modeledPnlForTarget(trade, targetR) : n(trade.pnlDollars, 0);
    days.set(trade.date, (days.get(trade.date) || 0) + pnl);
    weeks.set(weekFromDate(trade.date), (weeks.get(weekFromDate(trade.date)) || 0) + pnl);
    if (trade.symbol) symbols.add(trade.symbol);
  }
  const dayRows = [...days.entries()].filter(([key]) => key && key !== 'unknown');
  const weekRows = [...weeks.entries()].filter(([key]) => key && key !== 'unknown');
  return {
    uniqueDays: dayRows.length,
    uniqueWeeks: weekRows.length,
    uniqueSymbols: symbols.size,
    dayConsistency: dayRows.length ? dayRows.filter(([, pnl]) => pnl > 0).length / dayRows.length * 100 : 0,
    weekConsistency: weekRows.length ? weekRows.filter(([, pnl]) => pnl > 0).length / weekRows.length * 100 : 0,
  };
}

function conflictKey(trade) {
  return [trade.symbol, trade.side, trade.entryTime, n(trade.entry, 0).toFixed(4)].join('|');
}

function resolveConflicts(trades, scoreByTrade) {
  const best = new Map();
  for (const trade of trades) {
    const key = conflictKey(trade);
    const previous = best.get(key);
    if (!previous || scoreByTrade.get(trade.canonicalId) > scoreByTrade.get(previous.canonicalId)) best.set(key, trade);
  }
  return [...best.values()].sort((a, b) => tradeTime(a) - tradeTime(b));
}

function featureValue(trade, feature) {
  if (feature === 'confidence') return clamp01(n(trade.confidence, 0) / 100);
  if (feature === 'alphaQuality') return clamp01(n(trade.alphaQuality, 0) / 100);
  if (feature === 'intradayOnly') return isOvernight(trade) ? 0 : 1;
  if (feature === 'overnightOnly') return isOvernight(trade) ? 1 : 0;
  return clamp01(trade.features?.[feature]);
}

function entryScore(trade, weights) {
  let positive = 0;
  let positiveWeight = 0;
  let penalty = 0;
  let penaltyWeight = 0;
  for (const [feature, weight] of Object.entries(weights || {})) {
    const value = featureValue(trade, feature);
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
  return clamp01(good - bad * 0.72);
}

function symsFromLedger(payload, categories = Object.keys(payload.categoryMap || {})) {
  const symbols = new Set();
  const ids = new Set();
  for (const category of categories) {
    const id = payload.categoryMap?.[category];
    for (const trade of payload.ledgers?.[id]?.trades || []) {
      if (trade.symbol) symbols.add(trade.symbol);
      if (trade.canonicalId) ids.add(trade.canonicalId);
    }
  }
  return { symbols, ids };
}

const phase22Ledgers = readJson(paths.phase22Ledgers, { categoryMap: {}, ledgers: {} });
const phase23Ledgers = readJson(paths.phase23Ledgers, { categoryMap: {}, ledgers: {} });
const phase24Ledgers = readJson(paths.phase24Ledgers, { categoryMap: {}, ledgers: {} });
const allTrades = await readJsonl(paths.fullTrades);
if (!allTrades.length) throw new Error('Missing full canonical trades. Run Phase21 with FUSION_WRITE_FULL_CANONICAL=true.');

const allChampion = [
  symsFromLedger(phase22Ledgers),
  symsFromLedger(phase23Ledgers),
  symsFromLedger(phase24Ledgers),
];
const primaryChampion = [
  symsFromLedger(phase22Ledgers, ['profitMax']),
  symsFromLedger(phase24Ledgers, ['bestProfit']),
];
const excludeSymbols = new Set((excludeMode === 'primary-profit-symbols' ? primaryChampion : allChampion).flatMap((item) => [...item.symbols]));
const excludeIds = new Set((excludeMode === 'trade-ids-only' ? [...allChampion, ...primaryChampion] : []).flatMap((item) => [...item.ids]));

const freshTrades = allTrades.filter((trade) => !excludeSymbols.has(trade.symbol) && !excludeIds.has(trade.canonicalId));
const symbolStats = [...freshTrades.reduce((map, trade) => {
  const row = map.get(trade.symbol) || { symbol: trade.symbol, family: trade.family, trades: 0, wins: 0, netDollars: 0 };
  row.trades += 1;
  row.netDollars += n(trade.pnlDollars, 0);
  if (n(trade.pnlDollars, 0) > 0) row.wins += 1;
  map.set(trade.symbol, row);
  return map;
}, new Map()).values()].map((row) => ({
  ...row,
  winRate: row.trades ? row.wins / row.trades * 100 : 0,
})).sort((a, b) => b.netDollars - a.netDollars);

const freshSymbols = new Set(symbolStats.map((row) => row.symbol));

const championBackboneWeights = {
  confidence: 0.12,
  alphaQuality: 0.1,
  volumeQuality: 0.08,
  cleanVolume: 0.08,
  volumeFlowAgreement: 0.08,
  vwapPressure: 0.08,
  relativeStrength: 0.09,
  momentumBurst: 0.09,
  optionBurstShape: 0.08,
  closeLocation: 0.08,
  compressionRelease: 0.06,
  failedBreakRisk: -0.12,
  vwapExtensionRisk: -0.08,
  chopQuality: -0.04,
};

const challengerTwists = [
  ['relative_strength_plus', 'Requires fresh symbols to outperform market/peer context.', { relativeStrength: 0.22, marketAlignment: 0.1, marketImpulse: 0.08 }],
  ['volume_accumulation', 'Real volume expansion and flow agreement.', { volumeQuality: 0.18, cleanVolume: 0.16, volumeFlowAgreement: 0.16, volumeAcceleration: 0.1 }],
  ['vwap_reclaim_clean', 'Clean VWAP pressure/reclaim with limited extension.', { vwapPressure: 0.2, pullbackReclaim: 0.12, vwapExtensionRisk: -0.2 }],
  ['anti_chase_guard', 'Avoids late entries too far from VWAP/fair value.', { vwapExtensionRisk: -0.28, failedBreakRisk: -0.16, closeLocation: 0.1 }],
  ['failed_break_trap_guard', 'Blocks fake breakouts and trap signatures.', { failedBreakRisk: -0.32, cleanBreakout: 0.14, breakoutQuality: 0.12 }],
  ['compression_pop', 'Low compression into range expansion.', { compressionRelease: 0.22, rangeExpansionQuality: 0.14, cleanBreakout: 0.1 }],
  ['liquidity_sweep_reclaim', 'Stop-run/liquidity sweep reversal behavior.', { liquiditySweep: 0.24, stopRunReclaim: 0.2, rejectionWick: 0.08 }],
  ['momentum_burst', 'Fast price acceleration and momentum burst.', { momentumBurst: 0.24, priceAcceleration: 0.14, directionalCandle: 0.08 }],
  ['opening_drive', 'Opening-drive strength and early time edge.', { openingDriveQuality: 0.22, timeEdge: 0.14, volumeAcceleration: 0.08 }, { sessions: ['open', 'open-0930', 'open-1000'] }],
  ['trend_pullback_resume', 'Trend quality plus pullback/reclaim resume.', { trendQuality: 0.18, pullbackReclaim: 0.16, emaSlope: 0.1 }],
  ['candle_close_strength', 'Close location and body quality.', { closeLocation: 0.22, bodyQuality: 0.14, directionalCandle: 0.1 }],
  ['low_drawdown_quality', 'Prioritizes low MAE-style setup quality.', { failedBreakRisk: -0.22, vwapExtensionRisk: -0.18, chopQuality: -0.14, closeLocation: 0.14 }],
  ['options_burst_shape', 'Fresh symbols with options-worthy burst shape.', { optionBurstShape: 0.24, momentumBurst: 0.14, rangeExpansionQuality: 0.1 }, { requireOptionTag: true, targetR: 0.75 }],
  ['intraday_scalp_only', 'Forces same-day fast trades.', { intradayOnly: 0.2, timeEdge: 0.14, priceAcceleration: 0.08 }, { blockOvernight: true, maxMinutes: 390, targetR: 0.35 }],
  ['overnight_swing_burst', 'Explicit overnight/swing candidate.', { overnightOnly: 0.22, trendQuality: 0.14, relativeStrength: 0.12 }, { minMinutes: 390, targetR: 0.75 }],
  ['short_bias', 'Fresh-symbol short specialist.', { failedBreakRisk: -0.2, relativeStrength: 0.12, closeLocation: 0.08 }, { direction: 'short' }],
  ['long_bias', 'Fresh-symbol long specialist.', { relativeStrength: 0.14, trendQuality: 0.12, momentumBurst: 0.08 }, { direction: 'long' }],
  ['high_confidence_only', 'Requires high confidence/alpha quality.', { confidence: 0.24, alphaQuality: 0.18, failedBreakRisk: -0.16 }, { minConfidence: 80, minAlpha: 65 }],
  ['low_price_momentum', 'Lower-priced momentum names.', { momentumBurst: 0.16, volumeAcceleration: 0.12, optionBurstShape: 0.1 }, { maxPrice: 30 }],
  ['high_beta_growth_rotation', 'High-beta growth fresh symbols.', { relativeStrength: 0.14, momentumBurst: 0.12, cleanVolume: 0.1 }, { families: ['high-beta-growth'] }],
  ['biotech_healthcare_rotation', 'Healthcare/biotech style fresh names by symbol/family mix.', { volumeQuality: 0.12, gapReclaim: 0.08, relativeStrength: 0.12 }, { symbols: ['OPCH', 'NTLA', 'BEAM', 'BBIO', 'CNC', 'REGN', 'BSX', 'PFE', 'HUM'] }],
  ['semis_unseen_rotation', 'Fresh semiconductor/AI-adjacent names not already championed.', { trendQuality: 0.14, relativeStrength: 0.12, cleanBreakout: 0.1 }, { symbols: ['RMBS', 'AXTI', 'LITE', 'KLAC', 'SMH', 'ALAB', 'TSM', 'WDC'] }],
  ['meme_cannabis_fresh', 'Fresh high-vol meme/cannabis names.', { volumeAcceleration: 0.18, optionBurstShape: 0.12, momentumBurst: 0.12 }, { symbols: ['CGC', 'ACB', 'TLRY'] }],
  ['mega_cap_fresh', 'Fresh large/liquid symbols not in current champions.', { trendQuality: 0.14, relativeStrength: 0.1, vwapPressure: 0.1 }, { symbols: ['AMZN', 'PDD', 'LULU', 'LOW', 'TGT'] }],
  ['prior_day_break', 'Prior-day level break/reclaim behavior.', { priorDayBreakQuality: 0.22, priorDayReclaim: 0.14, rangeExpansionQuality: 0.1 }],
  ['time_edge_specialist', 'Trades only where time-of-day historically helps.', { timeEdge: 0.24, openingDriveQuality: 0.1, volumeQuality: 0.08 }],
  ['profit_target_035', 'Same backbone with tighter 0.35R target.', { confidence: 0.14, alphaQuality: 0.12 }, { targetR: 0.35 }],
  ['profit_target_050', 'Same backbone with 0.50R target.', { confidence: 0.14, alphaQuality: 0.12 }, { targetR: 0.5 }],
  ['profit_target_075', 'Same backbone with wider 0.75R target.', { optionBurstShape: 0.16, momentumBurst: 0.12 }, { targetR: 0.75 }],
  ['balanced_consensus', 'Requires broad agreement without a single dominant feature.', { confidence: 0.16, alphaQuality: 0.14, volumeQuality: 0.12, relativeStrength: 0.12, closeLocation: 0.12 }],
];

function makeChallenger([name, description, weightPatch = {}, constraints = {}]) {
  return {
    name,
    description,
    weights: { ...championBackboneWeights, ...weightPatch },
    constraints: {
      direction: 'both',
      targetR: 0.5,
      minConfidence: 0,
      minAlpha: 0,
      thresholdBias: 0,
      ...constraints,
    },
  };
}

const challengers = challengerTwists.map(makeChallenger);

function passTradeConstraints(trade, challenger) {
  const c = challenger.constraints;
  if (c.direction !== 'both' && trade.side !== c.direction) return false;
  if (c.sessions && !c.sessions.includes(trade.session)) return false;
  if (c.families && !c.families.includes(trade.family)) return false;
  if (c.symbols && !c.symbols.includes(trade.symbol)) return false;
  if (c.maxPrice && n(trade.entry, 0) > c.maxPrice) return false;
  if (n(trade.confidence, 0) < c.minConfidence) return false;
  if (n(trade.alphaQuality, 0) < c.minAlpha) return false;
  const held = minutesHeld(trade) || 0;
  if (c.blockOvernight && isOvernight(trade)) return false;
  if (c.maxMinutes && held > c.maxMinutes) return false;
  if (c.minMinutes && held < c.minMinutes) return false;
  if (c.requireOptionTag && !(trade.optionWorthy || (trade.tags || []).includes('options-worthy-burst') || n(trade.mfeR, 0) >= 1.5)) return false;
  return true;
}

function summarizeBy(trades, field, targetR = null, limit = 25) {
  const grouped = new Map();
  for (const trade of trades) {
    const key = trade[field] || 'unknown';
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(trade);
  }
  return [...grouped.entries()]
    .map(([name, rows]) => ({ name, metrics: metrics(rows, targetR) }))
    .sort((a, b) => b.metrics.netDollars - a.metrics.netDollars)
    .slice(0, limit);
}

function compactTrade(trade, index, targetR, score) {
  const pnl = modeledPnlForTarget(trade, targetR);
  return {
    index: index + 1,
    outcome: pnl > 0 ? 'win' : pnl < 0 ? 'loss' : 'flat',
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
    overnight: isOvernight(trade),
    entry: trade.entry,
    exit: trade.exit,
    pnlDollars: pnl,
    sourcePnlDollars: trade.pnlDollars,
    modeledPnlScaledTo10k: pnl * 0.10,
    mfeR: trade.mfeR,
    maeR: trade.maeR,
    confidence: trade.confidence,
    alphaQuality: trade.alphaQuality,
    phase25Score: score,
    targetR,
    tags: trade.tags || [],
    selectedRouteKey: trade.routeId,
  };
}

function scoreVariant(result) {
  const drawdownPenalty = result.metrics.netDollars > 0 ? Math.min(40, result.metrics.maxDrawdownDollars / result.metrics.netDollars * 100) : 40;
  return Number((
    Math.tanh(result.metrics.netDollars / 180000) * 30
    + result.metrics.winRate * 0.18
    + result.holdout.winRate * 0.18
    + Math.min(100, result.metrics.trades / 350 * 100) * 0.12
    + Math.min(100, Math.max(0, result.metrics.avgDollars) / 850 * 100) * 0.12
    + result.consistency.dayConsistency * 0.08
    + result.stress.winRate * 0.08
    - drawdownPenalty * 0.7
    - result.metrics.maxLossStreak * 4
  ).toFixed(4));
}

function decisionForVariant(result) {
  const reasons = [];
  if (result.metrics.trades < minTrades) reasons.push(`below trade floor ${result.metrics.trades}/${minTrades}`);
  if (result.consistency.uniqueSymbols < 8) reasons.push(`too few symbols ${result.consistency.uniqueSymbols}/8`);
  if (result.consistency.uniqueDays < 6) reasons.push(`too few unique days ${result.consistency.uniqueDays}/6`);
  if (result.holdout.winRate < 65) reasons.push(`holdout win below 65%`);
  if (result.stress.netDollars <= 0) reasons.push(`stress net not positive`);
  if (result.metrics.maxLossStreak > 5) reasons.push(`loss streak too high`);
  if (!reasons.length && result.metrics.winRate >= 80 && result.metrics.netDollars > 25000) return { decision: 'fresh_symbol_promoted', reasons: ['passes fresh-symbol win/net/holdout/stress gates'] };
  if (!reasons.length) return { decision: 'fresh_symbol_watchlist', reasons: ['valid but below promotion strength'] };
  return { decision: 'rejected', reasons };
}

function evaluate(challenger, threshold) {
  const targetR = challenger.constraints.targetR;
  const scoreByTrade = new Map();
  const selected = [];
  for (const trade of freshTrades) {
    if (!passTradeConstraints(trade, challenger)) continue;
    const score = entryScore(trade, challenger.weights);
    if (score < threshold + n(challenger.constraints.thresholdBias, 0)) continue;
    scoreByTrade.set(trade.canonicalId, score);
    selected.push(trade);
  }
  const trades = resolveConflicts(selected, scoreByTrade);
  const split = splitChronological(trades);
  const result = {
    challenger,
    threshold,
    targetR,
    trades,
    scoreByTrade,
    metrics: metrics(trades, targetR),
    train: metrics(split.train, targetR),
    test: metrics(split.test, targetR),
    holdout: metrics(split.holdout, targetR),
    stress: metrics(trades, targetR, stressPnl(targetR)),
    consistency: consistency(trades, targetR),
  };
  result.score = scoreVariant(result);
  const decision = decisionForVariant(result);
  result.decision = decision.decision;
  result.decisionReasons = decision.reasons;
  result.id = ['phase25', challenger.name, `q${Math.round(threshold * 100)}`, `t${String(targetR).replace('.', 'p')}`, challenger.constraints.direction || 'both'].join('__');
  return result;
}

function compactVariant(variant, tradeLimit = 20) {
  if (!variant) return null;
  return {
    id: variant.id,
    challenger: variant.challenger.name,
    description: variant.challenger.description,
    uniqueTwist: variant.challenger.name,
    threshold: variant.threshold,
    targetR: variant.targetR,
    constraints: variant.challenger.constraints,
    score: variant.score,
    decision: variant.decision,
    decisionReasons: variant.decisionReasons,
    metrics: variant.metrics,
    train: variant.train,
    test: variant.test,
    holdout: variant.holdout,
    stress: variant.stress,
    consistency: variant.consistency,
    topSymbols: summarizeBy(variant.trades, 'symbol', variant.targetR, 18),
    topFamilies: summarizeBy(variant.trades, 'family', variant.targetR, 12),
    topTriggers: summarizeBy(variant.trades, 'trigger', variant.targetR, 12),
    topRoutes: summarizeBy(variant.trades, 'routeId', variant.targetR, 20),
    topTrades: [...variant.trades].sort((a, b) => modeledPnlForTarget(b, variant.targetR) - modeledPnlForTarget(a, variant.targetR)).slice(0, tradeLimit).map((trade, index) => compactTrade(trade, index, variant.targetR, variant.scoreByTrade.get(trade.canonicalId))),
    tradeSample: variant.trades.slice(0, Math.min(20, tradeLimit)).map((trade, index) => compactTrade(trade, index, variant.targetR, variant.scoreByTrade.get(trade.canonicalId))),
  };
}

const thresholds = [0.26, 0.30, 0.34, 0.38, 0.42, 0.46, 0.50, 0.54, 0.58, 0.62, 0.66, 0.70];
const variants = [];
let evaluated = 0;
for (const challenger of challengers) {
  for (const threshold of thresholds) {
    if (variants.length >= maxVariants) break;
    const result = evaluate(challenger, threshold);
    evaluated += 1;
    if (result.metrics.trades >= 15) variants.push(result);
  }
}

variants.sort((a, b) => b.score - a.score || b.metrics.netDollars - a.metrics.netDollars);
const qualified = variants.filter((variant) => variant.metrics.trades >= minTrades);
qualified.sort((a, b) => b.score - a.score || b.metrics.netDollars - a.metrics.netDollars);
const promoted = qualified.filter((variant) => variant.decision === 'fresh_symbol_promoted').sort((a, b) => b.score - a.score);
const bestOverall = promoted[0] || qualified[0] || variants[0] || null;
const bestProfit = [...qualified].sort((a, b) => b.metrics.netDollars - a.metrics.netDollars || b.score - a.score)[0] || bestOverall;
const bestHighWin = [...qualified].sort((a, b) => b.metrics.winRate - a.metrics.winRate || b.metrics.netDollars - a.metrics.netDollars)[0] || bestOverall;
const bestHoldout = [...qualified].sort((a, b) => b.holdout.winRate - a.holdout.winRate || b.metrics.netDollars - a.metrics.netDollars)[0] || bestOverall;
const bestOptions = [...qualified].sort((a, b) => b.metrics.optionWorthyRate - a.metrics.optionWorthyRate || b.metrics.netDollars - a.metrics.netDollars)[0] || bestOverall;

const perChallengerBest = challengers.map((challenger) => {
  const rows = variants.filter((variant) => variant.challenger.name === challenger.name);
  rows.sort((a, b) => b.score - a.score || b.metrics.netDollars - a.metrics.netDollars);
  return compactVariant(rows[0], 6);
}).filter(Boolean);

const runId = `phase25-${new Date().toISOString().replace(/[:.]/g, '-')}`;
const output = {
  updatedAt: new Date().toISOString(),
  runId,
  phase: 'Phase25 Fresh Symbol Tournament',
  goal: 'Test the current champion backbone on entirely fresh symbols/trades excluded from Phase22/Phase23/Phase24 champion ledgers, using 30 challengers with one unique improvement each.',
  safety: {
    paperOnly: true,
    noBrokerOrders: true,
  },
  config: {
    excludeMode,
    maxVariants,
    minTrades,
    evaluated,
    kept: variants.length,
    qualified: qualified.length,
    challengerCount: challengers.length,
    freshSymbols: freshSymbols.size,
    freshTrades: freshTrades.length,
    excludedSymbols: excludeSymbols.size,
    stressCostDollars,
    stressPct,
  },
  excludedSymbols: [...excludeSymbols].sort(),
  freshSymbolLeaderboard: symbolStats.slice(0, 80),
  lowSampleWatchlist: variants
    .filter((variant) => variant.metrics.trades < minTrades)
    .slice(0, 40)
    .map((variant) => compactVariant(variant, 5)),
  categoryChampions: {
    bestOverall: compactVariant(bestOverall, 12),
    bestProfit: compactVariant(bestProfit, 12),
    bestHighWin: compactVariant(bestHighWin, 12),
    bestHoldout: compactVariant(bestHoldout, 12),
    bestOptions: compactVariant(bestOptions, 12),
  },
  perChallengerBest,
  promoted: promoted.slice(0, 30).map((variant) => compactVariant(variant, 8)),
  rankedVariants: qualified.slice(0, 80).map((variant) => compactVariant(variant, 5)),
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
  bestHoldout,
  bestOptions,
  ...Object.fromEntries(promoted.slice(0, 10).map((variant, index) => [`promoted${index + 1}`, variant])),
};
for (const [category, variant] of Object.entries(ledgerCategories)) {
  if (!variant) continue;
  ledger.categoryMap[category] = variant.id;
  if (!ledger.ledgers[variant.id]) {
    ledger.ledgers[variant.id] = {
      id: variant.id,
      categories: [],
      challenger: variant.challenger.name,
      description: variant.challenger.description,
      decision: variant.decision,
      decisionReasons: variant.decisionReasons,
      threshold: variant.threshold,
      targetR: variant.targetR,
      metrics: variant.metrics,
      holdout: variant.holdout,
      stress: variant.stress,
      consistency: variant.consistency,
      trades: variant.trades.map((trade, index) => compactTrade(trade, index, variant.targetR, variant.scoreByTrade.get(trade.canonicalId))),
    };
  }
  ledger.ledgers[variant.id].categories.push(category);
}

writeJson(join(paths.models, 'current-phase25-fresh-symbol-tournament.json'), output);
writeJson(join(paths.reports, 'phase25-fresh-symbol-tournament-report.json'), output);
writeJson(join(paths.reports, 'phase25-fresh-symbol-trade-ledgers.json'), ledger);
writeJson(join(paths.dashboardData, 'phase25-fresh-symbol-tournament.json'), output);
writeJson(join(paths.dashboardData, 'phase25-fresh-symbol-trade-ledgers.json'), ledger);
writeJson(join(paths.generated, 'phase25_fresh_symbol_export.json'), {
  updatedAt: output.updatedAt,
  runId,
  bestOverall: output.categoryChampions.bestOverall,
  bestProfit: output.categoryChampions.bestProfit,
  bestHighWin: output.categoryChampions.bestHighWin,
  freshSymbols: output.freshSymbolLeaderboard.slice(0, 40).map((row) => row.symbol).join(','),
});

console.log('Phase25 Fresh Symbol Tournament complete');
console.log(`Fresh symbols=${freshSymbols.size} freshTrades=${freshTrades.length} excludedSymbols=${excludeSymbols.size}`);
console.log(`Challengers=${challengers.length} evaluated=${evaluated} kept=${variants.length} promoted=${promoted.length}`);
if (bestOverall) console.log(`Best=${bestOverall.id} trades=${bestOverall.metrics.trades} win=${bestOverall.metrics.winRate.toFixed(2)}% net=$${bestOverall.metrics.netDollars.toFixed(0)} holdout=${bestOverall.holdout.winRate.toFixed(2)}% stress=$${bestOverall.stress.netDollars.toFixed(0)}`);
