#!/usr/bin/env node
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const outDir = join(root, 'optimization-results');
const playbooksDir = join(outDir, 'models', 'playbooks');
const generatedDir = join(root, 'generated');
for (const dir of [playbooksDir, generatedDir]) mkdirSync(dir, { recursive: true });

const args = new Map(process.argv.slice(2).map((arg) => {
  const [key, value = 'true'] = arg.replace(/^--/, '').split('=');
  return [key, value];
}));

const runId = new Date().toISOString().replace(/[:.]/g, '-');
const interval = args.get('interval') || '5m';
const range = args.get('range') || '60d';
const capital = Number(args.get('capital') || 100000);
const projectionCapital = Number(args.get('projection-capital') || 10000);
const maxSymbols = Number(args.get('max-symbols') || 150);
const maxRoutes = Number(args.get('max-routes') || 70);
const maxConcurrent = Number(args.get('max-concurrent') || 5);
const freshData = args.get('fresh-data') === 'true';
const stressBps = Number(args.get('stress-bps') || 6);
const minRouteTrades = Number(args.get('min-route-trades') || 5);
const minRouteDays = Number(args.get('min-route-days') || 3);
const minHoldoutTrades = Number(args.get('min-holdout-trades') || 1);
const minChampionTrades = Number(args.get('min-champion-trades') || 120);
const minHoldoutWin = Number(args.get('min-holdout-win') || 55);
const minHoldoutPf = Number(args.get('min-holdout-pf') || 1.05);
const minHoldoutNet = Number(args.get('min-holdout-net') || 0);
const minRecentWin = Number(args.get('min-recent-win') || 50);
const maxRoutesPerFamily = Number(args.get('max-routes-per-family') || 14);
const maxRoutesPerFamilySession = Number(args.get('max-routes-per-family-session') || 7);
const maxRoutesPerArchetypeSession = Number(args.get('max-routes-per-archetype-session') || 10);
const maxRoutesPerTriggerSession = Number(args.get('max-routes-per-trigger-session') || 10);
const useForwardTrust = args.get('use-forward-trust') !== 'false';
const forwardTrustPath = args.get('forward-trust') || join(outDir, 'forward-tests', 'phase17-forward-route-trust.json');
const minForwardTrustTrades = Number(args.get('min-forward-trust-trades') || 1);
const minForwardTrustWin = Number(args.get('min-forward-trust-win') || 50);
const minForwardTrustNet = Number(args.get('min-forward-trust-net') || 0);
const forwardGapPenalty = Number(args.get('forward-gap-penalty') || 8);
const symbolFile = args.get('symbol-file') || join(root, 'config', 'scalp-symbols-expanded.txt');

function uniq(values) {
  return [...new Set(values.filter(Boolean))];
}

function readJson(path, fallback = null) {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return fallback;
  }
}

function readSymbols() {
  if (args.get('symbols')) return uniq(args.get('symbols').split(/[\s,]+/).map((symbol) => symbol.trim().toUpperCase())).slice(0, maxSymbols);
  const raw = readFileSync(symbolFile, 'utf8');
  return uniq(raw.split(/[\s,]+/).map((symbol) => symbol.trim().toUpperCase())).slice(0, maxSymbols);
}

const forwardTrust = useForwardTrust ? readJson(forwardTrustPath, { updatedAt: null, routes: {} }) : { updatedAt: null, routes: {} };

function blankForwardTrust(scope = 'none') {
  return {
    scope,
    trades: 0,
    wins: 0,
    winRate: 0,
    netDollars: 0,
    grossWin: 0,
    grossLoss: 0,
    profitFactor: 0,
    lastSeen: null,
  };
}

function mergeForwardTrust(base, item, scope) {
  const out = { ...blankForwardTrust(scope), ...base, scope };
  out.trades += item.trades || 0;
  out.wins += item.wins || 0;
  out.netDollars += item.netDollars || 0;
  out.grossWin += item.grossWin || 0;
  out.grossLoss += item.grossLoss || 0;
  out.lastSeen = !out.lastSeen || (item.lastSeen && item.lastSeen > out.lastSeen) ? item.lastSeen : out.lastSeen;
  out.winRate = out.trades ? out.wins / out.trades * 100 : 0;
  out.profitFactor = out.grossLoss > 0 ? out.grossWin / out.grossLoss : out.grossWin > 0 ? 999 : 0;
  return out;
}

function routeParts(id) {
  const [symbol, archetype, triggerMode, session, direction, targetR, timeStopBars, structureExit] = String(id).split('|');
  return { symbol, archetype, triggerMode, session, direction, targetR, timeStopBars, structureExit };
}

function buildForwardTrustIndex(trust) {
  const index = {
    exact: new Map(),
    familyDirection: new Map(),
    familyBothAware: new Map(),
    triggerSession: new Map(),
  };
  for (const [id, item] of Object.entries(trust?.routes || {})) {
    const parts = routeParts(id);
    const exactItem = {
      ...blankForwardTrust('exact'),
      ...item,
      scope: 'exact',
      winRate: item.winRate || (item.trades ? (item.wins || 0) / item.trades * 100 : 0),
      profitFactor: item.profitFactor || (item.grossLoss > 0 ? (item.grossWin || 0) / item.grossLoss : item.grossWin > 0 ? 999 : 0),
    };
    index.exact.set(id, exactItem);
    const keys = [
      ['familyDirection', `${parts.symbol}|${parts.triggerMode}|${parts.session}|${parts.direction}`],
      ['familyBothAware', `${parts.symbol}|${parts.triggerMode}|${parts.session}|both-aware`],
      ['triggerSession', `${parts.symbol}|${parts.triggerMode}|${parts.session}`],
    ];
    for (const [bucket, key] of keys) {
      index[bucket].set(key, mergeForwardTrust(index[bucket].get(key), exactItem, bucket));
    }
  }
  return index;
}

