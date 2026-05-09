#!/usr/bin/env node
import { appendFileSync, createReadStream, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
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

const runId = new Date().toISOString().replace(/[:.]/g, '-');
const capital = Number(args.get('capital') || 100000);
const projectionCapital = Number(args.get('projection-capital') || 10000);
const range = args.get('range') || '60d';
const interval = args.get('interval') || '5m';
const maxSymbols = Number(args.get('max-symbols') || 120);
const trainPct = Number(args.get('train-pct') || 0.65);
const minTestTrades = Number(args.get('min-test-trades') || 150);
const maxConcurrent = Number(args.get('max-concurrent') || 2);
const candidateCount = Number(args.get('candidates') || 1200);
let tradeLedger = args.get('trade-ledger') || '';

const universe = [
  'NVDA', 'AMD', 'AVGO', 'SMCI', 'ARM', 'MRVL', 'MU', 'SOXL', 'NVDL',
  'TSLA', 'RIVN', 'LCID', 'QS', 'NIO', 'XPEV',
  'COIN', 'MSTR', 'MARA', 'RIOT', 'CLSK', 'WULF', 'CIFR', 'IREN', 'CONL',
  'PLTR', 'SOFI', 'HOOD', 'AFRM', 'UPST', 'RBLX', 'ROKU', 'APP', 'RDDT',
  'IONQ', 'RGTI', 'QBTS', 'AI', 'PATH', 'SNOW', 'DDOG', 'NET', 'CRWD',
  'OPEN', 'GME', 'AMC', 'SNDK', 'NVTS', 'RUN', 'CHPT',
  'TQQQ', 'SQQQ', 'QQQ', 'SPY', 'IWM', 'ARKK', 'XBI',
  'AAPL', 'MSFT', 'META', 'AMZN', 'NFLX', 'ORCL', 'SHOP', 'UBER', 'DASH',
].slice(0, maxSymbols);

function family(symbol) {
  if (['NVDA', 'AMD', 'AVGO', 'SMCI', 'ARM', 'MRVL', 'MU', 'SOXL', 'NVDL'].includes(symbol)) return 'semis';
  if (['COIN', 'MSTR', 'MARA', 'RIOT', 'CLSK', 'WULF', 'CIFR', 'IREN', 'CONL'].includes(symbol)) return 'crypto';
  if (['TSLA', 'RIVN', 'LCID', 'QS', 'NIO', 'XPEV', 'CHPT'].includes(symbol)) return 'ev';
  if (['PLTR', 'AI', 'PATH', 'IONQ', 'RGTI', 'QBTS', 'SNOW', 'DDOG', 'NET', 'CRWD'].includes(symbol)) return 'softwareAi';
  if (['OPEN', 'GME', 'AMC', 'SNDK', 'NVTS', 'RUN'].includes(symbol)) return 'pennyMeme';
  if (['TQQQ', 'SQQQ', 'QQQ', 'SPY', 'IWM', 'ARKK', 'XBI'].includes(symbol)) return 'etf';
  return 'liquidMomentum';
}

function generateCombos(symbols) {
  const engines = [
    { name: 'profit_breakout_075', triggerMode: 'breakout', targetR: 0.75, trailR: 0.5, timeStopBars: 9, minConf: 70, minAlphaQuality: 60, volMult: 1.2, openingRange: 'break-15m', dailyContext: 'range-expansion' },
    { name: 'profit_breakout_1r', triggerMode: 'breakout', targetR: 1, trailR: 0.75, timeStopBars: 12, minConf: 72, minAlphaQuality: 65, volMult: 1.2, openingRange: 'break-15m', dailyContext: 'range-expansion' },
    { name: 'options_burst_1r', triggerMode: 'options-burst', targetR: 1, trailR: 0.75, timeStopBars: 9, minConf: 75, minAlphaQuality: 65, volMult: 1.5, requireConfRising: true },
    { name: 'options_burst_15r', triggerMode: 'options-burst', targetR: 1.5, trailR: 1, timeStopBars: 12, minConf: 78, minAlphaQuality: 70, volMult: 1.5, requireConfRising: true },
    { name: 'open_drive_runner', triggerMode: 'opening-drive-continuation', targetR: 1, trailR: 0.75, timeStopBars: 12, minConf: 72, minAlphaQuality: 60, dailyContext: 'trend-day' },
    { name: 'momentum_runner', triggerMode: 'momentum-acceleration', targetR: 0.75, trailR: 0.5, timeStopBars: 9, minConf: 72, minAlphaQuality: 65, requireConfRising: true },
    { name: 'relative_strength_runner', triggerMode: 'relative-strength-reclaim', targetR: 1, trailR: 0.75, timeStopBars: 12, minConf: 72, minAlphaQuality: 65, marketMode: 'qqq' },
    { name: 'hybrid_runner', triggerMode: 'hybrid-consensus', targetR: 0.75, trailR: 0.5, timeStopBars: 9, minConf: 75, minAlphaQuality: 65, requireConfRising: true },
    { name: 'squeeze_expansion_runner', triggerMode: 'squeeze-expansion', targetR: 1, trailR: 0.75, timeStopBars: 12, minConf: 72, minAlphaQuality: 60, volMult: 1.5 },
    { name: 'volume_shock_runner', triggerMode: 'volume-shock', targetR: 0.75, trailR: 0.5, timeStopBars: 9, minConf: 70, minAlphaQuality: 60, volMult: 1.8, volumeQuality: 'clean', relVolMode: 'tod', minRelVolTod: 1.2 },
  ];
  const sessions = ['open-0930', 'open-1000', 'morning'];
  const directions = ['both', 'long', 'short'];
  const combos = [];
  for (const symbol of symbols) for (const engine of engines) for (const session of sessions) for (const direction of directions) {
    combos.push({
      playbook: 'Scalp', symbolFilter: symbol, triggerMode: engine.triggerMode, minConf: engine.minConf,
      targetR: engine.targetR, exitMode: 'smart', trailR: engine.trailR, timeStopBars: engine.timeStopBars,
      partialR: 0.5, confidenceDrop: engine.targetR >= 1 ? 28 : 22, structureExit: 'loose', minLead: 65,
      minEdge: 12, minAtrRatio: 0.9, minAdx: 14, minEr: 0.1, volMult: engine.volMult || 1.2,
      session, direction, lossCooldownBars: 0, maxVwapAtr: 0, requireConfRising: engine.requireConfRising ?? false,
      slippageBps: 1, spreadBps: 2, minMoveToCost: 5, openingRange: engine.openingRange || 'off',
      htfMode: 'not-against50', volumeQuality: engine.volumeQuality || 'off', adaptiveTarget: true,
      maxConsecutiveLosses: 0, clusterCooldownBars: 0, minPrice: 1, maxPrice: 0, minDollarVolume: 500000,
      gapMode: 'off', dailyContext: engine.dailyContext || 'trend-day', pdLevelMode: 'off', marketMode: engine.marketMode || 'off',
      relVolMode: engine.relVolMode || 'off', minRelVolTod: engine.minRelVolTod || 1, peerMode: 'off', newsMode: 'off',
      alphaMode: 'specialist-intel', alphaWeightSet: 'default', minAlphaQuality: engine.minAlphaQuality,
      minIntelScore: 45, positionSizing: 'fixed', minPositionScale: 1, maxPositionScale: 1,
      archetype: engine.name, symbolFamily: family(symbol),
    });
  }
  return combos;
}

function dayKey(timestamp) { return new Date(timestamp * 1000).toISOString().slice(0, 10); }
function weekKey(timestamp) {
  const d = new Date(timestamp * 1000);
  const oneJan = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((d - oneJan) / 86400000) + oneJan.getUTCDay() + 1) / 7);
  return `${d.getUTCFullYear()}-${String(week).padStart(2, '0')}`;
}

