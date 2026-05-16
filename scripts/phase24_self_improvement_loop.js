#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

const paths = {
  config: join(root, 'config', 'self_improvement', 'phase24_challenger_space.json'),
  fullTrades: join(root, 'optimization-results', 'canonical', 'canonical-trades.full.jsonl'),
  phase22: join(root, 'models', 'champions', 'current-phase22-deep-specialist-tournament.json'),
  phase23: join(root, 'models', 'champions', 'current-phase23-intelligence-specialist.json'),
  phase22Ledgers: join(root, 'apps', 'dashboard', 'public', 'data', 'phase22-trade-ledgers.json'),
  phase23Ledgers: join(root, 'apps', 'dashboard', 'public', 'data', 'phase23-intelligence-trade-ledgers.json'),
  models: join(root, 'models', 'self-improvement'),
  reports: join(root, 'reports', 'self-improvement'),
  dashboardData: join(root, 'apps', 'dashboard', 'public', 'data'),
  generated: join(root, 'generated'),
};

for (const path of [paths.models, paths.reports, paths.dashboardData, paths.generated]) mkdirSync(path, { recursive: true });

const args = new Map(process.argv.slice(2).map((arg) => {
  const [key, value = 'true'] = arg.replace(/^--/, '').split('=');
  return [key, value];
}));

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

const config = readJson(paths.config);
if (!config) throw new Error(`Missing Phase24 config: ${paths.config}`);

const iterations = Number(args.get('iterations') || config.defaultIterations || 3);
const maxVariants = Number(args.get('max-variants') || config.defaultMaxVariants || 20000);
const maxInitialConfigs = Number(args.get('max-initial-configs') || 14000);
const stressCostDollars = Number(args.get('stress-cost-dollars') || 24);
const stressPct = Number(args.get('stress-pct') || 0.02);

const phase22 = readJson(paths.phase22, {});
const phase23 = readJson(paths.phase23, {});
const phase22Ledgers = readJson(paths.phase22Ledgers, { categoryMap: {}, ledgers: {} });
const phase23Ledgers = readJson(paths.phase23Ledgers, { categoryMap: {}, ledgers: {} });
const allTrades = readJsonl(paths.fullTrades);
if (!allTrades.length) throw new Error('Missing full canonical trades. Run Phase21 locally with FUSION_WRITE_FULL_CANONICAL=true.');

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
    optionWorthyRate: trades.length ? trades.filter((trade) => trade.optionWorthy || n(trade.mfeR, 0) >= 1.5 || (trade.tags || []).includes('options-worthy-burst')).length / trades.length * 100 : 0,
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
  if (feature === 'overextensionGuard') return 1 - clamp01(trade.features?.vwapExtensionRisk);
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

function compactTrade(trade, index, targetR = null, phase24Score = null) {
  const pnl = targetR ? modeledPnlForTarget(trade, targetR) : n(trade.pnlDollars, 0);
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
    targetR: targetR || trade.targetR,
    optionWorthy: Boolean(trade.optionWorthy || (trade.tags || []).includes('options-worthy-burst') || n(trade.mfeR, 0) >= 1.5),
    phase24Score,
    tags: trade.tags || [],
    selectedRouteKey: trade.routeId,
  };
}

function compactVariant(variant, options = {}) {
  if (!variant) return null;
  const topLimit = options.topLimit ?? 20;
  const tradeLimit = options.tradeLimit ?? 25;
  const targetR = variant.config.targetR;
  return {
    id: variant.id,
    iteration: variant.iteration,
    profile: variant.config.profile.name,
    description: variant.config.profile.description,
    poolId: variant.config.pool.id,
    poolLabel: variant.config.pool.label,
    poolKind: variant.config.pool.kind,
    direction: variant.config.direction,
    sessionGroup: variant.config.sessionGroup,
    familyGroup: variant.config.familyGroup,
    threshold: variant.config.threshold,
    minConfidence: variant.config.minConfidence,
    minAlphaQuality: variant.config.minAlphaQuality,
    targetR,
    score: variant.score,
    decision: variant.decision,
    decisionReasons: variant.decisionReasons,
    promotionClass: variant.promotionClass,
    metrics: variant.metrics,
    train: variant.train,
    test: variant.test,
    holdout: variant.holdout,
    stress: variant.stress,
    consistency: variant.consistency,
    topSymbols: summarizeBy(variant.trades, 'symbol', targetR, topLimit),
    topFamilies: summarizeBy(variant.trades, 'family', targetR, 12),
    topTriggers: summarizeBy(variant.trades, 'trigger', targetR, 12),
    topRoutes: summarizeBy(variant.trades, 'routeId', targetR, topLimit),
    topTrades: [...variant.trades].sort((a, b) => modeledPnlForTarget(b, targetR) - modeledPnlForTarget(a, targetR)).slice(0, tradeLimit).map((trade, index) => compactTrade(trade, index, targetR, variant.scoreByTrade.get(trade.canonicalId))),
    tradeSample: variant.trades.slice(0, Math.min(20, tradeLimit)).map((trade, index) => compactTrade(trade, index, targetR, variant.scoreByTrade.get(trade.canonicalId))),
  };
}

