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
for (const dir of [playbooksDir, generatedDir, join(outDir, 'forward-tests')]) mkdirSync(dir, { recursive: true });

const args = new Map(process.argv.slice(2).map((arg) => {
  const [key, value = 'true'] = arg.replace(/^--/, '').split('=');
  return [key, value];
}));

const runId = new Date().toISOString().replace(/[:.]/g, '-');
const interval = args.get('interval') || '5m';
const range = args.get('range') || '60d';
const capital = Number(args.get('capital') || 100000);
const projectionCapital = Number(args.get('projection-capital') || 10000);
const maxConcurrent = Number(args.get('max-concurrent') || 5);
const freshData = args.get('fresh-data') === 'true';
const stressBps = Number(args.get('stress-bps') || 6);
const maxLiveRoutes = Number(args.get('max-live-routes') || 100);
const maxPhase17Routes = Number(args.get('max-phase17-routes') || 70);
const maxRoutes = Number(args.get('max-routes') || 90);
const minRouteTrades = Number(args.get('min-route-trades') || 4);
const minHoldoutTrades = Number(args.get('min-holdout-trades') || 1);
const minChampionTrades = Number(args.get('min-champion-trades') || 150);

const livePath = args.get('live-path') || join(playbooksDir, 'current-live-scalp-champions.json');
const phase17Path = args.get('phase17-path') || join(playbooksDir, 'current-phase17-specialist-tournament.json');

function readJson(path, fallback = null) {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return fallback;
  }
}

function uniq(values) {
  return [...new Set(values.filter(Boolean))];
}

function comboKey(combo) {
  const normalized = {
    symbolFilter: combo.symbolFilter,
    playbook: combo.playbook,
    triggerMode: combo.triggerMode,
    minConf: combo.minConf,
    targetR: combo.targetR,
    exitMode: combo.exitMode,
    trailR: combo.trailR,
    timeStopBars: combo.timeStopBars,
    partialR: combo.partialR,
    confidenceDrop: combo.confidenceDrop,
    structureExit: combo.structureExit,
    minLead: combo.minLead,
    minEdge: combo.minEdge,
    minAtrRatio: combo.minAtrRatio,
    minAdx: combo.minAdx,
    minEr: combo.minEr,
    volMult: combo.volMult,
    session: combo.session,
    direction: combo.direction,
    lossCooldownBars: combo.lossCooldownBars,
    maxVwapAtr: combo.maxVwapAtr,
    requireConfRising: combo.requireConfRising,
    slippageBps: combo.slippageBps,
    spreadBps: combo.spreadBps,
    minMoveToCost: combo.minMoveToCost,
    openingRange: combo.openingRange,
    htfMode: combo.htfMode,
    volumeQuality: combo.volumeQuality,
    adaptiveTarget: combo.adaptiveTarget,
    maxConsecutiveLosses: combo.maxConsecutiveLosses,
    clusterCooldownBars: combo.clusterCooldownBars,
    minPrice: combo.minPrice,
    maxPrice: combo.maxPrice,
    minDollarVolume: combo.minDollarVolume,
    gapMode: combo.gapMode,
    dailyContext: combo.dailyContext,
    pdLevelMode: combo.pdLevelMode,
    marketMode: combo.marketMode,
    relVolMode: combo.relVolMode,
    minRelVolTod: combo.minRelVolTod,
    peerMode: combo.peerMode,
    newsMode: combo.newsMode,
    alphaMode: combo.alphaMode,
    alphaWeightSet: combo.alphaWeightSet,
    minAlphaQuality: combo.minAlphaQuality,
    minIntelScore: combo.minIntelScore,
    positionSizing: combo.positionSizing,
    minPositionScale: combo.minPositionScale,
    maxPositionScale: combo.maxPositionScale,
    archetype: combo.archetype || 'route',
  };
  return JSON.stringify(normalized);
}

