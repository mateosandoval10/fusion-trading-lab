#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

const dashboardDir = join(root, 'apps', 'dashboard', 'public', 'data');
const reportsDir = join(root, 'reports');
mkdirSync(dashboardDir, { recursive: true });
mkdirSync(reportsDir, { recursive: true });

function readJson(path, fallback = null) {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return fallback;
  }
}

function readJsonl(path) {
  if (!existsSync(path)) return [];
  const raw = readFileSync(path, 'utf8').trim();
  if (!raw) return [];
  return raw.split('\n').filter(Boolean).flatMap((line) => {
    try {
      return [JSON.parse(line)];
    } catch {
      return [];
    }
  });
}

function writeJson(path, payload) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(payload, null, 2)}\n`);
}

function fileInfo(path) {
  if (!existsSync(path)) return null;
  const stats = statSync(path);
  return {
    path,
    updatedAt: stats.mtime.toISOString(),
    bytes: stats.size,
  };
}

function metricCompact(metrics = {}) {
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

function compactTournamentVariant(variant, options = {}) {
  if (!variant || typeof variant !== 'object') return variant || null;
  const topLimit = options.topLimit ?? 12;
  const tradeLimit = options.tradeLimit ?? 8;
  return {
    id: variant.id,
    challenger: variant.challenger,
    description: variant.description,
    uniqueTwist: variant.uniqueTwist,
    profile: variant.profile,
    goal: variant.goal,
    universe: variant.universe,
    sessionGroup: variant.sessionGroup,
    triggerGroup: variant.triggerGroup,
    routeSet: variant.routeSet,
    threshold: variant.threshold,
    targetR: variant.targetR,
    constraints: variant.constraints,
    maxFailedBreak: variant.maxFailedBreak,
    maxVwapExtension: variant.maxVwapExtension,
    minVolumeScore: variant.minVolumeScore,
    minRelativeScore: variant.minRelativeScore,
    requireCleanVwap: variant.requireCleanVwap,
    requireTrapGuard: variant.requireTrapGuard,
    score: variant.score,
    routeCount: variant.routeCount || variant.topRoutes?.length || 0,
    metrics: metricCompact(variant.metrics || {}),
    train: metricCompact(variant.train || {}),
    test: metricCompact(variant.test || {}),
    holdout: metricCompact(variant.holdout || {}),
    stress: metricCompact(variant.stress || {}),
    deepStress: metricCompact(variant.deepStress || {}),
    consistency: variant.consistency,
    leaveOneSymbolOut: variant.leaveOneSymbolOut,
    leaveOneFamilyOut: variant.leaveOneFamilyOut,
    setupValidation: variant.setupValidation,
    regimeValidation: variant.regimeValidation,
    freshSymbolMetrics: metricCompact(variant.freshSymbolMetrics || {}),
    diagnostics: variant.diagnostics,
    engineAverages: variant.engineAverages,
    monteCarlo: variant.monteCarlo,
    decision: variant.decision,
    decisionReasons: variant.decisionReasons,
    topSymbols: variant.topSymbols?.slice(0, topLimit) || [],
    topFamilies: variant.topFamilies?.slice(0, topLimit) || [],
    topTriggers: variant.topTriggers?.slice(0, topLimit) || [],
    topRoutes: variant.topRoutes?.slice(0, topLimit) || [],
    topTrades: variant.topTrades?.slice(0, tradeLimit) || [],
    tradeSample: variant.tradeSample?.slice(0, tradeLimit) || [],
  };
}

function compactCategoryMap(map = {}, options = {}) {
  return Object.fromEntries(Object.entries(map || {}).map(([key, value]) => [
    key,
    compactTournamentVariant(value, options),
  ]));
}

function sideText(trade = {}) {
  return trade.side || (trade.dir === 1 ? 'long' : trade.dir === -1 ? 'short' : 'unknown');
}

function dateTime(epoch) {
  const value = Number(epoch || 0);
  if (!Number.isFinite(value) || value <= 0) return 'n/a';
  return new Date((value > 100000000000 ? value : value * 1000)).toISOString();
}

function minutesBetween(start, end) {
  const a = Number(start || 0);
  const b = Number(end || 0);
  if (!Number.isFinite(a) || !Number.isFinite(b) || a <= 0 || b <= 0) return null;
  const startMs = a > 100000000000 ? a : a * 1000;
  const endMs = b > 100000000000 ? b : b * 1000;
  return Math.max(0, Math.round((endMs - startMs) / 60000));
}

function summarizeTradesBySymbol(trades = [], limit = 12) {
  const bySymbol = new Map();
  for (const trade of trades) {
    const symbol = trade.symbol || trade.combo?.symbolFilter;
    if (!symbol) continue;
    const item = bySymbol.get(symbol) || {
      symbol,
      trades: 0,
      wins: 0,
      netDollars: 0,
      grossWin: 0,
      grossLoss: 0,
      avgMfeR: 0,
      avgMaeR: 0,
      bestTrade: null,
    };
    const pnl = Number(trade.pnlDollars || 0);
    item.trades += 1;
    item.netDollars += pnl;
    item.avgMfeR += Number(trade.mfeR || 0);
    item.avgMaeR += Number(trade.maeR || 0);
    if (pnl > 0) {
      item.wins += 1;
      item.grossWin += pnl;
    } else {
      item.grossLoss += Math.abs(pnl);
    }
    if (!item.bestTrade || pnl > item.bestTrade.pnlDollars) {
      item.bestTrade = {
        symbol,
        side: sideText(trade),
        entryTime: dateTime(trade.entryTime),
        exitTime: dateTime(trade.exitTime),
        minutesHeld: minutesBetween(trade.entryTime, trade.exitTime),
        entry: trade.entry,
        exit: trade.exit,
        pnlDollars: pnl,
        pnlR: trade.pnlR,
        mfeR: trade.mfeR,
        maeR: trade.maeR,
        confidence: trade.confidence,
        triggerMode: trade.combo?.triggerMode || trade.triggerMode || 'unknown',
      };
    }
    bySymbol.set(symbol, item);
  }
  return [...bySymbol.values()]
    .map((item) => ({
      ...item,
      winRate: item.trades ? item.wins / item.trades * 100 : 0,
      profitFactor: item.grossLoss > 0 ? item.grossWin / item.grossLoss : item.grossWin > 0 ? 999 : 0,
      avgDollars: item.trades ? item.netDollars / item.trades : 0,
      avgMfeR: item.trades ? item.avgMfeR / item.trades : 0,
      avgMaeR: item.trades ? item.avgMaeR / item.trades : 0,
    }))
    .sort((a, b) => b.netDollars - a.netDollars)
    .slice(0, limit);
}

function summarizeBiggestTrades(trades = [], limit = 12) {
  return trades
    .map((trade) => ({
      symbol: trade.symbol || trade.combo?.symbolFilter || 'unknown',
      side: sideText(trade),
      triggerMode: trade.combo?.triggerMode || trade.triggerMode || 'unknown',
      entryTime: dateTime(trade.entryTime),
      exitTime: dateTime(trade.exitTime),
      minutesHeld: minutesBetween(trade.entryTime, trade.exitTime),
      entry: trade.entry,
      exit: trade.exit,
      pnlDollars: Number(trade.pnlDollars || 0),
      pnlR: trade.pnlR,
      mfeR: trade.mfeR,
      maeR: trade.maeR,
      confidence: trade.confidence,
    }))
    .sort((a, b) => b.pnlDollars - a.pnlDollars)
    .slice(0, limit);
}

function parseRouteIds(routeIds = []) {
  const rows = routeIds.map((routeId) => {
    const [symbol, session, direction, trigger] = String(routeId).split('|');
    return { routeId, symbol, session, direction, trigger };
  });
  const countBy = (field) => [...rows.reduce((map, row) => {
    const key = row[field] || 'unknown';
    map.set(key, (map.get(key) || 0) + 1);
    return map;
  }, new Map())]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count);
  return {
    symbols: countBy('symbol').slice(0, 20),
    triggers: countBy('trigger').slice(0, 12),
    sessions: countBy('session').slice(0, 8),
    directions: countBy('direction').slice(0, 8),
    examples: rows.slice(0, 12),
  };
}

function specialistBestFor(key, value = {}) {
  const text = `${key} ${value.name || ''} ${value.description || ''}`.toLowerCase();
  if (text.includes('council')) return 'Fused specialist council combining high-win and Phase17 routes.';
  if (text.includes('powerhour')) return 'Late-day momentum scalps on whitelisted symbols.';
  if (text.includes('profit max') || text.includes('aggressive')) return 'Higher-profit satellite signals when you accept lower win-rate risk.';
  if (text.includes('phase17')) return 'Validated multi-trigger routing by symbol, session, and direction.';
  if (text.includes('high win') || text.includes('conservative')) return 'Default conservative BUY/SELL labels focused on accuracy.';
  return 'Specialist route set for paper/watchlist evaluation.';
}

function summarizeChampion(champion) {
  if (!champion) return null;
  const bestVariant = champion.bestVariant;
  const record = champion.variants?.[bestVariant];
  const trades = record?.portfolio?.trades || [];
  return {
    updatedAt: champion.updatedAt,
    phase: champion.phase,
    bestVariant,
    qualified: champion.bestVariantQualified,
    config: champion.config,
    metrics: metricCompact(record?.portfolio?.metrics),
    train: metricCompact(record?.portfolio?.train),
    test: metricCompact(record?.portfolio?.test),
    holdout: metricCompact(record?.portfolio?.holdout),
    stress: metricCompact(record?.portfolio?.stress),
    holdoutStress: metricCompact(record?.portfolio?.holdoutStress),
    byTrigger: record?.byTrigger || [],
    byFamily: record?.byFamily || [],
    topSymbols: summarizeTradesBySymbol(trades, 15),
    biggestTrades: summarizeBiggestTrades(trades, 15),
    watchlist: champion.watchlists?.[bestVariant] || [],
  };
}

function summarizeSpecialists(activeModes = {}, context = {}) {
  return Object.entries(activeModes.activeModes || activeModes || {}).map(([key, value]) => {
    const routeSummary = parseRouteIds(value.rules?.routeIds || []);
    const combo = value.rules?.combo || {};
    const phase17Routes = context.phase17?.champions?.[context.phase17?.bestMode || 'high_win']?.selectedRoutes || [];
    const phase17Symbols = [...new Set(phase17Routes.map((route) => route.symbol).filter(Boolean))];
    const phase17Triggers = [...new Set(phase17Routes.map((route) => route.triggerMode).filter(Boolean))];
    const symbols = key.includes('phase19')
      ? (value.symbols || context.champion?.watchlist || [])
      : key.includes('phase17')
        ? (value.symbols || value.rules?.symbols || phase17Symbols)
        : value.symbols || value.rules?.symbols || routeSummary.symbols.map((item) => item.name);
    const triggers = key.includes('phase19')
      ? (context.champion?.byTrigger || []).map((item) => item.name).filter(Boolean)
      : key.includes('phase17')
        ? (phase17Triggers.length ? phase17Triggers : value.rules?.triggers || [])
        : value.rules?.triggers || (combo.triggerMode ? [combo.triggerMode] : routeSummary.triggers.map((item) => item.name));
    return {
      key,
      name: value.name || key,
      status: value.status || 'unknown',
      mode: value.mode || null,
      source: value.source || 'unknown',
      purpose: value.description || '',
      bestFor: specialistBestFor(key, value),
      preferredUse: value.rules?.preferredUse || '',
      activation: value.rules?.activation || '',
      forwardFeedback: value.rules?.forwardFeedback || '',
      validationDecision: value.validationDecision || '',
      bestMode: value.bestMode || '',
      routeCount: value.routeCount || value.rules?.routeCount || value.metrics?.routes || 0,
      symbols: symbols.slice(0, 60),
      triggers: triggers.slice(0, 20),
      sessions: combo.session ? [combo.session] : routeSummary.sessions.map((item) => item.name),
      directions: combo.direction ? [combo.direction] : routeSummary.directions.map((item) => item.name),
      routeExamples: routeSummary.examples,
      metrics: metricCompact(value.metrics),
      holdout: metricCompact(value.holdout),
      stress: metricCompact(value.stress),
      notes: value.description || value.activation || '',
    };
  }).sort((a, b) => b.metrics.netDollars - a.metrics.netDollars);
}

function latestFiles(dir, limit = 20) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .map((name) => join(dir, name))
    .filter((path) => statSync(path).isFile())
    .map((path) => fileInfo(path))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, limit);
}

function summarizeForward() {
  const forwardDir = join(root, 'optimization-results', 'forward-tests');
  const latestPhase18 = readJson(join(forwardDir, 'latest-phase18-forward-proven-summary.json'), null);
  const routeTrust = readJson(join(forwardDir, 'phase18-forward-route-trust.json'), { routes: {} });
  const openHour = readJson(join(forwardDir, 'latest-champion-open-hour-forward-test.json'), null);
  const currentWindow = readJson(join(forwardDir, 'latest-champion-current-window-forward-test.json'), null);
  const performanceLedger = readJsonl(join(forwardDir, 'champion-forward-performance-ledger.jsonl')).slice(-200);
  const routeTrustRows = Object.values(routeTrust.routes || {})
    .sort((a, b) => (b.netDollars || 0) - (a.netDollars || 0))
    .slice(0, 50);
  return {
    latestPhase18,
    openHour,
    currentWindow,
    routeTrustUpdatedAt: routeTrust.updatedAt || null,
    topRouteTrust: routeTrustRows,
    recentForwardLedger: performanceLedger,
  };
}

function pineStatus() {
  const pinePath = join(root, 'generated', 'fusionv3_codex_clean_tradingview.pine');
  const pine = existsSync(pinePath) ? readFileSync(pinePath, 'utf8') : '';
  const modelId = pine.match(/closedLoopModelId\s*=\s*input\.string\("([^"]+)"/)?.[1] || 'unknown';
  const activeModeSource = pine.split('\n').find((line) => line.includes('activeScalpMode = input.string')) || '';
  const activeModeLine = activeModeSource.match(/activeScalpMode\s*=\s*input\.string\("([^"]+)".*options=\[([^\]]+)/);
  return {
    ...fileInfo(pinePath),
    modelId,
    defaultMode: activeModeLine?.[1] || 'unknown',
    hasClosedLoopAlert: pine.includes('alert(closedLoopPayload'),
    modeOptions: activeModeLine?.[2]?.replaceAll('"', '').split(',').map((item) => item.trim()).filter(Boolean) || [],
  };
}

const champion = readJson(join(root, 'models', 'champions', 'current-phase19-champion-council-fusion.json'), null);
const activeModes = readJson(join(root, 'models', 'registry', 'current-active-scalp-modes.json'), {});
const patternLab = readJson(join(root, 'models', 'pattern-lab', 'current-pattern-lab.json'), null);
const patternCandidates = readJson(join(root, 'models', 'specialists', 'pattern-specialist-candidates.json'), { candidates: [] });
const canonicalData = readJson(join(root, 'data', 'canonical', 'canonical-summary.json'), null)
  || readJson(join(root, 'apps', 'dashboard', 'public', 'data', 'canonical-data.json'), null);
const specialistFactory = readJson(join(root, 'models', 'specialists', 'phase21-specialist-factory.json'), { candidates: [] });
const phase22 = readJson(join(root, 'models', 'champions', 'current-phase22-deep-specialist-tournament.json'), null)
  || readJson(join(root, 'apps', 'dashboard', 'public', 'data', 'phase22-deep-specialist-tournament.json'), null);
const phase23 = readJson(join(root, 'models', 'champions', 'current-phase23-intelligence-specialist.json'), null)
  || readJson(join(root, 'apps', 'dashboard', 'public', 'data', 'phase23-intelligence-specialist.json'), null);
const phase24 = readJson(join(root, 'models', 'self-improvement', 'current-phase24-self-improvement.json'), null)
  || readJson(join(root, 'apps', 'dashboard', 'public', 'data', 'phase24-self-improvement.json'), null);
const phase25 = readJson(join(root, 'models', 'fresh-symbol', 'current-phase25-fresh-symbol-tournament.json'), null)
  || readJson(join(root, 'apps', 'dashboard', 'public', 'data', 'phase25-fresh-symbol-tournament.json'), null);
const phase26 = readJson(join(root, 'models', 'generalization', 'current-phase26-generalization-engine.json'), null)
  || readJson(join(root, 'apps', 'dashboard', 'public', 'data', 'phase26-generalization-engine.json'), null);
const phase27 = readJson(join(root, 'models', 'promotions', 'current-phase27-promotion-audit.json'), null)
  || readJson(join(root, 'apps', 'dashboard', 'public', 'data', 'phase27-promotion-audit.json'), null);
const phase27Options = readJson(join(root, 'models', 'options', 'current-phase27-options-overlay.json'), null)
  || readJson(join(root, 'apps', 'dashboard', 'public', 'data', 'phase27-options-overlay.json'), null);
const optionsProbe = readJson(join(root, 'apps', 'dashboard', 'public', 'data', 'options-data-probe.json'), null)
  || readJson(join(root, 'reports', 'options-data-probe-report.json'), null);
const tradingViewMcp = readJson(join(root, 'apps', 'dashboard', 'public', 'data', 'tradingview-mcp-snapshot.json'), null)
  || readJson(join(root, 'reports', 'tradingview-mcp-snapshot.json'), null);
const phase17 = readJson(join(root, 'models', 'specialists', 'current-phase17-specialist-tournament.json'), null);
const championSummary = summarizeChampion(champion);

const dashboard = {
  updatedAt: new Date().toISOString(),
  champion: championSummary,
  specialists: summarizeSpecialists(activeModes, { champion: championSummary, phase17 }),
  patternLab: patternLab ? {
    updatedAt: patternLab.updatedAt,
    data: patternLab.data,
    global: patternLab.global,
    topPatterns: patternLab.patterns?.byTag?.slice(0, 20) || [],
    topRoutes: patternLab.patterns?.byRoute?.slice(0, 30) || [],
    topSymbols: patternLab.topSymbols?.slice(0, 30) || [],
    biggestTrades: patternLab.biggestTrades?.slice(0, 30) || [],
    clusters: patternLab.clusters,
    dailyPerformance: patternLab.dailyPerformance || [],
  } : null,
  canonical: canonicalData ? {
    updatedAt: canonicalData.updatedAt,
    source: canonicalData.source,
    config: canonicalData.config,
    stats: canonicalData.stats,
    globalMetrics: canonicalData.globalMetrics,
    topRoutes: canonicalData.topRoutes?.slice(0, 60) || [],
    topSymbols: canonicalData.topSymbols?.slice(0, 60) || [],
    factoryCandidates: canonicalData.factoryCandidates?.slice(0, 80) || [],
  } : null,
  backtestHits: {
    source: canonicalData ? 'Phase21 canonical deduped ledgers' : 'Pattern Lab sampled ledgers',
    topSymbols: canonicalData?.topSymbols?.slice(0, 30) || patternLab?.topSymbols?.slice(0, 30) || summarizeChampion(champion)?.topSymbols || [],
    biggestTrades: patternLab?.biggestTrades?.slice(0, 30) || summarizeChampion(champion)?.biggestTrades || [],
  },
  patternCandidates: patternCandidates.candidates || [],
  specialistFactory: specialistFactory.candidates || canonicalData?.factoryCandidates || [],
  phase22: phase22 ? {
    updatedAt: phase22.updatedAt,
    runId: phase22.runId,
    phase: phase22.phase,
    config: phase22.config,
    recommendedChampion: compactTournamentVariant(phase22.recommendedChampion, { topLimit: 16, tradeLimit: 10 }),
    categoryChampions: compactCategoryMap(phase22.categoryChampions, { topLimit: 10, tradeLimit: 5 }),
    rankedVariants: phase22.rankedVariants?.slice(0, 40).map((variant) => compactTournamentVariant(variant, { topLimit: 6, tradeLimit: 0 })) || [],
  } : null,
  phase23: phase23 ? {
    updatedAt: phase23.updatedAt,
    runId: phase23.runId,
    phase: phase23.phase,
    goal: phase23.goal,
    config: phase23.config,
    baselinePhase22: phase23.baselinePhase22,
    recommendedChampion: compactTournamentVariant(phase23.recommendedChampion, { topLimit: 16, tradeLimit: 10 }),
    categoryChampions: compactCategoryMap(phase23.categoryChampions, { topLimit: 10, tradeLimit: 5 }),
    featureBlueprints: phase23.featureBlueprints,
    machineLearningDraft: phase23.machineLearningDraft,
    rankedVariants: phase23.rankedVariants?.slice(0, 40).map((variant) => compactTournamentVariant(variant, { topLimit: 6, tradeLimit: 0 })) || [],
  } : null,
  phase24: phase24 ? {
    updatedAt: phase24.updatedAt,
    runId: phase24.runId,
    phase: phase24.phase,
    goal: phase24.goal,
    safety: phase24.safety,
    config: phase24.config,
    baselines: phase24.baselines,
    categoryChampions: compactCategoryMap(phase24.categoryChampions, { topLimit: 10, tradeLimit: 5 }),
    promoted: phase24.promoted?.slice(0, 20).map((variant) => compactTournamentVariant(variant, { topLimit: 8, tradeLimit: 3 })) || [],
    watchlist: phase24.watchlist?.slice(0, 20).map((variant) => compactTournamentVariant(variant, { topLimit: 8, tradeLimit: 3 })) || [],
    rejected: phase24.rejected?.slice(0, 20).map((variant) => compactTournamentVariant(variant, { topLimit: 5, tradeLimit: 2 })) || [],
    rankedVariants: phase24.rankedVariants?.slice(0, 40).map((variant) => compactTournamentVariant(variant, { topLimit: 6, tradeLimit: 0 })) || [],
    optionsWorthyTrades: phase24.optionsWorthyTrades?.slice(0, 30) || [],
    improvementLoop: phase24.improvementLoop || [],
  } : null,
  phase25: phase25 ? {
    updatedAt: phase25.updatedAt,
    runId: phase25.runId,
    phase: phase25.phase,
    goal: phase25.goal,
    safety: phase25.safety,
    config: phase25.config,
    freshSymbolLeaderboard: phase25.freshSymbolLeaderboard?.slice(0, 40) || [],
    categoryChampions: compactCategoryMap(phase25.categoryChampions, { topLimit: 12, tradeLimit: 6 }),
    perChallengerBest: phase25.perChallengerBest?.slice(0, 30).map((variant) => compactTournamentVariant(variant, { topLimit: 8, tradeLimit: 3 })) || [],
    promoted: phase25.promoted?.slice(0, 20).map((variant) => compactTournamentVariant(variant, { topLimit: 8, tradeLimit: 3 })) || [],
    lowSampleWatchlist: phase25.lowSampleWatchlist?.slice(0, 20).map((variant) => compactTournamentVariant(variant, { topLimit: 6, tradeLimit: 3 })) || [],
    rankedVariants: phase25.rankedVariants?.slice(0, 40).map((variant) => compactTournamentVariant(variant, { topLimit: 6, tradeLimit: 0 })) || [],
  } : null,
  phase26: phase26 ? {
    updatedAt: phase26.updatedAt,
    runId: phase26.runId,
    phase: phase26.phase,
    goal: phase26.goal,
    safety: phase26.safety,
    config: phase26.config,
    baselines: phase26.baselines,
    improvementCoverage: phase26.improvementCoverage || [],
    featureImportance: phase26.featureImportance?.slice(0, 30) || [],
    patternPrototypes: phase26.patternPrototypes?.slice(0, 30) || [],
    tickerDiscovery: phase26.tickerDiscovery?.slice(0, 40) || [],
    categoryChampions: compactCategoryMap(phase26.categoryChampions, { topLimit: 12, tradeLimit: 6 }),
    perLayerBest: phase26.perLayerBest?.slice(0, 30).map((variant) => compactTournamentVariant(variant, { topLimit: 8, tradeLimit: 3 })) || [],
    promoted: phase26.promoted?.slice(0, 20).map((variant) => compactTournamentVariant(variant, { topLimit: 8, tradeLimit: 3 })) || [],
    watchlist: phase26.watchlist?.slice(0, 20).map((variant) => compactTournamentVariant(variant, { topLimit: 8, tradeLimit: 3 })) || [],
    rankedVariants: phase26.rankedVariants?.slice(0, 40).map((variant) => compactTournamentVariant(variant, { topLimit: 6, tradeLimit: 0 })) || [],
  } : null,
  phase27: phase27 ? {
    updatedAt: phase27.updatedAt,
    runId: phase27.runId,
    phase: phase27.phase,
    safety: phase27.safety,
    promotedChampion: phase27.promotedChampion,
    specialistModes: phase27.specialistModes,
    auditFindings: phase27.auditFindings || [],
    realityChecklist: phase27.realityChecklist || [],
    activeModes: phase27.activeModes,
    optionsOverlaySummary: phase27.optionsOverlaySummary,
  } : null,
  phase27Options: phase27Options ? {
    updatedAt: phase27Options.updatedAt,
    phase: phase27Options.phase,
    safety: phase27Options.safety,
    source: phase27Options.source,
    config: phase27Options.config,
    totals: phase27Options.totals,
    dataConfidence: phase27Options.dataConfidence,
    rows: phase27Options.rows?.slice(0, 80) || [],
  } : null,
  optionsProbe: optionsProbe ? {
    updatedAt: optionsProbe.updatedAt,
    phase: optionsProbe.phase,
    sourceLedger: optionsProbe.sourceLedger,
    config: optionsProbe.config,
    providerResults: optionsProbe.providerResults || [],
    totals: optionsProbe.totals,
    dataConfidence: optionsProbe.dataConfidence,
    rows: optionsProbe.rows?.slice(0, 60) || [],
  } : null,
  tradingViewMcp,
  forward: summarizeForward(),
  pine: pineStatus(),
  artifacts: {
    reports: latestFiles(reportsDir, 30),
    ledgers: latestFiles(join(root, 'ledgers'), 20),
    generated: latestFiles(join(root, 'generated'), 20),
  },
};

writeJson(join(dashboardDir, 'dashboard.json'), dashboard);
writeJson(join(reportsDir, 'dashboard-summary.json'), dashboard);

console.log('Dashboard data built');
console.log(`Champion=${dashboard.champion?.bestVariant || 'none'} specialists=${dashboard.specialists.length} patternCandidates=${dashboard.patternCandidates.length}`);
console.log(`Data: ${join(dashboardDir, 'dashboard.json')}`);