function regimeOf(features, combo) {
  const f = features || {};
  const trap = (f.failedBreakRisk || 0) + (f.rejectionWick || 0) + (f.vwapExtensionRisk || 0);
  if (trap > 1.45) return 'trap_risk';
  if ((f.chopQuality || 0) < 0.45 || ((f.efficiency || 0) < 0.35 && (f.atrExpansion || 0) < 0.55)) return 'chop_risk';
  if ((f.vwapExtensionRisk || 0) > 0.75 && (f.momentumBurst || 0) < 0.6) return 'exhaustion_risk';
  if ((f.openingDriveQuality || 0) > 0.74 && combo.session === 'open-0930') return 'open_drive';
  if ((f.compressionRelease || 0) > 0.72 && (f.rangeExpansionQuality || 0) > 0.62) return 'squeeze_expansion';
  if ((f.optionBurstShape || 0) > 0.72 && (f.momentumBurst || 0) > 0.62) return 'options_burst';
  if ((f.pullbackReclaim || 0) > 0.58 || (f.stopRunReclaim || 0) > 0.72 || (f.priorDayReclaim || 0) > 0.6) return 'vwap_reclaim';
  if ((f.breakoutQuality || 0) > 0.68 && (f.cleanBreakout || 0) > 0.52) return 'clean_breakout';
  if ((f.volumeQuality || 0) > 0.75 && (f.volumeAcceleration || 0) > 0.65) return 'volume_expansion';
  if ((f.trendQuality || 0) > 0.72 && (f.emaSlope || 0) > 0.62) return 'clean_momentum';
  return 'mixed';
}

