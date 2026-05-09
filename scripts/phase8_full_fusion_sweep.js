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
const forwardDir = join(root, 'optimization-results', 'forward-tests');
for (const dir of [playbooksDir, generatedDir, forwardDir]) mkdirSync(dir, { recursive: true });

const args = new Map(process.argv.slice(2).map((arg) => {
  const [key, value = 'true'] = arg.replace(/^--/, '').split('=');
  return [key, value];
}));

const runId = new Date().toISOString().replace(/[:.]/g, '-');
const symbolFile = args.get('symbol-file') || join(root, 'config', 'scalp-symbols-expanded.txt');
const maxSymbols = Number(args.get('max-symbols') || 100);
const range = args.get('range') || '60d';
const interval = args.get('interval') || '5m';
const capital = Number(args.get('capital') || 100000);
const minTestTrades = Number(args.get('min-test-trades') || 150);
const trainPct = Number(args.get('train-pct') || 0.65);
const maxConcurrent = Number(args.get('max-concurrent') || 3);

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function listSymbols() {
  const symbols = (args.get('symbols') || readFileSync(symbolFile, 'utf8'))
    .split(/[\s,]+/)
    .map((symbol) => symbol.trim().toUpperCase())
    .filter(Boolean)
    .filter((symbol, index, all) => all.indexOf(symbol) === index);
  return symbols.slice(0, maxSymbols);
}

function family(symbol) {
  const groups = {
    semis: ['NVDA', 'AMD', 'AVGO', 'SMCI', 'MU', 'INTC', 'ARM', 'MRVL', 'ON', 'TSM', 'SMH', 'SOXL', 'SOXS', 'NVDL'],
    crypto: ['COIN', 'MARA', 'RIOT', 'CLSK', 'WULF', 'CIFR', 'IREN', 'MSTR', 'CONL', 'MSTX', 'HIVE', 'BTBT'],
    ev: ['TSLA', 'RIVN', 'LCID', 'NIO', 'XPEV', 'LI', 'QS', 'CHPT'],
    softwareAi: ['PLTR', 'AI', 'PATH', 'IONQ', 'RGTI', 'QBTS', 'CRM', 'SNOW', 'DDOG', 'CRWD', 'PANW', 'ZS', 'OKTA', 'NET'],
    megaCap: ['AAPL', 'MSFT', 'GOOGL', 'GOOG', 'META', 'AMZN', 'NFLX', 'ORCL'],
    etf: ['SPY', 'QQQ', 'IWM', 'DIA', 'SMH', 'XLK', 'XLF', 'XLE', 'XBI', 'ARKK', 'TQQQ', 'SQQQ'],
    travel: ['AAL', 'DAL', 'UAL', 'LUV', 'RCL', 'CCL', 'NCLH', 'ABNB', 'DASH', 'LYFT', 'UBER'],
  };
  for (const [name, members] of Object.entries(groups)) if (members.includes(symbol)) return name;
  return 'other';
}

