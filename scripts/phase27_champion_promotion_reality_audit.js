#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

const paths = {
  phase26: join(root, 'models', 'generalization', 'current-phase26-generalization-engine.json'),
  phase26Ledgers: join(root, 'apps', 'dashboard', 'public', 'data', 'phase26-generalization-trade-ledgers.json'),
  pine: join(root, 'generated', 'fusionv3_codex_clean_tradingview.pine'),
  activeModes: join(root, 'models', 'registry', 'current-active-scalp-modes.json'),
  models: join(root, 'models', 'promotions'),
  reports: join(root, 'reports', 'promotions'),
  optionsModels: join(root, 'models', 'options'),
  optionsReports: join(root, 'reports', 'options'),
  dashboardData: join(root, 'apps', 'dashboard', 'public', 'data'),
  generated: join(root, 'generated'),
};

for (const path of [paths.models, paths.reports, paths.optionsModels, paths.optionsReports, paths.dashboardData, paths.generated]) {
  mkdirSync(path, { recursive: true });
}

const args = new Map(process.argv.slice(2).map((arg) => {
  const [key, value = 'true'] = arg.replace(/^--/, '').split('=');
  return [key, value];
}));

const phase26 = readJson(paths.phase26);
const phase26Ledgers = readJson(paths.phase26Ledgers, { ledgers: {}, categoryMap: {} });
if (!phase26) throw new Error(`Missing Phase26 model: ${paths.phase26}`);