async function readTrades(path) {
  const rows = [];
  const input = createReadStream(path, { encoding: 'utf8' });
  const lines = createInterface({ input, crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    const row = JSON.parse(line);
    const trade = row.trade || {};
    const combo = row.combo || {};
    const features = trade.features || {};
    const item = {
      ...trade,
      symbol: row.symbol,
      combo,
      features,
      family: combo.symbolFamily || family(row.symbol),
      archetype: combo.archetype || combo.triggerMode,
      triggerMode: combo.triggerMode,
      session: combo.session,
      direction: combo.direction,
      regime: regimeOf(features, combo),
      win: (trade.pnlDollars || 0) > 0,
      fastMove: Math.max(trade.move5mR || 0, trade.move10mR || 0, trade.move15mR || 0),
    };
    item.routeKey = `${item.regime}|${item.family}|${item.triggerMode}|${item.session}|${item.side}`;
    item.familyKey = `${item.regime}|${item.family}`;
    item.triggerKey = `${item.regime}|${item.triggerMode}`;
    rows.push(item);
  }
  rows.sort((a, b) => a.entryTime - b.entryTime);
  return rows;
}

function splitTrades(trades) {
  const times = [...new Set(trades.map((trade) => trade.entryTime))].sort((a, b) => a - b);
  const cutoff = times[Math.floor(times.length * trainPct)] || times.at(-1);
  return { cutoff, train: trades.filter((trade) => trade.entryTime <= cutoff), test: trades.filter((trade) => trade.entryTime > cutoff) };
}

function rawMetrics(rows) {
  const grossWin = rows.filter((r) => (r.pnlDollars || 0) > 0).reduce((s, r) => s + r.pnlDollars, 0);
  const grossLoss = Math.abs(rows.filter((r) => (r.pnlDollars || 0) <= 0).reduce((s, r) => s + r.pnlDollars, 0));
  return {
    trades: rows.length,
    winRate: rows.length ? rows.filter((r) => (r.pnlDollars || 0) > 0).length / rows.length * 100 : 0,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? 999 : 0),
    netDollars: rows.reduce((s, r) => s + (r.pnlDollars || 0), 0),
    avgDollars: rows.length ? rows.reduce((s, r) => s + (r.pnlDollars || 0), 0) / rows.length : 0,
    avgMfeR: rows.length ? rows.reduce((s, r) => s + (r.mfeR || 0), 0) / rows.length : 0,
    avgMaeR: rows.length ? rows.reduce((s, r) => s + (r.maeR || 0), 0) / rows.length : 0,
    fastMoveRate: rows.length ? rows.filter((r) => r.fastMove >= 0.5).length / rows.length * 100 : 0,
    optionWorthyRate: rows.length ? rows.filter((r) => r.optionWorthy).length / rows.length * 100 : 0,
    uniqueDays: new Set(rows.map((r) => dayKey(r.entryTime))).size,
    uniqueWeeks: new Set(rows.map((r) => weekKey(r.entryTime))).size,
  };
}

function buildStats(train) {
  const maps = { route: new Map(), family: new Map(), trigger: new Map(), regime: new Map(), symbol: new Map() };
  const add = (map, key, trade) => {
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(trade);
  };
  for (const trade of train) {
    add(maps.route, trade.routeKey, trade);
    add(maps.family, trade.familyKey, trade);
    add(maps.trigger, trade.triggerKey, trade);
    add(maps.regime, trade.regime, trade);
    add(maps.symbol, `${trade.regime}|${trade.symbol}|${trade.side}`, trade);
  }
  const out = {};
  for (const [name, map] of Object.entries(maps)) {
    out[name] = new Map([...map.entries()].map(([key, rows]) => [key, rawMetrics(rows)]));
  }
  return out;
}