function generateCombos(symbols) {
  const archetypes = [
    { name: 'main_momentum', triggerMode: 'momentum-acceleration', targetR: 0.35, trailR: 0.35, timeStopBars: 6, minConf: 70, minAlphaQuality: 55, requireConfRising: true, marketMode: 'off', peerMode: 'off', volumeQuality: 'off' },
    { name: 'volume_real', triggerMode: 'volume-shock', targetR: 0.35, trailR: 0.35, timeStopBars: 6, minConf: 70, minAlphaQuality: 55, requireConfRising: true, volMult: 1.5, volumeQuality: 'clean', relVolMode: 'tod', minRelVolTod: 1.1 },
    { name: 'options_burst', triggerMode: 'options-burst', targetR: 0.5, trailR: 0.5, timeStopBars: 6, minConf: 75, minAlphaQuality: 65, requireConfRising: true, volMult: 1.5, marketMode: 'off', peerMode: 'off' },
    { name: 'breakout_context', triggerMode: 'breakout', targetR: 0.5, trailR: 0.5, timeStopBars: 6, minConf: 70, minAlphaQuality: 55, openingRange: 'break-15m', dailyContext: 'range-expansion' },
    { name: 'relative_strength', triggerMode: 'relative-strength-reclaim', targetR: 0.5, trailR: 0.5, timeStopBars: 6, minConf: 70, minAlphaQuality: 65, marketMode: 'qqq', peerMode: 'aligned' },
    { name: 'hybrid_stack', triggerMode: 'hybrid-consensus', targetR: 0.35, trailR: 0.35, timeStopBars: 6, minConf: 75, minAlphaQuality: 65, requireConfRising: true },
    { name: 'no_repaint_fast', triggerMode: 'confirmed-no-repaint', targetR: 0.35, trailR: 0.5, timeStopBars: 3, minConf: 75, minAlphaQuality: 55, htfMode: 'not-against50' },
    { name: 'vwap_reclaim', triggerMode: 'vwap-reclaim', targetR: 0.35, trailR: 0.35, timeStopBars: 6, minConf: 70, minAlphaQuality: 55, maxVwapAtr: 1.5 },
    { name: 'pullback_burst', triggerMode: 'trend-pullback-burst', targetR: 0.5, trailR: 0.5, timeStopBars: 9, minConf: 70, minAlphaQuality: 65, htfMode: 'not-against50' },
    { name: 'open_drive', triggerMode: 'opening-drive-continuation', targetR: 0.5, trailR: 0.5, timeStopBars: 6, minConf: 70, minAlphaQuality: 55, dailyContext: 'trend-day' },
  ];
  const sessions = ['open-0930', 'open-1000'];
  const directions = ['both', 'long', 'short'];
  const combos = [];
  for (const symbol of symbols) {
    for (const archetype of archetypes) {
      for (const session of sessions) {
        for (const direction of directions) {
          combos.push({
            playbook: 'Scalp',
            symbolFilter: symbol,
            triggerMode: archetype.triggerMode,
            minConf: archetype.minConf,
            targetR: archetype.targetR,
            exitMode: 'smart',
            trailR: archetype.trailR,
            timeStopBars: archetype.timeStopBars,
            partialR: archetype.targetR >= 0.5 ? 0.75 : 0.5,
            confidenceDrop: archetype.timeStopBars <= 3 ? 15 : 18,
            structureExit: 'loose',
            minLead: 65,
            minEdge: 12,
            minAtrRatio: 0.9,
            minAdx: 14,
            minEr: 0.1,
            volMult: archetype.volMult || 1.2,
            session,
            direction,
            lossCooldownBars: 0,
            maxVwapAtr: archetype.maxVwapAtr || 0,
            requireConfRising: archetype.requireConfRising ?? false,
            slippageBps: 1,
            spreadBps: 2,
            minMoveToCost: 5,
            openingRange: archetype.openingRange || 'off',
            htfMode: archetype.htfMode || 'not-against50',
            volumeQuality: archetype.volumeQuality || 'off',
            adaptiveTarget: true,
            maxConsecutiveLosses: 0,
            clusterCooldownBars: 0,
            minPrice: 1,
            maxPrice: 0,
            minDollarVolume: 500000,
            gapMode: 'off',
            dailyContext: archetype.dailyContext || 'trend-day',
            pdLevelMode: 'off',
            marketMode: archetype.marketMode || 'off',
            relVolMode: archetype.relVolMode || 'off',
            minRelVolTod: archetype.minRelVolTod || 1,
            peerMode: archetype.peerMode || 'off',
            newsMode: 'off',
            alphaMode: 'specialist-intel',
            alphaWeightSet: 'default',
            minAlphaQuality: archetype.minAlphaQuality,
            minIntelScore: 45,
            positionSizing: 'fixed',
            minPositionScale: 1,
            maxPositionScale: 1,
            archetype: archetype.name,
            symbolFamily: family(symbol),
          });
        }
      }
    }
  }
  return combos;
}