const forwardTrustIndex = buildForwardTrustIndex(forwardTrust);

const symbolFamilies = {
  semis: ['NVDA', 'AMD', 'AVGO', 'SMCI', 'MU', 'INTC', 'ARM', 'QCOM', 'MRVL', 'ON', 'AMAT', 'LRCX', 'KLAC', 'ASML', 'TSM', 'SMH', 'SOXL', 'SOXS', 'NVDL', 'TSLL'],
  crypto: ['COIN', 'MARA', 'RIOT', 'CLSK', 'WULF', 'CIFR', 'BTBT', 'HIVE', 'IREN', 'CAN', 'MSTR', 'CONL', 'MSTX', 'MSTU', 'IBIT', 'BITO', 'BITX'],
  ev: ['TSLA', 'RIVN', 'LCID', 'NIO', 'XPEV', 'LI', 'QS', 'CHPT', 'F', 'GM', 'BLNK', 'WKHS'],
  softwareAi: ['PLTR', 'AI', 'PATH', 'IONQ', 'RGTI', 'QBTS', 'CRM', 'ADBE', 'NOW', 'MDB', 'SNOW', 'DDOG', 'NET', 'CRWD', 'PANW', 'ZS', 'OKTA', 'APP', 'U', 'RDDT'],
  pennyMeme: ['OPEN', 'AMC', 'GME', 'KOSS', 'HOLO', 'BNGO', 'OCGN', 'PROK', 'SNDL', 'TLRY', 'CGC', 'ACB', 'BB', 'SPCE', 'FCEL', 'PLUG', 'SOUN', 'BBAI', 'ACHR', 'JOBY', 'EOSE'],
  etf: ['SPY', 'QQQ', 'IWM', 'DIA', 'XLK', 'XLF', 'XLE', 'XBI', 'ARKK', 'TQQQ', 'SQQQ', 'TLT', 'HYG', 'GLD', 'SLV', 'USO', 'UVXY'],
  travelConsumer: ['AAL', 'UAL', 'DAL', 'LUV', 'CCL', 'RCL', 'NCLH', 'ABNB', 'UBER', 'LYFT', 'DASH', 'DKNG', 'RBLX', 'ROKU'],
};

function family(symbol) {
  for (const [name, members] of Object.entries(symbolFamilies)) if (members.includes(symbol)) return name;
  return 'liquidMomentum';
}

function cluster(symbol) {
  const f = family(symbol);
  if (['semis', 'crypto', 'ev', 'softwareAi', 'pennyMeme', 'etf', 'travelConsumer'].includes(f)) return f;
  return 'other';
}

function baseCombo(overrides) {
  return {
    playbook: 'Scalp',
    minConf: 70,
    targetR: 0.5,
    exitMode: 'smart',
    trailR: 0.35,
    timeStopBars: 6,
    partialR: 0.5,
    confidenceDrop: 22,
    structureExit: 'loose',
    minLead: 65,
    minEdge: 12,
    minAtrRatio: 0.9,
    minAdx: 14,
    minEr: 0.1,
    volMult: 1.2,
    session: 'open-0930',
    direction: 'both',
    lossCooldownBars: 0,
    maxVwapAtr: 0,
    requireConfRising: true,
    slippageBps: 1,
    spreadBps: 2,
    minMoveToCost: 5,
    openingRange: 'off',
    htfMode: 'not-against50',
    volumeQuality: 'off',
    adaptiveTarget: false,
    maxConsecutiveLosses: 0,
    clusterCooldownBars: 0,
    minPrice: 1,
    maxPrice: 0,
    minDollarVolume: 500000,
    gapMode: 'off',
    dailyContext: 'off',
    pdLevelMode: 'off',
    marketMode: 'off',
    relVolMode: 'off',
    minRelVolTod: 1,
    peerMode: 'off',
    newsMode: 'off',
    alphaMode: 'specialist-blend',
    alphaWeightSet: 'default',
    minAlphaQuality: 55,
    minIntelScore: 0,
    positionSizing: 'fixed',
    minPositionScale: 1,
    maxPositionScale: 1,
    ...overrides,
  };
}