function addCombo(map, combo, source, sourceRoute = {}) {
  const next = {
    playbook: 'Scalp',
    triggerMode: 'base',
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
    session: 'all',
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
    alphaMode: 'default',
    alphaWeightSet: 'default',
    minAlphaQuality: 0,
    minIntelScore: 0,
    positionSizing: 'fixed',
    minPositionScale: 1,
    maxPositionScale: 1,
    ...combo,
    symbolFilter: sourceRoute.symbol || combo.symbolFilter,
    archetype: combo.archetype || sourceRoute.archetype || sourceRoute.family || source,
  };
  if (!next.symbolFilter) return;
  const key = comboKey(next);
  const current = map.get(key);
  if (current) {
    current.councilSources = uniq([...(current.councilSources || []), source]);
    current.sourceRoutes.push(sourceRoute);
    current.sourceVotes = current.councilSources.length;
    return;
  }
  map.set(key, {
    ...next,
    councilSources: [source],
    sourceVotes: 1,
    sourceRoutes: [sourceRoute],
  });
}

function directionCompatible(a, b) {
  if (!a || !b || a === 'both' || b === 'both') return true;
  return a === b;
}

function sessionCompatible(a, b) {
  if (!a || !b || a === 'all' || b === 'all') return true;
  if (a === b) return true;
  if (a === 'morning' && ['open-0930', 'open-1000', 'open-1030'].includes(b)) return true;
  if (b === 'morning' && ['open-0930', 'open-1000', 'open-1030'].includes(a)) return true;
  return false;
}

function compatibleSignature(route) {
  return `${route.symbol}|${route.triggerMode}|${route.direction || 'both'}|${route.session || 'all'}`;
}

function buildCombos() {
  const live = readJson(livePath, {});
  const phase17 = readJson(phase17Path, {});
  const comboMap = new Map();
  const liveRoutes = (live.routes || [])
    .slice(0, maxLiveRoutes)
    .map((route, index) => ({
      ...route,
      sourceRank: index + 1,
      symbol: route.symbol,
      triggerMode: route.combo?.triggerMode || 'base',
      session: route.combo?.session || route.session || 'all',
      direction: route.combo?.direction || route.direction || 'both',
      targetR: route.combo?.targetR,
      timeStopBars: route.combo?.timeStopBars,
      structureExit: route.combo?.structureExit,
      sourceMetrics: {
        train: route.train,
        test: route.test,
        recent: route.recent,
        qualityScore: route.qualityScore,
        score: route.score,
      },
    }));
  const p17Modes = ['high_win', 'profit_max', 'balanced'];
  const phase17Routes = p17Modes.flatMap((mode) => (phase17.champions?.[mode]?.selectedRoutes || [])
    .slice(0, maxPhase17Routes)
    .map((route, index) => ({
      ...route,
      sourceMode: mode,
      sourceRank: index + 1,
      triggerMode: route.triggerMode || route.combo?.triggerMode,
      session: route.session || route.combo?.session,
      direction: route.direction || route.combo?.direction,
      sourceMetrics: {
        metrics: route.metrics,
        trainTest: route.trainTest,
        test: route.test,
        holdout: route.holdout,
        recent: route.recent,
        forward: route.forward,
        score: route.selectionScore || route.score,
      },
    })));

  for (const route of liveRoutes) {
    addCombo(comboMap, route.combo || {}, 'live407_highwin', {
      symbol: route.symbol,
      family: route.family,
      triggerMode: route.triggerMode,
      session: route.session,
      direction: route.direction,
      sourceRank: route.sourceRank,
      sourceMetrics: route.sourceMetrics,
    });
  }
  for (const route of phase17Routes) {
    addCombo(comboMap, route.combo || {}, `phase17_${route.sourceMode}`, {
      symbol: route.symbol,
      family: route.family,
      archetype: route.archetype,
      triggerMode: route.triggerMode,
      session: route.session,
      direction: route.direction,
      sourceMode: route.sourceMode,
      sourceRank: route.sourceRank,
      sourceMetrics: route.sourceMetrics,
    });
  }

  const liveIndex = liveRoutes;
  const phase17Index = phase17Routes;
  const combos = [...comboMap.values()].map((combo) => {
    const routeShape = {
      symbol: combo.symbolFilter,
      triggerMode: combo.triggerMode,
      session: combo.session,
      direction: combo.direction,
    };
    const liveCompat = liveIndex.filter((route) => route.symbol === routeShape.symbol
      && route.triggerMode === routeShape.triggerMode
      && directionCompatible(route.direction, routeShape.direction)
      && sessionCompatible(route.session, routeShape.session));
    const phase17Compat = phase17Index.filter((route) => route.symbol === routeShape.symbol
      && route.triggerMode === routeShape.triggerMode
      && directionCompatible(route.direction, routeShape.direction)
      && sessionCompatible(route.session, routeShape.session));
    const symbolCompat = phase17Index.some((route) => route.symbol === routeShape.symbol)
      && liveIndex.some((route) => route.symbol === routeShape.symbol);
    return {
      ...combo,
      councilSources: combo.councilSources.sort(),
      sourceVotes: combo.sourceVotes,
      hasLive407Compat: liveCompat.length > 0,
      hasPhase17Compat: phase17Compat.length > 0,
      hasSymbolCouncil: symbolCompat,
      compatibleSignature: compatibleSignature(routeShape),
    };
  });
  const symbols = uniq(combos.map((combo) => combo.symbolFilter)).sort();
  return { combos, symbols, live, phase17 };
}