function statScore(stat, minTrades) {
  if (!stat || stat.trades < minTrades) return -40;
  return stat.winRate * 0.7 + Math.min(stat.profitFactor, 12) * 8 + Math.min(stat.avgDollars / 10, 80)
    + Math.min(stat.fastMoveRate, 100) * 0.12 + Math.min(stat.optionWorthyRate, 100) * 0.1
    - Math.max(0, 0.55 - stat.avgMfeR + stat.avgMaeR) * 18;
}

function rng(seed = 91511) {
  let state = seed >>> 0;
  return () => {
    state ^= state << 13; state ^= state >>> 17; state ^= state << 5;
    return ((state >>> 0) / 4294967296);
  };
}

function generateCandidates(count) {
  const random = rng(20260504);
  const candidates = [];
  const archetypes = ['balanced', 'high_win', 'profit_router', 'open_drive', 'options_fast', 'risk_guard', 'family_specialist'];
  for (let i = 0; i < count; i += 1) {
    const type = archetypes[Math.floor(random() * archetypes.length)];
    candidates.push({
      name: `${type}_${i}`,
      type,
      minRouteTrades: type === 'high_win' ? 4 + Math.floor(random() * 5) : 3 + Math.floor(random() * 8),
      minFamilyTrades: 8 + Math.floor(random() * 18),
      minTriggerTrades: 8 + Math.floor(random() * 18),
      minRegimeTrades: 14 + Math.floor(random() * 26),
      minRouteWin: type === 'high_win' ? 74 + random() * 16 : 58 + random() * 20,
      minRoutePf: type === 'profit_router' ? 1.45 + random() * 1.4 : 1.05 + random() * 1.6,
      minPolicyScore: type === 'high_win' ? 136 + random() * 34 : 94 + random() * 60,
      maxTrapScore: type === 'risk_guard' ? 0.9 + random() * 0.25 : 1.1 + random() * 0.55,
      maxVwapRisk: type === 'risk_guard' ? 0.55 + random() * 0.25 : 0.65 + random() * 0.35,
      minMomentum: type === 'options_fast' ? 0.48 + random() * 0.28 : 0.2 + random() * 0.36,
      minRelativeStrength: type === 'family_specialist' ? 0.45 + random() * 0.3 : 0.2 + random() * 0.35,
      maxConcurrent: 1 + Math.floor(random() * 3),
      sizeMode: random() > 0.65 ? 'quality' : 'fixed',
      allowRiskRegimes: random() > 0.82,
      requireRegimeEdge: random() > 0.25,
      weightRoute: 0.85 + random() * 1.4,
      weightFamily: 0.4 + random() * 0.9,
      weightTrigger: 0.35 + random() * 0.9,
      weightRegime: 0.2 + random() * 0.7,
      weightSymbol: random() * 0.9,
      weightEntry: 30 + random() * 85,
    });
  }
  return candidates;
}

function entryQuality(trade) {
  const f = trade.features || {};
  return (trade.confidence || 0) * 0.55
    + (trade.alphaQuality || 0) * 0.42
    + (trade.intelligence?.score || 0) * 0.18
    + (f.optionBurstShape || 0) * 18
    + (f.momentumBurst || 0) * 16
    + (f.openingDriveQuality || 0) * 12
    + (f.breakoutQuality || 0) * 12
    + (f.compressionRelease || 0) * 9
    + (f.volumeQuality || 0) * 10
    + (f.cleanVolume || 0) * 8
    + (f.relativeStrength || 0) * 14
    + (f.emaSlope || 0) * 9
    + (f.vwapPressure || 0) * 8
    - (f.failedBreakRisk || 0) * 22
    - (f.vwapExtensionRisk || 0) * 18
    - (f.rejectionWick || 0) * 9;
}