function optionEstimateForTrade(trade, optionConfig) {
  const side = trade.side === 'short' ? 'put' : 'call';
  const entry = Math.max(0.01, n(trade.entry, 0));
  const exit = Math.max(0.01, n(trade.exit, entry));
  const dtes = optionConfig.dteCandidates || [0, 1, 3, 7, 14];
  const otms = optionConfig.otmPctCandidates || [0, 0.01, 0.02, 0.05];
  const heldDays = Math.max(0, (minutesHeld(trade) || 0) / 1440);
  const targetR = Math.max(0.1, n(trade.targetR, 0.5));
  const riskMove = Math.abs(exit - entry) / targetR;
  const oracleUnderlying = side === 'call'
    ? Math.max(exit, entry + riskMove * Math.max(n(trade.mfeR, 0), targetR))
    : Math.min(exit, entry - riskMove * Math.max(n(trade.mfeR, 0), targetR));
  const features = trade.features || {};
  const volGuess = clamp(0.35 + 0.65 * clamp01(features.atrExpansion) + 0.35 * clamp01(features.optionBurstShape), 0.35, 1.6);

  function premium(underlying, strike, dte) {
    const time = Math.sqrt(Math.max(1, dte + 1) / 365);
    const moneyness = Math.abs(strike / underlying - 1);
    const intrinsic = side === 'call' ? Math.max(0, underlying - strike) : Math.max(0, strike - underlying);
    const extrinsic = underlying * volGuess * time * 0.085 * Math.exp(-moneyness * 8);
    return Math.max(0.05, intrinsic + extrinsic);
  }

  let best = null;
  for (const dte of dtes) {
    if (dte + 0.05 < heldDays) continue;
    for (const otm of otms) {
      const strike = side === 'call' ? entry * (1 + otm) : entry * (1 - otm);
      const entryPremium = premium(entry, strike, dte);
      const exitPremium = premium(exit, strike, Math.max(0, dte - heldDays));
      const oracleExitPremium = premium(oracleUnderlying, strike, Math.max(0, dte - heldDays));
      const contracts10k = Math.floor(10000 / (entryPremium * 100));
      const profit10k = contracts10k * (exitPremium - entryPremium) * 100;
      const oracleProfit10k = contracts10k * (oracleExitPremium - entryPremium) * 100;
      const candidate = {
        dataConfidence: 'Estimated',
        side,
        dte,
        strike: Number(strike.toFixed(2)),
        entryPremium: Number(entryPremium.toFixed(2)),
        exitPremium: Number(exitPremium.toFixed(2)),
        oracleExitPremium: Number(oracleExitPremium.toFixed(2)),
        contractsOn10k: contracts10k,
        roiPct: entryPremium > 0 ? (exitPremium - entryPremium) / entryPremium * 100 : 0,
        profitOn10k: profit10k,
        oracleRoiPct: entryPremium > 0 ? (oracleExitPremium - entryPremium) / entryPremium * 100 : 0,
        oracleProfitOn10k: oracleProfit10k,
        warning: 'Estimated from underlying move; not historical bid/ask option-chain data.',
      };
      if (!best || candidate.oracleProfitOn10k > best.oracleProfitOn10k) best = candidate;
    }
  }
  return best;
}

const tradeByCanonicalId = new Map(allTrades.map((trade) => [trade.canonicalId, trade]));