function buildCombos() {
  const routeFamilies = [
    {
      archetype: 'high_win_confirmed',
      triggers: ['confirmed-no-repaint', 'hybrid-consensus'],
      sessions: ['open-0930', 'open-1000', 'powerhour'],
      directions: ['both', 'long', 'short'],
      targets: [0.35, 0.5],
      config: { minConf: 75, minAlphaQuality: 65, timeStopBars: 6, trailR: 0.35, requireConfRising: true, structureExit: 'strict' },
    },
    {
      archetype: 'profit_momentum',
      triggers: ['momentum-acceleration', 'volume-shock', 'options-burst'],
      sessions: ['open-0930', 'morning', 'powerhour'],
      directions: ['both', 'long'],
      targets: [0.5, 0.75],
      config: { minConf: 70, minAlphaQuality: 55, timeStopBars: 9, trailR: 0.35, partialR: 1, requireConfRising: true, volMult: 1.2 },
    },
    {
      archetype: 'structure_reclaim',
      triggers: ['vwap-reclaim', 'failed-reversal', 'ema-pullback', 'relative-strength-reclaim'],
      sessions: ['open-1000', 'morning', 'afternoon'],
      directions: ['both', 'long', 'short'],
      targets: [0.35, 0.5],
      config: { minConf: 70, minAlphaQuality: 60, timeStopBars: 6, trailR: 0.35, htfMode: 'not-against50', marketMode: 'off' },
    },
    {
      archetype: 'breakout_expansion',
      triggers: ['breakout', 'opening-range', 'opening-drive-continuation', 'squeeze-expansion', 'compression-pop'],
      sessions: ['open-0930', 'open-1000', 'morning'],
      directions: ['both', 'long', 'short'],
      targets: [0.5, 0.75],
      config: { minConf: 70, minAlphaQuality: 60, timeStopBars: 9, trailR: 0.5, openingRange: 'off', dailyContext: 'range-expansion', volMult: 1.2 },
    },
    {
      archetype: 'reversal_sweep',
      triggers: ['liquidity-sweep', 'mean-reversion', 'failed-reversal'],
      sessions: ['open-1000', 'midday', 'afternoon'],
      directions: ['both', 'long', 'short'],
      targets: [0.35, 0.5],
      config: { minConf: 70, minAlphaQuality: 55, timeStopBars: 6, trailR: 0.35, structureExit: 'loose', minEr: 0.08 },
    },
  ];

  const combos = [];
  for (const routeFamily of routeFamilies) {
    for (const triggerMode of routeFamily.triggers) {
      for (const session of routeFamily.sessions) {
        for (const direction of routeFamily.directions) {
          for (const targetR of routeFamily.targets) {
            combos.push(baseCombo({
              ...routeFamily.config,
              archetype: routeFamily.archetype,
              triggerMode,
              session,
              direction,
              targetR,
            }));
          }
        }
      }
    }
  }
  return combos;
}

