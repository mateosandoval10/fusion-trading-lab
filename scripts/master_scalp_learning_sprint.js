#!/usr/bin/env node
import { appendFileSync, createReadStream, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const outDir = join(root, 'optimization-results');
const modelsDir = join(outDir, 'models', 'playbooks');
const ledgerDir = join(outDir, 'trade-ledger');
const generatedDir = join(root, 'generated');
for (const dir of [modelsDir, ledgerDir, generatedDir]) mkdirSync(dir, { recursive: true });

const args = new Map(process.argv.slice(2).map((arg) => {
  const [key, value = 'true'] = arg.replace(/^--/, '').split('=');
  return [key, value];
}));

const capital = Number(args.get('capital') || 100000);
const projectionCapital = Number(args.get('projection-capital') || 10000);
const range = args.get('range') || '60d';
const interval = args.get('interval') || '5m';
const trainPct = Number(args.get('train-pct') || 0.7);
const maxSymbols = Number(args.get('max-symbols') || 0);
const quick = args.get('quick') === 'true';
const freshData = args.get('fresh-data') === 'true';
const minRouteTrades = Number(args.get('min-route-trades') || 5);
const minRouteDays = Number(args.get('min-route-days') || 3);
const minRouteWeeks = Number(args.get('min-route-weeks') || 2);
const minChampionTrades = Number(args.get('min-champion-trades') || 20);
const maxSymbolRoutes = Number(args.get('max-symbol-routes') || 4);
const maxClusterRoutes = Number(args.get('max-cluster-routes') || 18);
const minNetAfterCosts = Number(args.get('min-net-after-costs') || 75);
const symbolFile = args.get('symbol-file') || join(root, 'config', 'scalp-symbols-expanded.txt');
const symbols = (args.get('symbols') || readFileSync(symbolFile, 'utf8'))
  .split(/[\s,]+/)
  .map((symbol) => symbol.trim().toUpperCase())
  .filter(Boolean)
  .filter((symbol, index, all) => all.indexOf(symbol) === index)
  .slice(0, maxSymbols > 0 ? maxSymbols : undefined);

const triggerModes = args.get('trigger-mode') ? listArg(args.get('trigger-mode')) : [
  'base',
  'ema-cross',
  'score-cross',
  'vwap-reclaim',
  'ema-pullback',
  'breakout',
  'failed-reversal',
  'momentum-acceleration',
  'mean-reversion',
  'trend-continuation',
  'squeeze-expansion',
  'opening-range',
  'volume-shock',
  'options-burst',
  'confirmed-no-repaint',
  'liquidity-sweep',
  'compression-pop',
  'relative-strength-reclaim',
  'trend-pullback-burst',
  'opening-drive-continuation',
  'hybrid-consensus',
];

const sessionGrid = quick ? 'open-0930|open-1000|powerhour' : 'all|open-0930|open-1000|open-1030|midday|powerhour';
const minConfGrid = quick ? '70|75' : '65|70|75|80';
const directionGrid = args.get('direction') || 'both|long|short';
const targetGrid = args.get('target-r') || (quick ? '0.35|0.5' : '0.25|0.35|0.5|0.75');
const timeStopGrid = args.get('time-stop-bars') || (quick ? '6|9' : '3|6|9|12');
const trailGrid = args.get('trail-r') || (quick ? '0.35|0.5' : '0.25|0.35|0.5|0.75');
const partialGrid = args.get('partial-r') || (quick ? '0.5|1' : '0.35|0.5|0.75|1');
const confidenceDropGrid = args.get('confidence-drop') || (quick ? '18|25' : '15|18|25|32');
const structureExitGrid = args.get('structure-exit') || (quick ? 'loose|strict' : 'off|loose|strict|ema-only|vwap-only');
const alphaGrid = quick ? '55|65' : '0|55|65|75';
const focused = quick || args.get('focused') !== 'false';

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function runNode(script, scriptArgs, label) {
  console.log(`\n=== ${label} ===`);
  const output = execFileSync('node', [script, ...scriptArgs], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024 * 220,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  process.stdout.write(output.split('\n').slice(-18).join('\n'));
  if (!output.endsWith('\n')) process.stdout.write('\n');
  return output;
}

function summaryPathFrom(output, label) {
  const match = output.match(/Summary: (.*\.json)/);
  if (!match) throw new Error(`${label} did not emit a summary path`);
  return match[1];
}

async function readJsonl(path) {
  const rows = [];
  if (!path || !existsSync(path)) return rows;
  const lines = createInterface({ input: createReadStream(path, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of lines) {
    if (line.trim()) rows.push(JSON.parse(line));
  }
  return rows;
}

function listArg(value) {
  return String(value).split('|').map((item) => item.trim()).filter(Boolean);
}

function comboId(symbol, combo) {
  return `${symbol}|${combo.session}|${combo.direction}|${combo.triggerMode}`;
}

function routeId(row) {
  return comboId(row.symbol, row.combo);
}

function validationComboKey(symbol, combo) {
  const ignored = new Set([
    'alphaMode',
    'alphaWeightSet',
    'minIntelScore',
    'positionSizing',
    'minPositionScale',
    'maxPositionScale',
  ]);
  const normalized = Object.fromEntries(
    Object.entries(combo || {})
      .filter(([key]) => !ignored.has(key))
      .sort(([a], [b]) => a.localeCompare(b)),
  );
  return `${symbol}|${JSON.stringify(normalized)}`;
}

function family(symbol) {
  const families = {
    semis: ['NVDA', 'AMD', 'AVGO', 'SMCI', 'MU', 'INTC', 'ARM', 'MRVL', 'ON', 'TSM', 'SMH', 'NVDL'],
    crypto: ['COIN', 'MARA', 'RIOT', 'CLSK', 'WULF', 'CIFR', 'IREN', 'MSTR', 'CONL', 'MSTX'],
    ev: ['TSLA', 'RIVN', 'LCID', 'QS', 'NIO', 'XPEV'],
    softwareAi: ['PLTR', 'AI', 'PATH', 'IONQ', 'RGTI', 'QBTS', 'CRM', 'NOW', 'MDB', 'SNOW', 'DDOG', 'CRWD', 'PANW', 'ZS', 'OKTA'],
    pennyMeme: ['OPEN', 'GME', 'AMC', 'SNDK', 'NVTS', 'RUN', 'NOK', 'ONDS', 'RGTI', 'QBTS'],
    travelConsumer: ['AAL', 'LUV', 'UAL', 'RCL', 'ABNB', 'DASH', 'LYFT', 'SHOP', 'AFRM'],
    megaCapTech: ['AAPL', 'MSFT', 'GOOGL', 'NFLX', 'ORCL', 'META', 'AMZN'],
    etf: ['SPY', 'QQQ', 'TQQQ', 'XBI', 'USO', 'TAN', 'IGV'],
  };
  for (const [name, members] of Object.entries(families)) if (members.includes(symbol)) return name;
  return 'other';
}

function correlationCluster(symbol) {
  const clusters = {
    semiAi: ['NVDA', 'AMD', 'AVGO', 'SMCI', 'MU', 'ARM', 'MRVL', 'ON', 'TSM', 'SMH', 'SOXL', 'SOXS', 'NVDL'],
    cryptoBeta: ['COIN', 'MARA', 'RIOT', 'CLSK', 'WULF', 'CIFR', 'IREN', 'MSTR', 'CONL', 'MSTX', 'BTBT', 'HIVE'],
    evSpec: ['TSLA', 'RIVN', 'LCID', 'NIO', 'XPEV', 'LI', 'QS', 'CHPT'],
    softwareGrowth: ['PLTR', 'AI', 'PATH', 'IONQ', 'RGTI', 'QBTS', 'CRM', 'SNOW', 'DDOG', 'CRWD', 'PANW', 'ZS', 'OKTA'],
    memePenny: ['OPEN', 'GME', 'AMC', 'SNDK', 'NVTS', 'RUN', 'NOK', 'ONDS', 'SPCE', 'FCEL'],
    travelConsumer: ['AAL', 'LUV', 'UAL', 'DAL', 'RCL', 'CCL', 'NCLH', 'ABNB', 'DASH', 'LYFT', 'UBER'],
    megaCap: ['AAPL', 'MSFT', 'GOOGL', 'GOOG', 'META', 'AMZN', 'NFLX', 'ORCL'],
    broadEtf: ['SPY', 'QQQ', 'TQQQ', 'SQQQ', 'IWM', 'DIA', 'XLK', 'XLF', 'XLE', 'XBI', 'ARKK'],
  };
  for (const [name, members] of Object.entries(clusters)) if (members.includes(symbol)) return name;
  return family(symbol);
}

function sessionBucket(session) {
  if (session === 'open-0930') return 'first_30';
  if (session === 'open-1000' || session === 'open-1030') return 'late_open';
  if (session === 'midday') return 'midday_chop';
  if (session === 'powerhour') return 'power_hour';
  if (session === 'open') return 'open_drive';
  return 'all_day';
}

function compact(metrics = {}) {
  return {
    trades: metrics.trades || 0,
    winRate: metrics.winRate || 0,
    profitFactor: metrics.profitFactor || 0,
    netDollars: metrics.netDollars || 0,
    avgDollars: metrics.avgDollars || 0,
    avgR: metrics.avgR || 0,
    avgMfeR: metrics.avgMfeR || 0,
    avgMaeR: metrics.avgMaeR || 0,
    optionWorthyRate: metrics.optionWorthyRate || 0,
    greatTradeRate: metrics.greatTradeRate || 0,
    maxDrawdownDollars: metrics.maxDrawdownDollars || 0,
    maxLossStreak: metrics.maxLossStreak || 0,
  };
}

function dayKey(timestamp) {
  if (!timestamp) return 'unknown';
  return new Date(timestamp * 1000).toISOString().slice(0, 10);
}

function weekKey(timestamp) {
  if (!timestamp) return 'unknown';
  const date = new Date(timestamp * 1000);
  const start = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const day = Math.floor((date - start) / 86400000);
  return `${date.getUTCFullYear()}-W${String(Math.floor(day / 7) + 1).padStart(2, '0')}`;
}

function dayParity(timestamp) {
  return Number(dayKey(timestamp).replaceAll('-', '')) % 2 === 0 ? 'even' : 'odd';
}

function median(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return 0;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function percentile(values, pct) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.floor((pct / 100) * (sorted.length - 1))));
  return sorted[index];
}

function seededRandom(seed) {
  let state = seed % 2147483647;
  if (state <= 0) state += 2147483646;
  return () => {
    state = state * 16807 % 2147483647;
    return (state - 1) / 2147483646;
  };
}

function marketRegimeFromTrade(trade) {
  const confidence = trade.confidence || 0;
  const mfe = trade.mfeR || 0;
  const mae = trade.maeR || 0;
  if (mfe >= 1.5 && mae <= 0.5) return 'clean_trend';
  if (mae >= 1.0 && mfe < 0.5) return 'trap_or_chop';
  if (confidence >= 85 && mfe >= 0.8) return 'momentum_expansion';
  if (mfe < 0.4 && mae < 0.4) return 'low_vol_grind';
  return 'mixed';
}

function blackoutSymbols() {
  const configPath = join(root, 'config', 'earnings-blackout-symbols.json');
  if (!existsSync(configPath)) return new Set(['AAPL', 'MSFT', 'AMZN', 'GOOGL', 'GOOG', 'META', 'NVDA', 'TSLA', 'NFLX']);
  try {
    const data = readJson(configPath);
    return new Set((data.symbols || []).map((symbol) => String(symbol).toUpperCase()));
  } catch {
    return new Set();
  }
}

const earningsBlackoutSymbols = blackoutSymbols();

function routeScore(route) {
  const test = route.test;
  const stress = route.stress || test;
  const forward = route.forward;
  const liveGapPenalty = forward.trades > 0 ? Math.max(0, test.winRate - forward.winRate) * 1.8 : 8;
  const overfitPenalty = Math.max(0, route.train.winRate - test.winRate) * 1.1
    + Math.max(0, route.train.profitFactor - test.profitFactor) * 2.0;
  const drawdownPenalty = Math.min(test.maxDrawdownDollars / 350, 45) + test.maxLossStreak * 9;
  const stressPenalty = stress.netDollars > 0 && stress.profitFactor >= 1 ? 0 : 35;
  const samplePenalty = Math.max(0, minRouteTrades - test.trades) * 18
    + Math.max(0, minRouteDays - route.robustness.uniqueDays) * 16
    + Math.max(0, minRouteWeeks - route.robustness.uniqueWeeks) * 22;
  const consistencyBonus = route.robustness.profitConsistencyScore * 0.45
    + route.robustness.oddEvenCvScore * 0.25
    + route.robustness.rollingWindowScore * 0.35
    + Math.min(route.robustness.monteCarloSurvivalRate, 100) * 0.22;
  const mfeMaeBonus = Math.max(0, (route.robustness.avgMfeR || 0) - (route.robustness.avgMaeR || 0)) * 18
    + (route.robustness.fastProfitRate || 0) * 0.18
    + (route.robustness.optionWorthyScore || 0) * 0.12;
  const qualityPenalty = route.robustness.outlierDependence * 28
    + (route.robustness.maeReject ? 40 : 0)
    + (route.robustness.lateEntryRisk ? 24 : 0)
    + (route.robustness.failedBreakoutRisk ? 28 : 0)
    + (route.robustness.trendExhaustionRisk ? 22 : 0)
    + (route.robustness.liquidityKill ? 60 : 0)
    + (route.robustness.earningsBlackout ? 35 : 0)
    + Math.max(0, (route.robustness.avgMaeR || 0) - 0.85) * 20
    + Math.max(0, 0.55 - (route.robustness.outlierCappedReturnRatio || 0)) * 45
    + Math.max(0, 55 - (route.robustness.rollingWindowScore || 0)) * 0.8;
  const sampleBonus = Math.min(test.trades, 40) * 0.7;
  const recentBonus = route.recent.trades ? Math.min(route.recent.winRate, 100) * 0.25 + Math.min(route.recent.netDollars / 100, 25) : 0;
  return test.winRate * 1.15
    + Math.min(test.profitFactor, 15) * 7
    + Math.min(test.avgDollars / 8, 100)
    + Math.min(test.avgMfeR, 5) * 12
    - Math.min(test.avgMaeR, 5) * 10
    + sampleBonus
    + recentBonus
    + consistencyBonus
    + mfeMaeBonus
    - liveGapPenalty
    - overfitPenalty
    - drawdownPenalty
    - stressPenalty
    - samplePenalty
    - qualityPenalty;
}

function recentMetrics(trades) {
  const sorted = [...trades].sort((a, b) => (a.trade?.entryTime || 0) - (b.trade?.entryTime || 0));
  const recent = sorted.slice(Math.max(0, Math.floor(sorted.length * 0.6)));
  const wins = recent.filter((row) => (row.trade?.pnlDollars || 0) > 0);
  const netDollars = recent.reduce((sum, row) => sum + (row.trade?.pnlDollars || 0), 0);
  return {
    trades: recent.length,
    winRate: recent.length ? wins.length / recent.length * 100 : 0,
    netDollars,
    avgDollars: recent.length ? netDollars / recent.length : 0,
  };
}

function featureVector(row, phase, recent, forward) {
  const combo = row.combo || {};
  const metrics = row.metrics || {};
  return {
    symbol: row.symbol,
    family: family(row.symbol),
    triggerMode: combo.triggerMode,
    session: combo.session,
    sessionBucket: sessionBucket(combo.session),
    direction: combo.direction,
    phase,
    minConf: combo.minConf || 0,
    targetR: combo.targetR || 0,
    timeStopBars: combo.timeStopBars || 0,
    minAlphaQuality: combo.minAlphaQuality || 0,
    requireConfRising: Boolean(combo.requireConfRising),
    htfMode: combo.htfMode || 'off',
    volumeQuality: combo.volumeQuality || 'off',
    openingRange: combo.openingRange || 'off',
    marketMode: combo.marketMode || 'off',
    peerMode: combo.peerMode || 'off',
    minAdx: combo.minAdx || 0,
    minEr: combo.minEr || 0,
    minAtrRatio: combo.minAtrRatio || 0,
    volMult: combo.volMult || 0,
    trades: metrics.trades || 0,
    winRate: metrics.winRate || 0,
    profitFactor: metrics.profitFactor || 0,
    netDollars: metrics.netDollars || 0,
    avgDollars: metrics.avgDollars || 0,
    mfeMaeEdge: (metrics.avgMfeR || 0) - (metrics.avgMaeR || 0),
    optionWorthyRate: metrics.optionWorthyRate || 0,
    maxLossStreak: metrics.maxLossStreak || 0,
    recentWinRate: recent.winRate || 0,
    recentNetDollars: recent.netDollars || 0,
    forwardWinRate: forward.winRate || 0,
    forwardTrades: forward.trades || 0,
  };
}

function aggregateTradeRows(rows) {
  const wins = rows.filter((row) => (row.trade?.pnlDollars || 0) > 0);
  const losses = rows.filter((row) => (row.trade?.pnlDollars || 0) <= 0);
  const netDollars = rows.reduce((sum, row) => sum + (row.trade?.pnlDollars || 0), 0);
  const grossWin = wins.reduce((sum, row) => sum + (row.trade?.pnlDollars || 0), 0);
  const grossLoss = Math.abs(losses.reduce((sum, row) => sum + (row.trade?.pnlDollars || 0), 0));
  return {
    trades: rows.length,
    wins: wins.length,
    losses: losses.length,
    winRate: rows.length ? wins.length / rows.length * 100 : 0,
    netDollars,
    grossWin,
    grossLoss,
    avgDollars: rows.length ? netDollars / rows.length : 0,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? 999 : 0),
  };
}

function routeRobustness(rows, routeContext) {
  const trades = rows.map((row) => row.trade || {});
  const ordered = [...trades].sort((a, b) => (a.entryTime || 0) - (b.entryTime || 0));
  const uniqueDays = new Set(trades.map((trade) => dayKey(trade.entryTime))).size;
  const uniqueWeeks = new Set(trades.map((trade) => weekKey(trade.entryTime))).size;
  const byDay = new Map();
  const byWeek = new Map();
  const byParity = { odd: [], even: [] };
  const byRegime = new Map();
  for (const trade of trades) {
    const day = dayKey(trade.entryTime);
    const week = weekKey(trade.entryTime);
    const parity = dayParity(trade.entryTime);
    const regime = marketRegimeFromTrade(trade);
    byDay.set(day, (byDay.get(day) || 0) + (trade.pnlDollars || 0));
    byWeek.set(week, (byWeek.get(week) || 0) + (trade.pnlDollars || 0));
    byParity[parity].push({ trade });
    const regimeRows = byRegime.get(regime) || [];
    regimeRows.push({ trade });
    byRegime.set(regime, regimeRows);
  }
  const dayPnls = [...byDay.values()];
  const profitableDays = dayPnls.filter((pnl) => pnl > 0).length;
  const profitConsistencyScore = dayPnls.length ? profitableDays / dayPnls.length * 100 : 0;
  const weekPnls = [...byWeek.values()];
  const profitableWeeks = weekPnls.filter((pnl) => pnl > 0).length;
  const weekConsistencyScore = weekPnls.length ? profitableWeeks / weekPnls.length * 100 : 0;
  const odd = aggregateTradeRows(byParity.odd);
  const even = aggregateTradeRows(byParity.even);
  const oddEvenCvScore = odd.trades > 0 && even.trades > 0
    ? Math.min(odd.winRate, even.winRate) - Math.abs(odd.avgDollars - even.avgDollars) / Math.max(1, Math.abs(odd.avgDollars) + Math.abs(even.avgDollars)) * 25
    : 0;
  const pnlValues = trades.map((trade) => trade.pnlDollars || 0);
  const cappedPnlValues = pnlValues.map((pnl) => Math.max(-Math.abs(percentile(pnlValues, 5)), Math.min(pnl, percentile(pnlValues, 95))));
  const net = pnlValues.reduce((sum, pnl) => sum + pnl, 0);
  const cappedNet = cappedPnlValues.reduce((sum, pnl) => sum + pnl, 0);
  const biggestWin = Math.max(0, ...pnlValues);
  const grossWin = pnlValues.filter((pnl) => pnl > 0).reduce((sum, pnl) => sum + pnl, 0);
  const outlierDependence = grossWin > 0 ? biggestWin / grossWin : 0;
  const foldCount = Math.min(5, Math.max(2, Math.floor(ordered.length / 3)));
  const folds = [];
  for (let fold = 0; fold < foldCount; fold += 1) {
    const start = Math.floor(ordered.length * fold / foldCount);
    const end = Math.floor(ordered.length * (fold + 1) / foldCount);
    folds.push(aggregateTradeRows(ordered.slice(start, end).map((trade) => ({ trade }))));
  }
  const validFolds = folds.filter((fold) => fold.trades > 0);
  const rollingWindowScore = validFolds.length
    ? Math.max(0, Math.min(...validFolds.map((fold) => fold.winRate)) * 0.7 + validFolds.filter((fold) => fold.netDollars > 0).length / validFolds.length * 30)
    : 0;
  const rand = seededRandom([...routeContext.id].reduce((sum, ch) => sum + ch.charCodeAt(0), 17));
  const monteRuns = 160;
  let survival = 0;
  let maxDrawdowns = [];
  for (let run = 0; run < monteRuns; run += 1) {
    let equity = 0;
    let peak = 0;
    let maxDrawdown = 0;
    for (let i = 0; i < pnlValues.length; i += 1) {
      const pnl = pnlValues[Math.floor(rand() * pnlValues.length)] || 0;
      equity += pnl;
      peak = Math.max(peak, equity);
      maxDrawdown = Math.max(maxDrawdown, peak - equity);
    }
    if (equity > 0) survival += 1;
    maxDrawdowns.push(maxDrawdown);
  }
  const avgMfe = trades.length ? trades.reduce((sum, trade) => sum + (trade.mfeR || 0), 0) / trades.length : 0;
  const avgMae = trades.length ? trades.reduce((sum, trade) => sum + (trade.maeR || 0), 0) / trades.length : 0;
  const fastProfitRate = trades.length ? trades.filter((trade) => (trade.reason === 'target' || (trade.pnlR || 0) > 0.25) && ((trade.exitTime || 0) - (trade.entryTime || 0)) <= 15 * 60).length / trades.length * 100 : 0;
  const optionWorthyScore = Math.max(0, avgMfe - avgMae) * 30 + fastProfitRate * 0.35;
  const volumeLiquidityProxy = Math.max(0, Math.min(100, (routeContext.test.avgDollars || 0) / Math.max(1, Math.abs(routeContext.test.avgMaeR || avgMae || 0.1)) / 4));
  const spreadStressProxyBps = routeContext.symbol.length <= 4 ? 2 : 6;
  const costAdjustedAvg = (routeContext.test.avgDollars || 0) - spreadStressProxyBps * 1.5;
  const maeReject = avgMae > Math.max(1.1, avgMfe * 1.25);
  const lateEntryRisk = median(trades.map((trade) => trade.maeR || 0)) > 0.75 && fastProfitRate < 35;
  const failedBreakoutRisk = routeContext.triggerMode?.includes('breakout') && avgMae > 0.9 && fastProfitRate < 45;
  const trendExhaustionRisk = avgMfe > 1.2 && routeContext.test.winRate < 70 && routeContext.sessionBucket === 'power_hour';
  const vwapEmaCompressionScore = Math.max(0, 100 - avgMae * 35 + fastProfitRate * 0.25);
  const relativeStrengthProxy = routeContext.direction === 'short'
    ? Math.max(0, 100 - routeContext.test.winRate)
    : Math.min(100, routeContext.test.winRate + Math.max(0, avgMfe - avgMae) * 8);
  return {
    uniqueDays,
    uniqueWeeks,
    profitConsistencyScore,
    weekConsistencyScore,
    oddEvenCvScore,
    rollingWindowScore,
    rollingWindows: validFolds,
    monteCarloSurvivalRate: monteRuns ? survival / monteRuns * 100 : 0,
    monteCarloMedianDrawdown: median(maxDrawdowns),
    outlierDependence,
    cappedNetDollars: cappedNet,
    outlierCappedReturnRatio: net ? cappedNet / net : 0,
    fastProfitRate,
    optionWorthyScore,
    avgMfeR: avgMfe,
    avgMaeR: avgMae,
    maeReject,
    lateEntryRisk,
    failedBreakoutRisk,
    trendExhaustionRisk,
    vwapEmaCompressionScore,
    relativeStrengthProxy,
    volumeLiquidityProxy,
    spreadStressProxyBps,
    costAdjustedAvg,
    liquidityKill: costAdjustedAvg < minNetAfterCosts,
    earningsBlackout: earningsBlackoutSymbols.has(routeContext.symbol),
    marketRegimes: Object.fromEntries([...byRegime.entries()].map(([regime, regimeRows]) => [regime, aggregateTradeRows(regimeRows)])),
  };
}

async function tradeBuckets(summaryPath) {
  const summary = readJson(summaryPath);
  const path = summary.paths?.trades;
  const rows = await readJsonl(path);
  const byFullCombo = new Map();
  const ledgerPath = join(ledgerDir, `backtest-trades-${summary.runId || Date.now()}.jsonl`);
  for (const row of rows) {
    const key = `${row.symbol}|${JSON.stringify(row.combo)}`;
    const list = byFullCombo.get(key) || [];
    list.push(row);
    byFullCombo.set(key, list);
    appendFileSync(ledgerPath, `${JSON.stringify({
      recordedAt: new Date().toISOString(),
      source: 'backtest',
      runId: row.runId,
      symbol: row.symbol,
      combo: row.combo,
      trade: row.trade,
      featureSeed: featureVector({ symbol: row.symbol, combo: row.combo, metrics: {} }, 'trade', {}, {}),
    })}\n`);
  }
  return { byFullCombo, ledgerPath, trades: rows };
}

function forwardEvidence() {
  const ledgerPath = join(outDir, 'forward-tests', 'champion-forward-performance-ledger.jsonl');
  const byRoute = new Map();
  if (!existsSync(ledgerPath)) return byRoute;
  for (const line of readFileSync(ledgerPath, 'utf8').trim().split('\n').filter(Boolean)) {
    try {
      const record = JSON.parse(line);
      if (!record.outputPath || !existsSync(record.outputPath)) continue;
      const detail = readJson(record.outputPath);
      for (const trade of detail.trades || []) {
        const key = `${trade.symbol}|${trade.session || 'all'}|${trade.direction || trade.side}|${trade.triggerMode}`;
        const list = byRoute.get(key) || [];
        list.push({ trade: { pnlDollars: trade.pnlDollars } });
        byRoute.set(key, list);
      }
    } catch {
      // ignore malformed forward evidence
    }
  }
  return new Map([...byRoute.entries()].map(([key, rows]) => [key, aggregateTradeRows(rows)]));
}

function featureImportance(routes) {
  const featureNames = ['minConf', 'targetR', 'timeStopBars', 'minAlphaQuality', 'minAdx', 'minEr', 'minAtrRatio', 'volMult'];
  const targetNames = ['winRate', 'avgDollars', 'mfeMaeEdge'];
  const out = {};
  for (const target of targetNames) {
    out[target] = {};
    for (const feature of featureNames) {
      const pairs = routes
        .map((route) => [route.features[feature], route.test[target] ?? route.features[target]])
        .filter(([x, y]) => Number.isFinite(x) && Number.isFinite(y));
      const mx = pairs.reduce((sum, [x]) => sum + x, 0) / Math.max(1, pairs.length);
      const my = pairs.reduce((sum, [, y]) => sum + y, 0) / Math.max(1, pairs.length);
      const cov = pairs.reduce((sum, [x, y]) => sum + (x - mx) * (y - my), 0);
      const vx = pairs.reduce((sum, [x]) => sum + (x - mx) ** 2, 0);
      const vy = pairs.reduce((sum, [, y]) => sum + (y - my) ** 2, 0);
      out[target][feature] = vx > 0 && vy > 0 ? cov / Math.sqrt(vx * vy) : 0;
    }
  }
  return out;
}

function confidenceCalibration(routes) {
  const buckets = {};
  for (const route of routes) {
    const bucket = `${Math.floor((route.combo.minConf || 0) / 10) * 10}-${Math.floor((route.combo.minConf || 0) / 10) * 10 + 9}`;
    const item = buckets[bucket] || { routes: 0, trades: 0, wins: 0, avgConfidence: 0 };
    item.routes += 1;
    item.trades += route.test.trades;
    item.wins += route.test.trades * route.test.winRate / 100;
    item.avgConfidence += route.combo.minConf || 0;
    buckets[bucket] = item;
  }
  return Object.fromEntries(Object.entries(buckets).map(([bucket, item]) => [bucket, {
    routes: item.routes,
    trades: item.trades,
    observedWinRate: item.trades ? item.wins / item.trades * 100 : 0,
    avgDeclaredConfidence: item.routes ? item.avgConfidence / item.routes : 0,
    calibrationGap: item.routes && item.trades ? (item.avgConfidence / item.routes) - (item.wins / item.trades * 100) : 0,
  }]));
}

const commonArgs = [
  `--symbols=${symbols.join(',')}`,
  `--interval=${interval}`,
  `--range=${range}`,
  `--capital=${capital}`,
  `--fresh-data=${freshData}`,
  '--playbook=Scalp',
  `--trigger-mode=${triggerModes.join('|')}`,
  `--min-conf=${minConfGrid}`,
  `--target-r=${targetGrid}`,
  '--exit-mode=smart',
  `--trail-r=${trailGrid}`,
  `--time-stop-bars=${timeStopGrid}`,
  `--partial-r=${partialGrid}`,
  `--confidence-drop=${confidenceDropGrid}`,
  `--structure-exit=${structureExitGrid}`,
  `--min-lead=${focused ? '65' : '65|70'}`,
  `--min-edge=${focused ? '12' : '12|18'}`,
  `--min-atr-ratio=${focused ? '0.9' : '0.9|1.0'}`,
  `--min-adx=${focused ? '14' : '14|18'}`,
  `--min-er=${focused ? '0.10' : '0.10|0.16'}`,
  `--vol-mult=${focused ? '1.2' : '1.2|1.5'}`,
  `--session=${args.get('session') || sessionGrid}`,
  `--direction=${directionGrid}`,
  `--loss-cooldown-bars=${focused ? '0' : '0|6'}`,
  `--max-vwap-atr=${focused ? '0' : '0|1.2'}`,
  '--require-conf-rising=true',
  '--slippage-bps=1',
  '--spread-bps=2',
  `--min-move-to-cost=${focused ? '5' : '5|8'}`,
  `--opening-range=${focused ? 'off' : 'off|break-reclaim'}`,
  `--htf-mode=${focused ? 'not-against50' : 'not-against50|with50'}`,
  `--volume-quality=${focused ? 'off' : 'off|real-expansion'}`,
  `--adaptive-target=${focused ? 'false' : 'false|true'}`,
  `--max-consecutive-losses=${focused ? '0' : '0|1'}`,
  `--cluster-cooldown-bars=${focused ? '0' : '0|6'}`,
  '--min-price=1',
  '--max-price=0',
  '--min-dollar-volume=500000',
  `--gap-mode=${args.get('gap-mode') || 'off'}`,
  `--daily-context=${args.get('daily-context') || (focused ? 'trend-day' : 'trend-day|off')}`,
  `--pd-level-mode=${args.get('pd-level-mode') || (focused ? 'off' : 'off|reclaim')}`,
  `--market-mode=${args.get('market-mode') || (focused ? 'off' : 'off|aligned')}`,
  `--rel-vol-mode=${args.get('rel-vol-mode') || (focused ? 'off' : 'off|tod')}`,
  `--min-rel-vol-tod=${args.get('min-rel-vol-tod') || '1'}`,
  `--peer-mode=${args.get('peer-mode') || (focused ? 'off' : 'off|aligned')}`,
  '--news-mode=off',
  '--alpha-mode=specialist-blend',
  `--min-alpha-quality=${args.get('min-alpha-quality') || alphaGrid}`,
  '--position-sizing=fixed',
  '--min-position-scale=1',
  '--max-position-scale=1',
  '--promote=false',
  '--min-trades=0',
  '--min-symbols=1',
];

console.log(`Master learning sprint: ${symbols.length} symbols, ${interval}/${range}, quick=${quick}`);
let trainSummaryPath = args.get('train-summary');
let testSummaryPath = args.get('test-summary');
let stressSummaryPath = args.get('stress-summary');
if (!trainSummaryPath || !testSummaryPath || !stressSummaryPath) {
  const trainOutput = runNode('scripts/local_fusion_backtest.js', [...commonArgs, '--sample=train', `--train-pct=${trainPct}`, '--save-trades=true'], 'walk-forward train');
  trainSummaryPath = summaryPathFrom(trainOutput, 'train');
  const intelligencePath = join(modelsDir, `scalp-intelligence-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  runNode('scripts/learn_scalp_intelligence.js', [`--summary=${trainSummaryPath}`, `--out=${intelligencePath}`, '--min-samples=6', '--min-bad-samples=3'], 'train split intelligence learning');
  const learnedArgs = ['--intelligence-mode=on', `--intelligence-model=${intelligencePath}`, '--alpha-mode=specialist-intel', '--min-intel-score=45'];
  const testOutput = runNode('scripts/local_fusion_backtest.js', [...commonArgs, ...learnedArgs, '--sample=test', `--train-pct=${trainPct}`, '--save-trades=true'], 'walk-forward holdout test');
  testSummaryPath = summaryPathFrom(testOutput, 'test');
  const stressArgs = commonArgs
    .filter((arg) => !arg.startsWith('--slippage-bps=') && !arg.startsWith('--spread-bps='))
    .concat([...learnedArgs, '--slippage-bps=3', '--spread-bps=12', '--sample=test', `--train-pct=${trainPct}`, '--save-trades=false']);
  const stressOutput = runNode('scripts/local_fusion_backtest.js', stressArgs, 'stress test');
  stressSummaryPath = summaryPathFrom(stressOutput, 'stress');
} else {
  console.log(`Reusing summaries:\ntrain=${trainSummaryPath}\ntest=${testSummaryPath}\nstress=${stressSummaryPath}`);
}

const validateOutput = runNode('scripts/validate_scalp_routes.js', [
  `--train-summary=${trainSummaryPath}`,
  `--test-summary=${testSummaryPath}`,
  `--stress-summary=${stressSummaryPath}`,
  `--projection-capital=${projectionCapital}`,
  '--min-train-trades=5',
  '--min-test-trades=2',
  '--min-train-win=58',
  '--min-test-win=52',
  '--min-profit-factor=1.0',
], 'route validation');

const trainRows = await readJsonl(readJson(trainSummaryPath).paths.run);
const testSummary = readJson(testSummaryPath);
const testRows = await readJsonl(testSummary.paths.run);
const stressRows = await readJsonl(readJson(stressSummaryPath).paths.run);
const { byFullCombo: testTrades, ledgerPath: backtestLedgerPath } = await tradeBuckets(testSummaryPath);
const trainByCombo = new Map(trainRows.map((row) => [validationComboKey(row.symbol, row.combo), row]));
const stressByCombo = new Map(stressRows.map((row) => [validationComboKey(row.symbol, row.combo), row]));
const forwardByRoute = forwardEvidence();

const routeCandidates = [];
for (const row of testRows) {
  if (row.combo?.playbook !== 'Scalp') continue;
  if ((row.metrics?.trades || 0) < 2) continue;
  const fullKey = `${row.symbol}|${JSON.stringify(row.combo)}`;
  const validationKey = validationComboKey(row.symbol, row.combo);
  const train = trainByCombo.get(validationKey);
  if (!train) continue;
  const tradeRows = testTrades.get(fullKey) || [];
  const actual = aggregateTradeRows(tradeRows);
  const recent = recentMetrics(tradeRows);
  const routeKey = routeId(row);
  const forward = forwardByRoute.get(routeKey) || { trades: 0, winRate: 0, netDollars: 0, profitFactor: 0 };
  const testMetrics = actual.trades > 0
    ? { ...compact(row.metrics), ...actual }
    : compact(row.metrics);
  const route = {
    id: routeKey,
    symbol: row.symbol,
    family: family(row.symbol),
    session: row.combo.session,
    sessionBucket: sessionBucket(row.combo.session),
    direction: row.combo.direction,
    triggerMode: row.combo.triggerMode,
    combo: row.combo,
    train: compact(train.metrics),
    test: testMetrics,
    stress: stressByCombo.has(validationKey) ? compact(stressByCombo.get(validationKey).metrics) : null,
    recent,
    forward,
  };
  route.robustness = routeRobustness(tradeRows, route);
  route.features = featureVector(row, 'holdout', recent, forward);
  route.score = routeScore(route);
  route.overfitPenalty = Math.max(0, route.train.winRate - route.test.winRate);
  route.liveBacktestGap = route.forward.trades > 0 ? route.test.winRate - route.forward.winRate : null;
  route.noTradeReasons = [];
  if (route.test.trades < minRouteTrades) route.noTradeReasons.push(`sample<${minRouteTrades}`);
  if (route.robustness.uniqueDays < minRouteDays) route.noTradeReasons.push(`days<${minRouteDays}`);
  if (route.robustness.uniqueWeeks < minRouteWeeks) route.noTradeReasons.push(`weeks<${minRouteWeeks}`);
  if (route.robustness.profitConsistencyScore < 55) route.noTradeReasons.push('inconsistent_daily_profit');
  if (route.robustness.weekConsistencyScore < 50) route.noTradeReasons.push('inconsistent_weekly_profit');
  if (route.robustness.monteCarloSurvivalRate < 62) route.noTradeReasons.push('monte_carlo_weak');
  if (route.robustness.outlierDependence > 0.55) route.noTradeReasons.push('outlier_dependent');
  if (route.robustness.outlierCappedReturnRatio < 0.45) route.noTradeReasons.push('outlier_cap_failed');
  if (route.robustness.rollingWindowScore < 50) route.noTradeReasons.push('rolling_walk_forward_weak');
  if (route.robustness.maeReject) route.noTradeReasons.push('mae_too_large');
  if (route.robustness.lateEntryRisk) route.noTradeReasons.push('late_entry_chase');
  if (route.robustness.failedBreakoutRisk) route.noTradeReasons.push('failed_breakout_risk');
  if (route.robustness.trendExhaustionRisk) route.noTradeReasons.push('trend_exhaustion');
  if (route.robustness.liquidityKill) route.noTradeReasons.push('cost_after_spread_too_small');
  if (route.robustness.earningsBlackout) route.noTradeReasons.push('earnings_blackout_candidate');
  route.status = route.forward.trades > 0 && route.forward.winRate < Math.max(45, route.test.winRate - 25)
    ? 'quarantined_forward_gap'
    : route.noTradeReasons.length > 0
      ? 'research_only'
      : route.test.netDollars <= 0 || route.stress?.netDollars <= 0
      ? 'research_only'
      : 'candidate';
  routeCandidates.push(route);
}

const validatedRoutes = routeCandidates
  .filter((route) => route.status === 'candidate')
  .filter((route) => route.test.winRate >= 58 && route.test.netDollars > 0 && route.test.profitFactor >= 1)
  .sort((a, b) => b.score - a.score);

const routeGroups = {
  highWin: validatedRoutes.filter((route) => route.test.winRate >= 75 && route.test.trades >= 3),
  profitMax: validatedRoutes.filter((route) => route.test.avgDollars >= 250 && route.test.netDollars > 0),
  lowDrawdown: validatedRoutes.filter((route) => route.test.maxLossStreak <= 1 && route.test.maxDrawdownDollars <= 1500),
  forwardProven: validatedRoutes.filter((route) => route.forward.trades >= 2 && route.forward.netDollars > 0),
  optionsWorthy: validatedRoutes.filter((route) => route.test.optionWorthyRate >= 10 || route.test.avgMfeR >= 1.2),
  openOnly: validatedRoutes.filter((route) => route.sessionBucket === 'first_30' || route.sessionBucket === 'late_open'),
  powerHour: validatedRoutes.filter((route) => route.sessionBucket === 'power_hour'),
};

function pickPortfolio(routes, maxRoutes = 80) {
  const picked = [];
  const usedSymbolSession = new Set();
  const familyCounts = new Map();
  const symbolCounts = new Map();
  const clusterCounts = new Map();
  const timeConflictKeys = new Set();
  for (const route of routes) {
    const key = `${route.symbol}|${route.sessionBucket}|${route.direction}`;
    const fCount = familyCounts.get(route.family) || 0;
    const sCount = symbolCounts.get(route.symbol) || 0;
    const cluster = correlationCluster(route.symbol);
    const cCount = clusterCounts.get(cluster) || 0;
    const conflictKey = `${route.session}|${route.direction}|${route.triggerMode}`;
    if (usedSymbolSession.has(key)) continue;
    if (timeConflictKeys.has(conflictKey) && route.score < 340) continue;
    if (fCount >= 12) continue;
    if (sCount >= maxSymbolRoutes) continue;
    if (cCount >= maxClusterRoutes) continue;
    picked.push(route);
    usedSymbolSession.add(key);
    timeConflictKeys.add(conflictKey);
    familyCounts.set(route.family, fCount + 1);
    symbolCounts.set(route.symbol, sCount + 1);
    clusterCounts.set(cluster, cCount + 1);
    if (picked.length >= maxRoutes) break;
  }
  return picked;
}

function positionScale(route) {
  const forwardBoost = route.forward.trades > 0 && route.forward.netDollars > 0 ? 0.2 : 0;
  const quality = route.score / 380;
  const consistency = route.robustness.profitConsistencyScore / 100;
  const drawdownDrag = Math.min(route.robustness.monteCarloMedianDrawdown / 2500, 0.35);
  return Math.max(0.25, Math.min(1.35, 0.45 + quality * 0.35 + consistency * 0.25 + forwardBoost - drawdownDrag));
}

function portfolioMetrics(routes) {
  const trades = routes.reduce((sum, route) => sum + route.test.trades, 0);
  const wins = routes.reduce((sum, route) => sum + (route.test.wins ?? route.test.trades * route.test.winRate / 100), 0);
  const netDollars = routes.reduce((sum, route) => sum + route.test.netDollars, 0);
  const grossWin = routes.reduce((sum, route) => sum + (route.test.grossWin ?? Math.max(route.test.netDollars, 0)), 0);
  const grossLoss = routes.reduce((sum, route) => sum + (route.test.grossLoss ?? Math.abs(Math.min(route.test.netDollars, 0))), 0);
  const projectedNet = netDollars * projectionCapital / capital;
  return {
    routes: routes.length,
    trades,
    winRate: trades ? wins / trades * 100 : 0,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? 999 : 0),
    netDollars,
    projectedNet,
    projectedAvgDollars: trades ? projectedNet / trades : 0,
    avgDollars: trades ? netDollars / trades : 0,
    avgScore: routes.length ? routes.reduce((sum, route) => sum + route.score, 0) / routes.length : 0,
    avgPositionScale: routes.length ? routes.reduce((sum, route) => sum + positionScale(route), 0) / routes.length : 0,
    avgMonteCarloSurvival: routes.length ? routes.reduce((sum, route) => sum + route.robustness.monteCarloSurvivalRate, 0) / routes.length : 0,
    avgUniqueDays: routes.length ? routes.reduce((sum, route) => sum + route.robustness.uniqueDays, 0) / routes.length : 0,
  };
}

function championScore(metrics) {
  if (!metrics || !metrics.trades) return 0;
  return (
    metrics.winRate * 1.2
    + Math.min(metrics.projectedNet / 100, 260)
    + Math.min(metrics.trades, 650) * 0.16
    + Math.min(metrics.profitFactor, 10) * 7
    + Math.min(metrics.avgMonteCarloSurvival || 0, 100) * 0.25
    + Math.min(metrics.avgUniqueDays || 0, 8) * 2.5
  );
}

const portfolios = Object.fromEntries(Object.entries(routeGroups).map(([name, routes]) => {
  const picked = pickPortfolio(routes.sort((a, b) => b.score - a.score), name === 'powerHour' ? 35 : 90);
  return [name, { name, metrics: portfolioMetrics(picked), routes: picked }];
}));
const balancedRoutes = pickPortfolio(validatedRoutes, 120);
portfolios.balanced = { name: 'balanced', metrics: portfolioMetrics(balancedRoutes), routes: balancedRoutes };

const champion = Object.values(portfolios)
  .filter((portfolio) => portfolio.metrics.trades >= minChampionTrades)
  .sort((a, b) => (
    b.metrics.winRate * 1.5
    + Math.min(b.metrics.projectedNet / 100, 250)
    + Math.min(b.metrics.trades, 500) * 0.08
    + Math.min(b.metrics.profitFactor, 10) * 8
  ) - (
    a.metrics.winRate * 1.5
    + Math.min(a.metrics.projectedNet / 100, 250)
    + Math.min(a.metrics.trades, 500) * 0.08
    + Math.min(a.metrics.profitFactor, 10) * 8
  ))[0] || portfolios.balanced;

const importance = featureImportance(validatedRoutes);
const calibration = confidenceCalibration(validatedRoutes);
const routeModelPath = join(modelsDir, 'current-master-scalp-learning-model.json');
const championPath = join(modelsDir, 'current-master-scalp-champion.json');
const registryPath = join(modelsDir, 'master-scalp-champion-registry.json');
const pinePath = join(generatedDir, 'master_scalp_champion_export.json');
const historyPath = join(modelsDir, 'master-scalp-learning-history.jsonl');
const runStamp = new Date().toISOString().replace(/[:.]/g, '-');
const championSnapshotPath = join(modelsDir, `master-scalp-champion-${runStamp}.json`);
const modelSnapshotPath = join(modelsDir, `master-scalp-learning-model-${runStamp}.json`);

const payload = {
  updatedAt: new Date().toISOString(),
  sprint: 'master-scalp-learning',
  scope: {
    symbols: symbols.length,
    interval,
    range,
    capital,
    projectionCapital,
    quick,
    freshData,
    triggerModes,
    sessionGrid: listArg(sessionGrid),
    minConfGrid: listArg(minConfGrid).map(Number),
    minChampionTrades,
    targetGrid: listArg(targetGrid).map(Number),
    timeStopGrid: listArg(timeStopGrid).map(Number),
    trailGrid: listArg(trailGrid).map(Number),
    partialGrid: listArg(partialGrid).map(Number),
    confidenceDropGrid: listArg(confidenceDropGrid).map(Number),
    structureExitGrid: listArg(structureExitGrid),
  },
  sourcePaths: {
    trainSummaryPath,
    testSummaryPath,
    stressSummaryPath,
    backtestLedgerPath,
    validateOutputTail: validateOutput.trim().split('\n').slice(-12),
  },
  totals: {
    routeCandidates: routeCandidates.length,
    validatedRoutes: validatedRoutes.length,
    quarantinedRoutes: routeCandidates.filter((route) => route.status === 'quarantined_forward_gap').length,
    researchOnlyRoutes: routeCandidates.filter((route) => route.status === 'research_only').length,
    blockedByReason: routeCandidates.reduce((acc, route) => {
      for (const reason of route.noTradeReasons || []) acc[reason] = (acc[reason] || 0) + 1;
      return acc;
    }, {}),
  },
  confidenceCalibration: calibration,
  featureImportance: importance,
  portfolios: Object.fromEntries(Object.entries(portfolios).map(([name, portfolio]) => [name, {
    name,
    metrics: portfolio.metrics,
    routes: portfolio.routes.slice(0, 60),
  }])),
  champion: {
    name: champion.name,
    metrics: champion.metrics,
    routes: champion.routes.map((route) => ({ ...route, positionScale: positionScale(route) })),
  },
  quarantined: routeCandidates.filter((route) => route.status === 'quarantined_forward_gap').slice(0, 100),
};

writeFileSync(routeModelPath, `${JSON.stringify(payload, null, 2)}\n`);
writeFileSync(modelSnapshotPath, `${JSON.stringify(payload, null, 2)}\n`);

const runChampionFile = {
  updatedAt: payload.updatedAt,
  source: routeModelPath,
  champion: payload.champion,
  runScore: championScore(payload.champion.metrics),
  indicatorMetadata: {
    badge: payload.champion.routes.some((route) => route.forward.trades > 0) ? 'Forward Proven' : 'Backtest Only',
    noTradeZones: [
      'late-session routes require specialist validation',
      'quarantined forward-gap routes disabled',
      `minimum ${minRouteTrades} trades, ${minRouteDays} days, ${minRouteWeeks} weeks per promoted route`,
      `minimum ${minChampionTrades} trades for main champion promotion`,
      'routes blocked for weak Monte Carlo, outlier dependence, MAE, chase, earnings/news, or cost edge',
    ],
    dashboardRows: ['Route', 'Backtest WR', 'Forward WR', 'Calibrated Confidence', 'Why Fired', 'Why Blocked'],
    powerHourWarning: payload.portfolios.powerHour?.metrics?.trades ? 'Power-hour specialist only' : 'Power-hour quarantined',
  },
};
writeFileSync(championSnapshotPath, `${JSON.stringify(runChampionFile, null, 2)}\n`);

const registry = existsSync(registryPath)
  ? readJson(registryPath)
  : { updatedAt: payload.updatedAt, main: null, challengers: [] };
const previousMain = registry.main?.path && existsSync(registry.main.path)
  ? readJson(registry.main.path)
  : null;
const previousScore = previousMain ? championScore(previousMain.champion?.metrics) : 0;
const runScore = championScore(payload.champion.metrics);
const meetsChampionFloor = payload.champion.metrics.trades >= minChampionTrades;
const beatsPrevious = (!previousMain && meetsChampionFloor)
  || (meetsChampionFloor && runScore > previousScore)
  || (
    meetsChampionFloor
    &&
    payload.champion.metrics.winRate >= (previousMain.champion.metrics.winRate - 1.5)
    && payload.champion.metrics.netDollars >= previousMain.champion.metrics.netDollars * 1.12
    && payload.champion.metrics.trades >= previousMain.champion.metrics.trades * 0.75
  );
const publishedChampionFile = beatsPrevious ? runChampionFile : previousMain;
if (publishedChampionFile) writeFileSync(championPath, `${JSON.stringify(publishedChampionFile, null, 2)}\n`);

registry.updatedAt = payload.updatedAt;
registry.main = {
  updatedAt: publishedChampionFile?.updatedAt,
  path: beatsPrevious ? championSnapshotPath : registry.main?.path,
  name: publishedChampionFile?.champion?.name,
  score: championScore(publishedChampionFile?.champion?.metrics),
  metrics: publishedChampionFile?.champion?.metrics,
};
registry.challengers = [
  {
    updatedAt: payload.updatedAt,
    path: championSnapshotPath,
    modelPath: modelSnapshotPath,
    name: payload.champion.name,
    score: runScore,
    metrics: payload.champion.metrics,
    promoted: beatsPrevious,
  },
  ...(registry.challengers || []),
].slice(0, 50);
writeFileSync(registryPath, `${JSON.stringify(registry, null, 2)}\n`);

writeFileSync(pinePath, `${JSON.stringify({
  generatedAt: publishedChampionFile?.updatedAt || payload.updatedAt,
  championName: publishedChampionFile?.champion?.name || payload.champion.name,
  badge: publishedChampionFile?.champion?.routes?.some((route) => route.forward.trades > 0) ? 'Forward Proven' : 'Backtest Only',
  ui: {
    labelFormat: 'SIDE CONF% · ROUTE · TARGET',
    dashboardRows: [
      'Champion Badge',
      'Route Name',
      'Trigger Family',
      'Target Mode',
      'Backtest / Forward WR',
      'Calibrated Confidence',
      'Why Fired',
      'No-Trade Reason',
    ],
    noTradeFallback: 'No matching champion route for this symbol/session/direction',
  },
  routes: (publishedChampionFile?.champion?.routes || payload.champion.routes).map((route) => ({
    symbol: route.symbol,
    session: route.session,
    direction: route.direction,
    triggerMode: route.triggerMode,
    targetR: route.combo.targetR,
    timeStopBars: route.combo.timeStopBars,
    minConf: route.combo.minConf,
    partialR: route.combo.partialR,
    trailR: route.combo.trailR,
    confidenceDrop: route.combo.confidenceDrop,
    structureExit: route.combo.structureExit,
    targetMode: `T${Number(route.combo.targetR || 0).toFixed(2)}R · stop ${route.combo.timeStopBars} bars`,
    calibratedConfidence: Math.max(0, Math.min(100, route.test.winRate - Math.max(0, route.overfitPenalty || 0) - (route.liveBacktestGap && route.liveBacktestGap > 0 ? route.liveBacktestGap * 0.35 : 0))),
    backtestWinRate: route.test.winRate,
    forwardWinRate: route.forward.winRate || null,
    routeName: `${route.symbol} ${route.triggerMode} ${route.direction} ${route.session}`,
    labelText: `${route.triggerMode} · ${route.direction} · T${Number(route.combo.targetR || 0).toFixed(2)}R`,
    positionScale: positionScale(route),
    uniqueDays: route.robustness.uniqueDays,
    uniqueWeeks: route.robustness.uniqueWeeks,
    profitConsistencyScore: route.robustness.profitConsistencyScore,
    monteCarloSurvivalRate: route.robustness.monteCarloSurvivalRate,
    optionWorthyScore: route.robustness.optionWorthyScore,
    relativeStrengthProxy: route.robustness.relativeStrengthProxy,
    compressionScore: route.robustness.vwapEmaCompressionScore,
    noTradeZone: route.status !== 'candidate',
    noTradeReasons: route.noTradeReasons || [],
    noTradeReason: route.noTradeReasons?.[0] || 'not_blocked',
    whyFired: [
      `${route.triggerMode} trigger`,
      `${route.session} session specialist`,
      `${route.direction} route`,
      `WR ${route.test.winRate.toFixed(1)}%`,
      `MC ${route.robustness.monteCarloSurvivalRate.toFixed(1)}%`,
    ],
    whyBlocked: route.noTradeReasons?.length ? route.noTradeReasons : ['not_blocked'],
    dashboardSummary: `${route.triggerMode} | ${route.direction} | BT ${route.test.winRate.toFixed(1)}% | ${route.forward.winRate ? `FW ${route.forward.winRate.toFixed(1)}%` : 'FW n/a'} | ${route.combo.targetR}R`,
  })),
}, null, 2)}\n`);
appendFileSync(historyPath, `${JSON.stringify({
  event: 'master_sprint_completed',
  updatedAt: payload.updatedAt,
  champion: payload.champion.name,
  metrics: payload.champion.metrics,
  runScore,
  publishedChampion: publishedChampionFile?.champion?.name,
  publishedMetrics: publishedChampionFile?.champion?.metrics,
  publishedScore: championScore(publishedChampionFile?.champion?.metrics),
  totals: payload.totals,
  routeModelPath,
  modelSnapshotPath,
  championPath,
  championSnapshotPath,
  registryPath,
})}\n`);

console.log('\n=== master scalp learning champion ===');
console.log(`Model saved: ${routeModelPath}`);
console.log(`Model snapshot: ${modelSnapshotPath}`);
console.log(`Champion saved: ${championPath}`);
console.log(`Run champion snapshot: ${championSnapshotPath}`);
console.log(`Champion registry: ${registryPath}`);
console.log(`Pine metadata export: ${pinePath}`);
console.log(`Backtest ledger: ${backtestLedgerPath}`);
console.log(`Candidates=${payload.totals.routeCandidates} validated=${payload.totals.validatedRoutes} quarantined=${payload.totals.quarantinedRoutes}`);
for (const [name, portfolio] of Object.entries(portfolios)) {
  const m = portfolio.metrics;
  console.log(`${name}: routes=${m.routes} trades=${m.trades} win=${m.winRate.toFixed(2)} pf=${m.profitFactor.toFixed(2)} net=$${m.netDollars.toFixed(0)} projected=$${m.projectedNet.toFixed(0)} avg=$${m.projectedAvgDollars.toFixed(2)}`);
}
console.log(`${beatsPrevious ? 'PROMOTED' : 'RETAINED MAIN'} ${publishedChampionFile.champion.name}: trades=${publishedChampionFile.champion.metrics.trades} win=${publishedChampionFile.champion.metrics.winRate.toFixed(2)} pf=${publishedChampionFile.champion.metrics.profitFactor.toFixed(2)} net=$${publishedChampionFile.champion.metrics.netDollars.toFixed(0)} projected=$${publishedChampionFile.champion.metrics.projectedNet.toFixed(0)}`);
if (!beatsPrevious) {
  console.log(`Specialist challenger kept: ${champion.name}: trades=${champion.metrics.trades} win=${champion.metrics.winRate.toFixed(2)} pf=${champion.metrics.profitFactor.toFixed(2)} net=$${champion.metrics.netDollars.toFixed(0)} projected=$${champion.metrics.projectedNet.toFixed(0)}`);
}