function readJson(path, fallback = null) {
  if (!existsSync(path)) return fallback;
  return JSON.parse(readFileSync(path, 'utf8'));
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

function moneyK(value) {
  return Math.round(n(value, 0) / 1000);
}

function uniq(items) {
  return [...new Set(items.filter(Boolean))];
}

function minutesHeld(trade) {
  if (trade.minutesHeld !== undefined && trade.minutesHeld !== null) return n(trade.minutesHeld, 0);
  const entry = n(trade.entryTime, 0);
  const exit = n(trade.exitTime, 0);
  if (!entry || !exit) return 0;
  const entryMs = entry > 100000000000 ? entry : entry * 1000;
  const exitMs = exit > 100000000000 ? exit : exit * 1000;
  return Math.max(0, Math.round((exitMs - entryMs) / 60000));
}

function compactMetrics(metrics = {}) {
  return {
    trades: metrics.trades || 0,
    winRate: metrics.winRate || 0,
    netDollars: metrics.netDollars || 0,
    avgDollars: metrics.avgDollars || 0,
    profitFactor: metrics.profitFactor || 0,
    maxDrawdownDollars: metrics.maxDrawdownDollars || 0,
    maxLossStreak: metrics.maxLossStreak || 0,
    optionWorthyRate: metrics.optionWorthyRate || 0,
  };
}

function metricForPromotion(variant) {
  return {
    id: variant.id,
    layer: variant.layer,
    description: variant.description,
    decision: variant.decision,
    metrics: compactMetrics(variant.metrics),
    holdout: compactMetrics(variant.holdout),
    deepStress: compactMetrics(variant.deepStress),
    leaveOneSymbolOut: variant.leaveOneSymbolOut,
    leaveOneFamilyOut: variant.leaveOneFamilyOut,
    topSymbols: variant.topSymbols?.slice(0, 30) || [],
    topSetups: variant.topSetups?.slice(0, 12) || [],
    topRegimes: variant.topRegimes?.slice(0, 12) || [],
  };
}

const bestOverall = phase26.categoryChampions?.bestOverall;
const bestHighWin = phase26.categoryChampions?.bestHighWin;
const bestFreshSymbols = phase26.categoryChampions?.bestFreshSymbols;
const bestProfit = phase26.categoryChampions?.bestProfit;
if (!bestOverall) throw new Error('Phase26 bestOverall champion missing');

const bestOverallLedger = phase26Ledgers.ledgers?.[phase26Ledgers.categoryMap?.bestOverall];
if (!bestOverallLedger?.trades?.length) throw new Error('Phase26 bestOverall ledger missing');

function symbolStatsFromTrades(trades) {
  const rows = new Map();
  for (const trade of trades) {
    const row = rows.get(trade.symbol) || { symbol: trade.symbol, family: trade.family, trades: 0, wins: 0, netDollars: 0 };
    row.trades += 1;
    row.netDollars += n(trade.pnlDollars, 0);
    if (n(trade.pnlDollars, 0) > 0) row.wins += 1;
    rows.set(trade.symbol, row);
  }
  return [...rows.values()]
    .map((row) => ({ ...row, winRate: row.trades ? row.wins / row.trades * 100 : 0 }))
    .sort((a, b) => b.netDollars - a.netDollars);
}

const phase26Whitelist = symbolStatsFromTrades(bestOverallLedger.trades)
  .filter((row) => row.trades >= 2 || row.netDollars > 2000)
  .slice(0, 80)
  .map((row) => row.symbol)
  .join(',');

const safePromotionLayers = new Set([
  'route_durability_score',
  'setup_archetype_models',
  'recent_edge_decay',
  'mfe_mae_predictor',
  'volume_intent_model',
  'liquidity_quality_model',
  'vwap_gravity_model',
  'candle_anatomy_scoring',
  'relative_strength_matrix',
  'pattern_cluster_prototypes',
  'champion_fusion',
]);

const researchOnlyLayers = new Set([
  'counterfactual_timing_proxy',
]);

const auditFindings = [
  {
    area: 'orders',
    status: 'passed',
    severity: 'critical',
    finding: 'No broker/order API is called. All outputs are model, dashboard, Pine indicator metadata, and paper options estimates.',
  },
  {
    area: 'lookahead',
    status: safePromotionLayers.has(bestOverall.layer) ? 'passed' : 'blocked',
    severity: 'critical',
    finding: `Promoted Phase26 layer is ${bestOverall.layer}. It is treated as safe for Pine promotion because it uses train-derived route/setup/regime quality and entry-time features, not direct post-entry MFE/MAE selection.`,
  },
  {
    area: 'lookahead',
    status: 'research_only',
    severity: 'high',
    finding: 'The counterfactual_timing_proxy layer references post-entry MAE as a research proxy. It remains excluded from promotion and should not be used for live/Pine signal selection.',
  },
  {
    area: 'tradingview_parity',
    status: 'partial',
    severity: 'high',
    finding: 'Pine receives the Phase26 mode, metrics, whitelist, and conservative trigger fallback. Exact JS route-stat parity still requires closed-loop TradingView alert capture and forward paper comparison.',
  },
  {
    area: 'execution_realism',
    status: 'partial',
    severity: 'high',
    finding: 'Phase26 includes normal and deep cost stress. It still does not model real bid/ask queue position, halts, assignment, option IV crush, or broker fills.',
  },
  {
    area: 'forward_proof',
    status: 'needed',
    severity: 'high',
    finding: 'Phase26 is Backtest Promoted, not Forward Proven. It should be forward-shadowed before using it for discretionary decision support.',
  },
];

function replaceOrThrow(source, search, replacement) {
  if (source.includes(replacement)) return source;
  if (!source.includes(search)) throw new Error(`Pine patch failed. Missing: ${search.slice(0, 120)}`);
  return source.replace(search, replacement);
}

function patchPine() {
  let pine = readFileSync(paths.pine, 'utf8');
  pine = pine.replace('indicator("Sniper v03 Fusion v3.2 [KhanSaab]"', 'indicator("Sniper v03 Fusion v3.3 [KhanSaab]"');
  pine = pine.replace('"v03.2 · "', '"v03.3 · "');
  pine = replaceOrThrow(
    pine,
    'activeScalpMode = input.string("Auto Specialist", "Active scalp mode", options=["Auto Specialist","Phase24 Self-Improving Champion","Phase23 Intelligence Specialist","Champion Council Fusion","High Win Main","Phase17 High Win Router","Profit Max Specialist","Powerhour Momentum","Options Burst Specialist"], group=groupScalpOpt, tooltip="Auto Specialist lets the indicator choose between Phase24 Self-Improving, Phase23 Intelligence, Champion Council, High Win, Phase17, Powerhour, Profit Max, and Options Burst based on symbol/session/volatility. Manual choices force one specialist.")',
    'activeScalpMode = input.string("Auto Specialist", "Active scalp mode", options=["Auto Specialist","Phase26 Generalization Champion","Phase26 High Win","Phase26 Fresh Symbols","Phase24 Self-Improving Champion","Phase23 Intelligence Specialist","Champion Council Fusion","High Win Main","Phase17 High Win Router","Profit Max Specialist","Powerhour Momentum","Options Burst Specialist"], group=groupScalpOpt, tooltip="Auto Specialist now prioritizes Phase26 Generalization when the ticker is in the promoted whitelist, then falls back to Phase24/Phase23/Council/High Win/Phase17/Powerhour/Profit/Options specialists. Manual choices force one specialist.")'
  );
  if (!pine.includes('phase26BacktestWr')) {
    pine = replaceOrThrow(
      pine,
      'phase24Whitelist = input.string("RDDT,OPEN,EOSE,QS,ZS,AMC,AFRM,OKLO,PLTR,COIN,RBLX,OKTA,TSLL,AI,SOFI,PANW", "Phase24 ticker whitelist", group=groupScalpOpt)',
      `phase24Whitelist = input.string("RDDT,OPEN,EOSE,QS,ZS,AMC,AFRM,OKLO,PLTR,COIN,RBLX,OKTA,TSLL,AI,SOFI,PANW", "Phase24 ticker whitelist", group=groupScalpOpt)
phase26BacktestWr = input.float(${bestOverall.metrics.winRate.toFixed(1)}, "Phase26 Generalization WR %", minval=0.0, maxval=100.0, step=0.1, group=groupScalpOpt)
phase26HoldoutWr = input.float(${bestOverall.holdout.winRate.toFixed(1)}, "Phase26 holdout WR %", minval=0.0, maxval=100.0, step=0.1, group=groupScalpOpt)
phase26HighWinWr = input.float(${(bestHighWin?.metrics?.winRate || bestOverall.metrics.winRate).toFixed(1)}, "Phase26 High Win WR %", minval=0.0, maxval=100.0, step=0.1, group=groupScalpOpt)
phase26FreshWr = input.float(${(bestFreshSymbols?.metrics?.winRate || bestOverall.metrics.winRate).toFixed(1)}, "Phase26 Fresh Symbols WR %", minval=0.0, maxval=100.0, step=0.1, group=groupScalpOpt)
phase26SymbolOos = input.float(${bestOverall.leaveOneSymbolOut.positiveRate.toFixed(1)}, "Phase26 symbol OOS positive %", minval=0.0, maxval=100.0, step=0.1, group=groupScalpOpt)
phase26FamilyOos = input.float(${bestOverall.leaveOneFamilyOut.positiveRate.toFixed(1)}, "Phase26 family OOS positive %", minval=0.0, maxval=100.0, step=0.1, group=groupScalpOpt)
phase26NetK = input.float(${moneyK(bestOverall.metrics.netDollars).toFixed(0)}, "Phase26 modeled net ($k)", minval=-1000.0, maxval=10000.0, step=1.0, group=groupScalpOpt)
phase26Status = input.string("Backtest Promoted", "Phase26 status", options=["Watchlist","Backtest Only","Backtest Promoted","Forward Proven","Quarantined"], group=groupScalpOpt)
phase26TriggerMode = input.string("Hybrid Consensus", "Phase26 fallback trigger", options=["Base","EMA Cross","Score Cross","VWAP Reclaim","EMA Pullback","Breakout","Failed Reversal","Liquidity Sweep","Compression Pop","Trend Pullback Burst","Exhaustion Reversal","Relative Strength Reclaim","Momentum Acceleration","Mean Reversion","Trend Continuation","Squeeze Expansion","Volume Shock","Options Burst","Confirmed No-Repaint","Hybrid Consensus"], group=groupScalpOpt, tooltip="Phase26 promotes the safe route-durability generalization layer. Pine uses this fallback trigger while the closed-loop alert stores exact route evidence.")
phase26Whitelist = input.string("${phase26Whitelist}", "Phase26 ticker whitelist", group=groupScalpOpt, tooltip="Promoted Phase26 symbols from the generalization champion. Use with Backtest Promoted status until forward paper evidence is mature.")`
    );
  }
  pine = pine.replace('closedLoopModelId = input.string("fusionv3-phase19"', 'closedLoopModelId = input.string("fusionv3-phase26"');
  if (!pine.includes('phase26TickerOkRaw')) {
    pine = replaceOrThrow(
      pine,
      'bool phase24TickerOkRaw = f_csvHas(phase24Whitelist, syminfo.ticker)',
      'bool phase24TickerOkRaw = f_csvHas(phase24Whitelist, syminfo.ticker)\nbool phase26TickerOkRaw = f_csvHas(phase26Whitelist, syminfo.ticker)'
    );
  }
  pine = replaceOrThrow(
    pine,
    'string selectedScalpMode = autoMode and powerhourTickerOkRaw and autoInPowerhour and powerhourStatus != "Quarantined" ? "Powerhour Momentum" : autoMode and phase24TickerOkRaw and phase24Status == "Forward Proven" ? "Phase24 Self-Improving Champion" : autoMode and phase23TickerOkRaw and phase23Status != "Quarantined" ? "Phase23 Intelligence Specialist" : autoMode and councilTickerOkRaw and councilStatus != "Quarantined" ? "Champion Council Fusion" : autoMode and autoOptionsContext and optionsBurstStatus != "Quarantined" ? "Options Burst Specialist" : autoMode and phase17TickerOkRaw and phase17Status != "Quarantined" ? "Phase17 High Win Router" : autoMode and autoPreferProfit ? "Profit Max Specialist" : autoMode ? "High Win Main" : activeScalpMode',
    'string selectedScalpMode = autoMode and phase26TickerOkRaw and phase26Status != "Quarantined" ? "Phase26 Generalization Champion" : autoMode and powerhourTickerOkRaw and autoInPowerhour and powerhourStatus != "Quarantined" ? "Powerhour Momentum" : autoMode and phase24TickerOkRaw and phase24Status == "Forward Proven" ? "Phase24 Self-Improving Champion" : autoMode and phase23TickerOkRaw and phase23Status != "Quarantined" ? "Phase23 Intelligence Specialist" : autoMode and councilTickerOkRaw and councilStatus != "Quarantined" ? "Champion Council Fusion" : autoMode and autoOptionsContext and optionsBurstStatus != "Quarantined" ? "Options Burst Specialist" : autoMode and phase17TickerOkRaw and phase17Status != "Quarantined" ? "Phase17 High Win Router" : autoMode and autoPreferProfit ? "Profit Max Specialist" : autoMode ? "High Win Main" : activeScalpMode'
  );
  if (!pine.includes('bool phase26Mode')) {
    pine = replaceOrThrow(
      pine,
      'bool phase24Mode = selectedScalpMode == "Phase24 Self-Improving Champion"',
      'bool phase26Mode = selectedScalpMode == "Phase26 Generalization Champion" or selectedScalpMode == "Phase26 High Win" or selectedScalpMode == "Phase26 Fresh Symbols"\nbool phase26HighWinMode = selectedScalpMode == "Phase26 High Win"\nbool phase26FreshMode = selectedScalpMode == "Phase26 Fresh Symbols"\nbool phase24Mode = selectedScalpMode == "Phase24 Self-Improving Champion"'
    );
  }
  pine = replaceOrThrow(
    pine,
    'bool activeSpecialistTickerOk = powerhourMode ? powerhourTickerOkRaw : phase24Mode ? phase24TickerOkRaw : phase23Mode ? phase23TickerOkRaw : councilMode ? councilTickerOkRaw : phase17Mode ? phase17TickerOkRaw : true',
    'bool activeSpecialistTickerOk = powerhourMode ? powerhourTickerOkRaw : phase26Mode ? phase26TickerOkRaw : phase24Mode ? phase24TickerOkRaw : phase23Mode ? phase23TickerOkRaw : councilMode ? councilTickerOkRaw : phase17Mode ? phase17TickerOkRaw : true'
  );
  pine = replaceOrThrow(
    pine,
    'string effectiveScalpTriggerMode = powerhourMode ? "Momentum Acceleration" : phase24Mode ? phase24TriggerMode : phase23Mode ? phase23TriggerMode : councilMode ? councilTriggerMode : phase17Mode ? phase17TriggerMode : optionsBurstMode ? "Options Burst" : profitMaxMode ? "Options Burst" : scalpTriggerMode',
    'string effectiveScalpTriggerMode = powerhourMode ? "Momentum Acceleration" : phase26Mode ? phase26TriggerMode : phase24Mode ? phase24TriggerMode : phase23Mode ? phase23TriggerMode : councilMode ? councilTriggerMode : phase17Mode ? phase17TriggerMode : optionsBurstMode ? "Options Burst" : profitMaxMode ? "Options Burst" : scalpTriggerMode'
  );
  pine = replaceOrThrow(
    pine,
    'string effectiveScalpSession = powerhourMode ? "Power hour" : phase24Mode ? "All" : phase23Mode ? "All" : councilMode ? "All" : phase17Mode ? "Morning" : optionsBurstMode ? "Morning" : scalpSession',
    'string effectiveScalpSession = powerhourMode ? "Power hour" : phase26Mode ? "All" : phase24Mode ? "All" : phase23Mode ? "All" : councilMode ? "All" : phase17Mode ? "Morning" : optionsBurstMode ? "Morning" : scalpSession'
  );
  pine = replaceOrThrow(
    pine,
    'bool effectiveScalpRequireConfRising = powerhourMode or phase24Mode or phase23Mode or councilMode or phase17Mode or optionsBurstMode ? true : scalpRequireConfRising',
    'bool effectiveScalpRequireConfRising = powerhourMode or phase26Mode or phase24Mode or phase23Mode or councilMode or phase17Mode or optionsBurstMode ? true : scalpRequireConfRising'
  );
  pine = replaceOrThrow(
    pine,
    'int effectiveScalpMinAlphaQuality = powerhourMode ? 55 : phase24Mode ? 60 : phase23Mode ? 70 : councilMode ? 60 : phase17Mode ? 65 : optionsBurstMode ? 65 : profitMaxMode ? 55 : scalpMinAlphaQuality',
    'int effectiveScalpMinAlphaQuality = powerhourMode ? 55 : phase26Mode ? 70 : phase24Mode ? 60 : phase23Mode ? 70 : councilMode ? 60 : phase17Mode ? 65 : optionsBurstMode ? 65 : profitMaxMode ? 55 : scalpMinAlphaQuality'
  );
  pine = replaceOrThrow(
    pine,
    'bool effectiveScalpUseAlphaQuality = powerhourMode or phase24Mode or phase23Mode or councilMode or phase17Mode or optionsBurstMode ? true : scalpUseAlphaQuality',
    'bool effectiveScalpUseAlphaQuality = powerhourMode or phase26Mode or phase24Mode or phase23Mode or councilMode or phase17Mode or optionsBurstMode ? true : scalpUseAlphaQuality'
  );
  pine = replaceOrThrow(
    pine,
    'float effectiveScalpTargetR = powerhourMode ? 0.50 : phase24Mode ? 0.75 : phase23Mode ? 0.50 : councilMode ? 0.50 : phase17Mode ? 0.50 : optionsBurstMode ? 0.75 : profitMaxMode ? 0.75 : tpLadderRR',
    'float effectiveScalpTargetR = powerhourMode ? 0.50 : phase26Mode ? 0.75 : phase24Mode ? 0.75 : phase23Mode ? 0.50 : councilMode ? 0.50 : phase17Mode ? 0.50 : optionsBurstMode ? 0.75 : profitMaxMode ? 0.75 : tpLadderRR'
  );
  pine = replaceOrThrow(
    pine,
    'int effectiveRuntimeMinConf = powerhourMode ? 70 : phase24Mode ? 70 : phase23Mode ? 75 : councilMode ? 70 : phase17Mode ? 75 : optionsBurstMode ? 80 : profitMaxMode ? 70 : runtimeMinConf',
    'int effectiveRuntimeMinConf = powerhourMode ? 70 : phase26Mode ? 75 : phase24Mode ? 70 : phase23Mode ? 75 : councilMode ? 70 : phase17Mode ? 75 : optionsBurstMode ? 80 : profitMaxMode ? 70 : runtimeMinConf'
  );
  pine = replaceOrThrow(
    pine,
    'string effectiveChampionRouteName = powerhourMode ? "Powerhour Momentum · whitelist" : phase24Mode ? "Phase24 Self-Improving · promoted route" : phase23Mode ? "Phase23 Intelligence · structure gates" : councilMode ? "Champion Council Fusion · Phase19" : phase17Mode ? "Phase17 High Win Router" : optionsBurstMode ? "Options Burst Specialist" : profitMaxMode ? "Profit Max Specialist" : highWinMode ? "High Win Main" : championRouteName',
    'string effectiveChampionRouteName = powerhourMode ? "Powerhour Momentum · whitelist" : phase26HighWinMode ? "Phase26 High Win · setup archetype" : phase26FreshMode ? "Phase26 Fresh Symbols · recent edge" : phase26Mode ? "Phase26 Generalization · route durability" : phase24Mode ? "Phase24 Self-Improving · promoted route" : phase23Mode ? "Phase23 Intelligence · structure gates" : councilMode ? "Champion Council Fusion · Phase19" : phase17Mode ? "Phase17 High Win Router" : optionsBurstMode ? "Options Burst Specialist" : profitMaxMode ? "Profit Max Specialist" : highWinMode ? "High Win Main" : championRouteName'
  );
  pine = replaceOrThrow(
    pine,
    'string effectiveChampionTargetMode = powerhourMode ? "0.50R smart scalp" : phase24Mode ? "0.75R self-improved target" : phase23Mode ? "0.50R intelligence guarded" : councilMode ? "0.50R profit-guarded fusion" : phase17Mode ? "0.50R high-win route" : optionsBurstMode ? "0.75R options burst" : profitMaxMode ? "0.75R profit max" : championTargetMode',
    'string effectiveChampionTargetMode = powerhourMode ? "0.50R smart scalp" : phase26HighWinMode ? "0.35R high-win guarded" : phase26Mode ? "0.75R generalization target" : phase24Mode ? "0.75R self-improved target" : phase23Mode ? "0.50R intelligence guarded" : councilMode ? "0.50R profit-guarded fusion" : phase17Mode ? "0.50R high-win route" : optionsBurstMode ? "0.75R options burst" : profitMaxMode ? "0.75R profit max" : championTargetMode'
  );
  pine = replaceOrThrow(
    pine,
    'float effectiveChampionBacktestWr = powerhourMode ? powerhourBacktestWr : phase24Mode ? phase24BacktestWr : phase23Mode ? phase23BacktestWr : councilMode ? councilBacktestWr : phase17Mode ? phase17BacktestWr : optionsBurstMode ? optionsBurstBacktestWr : profitMaxMode ? profitMaxBacktestWr : highWinMode ? highWinBacktestWr : championBacktestWr',
    'float effectiveChampionBacktestWr = powerhourMode ? powerhourBacktestWr : phase26HighWinMode ? phase26HighWinWr : phase26FreshMode ? phase26FreshWr : phase26Mode ? phase26BacktestWr : phase24Mode ? phase24BacktestWr : phase23Mode ? phase23BacktestWr : councilMode ? councilBacktestWr : phase17Mode ? phase17BacktestWr : optionsBurstMode ? optionsBurstBacktestWr : profitMaxMode ? profitMaxBacktestWr : highWinMode ? highWinBacktestWr : championBacktestWr'
  );
  pine = replaceOrThrow(
    pine,
    'float effectiveChampionForwardWr = powerhourMode ? powerhourHoldoutWr : phase24Mode ? phase24HoldoutWr : phase23Mode ? phase23HoldoutWr : councilMode ? councilForwardWr : phase17Mode ? phase17ForwardWr : optionsBurstMode ? optionsBurstForwardWr : profitMaxMode ? profitMaxForwardWr : highWinMode ? highWinForwardWr : championForwardWr',
    'float effectiveChampionForwardWr = powerhourMode ? powerhourHoldoutWr : phase26Mode ? phase26HoldoutWr : phase24Mode ? phase24HoldoutWr : phase23Mode ? phase23HoldoutWr : councilMode ? councilForwardWr : phase17Mode ? phase17ForwardWr : optionsBurstMode ? optionsBurstForwardWr : profitMaxMode ? profitMaxForwardWr : highWinMode ? highWinForwardWr : championForwardWr'
  );
  pine = replaceOrThrow(
    pine,
    'string effectiveChampionStatus = powerhourMode ? powerhourStatus : phase24Mode ? phase24Status : phase23Mode ? phase23Status : councilMode ? councilStatus : phase17Mode ? phase17Status : optionsBurstMode ? optionsBurstStatus : profitMaxMode ? profitMaxStatus : highWinMode ? highWinStatus : championBadge',
    'string effectiveChampionStatus = powerhourMode ? powerhourStatus : phase26Mode ? phase26Status : phase24Mode ? phase24Status : phase23Mode ? phase23Status : councilMode ? councilStatus : phase17Mode ? phase17Status : optionsBurstMode ? optionsBurstStatus : profitMaxMode ? profitMaxStatus : highWinMode ? highWinStatus : championBadge'
  );
  pine = replaceOrThrow(
    pine,
    'string modeProof = selectedScalpMode == "High Win Main" ? "BT " + str.tostring(highWinBacktestWr, "#.#") + "% · FW " + str.tostring(highWinForwardWr, "#.#") + "%" : selectedScalpMode == "Phase24 Self-Improving Champion" ? "BT " + str.tostring(phase24BacktestWr, "#.#") + "% · holdout " + str.tostring(phase24HoldoutWr, "#.#") + "% · net $" + str.tostring(phase24NetK, "#") + "k" : selectedScalpMode == "Phase23 Intelligence Specialist" ? "BT " + str.tostring(phase23BacktestWr, "#.#") + "% · holdout " + str.tostring(phase23HoldoutWr, "#.#") + "% · elite " + str.tostring(phase23EliteWr, "#.#") + "%" : selectedScalpMode == "Champion Council Fusion" ? "BT " + str.tostring(councilBacktestWr, "#.#") + "% · holdout " + str.tostring(councilHoldoutWr, "#.#") + "% · FW " + (councilForwardWr > 0 ? str.tostring(councilForwardWr, "#.#") + "%" : "n/a") : selectedScalpMode == "Phase17 High Win Router" ? "BT " + str.tostring(phase17BacktestWr, "#.#") + "% · holdout " + str.tostring(phase17HoldoutWr, "#.#") + "% · FW " + str.tostring(phase17ForwardWr, "#.#") + "%" : selectedScalpMode == "Powerhour Momentum" ? "BT " + str.tostring(powerhourBacktestWr, "#.#") + "% · holdout " + str.tostring(powerhourHoldoutWr, "#.#") + "%" : selectedScalpMode == "Options Burst Specialist" ? "BT " + str.tostring(optionsBurstBacktestWr, "#.#") + "% · FW " + str.tostring(optionsBurstForwardWr, "#.#") + "%" : "BT " + str.tostring(profitMaxBacktestWr, "#.#") + "% · FW " + str.tostring(profitMaxForwardWr, "#.#") + "%"',
    'string modeProof = selectedScalpMode == "High Win Main" ? "BT " + str.tostring(highWinBacktestWr, "#.#") + "% · FW " + str.tostring(highWinForwardWr, "#.#") + "%" : phase26Mode ? "BT " + str.tostring(effectiveChampionBacktestWr, "#.#") + "% · holdout " + str.tostring(phase26HoldoutWr, "#.#") + "% · OOS " + str.tostring(phase26SymbolOos, "#.#") + "/" + str.tostring(phase26FamilyOos, "#.#") + "% · net $" + str.tostring(phase26NetK, "#") + "k" : selectedScalpMode == "Phase24 Self-Improving Champion" ? "BT " + str.tostring(phase24BacktestWr, "#.#") + "% · holdout " + str.tostring(phase24HoldoutWr, "#.#") + "% · net $" + str.tostring(phase24NetK, "#") + "k" : selectedScalpMode == "Phase23 Intelligence Specialist" ? "BT " + str.tostring(phase23BacktestWr, "#.#") + "% · holdout " + str.tostring(phase23HoldoutWr, "#.#") + "% · elite " + str.tostring(phase23EliteWr, "#.#") + "%" : selectedScalpMode == "Champion Council Fusion" ? "BT " + str.tostring(councilBacktestWr, "#.#") + "% · holdout " + str.tostring(councilHoldoutWr, "#.#") + "% · FW " + (councilForwardWr > 0 ? str.tostring(councilForwardWr, "#.#") + "%" : "n/a") : selectedScalpMode == "Phase17 High Win Router" ? "BT " + str.tostring(phase17BacktestWr, "#.#") + "% · holdout " + str.tostring(phase17HoldoutWr, "#.#") + "% · FW " + str.tostring(phase17ForwardWr, "#.#") + "%" : selectedScalpMode == "Powerhour Momentum" ? "BT " + str.tostring(powerhourBacktestWr, "#.#") + "% · holdout " + str.tostring(powerhourHoldoutWr, "#.#") + "%" : selectedScalpMode == "Options Burst Specialist" ? "BT " + str.tostring(optionsBurstBacktestWr, "#.#") + "% · FW " + str.tostring(optionsBurstForwardWr, "#.#") + "%" : "BT " + str.tostring(profitMaxBacktestWr, "#.#") + "% · FW " + str.tostring(profitMaxForwardWr, "#.#") + "%"'
  );
  pine = replaceOrThrow(
    pine,
    'color modeCol = effectiveChampionStatus == "Forward Proven" ? color.lime : effectiveChampionStatus == "Quarantined" ? color.red : selectedScalpMode == "High Win Main" or selectedScalpMode == "Phase24 Self-Improving Champion" or selectedScalpMode == "Phase23 Intelligence Specialist" or selectedScalpMode == "Champion Council Fusion" or selectedScalpMode == "Phase17 High Win Router" ? color.green : color.orange',
    'color modeCol = effectiveChampionStatus == "Forward Proven" ? color.lime : effectiveChampionStatus == "Quarantined" ? color.red : phase26Mode or selectedScalpMode == "High Win Main" or selectedScalpMode == "Phase24 Self-Improving Champion" or selectedScalpMode == "Phase23 Intelligence Specialist" or selectedScalpMode == "Champion Council Fusion" or selectedScalpMode == "Phase17 High Win Router" ? color.green : color.orange'
  );
  writeFileSync(paths.pine, pine);
}

function updateActiveModes() {
  const active = readJson(paths.activeModes, { updatedAt: null, defaultMode: 'high_win', activeModes: {} });
  active.updatedAt = new Date().toISOString();
  active.defaultMode = 'phase26_generalization';
  active.activeModes = active.activeModes || {};
  active.activeModes.phase26_generalization = {
    name: 'Phase26 Generalization Champion',
    status: 'backtest-promoted',
    mode: 'phase26_generalization',
    source: 'current-phase26-generalization-engine',
    description: 'Promoted route-durability generalization champion with unseen-symbol/family diagnostics and deep stress checks.',
    metrics: bestOverall.metrics,
    holdout: bestOverall.holdout,
    deepStress: bestOverall.deepStress,
    rules: {
      preferredUse: 'default research champion / TradingView label mode / paper alerts',
      activation: 'Backtest Promoted only; forward paper evidence required before Forward Proven status.',
      routeLayer: bestOverall.layer,
      targetMode: bestOverall.targetMode,
      requiredVotes: bestOverall.requiredVotes,
      whitelist: phase26Whitelist.split(','),
      noRealOrders: true,
    },
  };
  active.activeModes.phase26_high_win = {
    name: 'Phase26 High Win',
    status: 'watchlist-specialist',
    mode: 'phase26_high_win',
    source: 'current-phase26-generalization-engine',
    description: 'High-win Phase26 watchlist variant for stricter signals.',
    metrics: bestHighWin?.metrics || null,
    holdout: bestHighWin?.holdout || null,
    rules: { preferredUse: 'manual high-win specialist mode', noRealOrders: true },
  };
  active.activeModes.phase26_fresh_symbols = {
    name: 'Phase26 Fresh Symbols',
    status: 'backtest-promoted-specialist',
    mode: 'phase26_fresh_symbols',
    source: 'current-phase26-generalization-engine',
    description: 'Fresh-symbol Phase26 specialist for ticker discovery and paper testing.',
    metrics: bestFreshSymbols?.metrics || null,
    holdout: bestFreshSymbols?.holdout || null,
    rules: { preferredUse: 'new ticker discovery / paper watchlist', noRealOrders: true },
  };
  writeJson(paths.activeModes, active);
  return active;
}

function optionPremium({ side, underlying, strike, dte, ivGuess }) {
  const time = Math.sqrt(Math.max(1, dte + 1) / 365);
  const moneyness = Math.abs(strike / Math.max(0.01, underlying) - 1);
  const intrinsic = side === 'call' ? Math.max(0, underlying - strike) : Math.max(0, strike - underlying);
  const extrinsic = underlying * ivGuess * time * 0.085 * Math.exp(-moneyness * 8);
  return Math.max(0.05, intrinsic + extrinsic);
}

function estimateOptionForRule(trade, rule) {
  const side = trade.side === 'short' ? 'put' : 'call';
  const entry = Math.max(0.01, n(trade.entry, 0));
  const exit = Math.max(0.01, n(trade.exit, entry));
  const heldDays = minutesHeld(trade) / 1440;
  const dte = rule.dte;
  if (dte + 0.05 < heldDays) return null;
  const strike = side === 'call' ? entry * (1 + rule.otmPct) : entry * (1 - rule.otmPct);
  const optionShape = trade.optionWorthy || (trade.tags || []).includes('options-worthy-burst') || trade.setup === 'options_burst'
    ? 1
    : clamp01(n(trade.mfeR, 0) / 2);
  const ivGuess = clamp(0.42 + 0.55 * optionShape + (entry < 20 ? 0.2 : 0), 0.35, 1.9);
  const entryPremium = optionPremium({ side, underlying: entry, strike, dte, ivGuess });
  const exitPremium = optionPremium({ side, underlying: exit, strike, dte: Math.max(0, dte - heldDays), ivGuess });
  const contracts10k = Math.floor(rule.capital / (entryPremium * 100));
  if (contracts10k <= 0) return null;
  const gross = contracts10k * (exitPremium - entryPremium) * 100;
  const estimatedSpread = contracts10k * Math.max(0.02, entryPremium * rule.spreadPct) * 100;
  const commission = contracts10k * rule.commissionPerContract * 2;
  const profitOnCapital = gross - estimatedSpread - commission;
  return {
    rule: rule.name,
    contractType: side,
    dte,
    otmPct: rule.otmPct,
    strike: Number(strike.toFixed(2)),
    entryPremium: Number(entryPremium.toFixed(2)),
    exitPremium: Number(exitPremium.toFixed(2)),
    contracts: contracts10k,
    capitalUsed: Number((contracts10k * entryPremium * 100).toFixed(2)),
    profitOnCapital,
    roiPct: contracts10k && entryPremium ? profitOnCapital / (contracts10k * entryPremium * 100) * 100 : 0,
    dataConfidence: 'Estimated',
  };
}

function chooseSystematicOptionRule(trade, rules) {
  const setup = trade.setup || '';
  const held = minutesHeld(trade);
  if (setup === 'options_burst' || trade.optionWorthy || (trade.tags || []).includes('options-worthy-burst')) {
    return held <= 60 ? rules.find((rule) => rule.name === 'fast_1dte_atm') : rules.find((rule) => rule.name === 'burst_3dte_1otm');
  }
  if (setup === 'liquidity_sweep_reclaim' || setup === 'vwap_reclaim') return rules.find((rule) => rule.name === 'reclaim_3dte_atm');
  if (held > 390) return rules.find((rule) => rule.name === 'swing_7dte_2otm');
  return rules.find((rule) => rule.name === 'balanced_3dte_atm');
}

function buildOptionsOverlay() {
  const capital = Number(args.get('options-capital') || 10000);
  const optionRules = [
    { name: 'fast_1dte_atm', dte: 1, otmPct: 0.0, capital, spreadPct: 0.08, commissionPerContract: 0.65 },
    { name: 'burst_3dte_1otm', dte: 3, otmPct: 0.01, capital, spreadPct: 0.08, commissionPerContract: 0.65 },
    { name: 'reclaim_3dte_atm', dte: 3, otmPct: 0.0, capital, spreadPct: 0.07, commissionPerContract: 0.65 },
    { name: 'balanced_3dte_atm', dte: 3, otmPct: 0.0, capital, spreadPct: 0.07, commissionPerContract: 0.65 },
    { name: 'swing_7dte_2otm', dte: 7, otmPct: 0.02, capital, spreadPct: 0.09, commissionPerContract: 0.65 },
  ];
  const candidates = bestOverallLedger.trades
    .filter((trade) => n(trade.pnlDollars, 0) > 0)
    .filter((trade) => trade.optionWorthy || trade.setup === 'options_burst' || n(trade.mfeR, 0) >= 1.0 || n(trade.specialistVotes, 0) >= 9)
    .filter((trade) => n(trade.entry, 0) >= 2);
  const rows = candidates.map((trade, index) => {
    const rule = chooseSystematicOptionRule(trade, optionRules);
    const system = estimateOptionForRule(trade, rule);
    const allRules = optionRules.map((item) => estimateOptionForRule(trade, item)).filter(Boolean);
    const bestRuleAtExit = [...allRules].sort((a, b) => b.profitOnCapital - a.profitOnCapital)[0] || system;
    return {
      rank: index + 1,
      symbol: trade.symbol,
      side: trade.side,
      setup: trade.setup,
      regime: trade.regime,
      date: trade.date,
      entryIso: trade.entryIso,
      exitIso: trade.exitIso,
      minutesHeld: trade.minutesHeld,
      equityEntry: trade.entry,
      equityExit: trade.exit,
      equityPnlOn100k: trade.pnlDollars,
      equityPnlOn10k: n(trade.pnlDollars, 0) * 0.10,
      mfeR: trade.mfeR,
      maeR: trade.maeR,
      specialistVotes: trade.specialistVotes,
      optionWorthy: trade.optionWorthy || (trade.tags || []).includes('options-worthy-burst') || trade.setup === 'options_burst',
      systematic: system,
      bestRuleAtExit,
      warning: 'Estimated options only. No live chain, historical bid/ask, IV surface, fills, assignment, or broker execution is modeled.',
    };
  }).filter((row) => row.systematic);
  const totals = rows.reduce((sum, row) => {
    sum.trades += 1;
    sum.equityPnlOn10k += n(row.equityPnlOn10k, 0);
    sum.systematicOptionsProfitOn10k += n(row.systematic?.profitOnCapital, 0);
    sum.bestRuleAtExitProfitOn10k += n(row.bestRuleAtExit?.profitOnCapital, 0);
    if (n(row.systematic?.profitOnCapital, 0) > 0) sum.systematicWins += 1;
    if (n(row.bestRuleAtExit?.profitOnCapital, 0) > 0) sum.bestRuleWins += 1;
    return sum;
  }, {
    trades: 0,
    systematicWins: 0,
    bestRuleWins: 0,
    equityPnlOn10k: 0,
    systematicOptionsProfitOn10k: 0,
    bestRuleAtExitProfitOn10k: 0,
  });
  totals.systematicWinRate = totals.trades ? totals.systematicWins / totals.trades * 100 : 0;
  totals.bestRuleWinRate = totals.trades ? totals.bestRuleWins / totals.trades * 100 : 0;
  totals.systematicMultiplierVsEquity10k = totals.equityPnlOn10k ? totals.systematicOptionsProfitOn10k / totals.equityPnlOn10k : 0;
  totals.bestRuleMultiplierVsEquity10k = totals.equityPnlOn10k ? totals.bestRuleAtExitProfitOn10k / totals.equityPnlOn10k : 0;
  return {
    updatedAt: new Date().toISOString(),
    phase: 'Phase27 Paper Options Overlay',
    safety: {
      paperOnly: true,
      noBrokerOrders: true,
      noAutoExecution: true,
      requiresManualReview: true,
    },
    source: {
      phase: 'phase26',
      category: 'bestOverall',
      modelId: bestOverall.id,
      ledgerId: bestOverallLedger.id,
    },
    config: {
      capital,
      rules: optionRules,
      selection: 'Phase26 winning trades with option-worthy setup, MFE >= 1R, or >= 9 specialist votes.',
    },
    totals,
    rows: rows
      .sort((a, b) => n(b.systematic?.profitOnCapital, 0) - n(a.systematic?.profitOnCapital, 0))
      .slice(0, 120),
    dataConfidence: {
      exactHistoricalContracts: 'not_available_in_this_run',
      estimatedBacktest: 'available',
      liveExecution: 'not_connected',
    },
  };
}

patchPine();
const activeModes = updateActiveModes();
const optionsOverlay = buildOptionsOverlay();

const promotion = {
  updatedAt: new Date().toISOString(),
  runId: `phase27-${new Date().toISOString().replace(/[:.]/g, '-')}`,
  phase: 'Phase27 Champion Promotion + Reality Audit',
  safety: {
    paperOnly: true,
    noBrokerOrders: true,
    pineIndicatorOnly: true,
    optionsOverlayIsEstimated: true,
  },
  promotedChampion: {
    modeName: 'Phase26 Generalization Champion',
    modelId: bestOverall.id,
    pineModelId: 'fusionv3-phase26',
    status: 'Backtest Promoted',
    safeToPromote: safePromotionLayers.has(bestOverall.layer),
    metrics: metricForPromotion(bestOverall),
    whitelist: phase26Whitelist.split(','),
  },
  specialistModes: {
    highWin: metricForPromotion(bestHighWin || bestOverall),
    freshSymbols: metricForPromotion(bestFreshSymbols || bestOverall),
    profitMax: metricForPromotion(bestProfit || bestOverall),
  },
  auditFindings,
  realityChecklist: [
    'Run TradingView closed-loop paper alerts for Phase26 before changing status to Forward Proven.',
    'Compare Pine alerts against Phase26 JS expected symbols, side, setup/regime, confidence, and target mode.',
    'Reject or quarantine symbols with live/paper divergence, clustered losses, or abnormal spread/volume.',
    'Treat all options overlay output as estimated until exact historical/live option chain data is connected.',
    'Never enable broker order placement from this repo without a separate explicit safety review and user confirmation.',
  ],
  activeModes: {
    defaultMode: activeModes.defaultMode,
    phase26: activeModes.activeModes.phase26_generalization,
  },
  optionsOverlaySummary: optionsOverlay.totals,
};

writeJson(join(paths.models, 'current-phase27-promotion-audit.json'), promotion);
writeJson(join(paths.reports, 'phase27-promotion-audit-report.json'), promotion);
writeJson(join(paths.dashboardData, 'phase27-promotion-audit.json'), promotion);
writeJson(join(paths.generated, 'phase27_promotion_export.json'), promotion);
writeJson(join(paths.optionsModels, 'current-phase27-options-overlay.json'), optionsOverlay);
writeJson(join(paths.optionsReports, 'phase27-options-overlay-report.json'), optionsOverlay);
writeJson(join(paths.dashboardData, 'phase27-options-overlay.json'), optionsOverlay);
writeJson(join(paths.generated, 'phase27_options_overlay_export.json'), optionsOverlay);

console.log('Phase27 Champion Promotion + Reality Audit complete');
console.log(`Promoted=${promotion.promotedChampion.modeName} safe=${promotion.promotedChampion.safeToPromote} model=${promotion.promotedChampion.modelId}`);
console.log(`Options overlay trades=${optionsOverlay.totals.trades} systematic=$${optionsOverlay.totals.systematicOptionsProfitOn10k.toFixed(0)} equity10k=$${optionsOverlay.totals.equityPnlOn10k.toFixed(0)} multiplier=${optionsOverlay.totals.systematicMultiplierVsEquity10k.toFixed(2)}x`);