function runLocalBacktest(symbols, combos) {
  const comboPath = join(playbooksDir, `phase17-specialist-combos-${runId}.json`);
  writeFileSync(comboPath, `${JSON.stringify(combos, null, 2)}\n`);
  console.log(`Phase 17 tournament: ${symbols.length} symbols × ${combos.length} combos on ${interval}/${range}`);
  console.log(`Combo file: ${comboPath}`);
  const output = execFileSync('node', [
    'scripts/local_fusion_backtest.js',
    `--symbols=${symbols.join(',')}`,
    `--combo-file=${comboPath}`,
    `--range=${range}`,
    `--interval=${interval}`,
    `--capital=${capital}`,
    `--fresh-data=${freshData ? 'true' : 'false'}`,
    '--promote=false',
    '--sample=all',
    '--save-trades=true',
  ], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024 * 300,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  process.stdout.write(output.split('\n').slice(-16).join('\n'));
  if (!output.endsWith('\n')) process.stdout.write('\n');
  const summaryPath = output.match(/Summary: (.*\.json)/)?.[1];
  const tradesPath = output.match(/Trades: (.*\.jsonl)/)?.[1];
  if (!summaryPath || !tradesPath) throw new Error('local_fusion_backtest did not emit summary/trades paths');
  return { comboPath, summaryPath, tradesPath };
}

function dayKey(timestamp) {
  return new Date(timestamp * 1000).toISOString().slice(0, 10);
}

function weekKey(timestamp) {
  const date = new Date(timestamp * 1000);
  const start = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const day = Math.floor((date - start) / 86400000);
  return `${date.getUTCFullYear()}-W${String(Math.floor(day / 7) + 1).padStart(2, '0')}`;
}

function routeIdFor(row) {
  const combo = row.combo || {};
  return [
    row.symbol,
    combo.archetype || 'route',
    combo.triggerMode,
    combo.session,
    combo.direction,
    combo.targetR,
    combo.timeStopBars,
    combo.structureExit,
  ].join('|');
}

function normalizeTrade(row) {
  const trade = row.trade || {};
  const combo = row.combo || {};
  return {
    ...trade,
    symbol: row.symbol,
    combo,
    routeId: routeIdFor(row),
    archetype: combo.archetype || 'route',
    family: family(row.symbol),
    cluster: cluster(row.symbol),
    triggerMode: combo.triggerMode,
    session: combo.session,
    direction: combo.direction,
    targetR: combo.targetR,
    entryTime: trade.entryTime,
    exitTime: trade.exitTime,
    pnlDollars: trade.pnlDollars || 0,
    notional: trade.notional || capital,
    fastMoveR: Math.max(trade.move5mR || 0, trade.move10mR || 0, trade.move15mR || 0),
  };
}

function readTrades(path) {
  const raw = readFileSync(path, 'utf8').trim();
  if (!raw) return [];
  return raw.split('\n').filter(Boolean).map((line) => normalizeTrade(JSON.parse(line))).sort((a, b) => a.entryTime - b.entryTime);
}

function metrics(trades, extraBps = 0) {
  const adjusted = trades.map((trade) => ({
    ...trade,
    pnlDollars: trade.pnlDollars - trade.notional * extraBps / 10000,
  }));
  let equity = 0;
  let peak = 0;
  let grossWin = 0;
  let grossLoss = 0;
  let maxDrawdownDollars = 0;
  let maxLossStreak = 0;
  let lossStreak = 0;
  for (const trade of adjusted) {
    equity += trade.pnlDollars;
    if (trade.pnlDollars > 0) {
      grossWin += trade.pnlDollars;
      lossStreak = 0;
    } else {
      grossLoss += Math.abs(trade.pnlDollars);
      lossStreak += 1;
      maxLossStreak = Math.max(maxLossStreak, lossStreak);
    }
    peak = Math.max(peak, equity);
    maxDrawdownDollars = Math.max(maxDrawdownDollars, peak - equity);
  }
  const wins = adjusted.filter((trade) => trade.pnlDollars > 0).length;
  const netDollars = adjusted.reduce((sum, trade) => sum + trade.pnlDollars, 0);
  return {
    trades: adjusted.length,
    wins,
    losses: adjusted.length - wins,
    winRate: adjusted.length ? wins / adjusted.length * 100 : 0,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? 999 : 0,
    netDollars,
    projectedNet: netDollars * projectionCapital / capital,
    avgDollars: adjusted.length ? netDollars / adjusted.length : 0,
    projectedAvgDollars: adjusted.length ? netDollars * projectionCapital / capital / adjusted.length : 0,
    maxDrawdownDollars,
    maxLossStreak,
    avgMfeR: adjusted.length ? adjusted.reduce((sum, trade) => sum + (trade.mfeR || 0), 0) / adjusted.length : 0,
    avgMaeR: adjusted.length ? adjusted.reduce((sum, trade) => sum + (trade.maeR || 0), 0) / adjusted.length : 0,
    optionWorthyRate: adjusted.length ? adjusted.filter((trade) => trade.optionWorthy).length / adjusted.length * 100 : 0,
    fastMoveRate: adjusted.length ? adjusted.filter((trade) => trade.fastMoveR >= 0.5).length / adjusted.length * 100 : 0,
    uniqueDays: new Set(adjusted.map((trade) => dayKey(trade.entryTime))).size,
    uniqueWeeks: new Set(adjusted.map((trade) => weekKey(trade.entryTime))).size,
  };
}

function splitChronologically(trades) {
  const sorted = [...trades].sort((a, b) => a.entryTime - b.entryTime);
  const trainEnd = Math.floor(sorted.length * 0.55);
  const testEnd = Math.floor(sorted.length * 0.80);
  return {
    train: sorted.slice(0, trainEnd),
    test: sorted.slice(trainEnd, testEnd),
    holdout: sorted.slice(testEnd),
  };
}

function recentRows(trades) {
  const sorted = [...trades].sort((a, b) => a.entryTime - b.entryTime);
  const count = Math.min(sorted.length, Math.max(3, Math.ceil(sorted.length * 0.30)));
  return sorted.slice(-count);
}

function trustForRoute(id) {
  const parts = routeParts(id);
  const item = forwardTrustIndex.exact.get(id)
    || forwardTrustIndex.familyDirection.get(`${parts.symbol}|${parts.triggerMode}|${parts.session}|${parts.direction}`)
    || forwardTrustIndex.familyDirection.get(`${parts.symbol}|${parts.triggerMode}|${parts.session}|both`)
    || forwardTrustIndex.familyBothAware.get(`${parts.symbol}|${parts.triggerMode}|${parts.session}|both-aware`)
    || forwardTrustIndex.triggerSession.get(`${parts.symbol}|${parts.triggerMode}|${parts.session}`);
  if (!item) {
    return {
      scope: 'none',
      trades: 0,
      wins: 0,
      winRate: 0,
      netDollars: 0,
      profitFactor: 0,
      status: 'untested-forward',
    };
  }
  const forwardFailed = item.trades >= minForwardTrustTrades
    && (item.netDollars < minForwardTrustNet || item.winRate < minForwardTrustWin);
  const forwardProven = item.trades >= minForwardTrustTrades
    && item.netDollars >= minForwardTrustNet
    && item.winRate >= minForwardTrustWin;
  return {
    scope: item.scope || 'exact',
    trades: item.trades || 0,
    wins: item.wins || 0,
    winRate: item.winRate || 0,
    netDollars: item.netDollars || 0,
    profitFactor: item.profitFactor || 0,
    lastSeen: item.lastSeen || null,
    status: forwardFailed ? 'forward-quarantine' : forwardProven ? 'forward-confirmed' : 'forward-watch',
  };
}

function buildRoutes(trades) {
  const buckets = new Map();
  for (const trade of trades) {
    if (!buckets.has(trade.routeId)) buckets.set(trade.routeId, []);
    buckets.get(trade.routeId).push(trade);
  }
  return [...buckets.entries()].map(([id, rows]) => {
    const first = rows[0];
    const split = splitChronologically(rows);
    const routeMetrics = metrics(rows);
    const train = metrics(split.train);
    const test = metrics(split.test);
    const holdout = metrics(split.holdout);
    const recent = metrics(recentRows(rows));
    const stress = metrics(rows, stressBps);
    const trainTest = metrics([...split.train, ...split.test]);
    const trainTestStress = metrics([...split.train, ...split.test], stressBps);
    const forward = trustForRoute(id);
    const forwardFailed = forward.trades >= minForwardTrustTrades
      && (forward.netDollars < minForwardTrustNet || forward.winRate < minForwardTrustWin);
    const forwardGap = forward.trades > 0 ? Math.max(0, holdout.winRate - forward.winRate) : 0;
    const forwardScore = forward.trades > 0
      ? forward.winRate * 1.4
        + Math.min(forward.netDollars / 100, 20)
        + Math.min(forward.profitFactor, 8) * 9
        - forwardGap * forwardGapPenalty
        - (forward.netDollars < 0 ? Math.min(Math.abs(forward.netDollars) / 50, 40) : 0)
      : 0;
    const quarantineReasons = [];
    if (routeMetrics.trades < minRouteTrades) quarantineReasons.push('too few trades');
    if (routeMetrics.uniqueDays < minRouteDays) quarantineReasons.push('too few unique days');
    if (holdout.trades < minHoldoutTrades) quarantineReasons.push('too few holdout trades');
    if (holdout.netDollars <= minHoldoutNet) quarantineReasons.push('holdout net failed');
    if (holdout.winRate < minHoldoutWin) quarantineReasons.push('holdout win failed');
    if (holdout.profitFactor < minHoldoutPf) quarantineReasons.push('holdout PF failed');
    if (trainTest.netDollars <= 0) quarantineReasons.push('train/test net failed');
    if (trainTestStress.netDollars <= 0) quarantineReasons.push('train/test stress failed');
    if (test.netDollars < 0) quarantineReasons.push('test net failed');
    if (test.trades <= 0) quarantineReasons.push('test empty');
    if (recent.trades >= 3 && recent.netDollars < 0) quarantineReasons.push('recent net failed');
    if (recent.trades >= 3 && recent.winRate < minRecentWin) quarantineReasons.push('recent win failed');
    if (forwardFailed) quarantineReasons.push('forward trust failed');
    const passSelection = routeMetrics.trades >= minRouteTrades
      && routeMetrics.uniqueDays >= minRouteDays
      && holdout.trades >= minHoldoutTrades
      && holdout.netDollars > minHoldoutNet
      && holdout.winRate >= minHoldoutWin
      && holdout.profitFactor >= minHoldoutPf
      && trainTest.netDollars > 0
      && trainTestStress.netDollars > 0
      && test.netDollars >= 0
      && test.trades > 0
      && (recent.trades < 3 || (recent.netDollars >= 0 && recent.winRate >= minRecentWin))
      && !forwardFailed;
    const selectionScore = trainTest.winRate * 2.2
      + test.winRate * 1.8
      + Math.min(trainTest.profitFactor, 12) * 13
      + Math.min(trainTest.netDollars / 1000, 80)
      + Math.min(trainTestStress.netDollars / 1000, 50)
      + Math.min(recent.netDollars / 1000, 35)
      + recent.winRate * 0.9
      + forwardScore
      + trainTest.fastMoveRate * 0.45
      + trainTest.optionWorthyRate * 0.35
      - Math.max(0, 65 - test.winRate) * 2.5
      - Math.max(0, minHoldoutWin - holdout.winRate) * 12
      - Math.max(0, minRecentWin - recent.winRate) * 5
      - forwardGap * forwardGapPenalty
      - trainTest.maxLossStreak * 7
      - Math.min(trainTest.maxDrawdownDollars / 1000, 35);
    const holdoutScore = holdout.winRate * 2.2
      + Math.min(holdout.profitFactor, 12) * 13
      + Math.min(holdout.netDollars / 1000, 50)
      - Math.max(0, 70 - holdout.winRate) * 2.5
      - holdout.maxLossStreak * 7
      - Math.min(holdout.maxDrawdownDollars / 1000, 35);
    return {
      id,
      symbol: first.symbol,
      family: first.family,
      cluster: first.cluster,
      archetype: first.archetype,
      triggerMode: first.triggerMode,
      session: first.session,
      direction: first.direction,
      targetR: first.targetR,
      combo: first.combo,
      metrics: routeMetrics,
      train,
      test,
      holdout,
      recent,
      forward,
      forwardGap,
      forwardScore,
      trainTest,
      trainTestStress,
      stress,
      passSelection,
      quarantined: quarantineReasons.length > 0,
      quarantineReasons,
      selectionScore,
      holdoutScore,
      score: selectionScore,
      sampleTrades: rows.slice(-5).map((trade) => ({
        entryTime: trade.entryTime,
        exitTime: trade.exitTime,
        side: trade.side,
        entry: trade.entry,
        exit: trade.exit,
        pnlDollars: trade.pnlDollars,
        reason: trade.reason,
      })),
    };
  }).sort((a, b) => b.selectionScore - a.selectionScore);
}

function replayPortfolio(routes, allTrades, mode) {
  const routeSet = new Set(routes.map((route) => route.id));
  const routeById = new Map(routes.map((route) => [route.id, route]));
  const candidates = allTrades
    .filter((trade) => routeSet.has(trade.routeId))
    .map((trade) => {
      const route = routeById.get(trade.routeId);
      const routeQuality = route ? route.selectionScore : 0;
      return { ...trade, routeQuality };
    })
    .sort((a, b) => (a.entryTime - b.entryTime) || (b.routeQuality - a.routeQuality));
  const accepted = [];
  const conflictLog = [];
  const familyOpen = new Map();
  const recentSymbolLosses = new Map();
  for (const trade of candidates) {
    const open = accepted.filter((item) => item.exitTime > trade.entryTime);
    if (open.length >= maxConcurrent) {
      conflictLog.push({ reason: 'max concurrent', trade });
      continue;
    }
    if (open.some((item) => item.symbol === trade.symbol)) {
      conflictLog.push({ reason: 'same symbol open', trade });
      continue;
    }
    if (mode !== 'profit_max' && open.some((item) => item.cluster === trade.cluster)) {
      conflictLog.push({ reason: 'cluster conflict', trade });
      continue;
    }
    const losses = recentSymbolLosses.get(trade.symbol) || [];
    const recentLossCount = losses.filter((time) => trade.entryTime - time <= 3 * 86400).length;
    if (mode === 'high_win' && recentLossCount >= 1) {
      conflictLog.push({ reason: 'recent loss guard', trade });
      continue;
    }
    accepted.push(trade);
    if (trade.pnlDollars <= 0) recentSymbolLosses.set(trade.symbol, [...losses, trade.entryTime].slice(-5));
    familyOpen.set(trade.cluster, trade.exitTime);
  }
  return {
    trades: accepted,
    metrics: metrics(accepted),
    stress: metrics(accepted, stressBps),
    conflicts: conflictLog.length,
  };
}

function tradesForSplit(routes, allTrades, splitName) {
  const selectedIds = new Set(routes.map((route) => route.id));
  const byRoute = new Map();
  for (const trade of allTrades) {
    if (!selectedIds.has(trade.routeId)) continue;
    if (!byRoute.has(trade.routeId)) byRoute.set(trade.routeId, []);
    byRoute.get(trade.routeId).push(trade);
  }
  const out = [];
  for (const rows of byRoute.values()) {
    const split = splitChronologically(rows);
    out.push(...(split[splitName] || []));
  }
  return out;
}

function selectRoutes(routes, mode) {
  const filtered = routes.filter((route) => {
    if (!route.passSelection || route.quarantined) return false;
    if (mode === 'high_win') {
      return route.trainTest.winRate >= 72
        && route.train.winRate >= 70
        && route.test.winRate >= 65
        && route.holdout.winRate >= Math.max(minHoldoutWin, 58)
        && route.holdout.netDollars > minHoldoutNet
        && route.trainTest.profitFactor >= 1.7
        && route.trainTestStress.netDollars > 0;
    }
    if (mode === 'profit_max') {
      return route.trainTest.profitFactor >= 1.3
        && route.trainTest.netDollars >= 1500
        && route.holdout.netDollars > minHoldoutNet
        && route.holdout.winRate >= minHoldoutWin
        && route.trainTestStress.netDollars > 0
        && route.test.netDollars >= 0;
    }
    return route.trainTest.winRate >= 64
      && route.test.winRate >= 55
      && route.holdout.winRate >= minHoldoutWin
      && route.holdout.netDollars > minHoldoutNet
      && route.trainTest.profitFactor >= 1.4
      && route.trainTest.netDollars >= 1000
      && route.trainTestStress.netDollars > 0;
  });
  const seenSymbols = new Map();
  const seenFamilies = new Map();
  const seenFamilySessions = new Map();
  const seenArchetypeSessions = new Map();
  const seenTriggerSessions = new Map();
  const out = [];
  for (const route of filtered) {
    const cap = mode === 'profit_max' ? 3 : 2;
    const count = seenSymbols.get(route.symbol) || 0;
    if (count >= cap) continue;
    const familyCap = mode === 'profit_max' ? maxRoutesPerFamily + 4 : maxRoutesPerFamily;
    const familySessionCap = mode === 'profit_max' ? maxRoutesPerFamilySession + 2 : maxRoutesPerFamilySession;
    const archetypeSessionCap = mode === 'profit_max' ? maxRoutesPerArchetypeSession + 2 : maxRoutesPerArchetypeSession;
    const triggerSessionCap = mode === 'profit_max' ? maxRoutesPerTriggerSession + 2 : maxRoutesPerTriggerSession;
    const familyKey = route.family;
    const familySessionKey = `${route.family}|${route.session}`;
    const archetypeSessionKey = `${route.archetype}|${route.session}`;
    const triggerSessionKey = `${route.triggerMode}|${route.session}`;
    if ((seenFamilies.get(familyKey) || 0) >= familyCap) continue;
    if ((seenFamilySessions.get(familySessionKey) || 0) >= familySessionCap) continue;
    if ((seenArchetypeSessions.get(archetypeSessionKey) || 0) >= archetypeSessionCap) continue;
    if ((seenTriggerSessions.get(triggerSessionKey) || 0) >= triggerSessionCap) continue;
    out.push(route);
    seenSymbols.set(route.symbol, count + 1);
    seenFamilies.set(familyKey, (seenFamilies.get(familyKey) || 0) + 1);
    seenFamilySessions.set(familySessionKey, (seenFamilySessions.get(familySessionKey) || 0) + 1);
    seenArchetypeSessions.set(archetypeSessionKey, (seenArchetypeSessions.get(archetypeSessionKey) || 0) + 1);
    seenTriggerSessions.set(triggerSessionKey, (seenTriggerSessions.get(triggerSessionKey) || 0) + 1);
    if (out.length >= maxRoutes) break;
  }
  return out.sort((a, b) => b.selectionScore - a.selectionScore);
}

function groupSummary(routes, key) {
  const buckets = new Map();
  for (const route of routes) {
    const name = route[key] || 'unknown';
    const item = buckets.get(name) || { routes: 0, trades: 0, netDollars: 0, wins: 0, losses: 0 };
    item.routes += 1;
    item.trades += route.metrics.trades;
    item.netDollars += route.metrics.netDollars;
    item.wins += route.metrics.wins;
    item.losses += route.metrics.losses;
    buckets.set(name, item);
  }
  return [...buckets.entries()].map(([name, item]) => ({
    name,
    ...item,
    winRate: item.trades ? item.wins / item.trades * 100 : 0,
  })).sort((a, b) => b.netDollars - a.netDollars);
}

function quarantineSummary(routes) {
  const counts = {};
  for (const route of routes) {
    for (const reason of route.quarantineReasons || []) counts[reason] = (counts[reason] || 0) + 1;
  }
  return Object.entries(counts)
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count);
}