function idsFromLedger(payload, category) {
  const id = payload.categoryMap?.[category];
  const ledger = id ? payload.ledgers?.[id] : null;
  return new Set((ledger?.trades || []).map((trade) => trade.canonicalId).filter(Boolean));
}

function tradesFromIds(ids) {
  return [...ids].map((id) => tradeByCanonicalId.get(id)).filter(Boolean);
}

function buildPools() {
  const pools = [];
  const addPool = (id, label, kind, trades, extra = {}) => {
    const unique = new Map();
    for (const trade of trades) if (trade?.canonicalId && !unique.has(trade.canonicalId)) unique.set(trade.canonicalId, trade);
    const rows = [...unique.values()];
    if (rows.length >= 30) pools.push({ id, label, kind, trades: rows, ...extra });
  };

  for (const [category] of Object.entries(phase22Ledgers.categoryMap || {})) {
    addPool(`phase22:${category}`, `Phase22 ${category}`, 'ledger', tradesFromIds(idsFromLedger(phase22Ledgers, category)), { sourcePhase: 'phase22', category });
  }
  for (const [category] of Object.entries(phase23Ledgers.categoryMap || {})) {
    addPool(`phase23:${category}`, `Phase23 ${category}`, 'ledger', tradesFromIds(idsFromLedger(phase23Ledgers, category)), { sourcePhase: 'phase23', category });
  }

  const fusionDefinitions = [
    ['fusion:profit_plus_phase23', 'Profit Max + Phase23 overlays', ['phase22:profitMax', 'phase23:balanced', 'phase23:highWinGuarded']],
    ['fusion:highwin_plus_elite', 'High Win + Elite Precision', ['phase22:mainMinimum150', 'phase22:highWin150', 'phase23:elitePrecision']],
    ['fusion:all_champions', 'All current champion ledgers', ['phase22:profitMax', 'phase22:mainMinimum150', 'phase23:balanced', 'phase23:highWinGuarded', 'phase23:elitePrecision']],
  ];
  const poolById = new Map(pools.map((pool) => [pool.id, pool]));
  for (const [id, label, members] of fusionDefinitions) {
    addPool(id, label, 'fusion', members.flatMap((member) => poolById.get(member)?.trades || []), { members });
  }

  addPool('universe:all', 'Full canonical universe', 'universe', allTrades);
  for (const [familyGroup, families] of Object.entries(config.familyGroups || {})) {
    if (!families.length || familyGroup === 'all') continue;
    addPool(`family:${familyGroup}`, `Family ${familyGroup}`, 'family', allTrades.filter((trade) => families.includes(trade.family)), { familyGroup });
  }

  const bySymbol = new Map();
  for (const trade of allTrades) {
    if (!bySymbol.has(trade.symbol)) bySymbol.set(trade.symbol, []);
    bySymbol.get(trade.symbol).push(trade);
  }
  const symbolRows = [...bySymbol.entries()]
    .map(([symbol, rows]) => ({ symbol, rows, metrics: metrics(rows) }))
    .filter((row) => row.metrics.trades >= (config.symbolExpansion?.minimumSymbolTrades || 35))
    .sort((a, b) => b.metrics.netDollars - a.metrics.netDollars)
    .slice(0, config.symbolExpansion?.topSymbolCount || 120);
  const batchSize = config.symbolExpansion?.batchSize || 12;
  for (let i = 0; i < symbolRows.length; i += batchSize) {
    const batch = symbolRows.slice(i, i + batchSize);
    addPool(`symbols:top_${i + 1}_${i + batch.length}`, `Top symbols ${i + 1}-${i + batch.length}`, 'symbol_batch', batch.flatMap((row) => row.rows), { symbols: batch.map((row) => row.symbol) });
  }

  addPool('hold:intraday_only', 'Intraday-only trades', 'holding_window', allTrades.filter((trade) => !isOvernight(trade) && (minutesHeld(trade) || 0) <= 390));
  addPool('hold:overnight_only', 'Overnight/swing burst trades', 'holding_window', allTrades.filter((trade) => isOvernight(trade) || (minutesHeld(trade) || 0) > 390));
  return pools;
}

function cloneProfile(profile, patch = {}) {
  return {
    ...profile,
    name: patch.name || profile.name,
    entryWeights: { ...profile.entryWeights, ...(patch.entryWeights || {}) },
    constraints: { ...(profile.constraints || {}), ...(patch.constraints || {}) },
    mutationTag: patch.mutationTag || profile.mutationTag || 'base',
  };
}