function runLocalBacktest(symbols, combos) {
  const comboPath = join(playbooksDir, `phase19-council-fusion-combos-${runId}.json`);
  writeFileSync(comboPath, `${JSON.stringify(combos, null, 2)}\n`);
  console.log(`Phase 19 council fusion: ${symbols.length} symbols × ${combos.length} exact route combos on ${interval}/${range}`);
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
    combo.triggerMode || 'base',
    combo.session || 'all',
    combo.direction || 'both',
    combo.targetR,
    combo.timeStopBars,
    combo.structureExit,
    combo.councilSources?.join('+') || 'unknown',
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
    family: combo.sourceRoutes?.[0]?.family || 'unknown',
    archetype: combo.archetype || 'route',
    triggerMode: combo.triggerMode || 'base',
    session: combo.session || 'all',
    direction: combo.direction || 'both',
    sources: combo.councilSources || [],
    sourceVotes: combo.sourceVotes || 1,
    hasLive407Compat: Boolean(combo.hasLive407Compat || combo.councilSources?.includes('live407_highwin')),
    hasPhase17Compat: Boolean(combo.hasPhase17Compat || combo.councilSources?.some((source) => source.startsWith('phase17_'))),
    hasSymbolCouncil: Boolean(combo.hasSymbolCouncil),
    targetR: combo.targetR,
    pnlDollars: trade.pnlDollars || 0,
    notional: trade.notional || capital,
    entryTime: trade.entryTime,
    exitTime: trade.exitTime,
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
  return sorted.slice(-Math.min(sorted.length, Math.max(3, Math.ceil(sorted.length * 0.30))));
}

function routeSourceFlags(rows) {
  const sources = uniq(rows.flatMap((trade) => trade.sources || []));
  return {
    sources,
    hasLive407: rows.some((trade) => trade.hasLive407Compat),
    hasPhase17: rows.some((trade) => trade.hasPhase17Compat),
    hasSymbolCouncil: rows.some((trade) => trade.hasSymbolCouncil),
    sourceVotes: Math.max(...rows.map((trade) => trade.sourceVotes || 1)),
  };
}