function forwardTrustSummary(routes) {
  const tested = routes.filter((route) => route.forward?.trades > 0);
  const quarantined = tested.filter((route) => route.forward?.status === 'forward-quarantine');
  const confirmed = tested.filter((route) => route.forward?.status === 'forward-confirmed');
  return {
    trustPath: useForwardTrust ? forwardTrustPath : null,
    trustUpdatedAt: forwardTrust?.updatedAt || null,
    testedRoutes: tested.length,
    confirmedRoutes: confirmed.length,
    quarantinedRoutes: quarantined.length,
    confirmed: confirmed.slice(0, 20).map((route) => ({
      id: route.id,
      symbol: route.symbol,
      triggerMode: route.triggerMode,
      session: route.session,
      direction: route.direction,
      forward: route.forward,
      holdout: route.holdout,
    })),
    quarantined: quarantined.slice(0, 20).map((route) => ({
      id: route.id,
      symbol: route.symbol,
      triggerMode: route.triggerMode,
      session: route.session,
      direction: route.direction,
      forward: route.forward,
      holdout: route.holdout,
      quarantineReasons: route.quarantineReasons,
    })),
  };
}

function buildForwardQueue(champions, bestMode) {
  const bestRoutes = champions[bestMode]?.selectedRoutes || [];
  return {
    updatedAt: new Date().toISOString(),
    status: 'paper-only',
    model: 'phase17_survival_router',
    bestMode,
    instructions: [
      'Track these routes in paper mode before promotion.',
      'Use the same 5m timeframe, route session, direction, trigger, and target settings.',
      'Promote only after forward sample is positive, stress-adjusted, and no loss cluster appears.',
    ],
    thresholds: {
      minForwardTrades: 30,
      minForwardWinRate: Math.max(58, minHoldoutWin),
      minForwardNetDollars: 0,
      maxForwardLossStreak: 3,
    },
    routes: bestRoutes.slice(0, 50).map((route) => ({
      id: route.id,
      symbol: route.symbol,
      family: route.family,
      archetype: route.archetype,
      triggerMode: route.triggerMode,
      session: route.session,
      direction: route.direction,
      targetR: route.targetR,
      timeStopBars: route.combo.timeStopBars,
      minConf: route.combo.minConf,
      minAlphaQuality: route.combo.minAlphaQuality,
      holdout: route.holdout,
      recent: route.recent,
      trainTest: route.trainTest,
      status: 'paper_queue',
    })),
  };
}