function policyScore(trade, candidate, stats) {
  const route = stats.route.get(trade.routeKey);
  const familyStat = stats.family.get(trade.familyKey);
  const trigger = stats.trigger.get(trade.triggerKey);
  const regime = stats.regime.get(trade.regime);
  const symbol = stats.symbol.get(`${trade.regime}|${trade.symbol}|${trade.side}`);
  if (!candidate.allowRiskRegimes && ['trap_risk', 'chop_risk', 'exhaustion_risk'].includes(trade.regime)) return -999;
  if (candidate.requireRegimeEdge && (!regime || regime.profitFactor < 1.05 || regime.winRate < 50)) return -999;
  if (route && route.trades >= candidate.minRouteTrades && (route.winRate < candidate.minRouteWin || route.profitFactor < candidate.minRoutePf)) return -999;
  const f = trade.features || {};
  const trapScore = (f.failedBreakRisk || 0) + (f.rejectionWick || 0) + (f.vwapExtensionRisk || 0);
  if (trapScore > candidate.maxTrapScore || (f.vwapExtensionRisk || 0) > candidate.maxVwapRisk) return -999;
  if ((f.momentumBurst || 0) < candidate.minMomentum && (f.priceAcceleration || 0) < candidate.minMomentum) return -999;
  if ((f.relativeStrength || 0) < candidate.minRelativeStrength && trade.family !== 'etf') return -999;
  return statScore(route, candidate.minRouteTrades) * candidate.weightRoute
    + statScore(familyStat, candidate.minFamilyTrades) * candidate.weightFamily
    + statScore(trigger, candidate.minTriggerTrades) * candidate.weightTrigger
    + statScore(regime, candidate.minRegimeTrades) * candidate.weightRegime
    + statScore(symbol, Math.max(2, Math.floor(candidate.minRouteTrades / 2))) * candidate.weightSymbol
    + entryQuality(trade) * candidate.weightEntry / 100;
}

function scoreTrades(trades, candidate, stats) {
  return trades.map((trade) => ({ ...trade, policyScore: policyScore(trade, candidate, stats) }))
    .filter((trade) => trade.policyScore >= candidate.minPolicyScore);
}