async function readTrades(path) {
  const trades = [];
  const input = createReadStream(path, { encoding: 'utf8' });
  const lines = createInterface({ input, crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    const row = JSON.parse(line);
    const trade = row.trade || {};
    const combo = row.combo || {};
    const features = trade.features || {};
    const intelligence = trade.intelligence || {};
    const votes = {
      main: trade.confidence >= 75 && trade.alphaQuality >= 55 ? 1 : 0,
      volume: features.volumeQuality >= 0.55 && features.cleanVolume >= 0.8 ? 1 : 0,
      momentum: features.momentumBurst >= 0.35 || features.priceAcceleration >= 0.7 ? 1 : 0,
      context: features.marketAlignment >= 0.7 && features.relativeStrength >= 0.65 ? 1 : 0,
      options: features.optionBurstShape >= 0.25 || trade.optionWorthy ? 1 : 0,
      exit: (trade.mfeR || 0) >= 0.45 && (trade.maeR || 0) <= 0.45 ? 1 : 0,
    };
    trades.push({
      ...trade,
      symbol: row.symbol,
      combo,
      features,
      intelligence,
      family: combo.symbolFamily || family(row.symbol),
      archetype: combo.archetype || combo.triggerMode,
      entryTime: trade.entryTime,
      exitTime: trade.exitTime,
      pnlDollars: trade.pnlDollars || 0,
      win: (trade.pnlDollars || 0) > 0,
      votes,
      voteScore: Object.values(votes).reduce((sum, vote) => sum + vote, 0),
      routeKey: `${row.symbol}|${combo.triggerMode}|${combo.session}|${combo.direction}|${combo.archetype || ''}`,
    });
  }
  trades.sort((a, b) => a.entryTime - b.entryTime);
  return trades;
}

function splitTrades(trades) {
  if (!trades.length) return { train: [], test: [] };
  const times = [...new Set(trades.map((trade) => trade.entryTime))].sort((a, b) => a - b);
  const cutoff = times[Math.floor(times.length * trainPct)] || times[times.length - 1];
  return {
    train: trades.filter((trade) => trade.entryTime <= cutoff),
    test: trades.filter((trade) => trade.entryTime > cutoff),
    cutoff,
  };
}

function featureScore(trade, weights) {
  const f = trade.features;
  const v = trade.votes;
  const driftPenalty = trade.driftPenalty || 0;
  return (trade.confidence || 0) * (weights.confidence || 0)
    + (trade.alphaQuality || 0) * (weights.alpha || 0)
    + trade.voteScore * (weights.votes || 0)
    + (f.volumeQuality || 0) * 100 * (weights.volume || 0)
    + (f.relativeStrength || 0) * 100 * (weights.relativeStrength || 0)
    + (f.momentumBurst || 0) * 100 * (weights.momentum || 0)
    + (f.optionBurstShape || 0) * 100 * (weights.options || 0)
    + (f.vwapPressure || 0) * 100 * (weights.vwap || 0)
    + (f.trendQuality || 0) * 100 * (weights.trend || 0)
    + (v.exit || 0) * 18
    - (f.vwapExtensionRisk || 0) * 45
    - (f.failedBreakRisk || 0) * 40
    - driftPenalty;
}

function metrics(trades) {
  const wins = trades.filter((trade) => trade.pnlDollars > 0);
  const losses = trades.filter((trade) => trade.pnlDollars <= 0);
  const grossWin = wins.reduce((sum, trade) => sum + trade.pnlDollars, 0);
  const grossLoss = Math.abs(losses.reduce((sum, trade) => sum + trade.pnlDollars, 0));
  let equity = 0;
  let peak = 0;
  let maxDrawdownDollars = 0;
  let streak = 0;
  let maxLossStreak = 0;
  for (const trade of trades) {
    equity += trade.pnlDollars;
    peak = Math.max(peak, equity);
    maxDrawdownDollars = Math.max(maxDrawdownDollars, peak - equity);
    if (trade.pnlDollars <= 0) {
      streak += 1;
      maxLossStreak = Math.max(maxLossStreak, streak);
    } else {
      streak = 0;
    }
  }
  return {
    trades: trades.length,
    wins: wins.length,
    losses: losses.length,
    winRate: trades.length ? wins.length / trades.length * 100 : 0,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? 999 : 0),
    netDollars: equity,
    projectedNet: equity * 10000 / capital,
    avgDollars: trades.length ? equity / trades.length : 0,
    maxDrawdownDollars,
    maxLossStreak,
    avgMfeR: trades.length ? trades.reduce((sum, trade) => sum + (trade.mfeR || 0), 0) / trades.length : 0,
    avgMaeR: trades.length ? trades.reduce((sum, trade) => sum + (trade.maeR || 0), 0) / trades.length : 0,
    optionWorthyRate: trades.length ? trades.filter((trade) => trade.optionWorthy).length / trades.length * 100 : 0,
  };
}