const symbols = readSymbols();
const combos = buildCombos();
const run = runLocalBacktest(symbols, combos);
const trades = readTrades(run.tradesPath);
const routes = buildRoutes(trades);

const champions = {};
for (const mode of ['high_win', 'profit_max', 'balanced']) {
  const selectedRoutes = selectRoutes(routes, mode);
  const portfolio = replayPortfolio(selectedRoutes, trades, mode);
  const trainPortfolio = replayPortfolio(selectedRoutes, tradesForSplit(selectedRoutes, trades, 'train'), mode);
  const testPortfolio = replayPortfolio(selectedRoutes, tradesForSplit(selectedRoutes, trades, 'test'), mode);
  const holdoutPortfolio = replayPortfolio(selectedRoutes, tradesForSplit(selectedRoutes, trades, 'holdout'), mode);
  champions[mode] = {
    mode,
    selectedRouteCount: selectedRoutes.length,
    selectedRoutes,
    portfolio: {
      metrics: portfolio.metrics,
      stress: portfolio.stress,
      train: trainPortfolio.metrics,
      test: testPortfolio.metrics,
      holdout: holdoutPortfolio.metrics,
      holdoutStress: holdoutPortfolio.stress,
      conflicts: portfolio.conflicts,
      trades: portfolio.trades.slice(-25),
    },
    byFamily: groupSummary(selectedRoutes, 'family'),
    byArchetype: groupSummary(selectedRoutes, 'archetype'),
    bySession: groupSummary(selectedRoutes, 'session'),
  };
}