function sessionAllowed(trade, sessionGroup) {
  const allowed = config.sessionGroups?.[sessionGroup] || [];
  return !allowed.length || allowed.includes(trade.session);
}

function familyAllowed(trade, familyGroup) {
  const allowed = config.familyGroups?.[familyGroup] || [];
  return !allowed.length || allowed.includes(trade.family);
}

function passConstraints(trade, variantConfig) {
  if (variantConfig.direction !== 'both' && trade.side !== variantConfig.direction) return false;
  if (!sessionAllowed(trade, variantConfig.sessionGroup)) return false;
  if (!familyAllowed(trade, variantConfig.familyGroup)) return false;
  if (n(trade.confidence, 0) < variantConfig.minConfidence) return false;
  if (n(trade.alphaQuality, 0) < variantConfig.minAlphaQuality) return false;
  const held = minutesHeld(trade) || 0;
  const constraints = variantConfig.profile.constraints || {};
  if (constraints.maxMinutesHeld && held > constraints.maxMinutesHeld) return false;
  if (constraints.minMinutesHeld && held < constraints.minMinutesHeld) return false;
  if (constraints.blockOvernight && isOvernight(trade)) return false;
  return true;
}

function variantId(variantConfig) {
  return [
    'phase24',
    variantConfig.profile.name,
    variantConfig.pool.id,
    `iter${variantConfig.iteration}`,
    `q${Math.round(variantConfig.threshold * 100)}`,
    `c${variantConfig.minConfidence}`,
    `a${variantConfig.minAlphaQuality}`,
    `t${String(variantConfig.targetR).replace('.', 'p')}`,
    variantConfig.direction,
    variantConfig.sessionGroup,
    variantConfig.familyGroup,
    variantConfig.profile.mutationTag || 'base',
  ].join('__').replaceAll(/[^\w|.-]+/g, '_');
}

function scoreVariant(result, profile) {
  const weights = profile.scoreWeights || {};
  const component = {
    net: Math.tanh(result.metrics.netDollars / 650000) * 100,
    stressNet: Math.tanh(result.stress.netDollars / 550000) * 100,
    win: result.metrics.winRate,
    holdoutWin: result.holdout.winRate,
    stressWin: result.stress.winRate,
    tradeCount: Math.min(100, result.metrics.trades / 1500 * 100),
    avgTrade: Math.min(100, Math.max(0, result.metrics.avgDollars) / 700 * 100),
    profitFactor: Math.min(100, result.metrics.profitFactor / 10 * 100),
    consistency: (result.consistency.dayConsistency + result.consistency.weekConsistency) / 2,
    optionWorthy: Math.min(100, result.metrics.optionWorthyRate * 6),
    avgMfe: Math.min(100, result.metrics.avgMfeR / 1.6 * 100),
    drawdownPenalty: result.metrics.netDollars > 0 ? Math.min(100, result.metrics.maxDrawdownDollars / result.metrics.netDollars * 100) : 100,
    lossStreakPenalty: Math.min(100, result.metrics.maxLossStreak * 18),
  };
  let score = 0;
  for (const [key, weight] of Object.entries(weights)) score += (component[key] || 0) * weight;
  return Number(score.toFixed(4));
}