function buildRoutes(trades) {
  const buckets = new Map();
  for (const trade of trades) {
    if (!buckets.has(trade.routeId)) buckets.set(trade.routeId, []);
    buckets.get(trade.routeId).push(trade);
  }
  return [...buckets.entries()].map(([id, rows]) => {
    const split = splitChronologically(rows);
    const trainTestRows = [...split.train, ...split.test];
    const sourceFlags = routeSourceFlags(rows);
    const m = metrics(rows);
    const train = metrics(split.train);
    const test = metrics(split.test);
    const holdout = metrics(split.holdout);
    const recent = metrics(recentRows(rows));
    const trainTest = metrics(trainTestRows);
    const stress = metrics(rows, stressBps);
    const trainTestStress = metrics(trainTestRows, stressBps);
    const passBase = m.trades >= minRouteTrades
      && holdout.trades >= minHoldoutTrades
      && trainTest.netDollars > 0
      && trainTestStress.netDollars > 0
      && test.trades > 0
      && test.netDollars >= 0
      && holdout.netDollars > 0
      && holdout.profitFactor >= 1.05
      && (recent.trades < 3 || recent.netDollars >= 0);
    const overlapBonus = sourceFlags.hasLive407 && sourceFlags.hasPhase17 ? 75 : sourceFlags.hasSymbolCouncil ? 25 : 0;
    const score = holdout.winRate * 2.6
      + test.winRate * 1.8
      + trainTest.winRate * 1.1
      + Math.min(holdout.profitFactor, 12) * 16
      + Math.min(trainTest.profitFactor, 12) * 10
      + Math.min(holdout.netDollars / 600, 75)
      + Math.min(trainTest.netDollars / 1000, 75)
      + recent.winRate * 0.65
      + Math.min(recent.netDollars / 1000, 35)
      + m.fastMoveRate * 0.45
      + m.optionWorthyRate * 0.55
      + overlapBonus
      - Math.max(0, 65 - holdout.winRate) * 8
      - Math.max(0, 65 - test.winRate) * 4
      - Math.min(m.maxDrawdownDollars / 700, 40)
      - m.maxLossStreak * 8
      - m.avgMaeR * 18;
    return {
      id,
      symbol: rows[0].symbol,
      family: rows[0].family,
      archetype: rows[0].archetype,
      triggerMode: rows[0].triggerMode,
      session: rows[0].session,
      direction: rows[0].direction,
      targetR: rows[0].targetR,
      combo: rows[0].combo,
      ...sourceFlags,
      metrics: m,
      train,
      test,
      holdout,
      recent,
      trainTest,
      stress,
      trainTestStress,
      passBase,
      score,
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
  }).sort((a, b) => b.score - a.score);
}

function routePass(route, variant) {
  if (!route.passBase) return false;
  if (variant === 'phase17_replay') return route.sources.some((source) => source.startsWith('phase17_'));
  if (variant === 'live407_replay') return route.hasLive407;
  if (variant === 'strict_overlap') {
    return route.hasLive407 && route.hasPhase17
      && route.holdout.winRate >= 70
      && route.test.winRate >= 70
      && route.trainTest.profitFactor >= 1.7;
  }
  if (variant === 'council_high_win') {
    return route.holdout.winRate >= 72
      && route.test.winRate >= 68
      && route.trainTest.winRate >= 70
      && route.trainTest.profitFactor >= 1.7
      && route.stress.netDollars > 0
      && (route.hasLive407 || route.hasPhase17);
  }
  if (variant === 'profit_guarded_fusion') {
    return route.trainTest.netDollars >= 1500
      && route.holdout.netDollars > 0
      && route.holdout.winRate >= 58
      && route.test.winRate >= 58
      && route.trainTest.profitFactor >= 1.35
      && route.stress.netDollars > 0
      && (route.hasLive407 || route.hasPhase17 || route.hasSymbolCouncil);
  }
  if (variant === 'supertool_balanced') {
    return route.holdout.winRate >= 62
      && route.test.winRate >= 60
      && route.trainTest.profitFactor >= 1.45
      && route.stress.netDollars > 0
      && (route.hasLive407 || route.hasPhase17);
  }
  return false;
}

function selectRoutes(routes, variant) {
  const caps = {
    phase17_replay: { symbol: 3, family: 22, max: maxRoutes },
    live407_replay: { symbol: 3, family: 24, max: maxRoutes },
    strict_overlap: { symbol: 2, family: 16, max: Math.min(60, maxRoutes) },
    council_high_win: { symbol: 2, family: 18, max: Math.min(70, maxRoutes) },
    profit_guarded_fusion: { symbol: 3, family: 26, max: maxRoutes },
    supertool_balanced: { symbol: 2, family: 20, max: maxRoutes },
  }[variant];
  const selected = [];
  const bySymbol = new Map();
  const byFamily = new Map();
  const candidates = routes
    .filter((route) => routePass(route, variant))
    .sort((a, b) => {
      const aBoost = variant.includes('council') || variant.includes('overlap') || variant.includes('supertool') ? (a.hasLive407 && a.hasPhase17 ? 100 : 0) : 0;
      const bBoost = variant.includes('council') || variant.includes('overlap') || variant.includes('supertool') ? (b.hasLive407 && b.hasPhase17 ? 100 : 0) : 0;
      return (b.score + bBoost) - (a.score + aBoost);
    });
  for (const route of candidates) {
    if ((bySymbol.get(route.symbol) || 0) >= caps.symbol) continue;
    if ((byFamily.get(route.family) || 0) >= caps.family) continue;
    selected.push(route);
    bySymbol.set(route.symbol, (bySymbol.get(route.symbol) || 0) + 1);
    byFamily.set(route.family, (byFamily.get(route.family) || 0) + 1);
    if (selected.length >= caps.max) break;
  }
  return selected;
}

function replayPortfolio(routes, allTrades, variant) {
  const routeSet = new Set(routes.map((route) => route.id));
  const routeById = new Map(routes.map((route) => [route.id, route]));
  const candidates = allTrades
    .filter((trade) => routeSet.has(trade.routeId))
    .map((trade) => ({ ...trade, routeQuality: routeById.get(trade.routeId)?.score || 0 }))
    .sort((a, b) => (a.entryTime - b.entryTime) || (b.routeQuality - a.routeQuality));
  const accepted = [];
  const conflictLog = [];
  const recentSymbolLosses = new Map();
  const strictMode = ['strict_overlap', 'council_high_win', 'supertool_balanced', 'phase17_replay'].includes(variant);
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
    if (strictMode && open.some((item) => item.family === trade.family)) {
      conflictLog.push({ reason: 'family conflict', trade });
      continue;
    }
    const losses = recentSymbolLosses.get(trade.symbol) || [];
    const recentLossCount = losses.filter((time) => trade.entryTime - time <= 3 * 86400).length;
    if (strictMode && recentLossCount >= 1) {
      conflictLog.push({ reason: 'recent loss guard', trade });
      continue;
    }
    accepted.push(trade);
    if (trade.pnlDollars <= 0) recentSymbolLosses.set(trade.symbol, [...losses, trade.entryTime].slice(-5));
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

function recordScore(record) {
  const h = record.portfolio.holdout;
  const t = record.portfolio.test;
  const m = record.portfolio.metrics;
  return h.projectedNet * 1.7
    + t.projectedNet * 0.7
    + m.projectedNet * 0.25
    + h.winRate * 150
    + Math.min(h.profitFactor, 12) * 700
    + Math.min(m.fastMoveRate, 80) * 25
    - h.maxDrawdownDollars / 1.8
    - m.maxLossStreak * 600
    - Math.max(0, minChampionTrades - m.trades) * 35;
}

function compactMetrics(m) {
  return {
    trades: m.trades,
    wins: m.wins,
    losses: m.losses,
    winRate: m.winRate,
    profitFactor: m.profitFactor,
    netDollars: m.netDollars,
    projectedNet: m.projectedNet,
    avgDollars: m.avgDollars,
    projectedAvgDollars: m.projectedAvgDollars,
    maxDrawdownDollars: m.maxDrawdownDollars,
    maxLossStreak: m.maxLossStreak,
    avgMfeR: m.avgMfeR,
    avgMaeR: m.avgMaeR,
    optionWorthyRate: m.optionWorthyRate,
    fastMoveRate: m.fastMoveRate,
    uniqueDays: m.uniqueDays,
    uniqueWeeks: m.uniqueWeeks,
  };
}

const { combos, symbols, live, phase17 } = buildCombos();
const run = runLocalBacktest(symbols, combos);
const trades = readTrades(run.tradesPath);
const routes = buildRoutes(trades);

const variants = {};
for (const variant of ['phase17_replay', 'live407_replay', 'strict_overlap', 'council_high_win', 'profit_guarded_fusion', 'supertool_balanced']) {
  const selectedRoutes = selectRoutes(routes, variant);
  const portfolio = replayPortfolio(selectedRoutes, trades, variant);
  const trainPortfolio = replayPortfolio(selectedRoutes, tradesForSplit(selectedRoutes, trades, 'train'), variant);
  const testPortfolio = replayPortfolio(selectedRoutes, tradesForSplit(selectedRoutes, trades, 'test'), variant);
  const holdoutPortfolio = replayPortfolio(selectedRoutes, tradesForSplit(selectedRoutes, trades, 'holdout'), variant);
  variants[variant] = {
    variant,
    selectedRouteCount: selectedRoutes.length,
    selectedRoutes,
    portfolio: {
      metrics: compactMetrics(portfolio.metrics),
      stress: compactMetrics(portfolio.stress),
      train: compactMetrics(trainPortfolio.metrics),
      test: compactMetrics(testPortfolio.metrics),
      holdout: compactMetrics(holdoutPortfolio.metrics),
      holdoutStress: compactMetrics(holdoutPortfolio.stress),
      conflicts: portfolio.conflicts,
      trades: portfolio.trades.slice(-30),
    },
    byFamily: groupSummary(selectedRoutes, 'family'),
    byTrigger: groupSummary(selectedRoutes, 'triggerMode'),
    bySource: groupSummary(selectedRoutes.flatMap((route) => route.sources.map((source) => ({ ...route, source }))), 'source'),
  };
}

const rankedVariants = Object.entries(variants)
  .map(([variant, record]) => ({
    variant,
    score: recordScore(record),
    qualified: record.portfolio.metrics.trades >= minChampionTrades
      && record.portfolio.holdout.trades >= Math.max(20, Math.floor(minChampionTrades * 0.15))
      && record.portfolio.holdout.netDollars > 0
      && record.portfolio.holdout.winRate >= 65
      && record.portfolio.holdout.profitFactor >= 1.4
      && record.portfolio.holdoutStress.netDollars > 0,
  }))
  .sort((a, b) => b.score - a.score);

const bestVariantRecord = rankedVariants.find((variant) => variant.qualified) || rankedVariants[0];
const bestVariant = bestVariantRecord?.variant || 'supertool_balanced';
const bestRecord = variants[bestVariant];

const output = {
  updatedAt: new Date().toISOString(),
  runId,
  phase: 'phase19-champion-council-fusion',
  goal: 'Fuse the $407k walk-forward highWin specialist with Phase17 specialist routing and test council variants.',
  source: {
    livePath,
    phase17Path,
    summaryPath: run.summaryPath,
    tradesPath: run.tradesPath,
    comboPath: run.comboPath,
    liveUpdatedAt: live.updatedAt,
    phase17UpdatedAt: phase17.updatedAt,
  },
  config: {
    interval,
    range,
    capital,
    projectionCapital,
    symbols: symbols.length,
    combos: combos.length,
    maxConcurrent,
    stressBps,
    maxLiveRoutes,
    maxPhase17Routes,
    maxRoutes,
    minRouteTrades,
    minHoldoutTrades,
    minChampionTrades,
  },
  baselines: {
    live407HighWin: live.best?.highWin || null,
    live407Test: live.best?.test || null,
    phase17BestMode: phase17.bestMode || null,
    phase17HighWin: phase17.champions?.high_win?.portfolio?.metrics || null,
    phase17ProfitMax: phase17.champions?.profit_max?.portfolio?.metrics || null,
    phase17Balanced: phase17.champions?.balanced?.portfolio?.metrics || null,
  },
  bestVariant,
  bestVariantQualified: Boolean(bestVariantRecord?.qualified),
  rankedVariants,
  variants,
  topRoutes: routes.slice(0, 120),
  watchlists: Object.fromEntries(Object.entries(variants).map(([variant, record]) => [
    variant,
    uniq(record.selectedRoutes.map((route) => route.symbol)),
  ])),
};

const outPath = join(playbooksDir, 'current-phase19-champion-council-fusion.json');
const histPath = join(playbooksDir, 'phase19-champion-council-fusion-history.jsonl');
const exportPath = join(generatedDir, 'phase19_champion_council_fusion_export.json');
writeFileSync(outPath, `${JSON.stringify(output, null, 2)}\n`);
appendFileSync(histPath, `${JSON.stringify({
  updatedAt: output.updatedAt,
  runId,
  bestVariant,
  bestVariantQualified: output.bestVariantQualified,
  rankedVariants,
  variants: Object.fromEntries(Object.entries(variants).map(([variant, record]) => [variant, {
    routes: record.selectedRouteCount,
    metrics: record.portfolio.metrics,
    test: record.portfolio.test,
    holdout: record.portfolio.holdout,
    stress: record.portfolio.stress,
  }])),
  source: output.source,
})}\n`);
writeFileSync(exportPath, `${JSON.stringify({
  updatedAt: output.updatedAt,
  bestVariant,
  bestVariantQualified: output.bestVariantQualified,
  rankedVariants,
  variants: Object.fromEntries(Object.entries(variants).map(([variant, record]) => [variant, {
    routeCount: record.selectedRouteCount,
    metrics: record.portfolio.metrics,
    test: record.portfolio.test,
    holdout: record.portfolio.holdout,
    stress: record.portfolio.stress,
    symbols: uniq(record.selectedRoutes.map((route) => route.symbol)),
    routes: record.selectedRoutes.slice(0, 50).map((route) => ({
      symbol: route.symbol,
      family: route.family,
      triggerMode: route.triggerMode,
      session: route.session,
      direction: route.direction,
      targetR: route.targetR,
      sources: route.sources,
      hasLive407: route.hasLive407,
      hasPhase17: route.hasPhase17,
      score: route.score,
      trainTestWinRate: route.trainTest.winRate,
      testWinRate: route.test.winRate,
      holdoutWinRate: route.holdout.winRate,
      holdoutNetDollars: route.holdout.netDollars,
      recentWinRate: route.recent.winRate,
    })),
  }])),
}, null, 2)}\n`);

const activePath = join(playbooksDir, 'current-active-scalp-modes.json');
const active = readJson(activePath, { updatedAt: new Date().toISOString(), activeModes: {} });
active.updatedAt = new Date().toISOString();
active.activeModes = active.activeModes || {};
active.activeModes.phase19_champion_council = {
  name: 'Champion Council Fusion',
  status: output.bestVariantQualified ? 'watchlist-specialist' : 'paper-only',
  mode: bestVariant,
  source: 'current-phase19-champion-council-fusion',
  description: 'Fusion router that retests exact $407k walk-forward highWin routes against Phase17 specialist routes, then selects overlap/high-win/profit-guarded council variants.',
  metrics: bestRecord.portfolio.metrics,
  stress: bestRecord.portfolio.stress,
  holdout: bestRecord.portfolio.holdout,
  holdoutStress: bestRecord.portfolio.holdoutStress,
  routeCount: bestRecord.selectedRouteCount,
  symbols: uniq(bestRecord.selectedRoutes.map((route) => route.symbol)),
  bestVariantQualified: output.bestVariantQualified,
  exportPath,
  rules: {
    variants: rankedVariants,
    preferredUse: 'paper/watchlist specialist until live TradingView alert evidence confirms it',
    activation: 'use when Phase17 and $407k walk-forward specialists overlap or when blended holdout/stress survives',
  },
};
writeFileSync(activePath, `${JSON.stringify(active, null, 2)}\n`);

function line(variant, record) {
  const m = record.portfolio.metrics;
  const h = record.portfolio.holdout;
  const s = record.portfolio.stress;
  return `${variant}: ${record.selectedRouteCount} routes, ${m.trades} trades, ${m.winRate.toFixed(2)}% win, net $${m.netDollars.toFixed(0)}, holdout ${h.trades} trades ${h.winRate.toFixed(2)}% win net $${h.netDollars.toFixed(0)}, stress $${s.netDollars.toFixed(0)}`;
}

console.log('\nPhase 19 Champion Council fusion complete');
for (const [variant, record] of Object.entries(variants)) console.log(line(variant, record));
console.log(`Best variant: ${bestVariant}${output.bestVariantQualified ? ' (qualified)' : ' (paper-only / not fully qualified)'}`);
console.log(`Saved: ${outPath}`);
console.log(`Export: ${exportPath}`);