function modeScore(record) {
  const holdout = record.portfolio.holdout;
  const test = record.portfolio.test;
  return holdout.projectedNet
    + holdout.winRate * 120
    + Math.min(holdout.profitFactor, 10) * 650
    + test.projectedNet * 0.35
    - holdout.maxDrawdownDollars / 2;
}

const rankedModes = Object.entries(champions)
  .map(([mode, record]) => ({
    mode,
    score: modeScore(record),
    qualified: record.portfolio.metrics.trades >= minChampionTrades
      && record.portfolio.holdout.trades >= Math.max(20, Math.floor(minChampionTrades * 0.15))
      && record.portfolio.holdout.netDollars > 0
      && record.portfolio.holdout.winRate >= minHoldoutWin
      && record.portfolio.holdout.profitFactor >= minHoldoutPf,
  }))
  .sort((a, b) => b.score - a.score);

const bestModeRecord = rankedModes.find((record) => record.qualified) || rankedModes[0] || { mode: 'balanced', qualified: false };
const bestMode = bestModeRecord.mode;
const bestModeQualified = bestModeRecord.qualified;

const forwardQueue = buildForwardQueue(champions, bestMode);

const output = {
  updatedAt: new Date().toISOString(),
  runId,
  source: {
    summaryPath: run.summaryPath,
    tradesPath: run.tradesPath,
    comboPath: run.comboPath,
  },
  config: {
    interval,
    range,
    capital,
    projectionCapital,
    symbols: symbols.length,
    combos: combos.length,
    maxRoutes,
    maxConcurrent,
    stressBps,
    minRouteTrades,
    minRouteDays,
    minHoldoutTrades,
    minChampionTrades,
    minHoldoutWin,
    minHoldoutPf,
    minHoldoutNet,
    minRecentWin,
    useForwardTrust,
    forwardTrustPath: useForwardTrust ? forwardTrustPath : null,
    minForwardTrustTrades,
    minForwardTrustWin,
    minForwardTrustNet,
    forwardGapPenalty,
    maxRoutesPerFamily,
    maxRoutesPerFamilySession,
    maxRoutesPerArchetypeSession,
    maxRoutesPerTriggerSession,
  },
  bestMode,
  bestModeQualified,
  rankedModes,
  champions,
  quarantineSummary: quarantineSummary(routes),
  forwardTrustSummary: forwardTrustSummary(routes),
  topRoutes: routes.slice(0, 100),
  watchlists: {
    highWinSymbols: uniq(champions.high_win.selectedRoutes.map((route) => route.symbol)),
    profitMaxSymbols: uniq(champions.profit_max.selectedRoutes.map((route) => route.symbol)),
    balancedSymbols: uniq(champions.balanced.selectedRoutes.map((route) => route.symbol)),
  },
};