function classifyDecision(variant, baselines) {
  const reasons = [];
  const min = config.minimums || {};
  const rules = config.promotionRules || {};
  const m = variant.metrics;
  const c = variant.consistency;
  const drawdownPct = m.netDollars > 0 ? m.maxDrawdownDollars / m.netDollars * 100 : 999;

  if (m.trades < min.specialistTrades) reasons.push(`below specialist trade floor ${m.trades}/${min.specialistTrades}`);
  if (c.uniqueDays < min.uniqueDays) reasons.push(`too few unique days ${c.uniqueDays}/${min.uniqueDays}`);
  if (c.uniqueWeeks < min.uniqueWeeks) reasons.push(`too few unique weeks ${c.uniqueWeeks}/${min.uniqueWeeks}`);
  if (variant.holdout.winRate < min.holdoutWinRate) reasons.push(`holdout win below floor ${variant.holdout.winRate.toFixed(2)}%`);
  if (variant.stress.netDollars < min.stressNetDollars) reasons.push(`stress net below floor $${variant.stress.netDollars.toFixed(0)}`);
  if (m.maxLossStreak > rules.maxAllowedLossStreak) reasons.push(`loss streak too high ${m.maxLossStreak}`);
  if (drawdownPct > rules.maxDrawdownToNetPct) reasons.push(`drawdown/net too high ${drawdownPct.toFixed(2)}%`);

  const profitBaseline = baselines.profitMax?.metrics?.netDollars || 0;
  const profitPromote = m.trades >= min.mainTrades
    && m.netDollars >= profitBaseline * (1 + (rules.mainProfitNetImprovementPct || 0) / 100)
    && variant.stress.netDollars > (baselines.profitMax?.stress?.netDollars || 0)
    && !reasons.length;

  const highWinPromote = m.trades >= (rules.highWinMinimumTrades || min.specialistTrades)
    && m.winRate >= (rules.highWinMinimumWinRate || 92)
    && variant.holdout.winRate >= (rules.highWinMinimumWinRate || 92) - 4
    && !reasons.length;

  const optionsPromote = variant.config.profile.name.includes('options')
    && m.trades >= min.specialistTrades
    && m.optionWorthyRate >= 10
    && m.netDollars > 50000
    && !reasons.length;

  if (profitPromote) return { decision: 'promote_main_profit_challenger', promotionClass: 'main_profit', reasons: ['beats Phase22 Profit Max on net and stress with enough trades'] };
  if (highWinPromote) return { decision: 'promote_specialist', promotionClass: 'high_win_specialist', reasons: ['passes high-win specialist thresholds'] };
  if (optionsPromote) return { decision: 'promote_specialist', promotionClass: 'options_worthy_specialist', reasons: ['passes options-worthy specialist thresholds'] };
  if (!reasons.length) return { decision: 'watchlist', promotionClass: 'watchlist', reasons: ['valid but does not beat current champion enough to replace it'] };
  return { decision: 'reject_or_quarantine', promotionClass: 'rejected', reasons };
}

function evaluateVariant(variantConfig, baselines) {
  const scoreByTrade = new Map();
  const scored = [];
  for (const trade of variantConfig.pool.trades) {
    if (!passConstraints(trade, variantConfig)) continue;
    const score = entryScore(trade, variantConfig.profile.entryWeights);
    if (score < variantConfig.threshold) continue;
    scoreByTrade.set(trade.canonicalId, score);
    scored.push(trade);
  }
  const trades = resolveConflicts(scored, scoreByTrade);
  const split = splitChronological(trades);
  const targetR = variantConfig.targetR;
  const result = {
    trades,
    scoreByTrade,
    metrics: metrics(trades, targetR),
    train: metrics(split.train, targetR),
    test: metrics(split.test, targetR),
    holdout: metrics(split.holdout, targetR),
    stress: metrics(trades, targetR, stressPnl(targetR)),
    consistency: consistency(trades, targetR),
  };
  result.score = scoreVariant(result, variantConfig.profile);
  const decision = classifyDecision({ ...result, config: variantConfig }, baselines);
  result.decision = decision.decision;
  result.decisionReasons = decision.reasons;
  result.promotionClass = decision.promotionClass;
  return result;
}

function generateInitialConfigs(pools) {
  const configs = [];
  const directions = config.directions || ['both'];
  const sessionGroups = Object.keys(config.sessionGroups || { all: [] });
  const familyGroups = Object.keys(config.familyGroups || { all: [] });
  outer:
  for (const pool of pools) {
    const poolFamilyGroups = pool.kind === 'family' ? ['all'] : familyGroups;
    const poolSessionGroups = pool.kind === 'ledger' || pool.kind === 'fusion' ? ['all', 'morning', 'open_only', 'afternoon_power'] : sessionGroups;
    for (const profile of config.profiles.map((item) => cloneProfile(item))) {
      for (const threshold of config.thresholdGrid || [0.5]) {
        for (const minConfidence of (config.confidenceGrid || [0]).filter((_, index) => index % 2 === 0 || threshold >= 0.62)) {
          for (const minAlphaQuality of (config.alphaGrid || [0]).filter((_, index) => index % 2 === 0 || minConfidence >= 80)) {
            for (const targetR of config.targetRGrid || [0.5]) {
              for (const direction of directions) {
                for (const sessionGroup of poolSessionGroups) {
                  for (const familyGroup of poolFamilyGroups) {
                    configs.push({ pool, profile, threshold, minConfidence, minAlphaQuality, targetR, direction, sessionGroup, familyGroup, iteration: 1 });
                    if (configs.length >= maxInitialConfigs) break outer;
                  }
                }
              }
            }
          }
        }
      }
    }
  }
  return configs;
}