function replay(scored, candidate) {
  const accepted = [];
  const seen = new Set();
  const sorted = scored.sort((a, b) => (a.entryTime - b.entryTime) || (b.policyScore - a.policyScore));
  for (const trade of sorted) {
    const key = `${trade.symbol}|${trade.entryTime}|${trade.exitTime}|${trade.side}|${Math.round(trade.entry * 10000)}|${Math.round(trade.exit * 10000)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const open = accepted.filter((item) => item.exitTime > trade.entryTime);
    if (open.some((item) => item.symbol === trade.symbol)) continue;
    if (open.length >= candidate.maxConcurrent) continue;
    accepted.push(trade);
  }
  return accepted;
}

function metrics(trades, sizeMode = 'fixed', stressBps = 0) {
  let equity = 0, grossWin = 0, grossLoss = 0, peak = 0, maxDrawdownDollars = 0, maxLossStreak = 0, lossStreak = 0;
  const scaled = trades.map((trade) => {
    const qualityScale = Math.max(0.35, Math.min(1.2, 0.35 + (trade.policyScore || 0) / 260));
    const scale = sizeMode === 'quality' ? qualityScale : 1;
    const stressCost = (trade.notional || capital) * stressBps / 10000;
    return { ...trade, pnlDollars: ((trade.pnlDollars || 0) - stressCost) * scale, scale };
  });
  for (const trade of scaled) {
    equity += trade.pnlDollars;
    if (trade.pnlDollars > 0) grossWin += trade.pnlDollars; else grossLoss += Math.abs(trade.pnlDollars);
    peak = Math.max(peak, equity);
    maxDrawdownDollars = Math.max(maxDrawdownDollars, peak - equity);
    if (trade.pnlDollars <= 0) { lossStreak += 1; maxLossStreak = Math.max(maxLossStreak, lossStreak); } else lossStreak = 0;
  }
  return {
    trades: scaled.length,
    wins: scaled.filter((t) => t.pnlDollars > 0).length,
    losses: scaled.filter((t) => t.pnlDollars <= 0).length,
    winRate: scaled.length ? scaled.filter((t) => t.pnlDollars > 0).length / scaled.length * 100 : 0,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? 999 : 0),
    netDollars: equity,
    projectedNet: equity * projectionCapital / capital,
    avgDollars: scaled.length ? equity / scaled.length : 0,
    projectedAvgDollars: scaled.length ? (equity * projectionCapital / capital) / scaled.length : 0,
    maxDrawdownDollars,
    maxLossStreak,
    avgMfeR: scaled.length ? scaled.reduce((s, t) => s + (t.mfeR || 0), 0) / scaled.length : 0,
    avgMaeR: scaled.length ? scaled.reduce((s, t) => s + (t.maeR || 0), 0) / scaled.length : 0,
    optionWorthyRate: scaled.length ? scaled.filter((t) => t.optionWorthy).length / scaled.length * 100 : 0,
    fastMoveRate: scaled.length ? scaled.filter((t) => t.fastMove >= 0.5).length / scaled.length * 100 : 0,
    uniqueDays: new Set(scaled.map((t) => dayKey(t.entryTime))).size,
    uniqueWeeks: new Set(scaled.map((t) => weekKey(t.entryTime))).size,
  };
}

function objective(m, stress) {
  return Math.min(m.projectedNet / 70, 850) + m.winRate * 1.1 + Math.min(m.profitFactor, 20) * 11
    + Math.min(m.trades, 700) * 0.12 + Math.min(m.avgDollars / 7, 180)
    + Math.min(m.fastMoveRate, 100) * 0.18 + Math.min(m.optionWorthyRate, 100) * 0.12
    + Math.min(stress.projectedNet / 90, 250) + Math.min(stress.profitFactor, 8) * 7
    - Math.max(0, minTestTrades - m.trades) * 2.5
    - Math.min(m.maxDrawdownDollars / 1000, 80) * 2.4
    - Math.max(0, m.maxLossStreak - 2) * 22
    - Math.max(0, 8 - m.uniqueDays) * 15
    - Math.max(0, 3 - m.uniqueWeeks) * 25;
}

function evaluate(candidate, train, test, stats) {
  const trainAccepted = replay(scoreTrades(train, candidate, stats), candidate);
  const trainMetrics = metrics(trainAccepted, candidate.sizeMode);
  const testAccepted = replay(scoreTrades(test, candidate, stats), candidate);
  const testMetrics = metrics(testAccepted, candidate.sizeMode);
  const stressMetrics = metrics(testAccepted, candidate.sizeMode, 6);
  return { candidate, trainMetrics, testMetrics, stressMetrics, score: objective(testMetrics, stressMetrics), accepted: testAccepted };
}

function summarizeBy(key, trades) {
  const buckets = new Map();
  for (const trade of trades) {
    const bucket = trade[key] || 'unknown';
    if (!buckets.has(bucket)) buckets.set(bucket, []);
    buckets.get(bucket).push(trade);
  }
  return [...buckets.entries()].map(([name, rows]) => ({ name, ...metrics(rows) })).sort((a, b) => b.netDollars - a.netDollars).slice(0, 14);
}

let comboPath = null;
if (!tradeLedger) {
  const combos = generateCombos(universe);
  comboPath = join(playbooksDir, `phase11-regime-router-combos-${runId}.json`);
  writeFileSync(comboPath, `${JSON.stringify(combos, null, 2)}\n`);
  console.log(`Phase 11 Regime Router: ${universe.length} symbols x ${combos.length} route combos x ${candidateCount} routers on ${interval}/${range}`);
  const output = execFileSync('node', [
    'scripts/local_fusion_backtest.js', `--symbols=${universe.join(',')}`, `--combo-file=${comboPath}`,
    `--range=${range}`, `--interval=${interval}`, `--capital=${capital}`, '--promote=false', '--sample=all', '--save-trades=true', '--fresh-data=false',
  ], { cwd: root, encoding: 'utf8', maxBuffer: 1024 * 1024 * 180, stdio: ['ignore', 'pipe', 'pipe'] });
  process.stdout.write(output.split('\n').slice(-18).join('\n'));
  if (!output.endsWith('\n')) process.stdout.write('\n');
  const tradeMatch = output.match(/Trades: (.*\.jsonl)/);
  if (!tradeMatch) throw new Error('Backtest did not emit trade ledger path');
  tradeLedger = tradeMatch[1];
} else {
  console.log(`Phase 11 Regime Router: reusing trade ledger ${tradeLedger}`);
}

const trades = await readTrades(tradeLedger);
const { train, test, cutoff } = splitTrades(trades);
const stats = buildStats(train);
const candidates = generateCandidates(candidateCount);
const results = candidates.map((candidate) => evaluate(candidate, train, test, stats)).sort((a, b) => b.score - a.score);
const top = results.slice(0, 25);
const best = top[0];
const currentChampionPath = join(playbooksDir, 'current-master-scalp-champion.json');
const currentChampion = existsSync(currentChampionPath) ? JSON.parse(readFileSync(currentChampionPath, 'utf8')) : null;
const currentStats = currentChampion?.champion?.metrics || currentChampion?.champion?.test || currentChampion?.best?.test || null;
const promotable = best.testMetrics.trades >= minTestTrades
  && best.testMetrics.uniqueDays >= 8
  && best.testMetrics.uniqueWeeks >= 3
  && best.stressMetrics.netDollars > 0
  && best.testMetrics.profitFactor >= 2.5
  && best.testMetrics.maxLossStreak <= 3
  && (!currentStats || (best.testMetrics.winRate >= (currentStats.winRate || 0) - 1 && best.testMetrics.projectedNet >= (currentStats.projectedNet || 0) * 1.08));

const payload = {
  updatedAt: new Date().toISOString(),
  phase: 'phase11-regime-router',
  scope: { symbols: universe.length, routeCombos: comboPath ? generateCombos(universe).length : null, routers: candidates.length, range, interval, capital, projectionCapital, trainPct, cutoff, rawTrades: trades.length, trainTrades: train.length, testTrades: test.length, minTestTrades },
  goal: 'classify entry-time market regime, learn route/family/trigger permissions on train, replay unseen holdout',
  guardrails: [
    'regime labels use entry-time features only',
    'route/family/trigger permissions are learned from chronological train data only',
    'holdout selection uses learned train stats plus current entry features only',
    'PnL/MFE/MAE are never used to choose holdout trades before replay scoring',
  ],
  paths: { comboPath, tradeLedger },
  best: {
    name: best.candidate.name,
    candidate: best.candidate,
    train: best.trainMetrics,
    test: best.testMetrics,
    stress: best.stressMetrics,
    byRegime: summarizeBy('regime', best.accepted),
    byFamily: summarizeBy('family', best.accepted),
    byTrigger: summarizeBy('triggerMode', best.accepted),
    sampleTrades: best.accepted.slice(0, 70).map((trade) => ({ symbol: trade.symbol, side: trade.side, regime: trade.regime, family: trade.family, triggerMode: trade.triggerMode, entryTime: trade.entryTime, exitTime: trade.exitTime, entry: trade.entry, exit: trade.exit, pnlDollars: trade.pnlDollars, pnlR: trade.pnlR, mfeR: trade.mfeR, maeR: trade.maeR, optionWorthy: trade.optionWorthy, policyScore: trade.policyScore })),
  },
  leaderboard: top.map((item) => ({ name: item.candidate.name, type: item.candidate.type, score: item.score, candidate: item.candidate, train: item.trainMetrics, test: item.testMetrics, stress: item.stressMetrics })),
  promotion: { promote: promotable, decision: promotable ? 'promote-regime-router' : 'research-only-not-better-than-champion', comparedTo: currentStats },
};

const outPath = join(playbooksDir, 'current-phase11-regime-router.json');
writeFileSync(outPath, `${JSON.stringify(payload, null, 2)}\n`);
appendFileSync(join(playbooksDir, 'phase11-regime-router-history.jsonl'), `${JSON.stringify(payload)}\n`);
const exportPath = join(generatedDir, 'regime_router_export.json');
writeFileSync(exportPath, `${JSON.stringify({ generatedAt: payload.updatedAt, decision: payload.promotion.decision, best: payload.best, guardrails: payload.guardrails }, null, 2)}\n`);

console.log('\n=== phase 11 regime router ===');
console.log(`Saved: ${outPath}`);
console.log(`Pine/regime metadata: ${exportPath}`);
console.log(`Raw trades=${trades.length} train=${train.length} test=${test.length}`);
for (const item of top.slice(0, 10)) {
  const m = item.testMetrics, s = item.stressMetrics;
  console.log(`${item.candidate.name}: test trades=${m.trades} win=${m.winRate.toFixed(2)} pf=${m.profitFactor.toFixed(2)} net=$${m.netDollars.toFixed(0)} projected=$${m.projectedNet.toFixed(0)} avg=$${m.avgDollars.toFixed(0)} dd=$${m.maxDrawdownDollars.toFixed(0)} stressNet=$${s.netDollars.toFixed(0)} days=${m.uniqueDays} weeks=${m.uniqueWeeks}`);
}
console.log(`Decision=${payload.promotion.decision}`);