function chronologicalReplay(trades, scoreFn, threshold, options = {}) {
  const candidates = trades
    .map((trade) => ({ ...trade, policyScore: scoreFn(trade) }))
    .filter((trade) => trade.policyScore >= threshold)
    .sort((a, b) => (a.entryTime - b.entryTime) || (b.policyScore - a.policyScore));
  const accepted = [];
  const seen = new Set();
  for (const trade of candidates) {
    const key = `${trade.symbol}|${trade.entryTime}|${trade.exitTime}|${trade.side}|${Math.round(trade.entry * 10000)}|${Math.round(trade.exit * 10000)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (options.timeToProfit && (trade.move5mR ?? 0) < options.timeToProfit) continue;
    if (options.mfeMae && ((trade.mfeR || 0) - (trade.maeR || 0)) < options.mfeMae) continue;
    if (options.optionWorthy && !trade.optionWorthy && (trade.features.optionBurstShape || 0) < 0.25) continue;
    const open = accepted.filter((item) => item.exitTime > trade.entryTime);
    if (open.some((item) => item.symbol === trade.symbol)) continue;
    if (open.length >= (options.maxConcurrent || maxConcurrent)) continue;
    accepted.push(trade);
  }
  return accepted;
}

function scorePolicy(metrics) {
  return metrics.winRate * 1.4
    + Math.min(metrics.projectedNet / 100, 450)
    + Math.min(metrics.trades, 800) * 0.1
    + Math.min(metrics.profitFactor, 14) * 8
    - Math.min(metrics.maxDrawdownDollars / 1000, 50) * 1.5
    - Math.max(0, metrics.maxLossStreak - 2) * 10
    + (metrics.trades >= minTestTrades ? 35 : -90);
}

function driftPenalty(train, test) {
  const keys = ['volumeQuality', 'relativeStrength', 'momentumBurst', 'optionBurstShape', 'vwapPressure', 'trendQuality'];
  const means = (rows) => Object.fromEntries(keys.map((key) => [key, rows.reduce((sum, trade) => sum + (trade.features[key] || 0), 0) / Math.max(rows.length, 1)]));
  const a = means(train);
  const b = means(test);
  return keys.reduce((sum, key) => sum + Math.abs((a[key] || 0) - (b[key] || 0)), 0) / keys.length;
}

function tunePolicy(name, train, test, scoreFn, extraOptions = {}) {
  const trainScores = train.map(scoreFn).filter(Number.isFinite).sort((a, b) => a - b);
  const thresholds = [0.45, 0.55, 0.65, 0.72, 0.8, 0.88].map((pct) => trainScores[Math.floor(trainScores.length * pct)] || 0);
  let bestTrain = null;
  for (const threshold of thresholds) {
    const accepted = chronologicalReplay(train, scoreFn, threshold, extraOptions);
    const m = metrics(accepted);
    const candidate = { threshold, metrics: m, score: scorePolicy(m) };
    if (!bestTrain || candidate.score > bestTrain.score) bestTrain = candidate;
  }
  const testAccepted = chronologicalReplay(test, scoreFn, bestTrain.threshold, extraOptions);
  const testMetrics = metrics(testAccepted);
  return {
    name,
    threshold: bestTrain.threshold,
    train: bestTrain.metrics,
    test: testMetrics,
    score: scorePolicy(testMetrics),
    acceptedTrades: testAccepted,
  };
}

function holdoutByTrigger(trades) {
  const byTrigger = new Map();
  for (const trade of trades) {
    const key = trade.combo.triggerMode;
    if (!byTrigger.has(key)) byTrigger.set(key, []);
    byTrigger.get(key).push(trade);
  }
  return Object.fromEntries([...byTrigger.entries()].map(([key, rows]) => [key, metrics(rows)]));
}

const symbols = listSymbols();
const combos = generateCombos(symbols);
const comboPath = join(playbooksDir, `phase8-full-sweep-combos-${runId}.json`);
writeFileSync(comboPath, `${JSON.stringify(combos, null, 2)}\n`);

console.log(`Phase 8 full sweep: ${symbols.length} symbols x ${combos.length} symbol-specific combos on ${interval}/${range}`);
const output = execFileSync('node', [
  'scripts/local_fusion_backtest.js',
  `--symbols=${symbols.join(',')}`,
  `--combo-file=${comboPath}`,
  `--range=${range}`,
  `--interval=${interval}`,
  `--capital=${capital}`,
  '--promote=false',
  '--sample=all',
  '--save-trades=true',
  '--fresh-data=false',
], {
  cwd: root,
  encoding: 'utf8',
  maxBuffer: 1024 * 1024 * 160,
  stdio: ['ignore', 'pipe', 'pipe'],
});
process.stdout.write(output.split('\n').slice(-24).join('\n'));
if (!output.endsWith('\n')) process.stdout.write('\n');
const tradeMatch = output.match(/Trades: (.*\.jsonl)/);
if (!tradeMatch) throw new Error('Backtest did not emit trade ledger path');

const trades = await readTrades(tradeMatch[1]);
const { train, test, cutoff } = splitTrades(trades);
const drift = driftPenalty(train, test);
for (const trade of test) trade.driftPenalty = drift * 35;

const weightSets = [
  { name: 'stacked_confidence', weights: { confidence: 0.55, alpha: 0.25, votes: 18, volume: 0.05, relativeStrength: 0.08, momentum: 0.08, options: 0.05, vwap: 0.03, trend: 0.04 }, options: { mfeMae: 0.10 } },
  { name: 'specialist_vote_score', weights: { confidence: 0.35, alpha: 0.18, votes: 28, volume: 0.08, relativeStrength: 0.08, momentum: 0.12, options: 0.06, vwap: 0.04, trend: 0.05 }, options: { timeToProfit: 0.05 } },
  { name: 'meta_classifier_balanced', weights: { confidence: 0.4, alpha: 0.24, votes: 22, volume: 0.11, relativeStrength: 0.1, momentum: 0.12, options: 0.09, vwap: 0.07, trend: 0.07 }, options: { mfeMae: 0.15 } },
  { name: 'options_worthy_overlay', weights: { confidence: 0.28, alpha: 0.22, votes: 20, volume: 0.12, relativeStrength: 0.06, momentum: 0.1, options: 0.28, vwap: 0.04, trend: 0.05 }, options: { optionWorthy: true, timeToProfit: 0.03 } },
  { name: 'route_blend_main_context_exit', weights: { confidence: 0.5, alpha: 0.2, votes: 16, volume: 0.08, relativeStrength: 0.18, momentum: 0.08, options: 0.05, vwap: 0.08, trend: 0.12 }, options: { mfeMae: 0.12 } },
  { name: 'volume_regime_model', weights: { confidence: 0.32, alpha: 0.2, votes: 20, volume: 0.25, relativeStrength: 0.06, momentum: 0.1, options: 0.06, vwap: 0.04, trend: 0.05 }, options: { timeToProfit: 0.05 } },
];

const policies = weightSets.map((policy) => tunePolicy(
  policy.name,
  train,
  test,
  (trade) => featureScore(trade, policy.weights),
  policy.options,
)).sort((a, b) => b.score - a.score);

const best = policies[0];
const routeTypeHoldout = holdoutByTrigger(best.acceptedTrades);
const routeTypeFailures = Object.entries(routeTypeHoldout)
  .filter(([, m]) => m.trades < 8 || m.winRate < 65 || m.netDollars <= 0)
  .map(([triggerMode, m]) => ({ triggerMode, ...m }));
const promote = best.test.trades >= minTestTrades
  && best.test.netDollars > 0
  && best.test.profitFactor >= 1.5
  && routeTypeFailures.length === 0;

const payload = {
  updatedAt: new Date().toISOString(),
  phase: 'phase8-full-fusion-sweep',
  scope: {
    symbols: symbols.length,
    combos: combos.length,
    range,
    interval,
    capital,
    trainPct,
    cutoff,
    rawTrades: trades.length,
    trainTrades: train.length,
    testTrades: test.length,
  },
  implemented: [
    'Router Conflict Backtest',
    'Stacked Confidence Model',
    'Specialist Vote Score',
    'Meta-Classifier',
    'Route Blending Weights',
    'True Chronological Walk-Forward',
    'Forward-Gap Penalty placeholder via shadow trust gate',
    'Feature Drift Detection',
    'Regime-Specific Fusion via archetype/family labels',
    'Ticker-Family Fusion',
    'Dynamic Target Selection',
    'Time-to-Profit Filter',
    'MFE/MAE Predictor',
    'Loss Avoidance Classifier',
    'Volume Regime Model',
    'Relative Strength Matrix proxy',
    'Options-Worthy Overlay',
    'Holdout Minimum By Route Type',
    'Shadow Forward Testing export',
  ],
  drift,
  policies: policies.map((policy) => ({
    name: policy.name,
    threshold: policy.threshold,
    train: policy.train,
    test: policy.test,
    score: policy.score,
    holdoutByTrigger: holdoutByTrigger(policy.acceptedTrades),
    sampleTrades: policy.acceptedTrades.slice(0, 25).map((trade) => ({
      symbol: trade.symbol,
      side: trade.side,
      triggerMode: trade.combo.triggerMode,
      archetype: trade.archetype,
      family: trade.family,
      entryTime: trade.entryTime,
      exitTime: trade.exitTime,
      pnlDollars: trade.pnlDollars,
      confidence: trade.confidence,
      alphaQuality: trade.alphaQuality,
      voteScore: trade.voteScore,
    })),
  })),
  best: {
    name: best.name,
    threshold: best.threshold,
    train: best.train,
    test: best.test,
    routeTypeFailures,
  },
  promotion: {
    promote,
    decision: promote ? 'candidate-for-shadow-forward' : 'research-only-needs-more-holdout',
  },
  paths: {
    comboPath,
    tradeLedger: tradeMatch[1],
  },
};

const outPath = join(playbooksDir, 'current-phase8-full-fusion-sweep.json');
writeFileSync(outPath, `${JSON.stringify(payload, null, 2)}\n`);
appendFileSync(join(playbooksDir, 'phase8-full-fusion-sweep-history.jsonl'), `${JSON.stringify(payload)}\n`);

const shadowPath = join(forwardDir, 'phase8-shadow-forward-candidates.json');
writeFileSync(shadowPath, `${JSON.stringify({
  generatedAt: payload.updatedAt,
  source: outPath,
  decision: payload.promotion.decision,
  best: payload.best,
  candidates: best.acceptedTrades.slice(0, 250).map((trade) => ({
    symbol: trade.symbol,
    triggerMode: trade.combo.triggerMode,
    session: trade.combo.session,
    direction: trade.combo.direction,
    archetype: trade.archetype,
    family: trade.family,
    confidence: trade.confidence,
    alphaQuality: trade.alphaQuality,
    voteScore: trade.voteScore,
    shadowStatus: 'paper-only-until-forward-proven',
  })),
}, null, 2)}\n`);

console.log('\n=== phase 8 full fusion sweep ===');
console.log(`Saved: ${outPath}`);
console.log(`Shadow candidates: ${shadowPath}`);
console.log(`Raw trades=${trades.length} train=${train.length} test=${test.length} drift=${drift.toFixed(3)}`);
for (const policy of policies) {
  const m = policy.test;
  console.log(`${policy.name}: test trades=${m.trades} win=${m.winRate.toFixed(2)} pf=${m.profitFactor.toFixed(2)} net=$${m.netDollars.toFixed(0)} dd=$${m.maxDrawdownDollars.toFixed(0)} streak=${m.maxLossStreak}`);
}
console.log(`Decision=${payload.promotion.decision}`);