function mutateConfig(seed, iteration) {
  const mutations = [];
  const deltaWeights = [
    ['relativeStrength', 0.03],
    ['failedBreakRisk', -0.03],
    ['vwapExtensionRisk', -0.03],
    ['optionBurstShape', 0.03],
    ['volumeQuality', 0.03],
    ['closeLocation', 0.03],
    ['momentumBurst', 0.03],
  ];
  const thresholds = [-0.04, -0.02, 0.02, 0.04].map((delta) => clamp(seed.config.threshold + delta, 0.25, 0.9));
  for (const threshold of thresholds) {
    mutations.push({
      ...seed.config,
      iteration,
      threshold,
      minConfidence: clamp(seed.config.minConfidence + (threshold > seed.config.threshold ? 5 : -5), 0, 95),
      minAlphaQuality: clamp(seed.config.minAlphaQuality + (threshold > seed.config.threshold ? 5 : -5), 0, 95),
      profile: cloneProfile(seed.config.profile, { name: `${seed.config.profile.name}_mut${iteration}`, mutationTag: `threshold_${Math.round(threshold * 100)}` }),
    });
  }
  for (const [feature, delta] of deltaWeights) {
    const nextWeight = n(seed.config.profile.entryWeights?.[feature], 0) + delta;
    mutations.push({
      ...seed.config,
      iteration,
      profile: cloneProfile(seed.config.profile, {
        name: `${seed.config.profile.name}_mut${iteration}`,
        mutationTag: `${feature}_${delta > 0 ? 'up' : 'down'}`,
        entryWeights: { [feature]: Number(nextWeight.toFixed(4)) },
      }),
    });
  }
  for (const targetR of config.targetRGrid || [seed.config.targetR]) {
    mutations.push({
      ...seed.config,
      iteration,
      targetR,
      profile: cloneProfile(seed.config.profile, { name: `${seed.config.profile.name}_mut${iteration}`, mutationTag: `target_${targetR}` }),
    });
  }
  return mutations;
}

function stableVariantKey(variantConfig) {
  return variantId(variantConfig);
}

const baselines = {
  profitMax: phase22.categoryChampions?.profitMax,
  highWin: phase22.categoryChampions?.mainMinimum150,
  phase23: phase23.recommendedChampion,
};

const pools = buildPools();
let configQueue = generateInitialConfigs(pools);
const variants = [];
const seen = new Set();
let evaluated = 0;

for (let iteration = 1; iteration <= iterations; iteration += 1) {
  const current = iteration === 1 ? configQueue : configQueue.splice(0, Math.max(2000, Math.floor(maxInitialConfigs / 3)));
  for (const variantConfig of current) {
    const key = stableVariantKey(variantConfig);
    if (seen.has(key)) continue;
    seen.add(key);
    const result = evaluateVariant(variantConfig, baselines);
    evaluated += 1;
    if (result.metrics.trades >= 30) {
      variants.push({
        id: variantId(variantConfig),
        iteration,
        config: variantConfig,
        ...result,
      });
    }
    if (variants.length >= maxVariants) break;
  }
  variants.sort((a, b) => b.score - a.score || b.metrics.netDollars - a.metrics.netDollars);
  if (iteration < iterations) {
    configQueue = variants.slice(0, 80).flatMap((variant) => mutateConfig(variant, iteration + 1));
  }
  if (variants.length >= maxVariants) break;
}

variants.sort((a, b) => b.score - a.score || b.metrics.netDollars - a.metrics.netDollars);