const outPath = join(playbooksDir, 'current-phase17-specialist-tournament.json');
const histPath = join(playbooksDir, 'phase17-specialist-tournament-history.jsonl');
const exportPath = join(generatedDir, 'phase17_specialist_tournament_export.json');
const forwardDir = join(outDir, 'forward-tests');
mkdirSync(forwardDir, { recursive: true });
const forwardQueuePath = join(forwardDir, 'phase17-forward-paper-queue.json');
writeFileSync(outPath, `${JSON.stringify(output, null, 2)}\n`);
writeFileSync(forwardQueuePath, `${JSON.stringify(forwardQueue, null, 2)}\n`);
writeFileSync(exportPath, `${JSON.stringify({
  updatedAt: output.updatedAt,
  bestMode,
  bestModeQualified,
  forwardQueuePath,
  rankedModes,
  forwardTrustSummary: output.forwardTrustSummary,
  modes: Object.fromEntries(Object.entries(champions).map(([mode, record]) => [mode, {
    metrics: record.portfolio.metrics,
    train: record.portfolio.train,
    test: record.portfolio.test,
    holdout: record.portfolio.holdout,
    stress: record.portfolio.stress,
    holdoutStress: record.portfolio.holdoutStress,
    routeCount: record.selectedRouteCount,
    symbols: uniq(record.selectedRoutes.map((route) => route.symbol)),
    routes: record.selectedRoutes.slice(0, 40).map((route) => ({
      symbol: route.symbol,
      archetype: route.archetype,
      triggerMode: route.triggerMode,
      session: route.session,
      direction: route.direction,
      targetR: route.targetR,
      winRate: route.metrics.winRate,
      holdoutWinRate: route.holdout.winRate,
      holdoutNetDollars: route.holdout.netDollars,
      recentWinRate: route.recent.winRate,
      forwardStatus: route.forward.status,
      forwardScope: route.forward.scope,
      forwardTrades: route.forward.trades,
      forwardWinRate: route.forward.winRate,
      forwardNetDollars: route.forward.netDollars,
      netDollars: route.metrics.netDollars,
    })),
  }])),
  quarantineSummary: output.quarantineSummary,
}, null, 2)}\n`);
appendFileSync(histPath, `${JSON.stringify({
  updatedAt: output.updatedAt,
  runId,
  bestMode,
  high_win: champions.high_win.portfolio.metrics,
  high_win_holdout: champions.high_win.portfolio.holdout,
  profit_max: champions.profit_max.portfolio.metrics,
  profit_max_holdout: champions.profit_max.portfolio.holdout,
  balanced: champions.balanced.portfolio.metrics,
  balanced_holdout: champions.balanced.portfolio.holdout,
  forwardTrustSummary: output.forwardTrustSummary,
  source: output.source,
})}\n`);

const activePath = join(playbooksDir, 'current-active-scalp-modes.json');
const active = readJson(activePath, { updatedAt: new Date().toISOString(), defaultMode: 'high_win', activeModes: {} });
active.updatedAt = new Date().toISOString();
active.activeModes.phase17_specialist_router = {
  name: 'Phase17 Specialist Router',
  status: bestModeQualified ? 'watchlist-specialist' : 'paper-only-quarantine',
  mode: 'phase17_specialist_router',
  source: 'current-phase17-specialist-tournament',
  description: 'Multi-trigger specialist tournament: train/test/holdout route validation, conflict optimizer, stress slippage, and symbol/session specialists.',
  bestMode,
  metrics: champions[bestMode].portfolio.metrics,
  stress: champions[bestMode].portfolio.stress,
  holdout: champions[bestMode].portfolio.holdout,
  holdoutStress: champions[bestMode].portfolio.holdoutStress,
  forwardQueuePath,
  bestModeQualified,
  forwardTrust: output.forwardTrustSummary,
  rules: {
    routeCount: champions[bestMode].selectedRouteCount,
    symbols: uniq(champions[bestMode].selectedRoutes.map((route) => route.symbol)),
    preferredUse: 'watchlist specialist until forward proof confirms it',
    activation: 'router chooses trigger/session/direction specialists by validated route',
    forwardFeedback: 'routes with negative paper/live trust are quarantined or penalized before selection',
  },
};
writeFileSync(activePath, `${JSON.stringify(active, null, 2)}\n`);

function fmt(record) {
  const m = record.portfolio.metrics;
  const h = record.portfolio.holdout;
  const s = record.portfolio.stress;
  return `${record.selectedRouteCount} routes, all ${m.trades} trades ${m.winRate.toFixed(2)}% win net $${m.netDollars.toFixed(0)}, holdout ${h.trades} trades ${h.winRate.toFixed(2)}% win net $${h.netDollars.toFixed(0)}, PF ${h.profitFactor.toFixed(2)}, stress all $${s.netDollars.toFixed(0)}`;
}

console.log('\nPhase 17 specialist tournament complete');
console.log(`High Win:   ${fmt(champions.high_win)}`);
console.log(`Profit Max: ${fmt(champions.profit_max)}`);
console.log(`Balanced:   ${fmt(champions.balanced)}`);
console.log(`Best mode: ${bestMode}${bestModeQualified ? ' (survival-qualified)' : ' (paper-only; not enough survival proof)'}`);
console.log(`Saved: ${outPath}`);
console.log(`Export: ${exportPath}`);
console.log(`Forward queue: ${forwardQueuePath}`);
console.log(`Top quarantine reasons: ${output.quarantineSummary.slice(0, 5).map((item) => `${item.reason}=${item.count}`).join(', ')}`);
console.log(`Forward trust: tested=${output.forwardTrustSummary.testedRoutes} confirmed=${output.forwardTrustSummary.confirmedRoutes} quarantined=${output.forwardTrustSummary.quarantinedRoutes}`);