const qualified = variants.filter((variant) => variant.metrics.trades >= (config.minimums?.specialistTrades || 150));
const bestProfit = [...qualified].sort((a, b) => b.metrics.netDollars - a.metrics.netDollars || b.score - a.score)[0] || null;
const bestHighWin = [...qualified].sort((a, b) => b.metrics.winRate - a.metrics.winRate || b.metrics.netDollars - a.metrics.netDollars)[0] || null;
const bestBalanced = qualified[0] || variants[0] || null;
const bestOptions = [...qualified].sort((a, b) => b.metrics.optionWorthyRate - a.metrics.optionWorthyRate || b.metrics.netDollars - a.metrics.netDollars)[0] || null;
const bestIntraday = [...qualified].filter((variant) => variant.config.profile.name.includes('intraday') || variant.config.pool.id.includes('intraday')).sort((a, b) => b.score - a.score)[0] || null;
const bestOvernight = [...qualified].filter((variant) => variant.config.profile.name.includes('overnight') || variant.config.pool.id.includes('overnight')).sort((a, b) => b.metrics.netDollars - a.metrics.netDollars)[0] || null;
const promoted = qualified.filter((variant) => variant.decision.startsWith('promote')).sort((a, b) => b.score - a.score);
const watchlist = qualified.filter((variant) => variant.decision === 'watchlist').slice(0, 25);
const rejected = variants.filter((variant) => variant.decision === 'reject_or_quarantine').slice(0, 25);

const optionsSource = bestOptions || bestProfit || bestBalanced;
const optionsWorthyTrades = optionsSource
  ? [...optionsSource.trades]
    .filter((trade) => modeledPnlForTarget(trade, optionsSource.config.targetR) > 0)
    .sort((a, b) => {
      const ao = optionEstimateForTrade(a, config.optionsProbe || {});
      const bo = optionEstimateForTrade(b, config.optionsProbe || {});
      return bo.oracleProfitOn10k - ao.oracleProfitOn10k;
    })
    .slice(0, 40)
    .map((trade, index) => ({
      ...compactTrade(trade, index, optionsSource.config.targetR, optionsSource.scoreByTrade.get(trade.canonicalId)),
      estimatedBestOption: optionEstimateForTrade(trade, config.optionsProbe || {}),
    }))
  : [];

const runId = `phase24-${new Date().toISOString().replace(/[:.]/g, '-')}`;
const output = {
  updatedAt: new Date().toISOString(),
  runId,
  phase: 'Phase24 Self-Improvement Loop',
  goal: 'Repeatable generate → backtest → score → promote/reject → export loop for profit, high-win, options-worthy, intraday, and overnight specialists.',
  safety: {
    paperOnly: true,
    noBrokerOrders: true,
    note: 'This repository does not place real trades.',
  },
  config: {
    iterations,
    maxVariants,
    maxInitialConfigs,
    evaluated,
    kept: variants.length,
    pools: pools.length,
    stressCostDollars,
    stressPct,
    capitalBase: config.capitalBase,
  },
  baselines: {
    profitMax: baselines.profitMax,
    highWin: baselines.highWin,
    phase23: baselines.phase23,
  },
  categoryChampions: {
    bestBalanced: compactVariant(bestBalanced, { topLimit: 16, tradeLimit: 10 }),
    bestProfit: compactVariant(bestProfit, { topLimit: 16, tradeLimit: 10 }),
    bestHighWin: compactVariant(bestHighWin, { topLimit: 16, tradeLimit: 10 }),
    bestOptions: compactVariant(bestOptions, { topLimit: 16, tradeLimit: 10 }),
    bestIntraday: compactVariant(bestIntraday, { topLimit: 16, tradeLimit: 10 }),
    bestOvernight: compactVariant(bestOvernight, { topLimit: 16, tradeLimit: 10 }),
  },
  promoted: promoted.slice(0, 20).map((variant) => compactVariant(variant, { topLimit: 10, tradeLimit: 5 })),
  watchlist: watchlist.map((variant) => compactVariant(variant, { topLimit: 8, tradeLimit: 3 })),
  rejected: rejected.map((variant) => compactVariant(variant, { topLimit: 5, tradeLimit: 2 })),
  rankedVariants: variants.slice(0, 80).map((variant) => compactVariant(variant, { topLimit: 8, tradeLimit: 3 })),
  optionsWorthyTrades,
  improvementLoop: [
    'generate challenger variants from champion ledgers, fusions, families, symbols, intraday, and overnight pools',
    'score entries using only entry-time features',
    'model exits/targets with MFE/MAE after selection',
    'stress test with extra spread/slippage cost',
    'compare against current baselines',
    'promote, watchlist, or quarantine',
    'export exact ledgers, dashboard data, and Pine metadata',
  ],
};

const ledgerCategories = {
  bestBalanced,
  bestProfit,
  bestHighWin,
  bestOptions,
  bestIntraday,
  bestOvernight,
  ...Object.fromEntries(promoted.slice(0, 6).map((variant, index) => [`promoted${index + 1}`, variant])),
};

const ledger = {
  updatedAt: output.updatedAt,
  runId,
  ledgers: {},
  categoryMap: {},
};
for (const [category, variant] of Object.entries(ledgerCategories)) {
  if (!variant) continue;
  ledger.categoryMap[category] = variant.id;
  if (!ledger.ledgers[variant.id]) {
    ledger.ledgers[variant.id] = {
      id: variant.id,
      categories: [],
      profile: variant.config.profile.name,
      poolId: variant.config.pool.id,
      poolLabel: variant.config.pool.label,
      decision: variant.decision,
      decisionReasons: variant.decisionReasons,
      metrics: variant.metrics,
      holdout: variant.holdout,
      stress: variant.stress,
      consistency: variant.consistency,
      trades: variant.trades.map((trade, index) => compactTrade(trade, index, variant.config.targetR, variant.scoreByTrade.get(trade.canonicalId))),
    };
  }
  ledger.ledgers[variant.id].categories.push(category);
}

const registryPath = join(paths.models, 'phase24-run-registry.json');
const previousRegistry = readJson(registryPath, { runs: [] });
const registry = {
  updatedAt: output.updatedAt,
  runs: [
    {
      runId,
      updatedAt: output.updatedAt,
      evaluated,
      kept: variants.length,
      bestProfit: output.categoryChampions.bestProfit,
      bestHighWin: output.categoryChampions.bestHighWin,
      promotedCount: promoted.length,
    },
    ...(previousRegistry.runs || []),
  ].slice(0, 50),
};

writeJson(join(paths.models, 'current-phase24-self-improvement.json'), output);
writeJson(registryPath, registry);
writeJson(join(paths.reports, 'phase24-self-improvement-report.json'), output);
writeJson(join(paths.reports, 'phase24-exact-trade-ledgers.json'), ledger);
writeJson(join(paths.dashboardData, 'phase24-self-improvement.json'), output);
writeJson(join(paths.dashboardData, 'phase24-trade-ledgers.json'), ledger);
writeJson(join(paths.generated, 'phase24_self_improvement_export.json'), {
  updatedAt: output.updatedAt,
  runId,
  bestProfit: output.categoryChampions.bestProfit,
  bestHighWin: output.categoryChampions.bestHighWin,
  bestOptions: output.categoryChampions.bestOptions,
  promoted: output.promoted,
  pineInputs: {
    modelId: 'fusionv3-phase24-self-improvement',
    selectableMode: 'Phase24 Self-Improving Champion',
    status: promoted.length ? 'Backtest Promoted' : 'Backtest Only',
    triggerMode: 'Hybrid Consensus',
    whitelist: output.categoryChampions.bestProfit?.topSymbols?.slice(0, 40).map((item) => item.name).join(',') || '',
    backtestWr: output.categoryChampions.bestProfit?.metrics?.winRate || 0,
    holdoutWr: output.categoryChampions.bestProfit?.holdout?.winRate || 0,
    netDollars: output.categoryChampions.bestProfit?.metrics?.netDollars || 0,
  },
});

console.log('Phase24 Self-Improvement Loop complete');
console.log(`Trades loaded=${allTrades.length} pools=${pools.length} evaluated=${evaluated} kept=${variants.length} promoted=${promoted.length}`);
if (bestProfit) console.log(`Best profit=${bestProfit.id} trades=${bestProfit.metrics.trades} win=${bestProfit.metrics.winRate.toFixed(2)}% net=$${bestProfit.metrics.netDollars.toFixed(0)} holdout=${bestProfit.holdout.winRate.toFixed(2)}% stress=$${bestProfit.stress.netDollars.toFixed(0)}`);
if (bestHighWin) console.log(`Best high-win=${bestHighWin.id} trades=${bestHighWin.metrics.trades} win=${bestHighWin.metrics.winRate.toFixed(2)}% net=$${bestHighWin.metrics.netDollars.toFixed(0)}`);
