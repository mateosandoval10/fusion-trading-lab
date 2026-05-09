#!/usr/bin/env node
import { appendFileSync, createReadStream, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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
const minTestTrades = Number(args.get('min-test-trades') || 120);
const maxConcurrent = Number(args.get('max-concurrent') || 2);

const highBetaUniverse = [
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
    { name: 'profit_breakout_1r', triggerMode: 'breakout', targetR: 1.0, trailR: 0.75, timeStopBars: 12, minConf: 72, minAlphaQuality: 65, volMult: 1.2, openingRange: 'break-15m', dailyContext: 'range-expansion' },
    { name: 'options_burst_1r', triggerMode: 'options-burst', targetR: 1.0, trailR: 0.75, timeStopBars: 9, minConf: 75, minAlphaQuality: 65, volMult: 1.5, requireConfRising: true },
    { name: 'options_burst_15r', triggerMode: 'options-burst', targetR: 1.5, trailR: 1.0, timeStopBars: 12, minConf: 78, minAlphaQuality: 70, volMult: 1.5, requireConfRising: true },
    { name: 'open_drive_runner', triggerMode: 'opening-drive-continuation', targetR: 1.0, trailR: 0.75, timeStopBars: 12, minConf: 72, minAlphaQuality: 60, dailyContext: 'trend-day' },
    { name: 'momentum_runner', triggerMode: 'momentum-acceleration', targetR: 0.75, trailR: 0.5, timeStopBars: 9, minConf: 72, minAlphaQuality: 65, requireConfRising: true },
    { name: 'relative_strength_runner', triggerMode: 'relative-strength-reclaim', targetR: 1.0, trailR: 0.75, timeStopBars: 12, minConf: 72, minAlphaQuality: 65, marketMode: 'qqq' },
    { name: 'hybrid_runner', triggerMode: 'hybrid-consensus', targetR: 0.75, trailR: 0.5, timeStopBars: 9, minConf: 75, minAlphaQuality: 65, requireConfRising: true },
    { name: 'squeeze_expansion_runner', triggerMode: 'squeeze-expansion', targetR: 1.0, trailR: 0.75, timeStopBars: 12, minConf: 72, minAlphaQuality: 60, volMult: 1.5 },
    { name: 'volume_shock_runner', triggerMode: 'volume-shock', targetR: 0.75, trailR: 0.5, timeStopBars: 9, minConf: 70, minAlphaQuality: 60, volMult: 1.8, volumeQuality: 'clean', relVolMode: 'tod', minRelVolTod: 1.2 },
  ];
  const sessions = ['open-0930', 'open-1000', 'morning'];
  const directions = ['both', 'long', 'short'];
  const combos = [];
  for (const symbol of symbols) {
    for (const engine of engines) {
      for (const session of sessions) {
        for (const direction of directions) {
          combos.push({
            playbook: 'Scalp',
            symbolFilter: symbol,
            triggerMode: engine.triggerMode,
            minConf: engine.minConf,
            targetR: engine.targetR,
            exitMode: 'smart',
            trailR: engine.trailR,
            timeStopBars: engine.timeStopBars,
            partialR: 0.5,
            confidenceDrop: engine.targetR >= 1 ? 28 : 22,
            structureExit: 'loose',
            minLead: 65,
            minEdge: 12,
            minAtrRatio: 0.9,
            minAdx: 14,
            minEr: 0.1,
            volMult: engine.volMult || 1.2,
            session,
            direction,
            lossCooldownBars: 0,
            maxVwapAtr: 0,
            requireConfRising: engine.requireConfRising ?? false,
            slippageBps: 1,
            spreadBps: 2,
            minMoveToCost: 5,
            openingRange: engine.openingRange || 'off',
            htfMode: 'not-against50',
            volumeQuality: engine.volumeQuality || 'off',
            adaptiveTarget: true,
            maxConsecutiveLosses: 0,
            clusterCooldownBars: 0,
            minPrice: 1,
            maxPrice: 0,
            minDollarVolume: 500000,
            gapMode: 'off',
            dailyContext: engine.dailyContext || 'trend-day',
            pdLevelMode: 'off',
            marketMode: engine.marketMode || 'off',
            relVolMode: engine.relVolMode || 'off',
            minRelVolTod: engine.minRelVolTod || 1,
            peerMode: 'off',
            newsMode: 'off',
            alphaMode: 'specialist-intel',
            alphaWeightSet: 'default',
            minAlphaQuality: engine.minAlphaQuality,
            minIntelScore: 45,
            positionSizing: 'fixed',
            minPositionScale: 1,
            maxPositionScale: 1,
            archetype: engine.name,
            symbolFamily: family(symbol),
          });
        }
      }
    }
  }
  return combos;
}

async function readTrades(path) {
  const rows = [];
  const input = createReadStream(path, { encoding: 'utf8' });
  const lines = createInterface({ input, crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    const row = JSON.parse(line);
    const trade = row.trade || {};
    const features = trade.features || {};
    rows.push({
      ...trade,
      symbol: row.symbol,
      combo: row.combo || {},
      features,
      family: row.combo?.symbolFamily || family(row.symbol),
      archetype: row.combo?.archetype || row.combo?.triggerMode,
      win: (trade.pnlDollars || 0) > 0,
      profitScore: (trade.confidence || 0) * 1.7
        + (trade.alphaQuality || 0) * 1.35
        + (trade.intelligence?.score || 0) * 0.75
        + (features.optionBurstShape || 0) * 320
        + (features.momentumBurst || 0) * 220
        + (features.volumeQuality || 0) * 170
        + (features.cleanVolume || 0) * 85
        + (features.volumeAcceleration || 0) * 130
        + (features.relativeStrength || 0) * 160
        + (features.marketAlignment || 0) * 100
        + (features.vwapPressure || 0) * 120
        + (features.breakoutQuality || 0) * 160
        + (features.openingDriveQuality || 0) * 160
        + (features.compressionRelease || 0) * 140
        + (features.trendQuality || 0) * 120
        + (features.intradayTrendQuality || 0) * 120
        + (features.rangeExpansionQuality || 0) * 120
        - (features.vwapExtensionRisk || 0) * 250
        - (features.failedBreakRisk || 0) * 250,
    });
  }
  rows.sort((a, b) => a.entryTime - b.entryTime);
  return rows;
}

function splitTrades(trades) {
  const times = [...new Set(trades.map((trade) => trade.entryTime))].sort((a, b) => a - b);
  const cutoff = times[Math.floor(times.length * trainPct)] || times.at(-1);
  return {
    cutoff,
    train: trades.filter((trade) => trade.entryTime <= cutoff),
    test: trades.filter((trade) => trade.entryTime > cutoff),
  };
}

function metrics(trades, sizeMode = 'fixed') {
  let equity = 0;
  let grossWin = 0;
  let grossLoss = 0;
  let peak = 0;
  let maxDrawdownDollars = 0;
  let maxLossStreak = 0;
  let lossStreak = 0;
  const scaled = trades.map((trade) => {
    const scale = sizeMode === 'quality'
      ? Math.max(0.45, Math.min(1.0, 0.45 + (trade.policyScore || 0) / 260))
      : 1;
    const pnlDollars = (trade.pnlDollars || 0) * scale;
    return { ...trade, scale, pnlDollars };
  });
  for (const trade of scaled) {
    equity += trade.pnlDollars;
    if (trade.pnlDollars > 0) grossWin += trade.pnlDollars;
    else grossLoss += Math.abs(trade.pnlDollars);
    peak = Math.max(peak, equity);
    maxDrawdownDollars = Math.max(maxDrawdownDollars, peak - equity);
    if (trade.pnlDollars <= 0) {
      lossStreak += 1;
      maxLossStreak = Math.max(maxLossStreak, lossStreak);
    } else {
      lossStreak = 0;
    }
  }
  return {
    trades: scaled.length,
    wins: scaled.filter((trade) => trade.pnlDollars > 0).length,
    losses: scaled.filter((trade) => trade.pnlDollars <= 0).length,
    winRate: scaled.length ? scaled.filter((trade) => trade.pnlDollars > 0).length / scaled.length * 100 : 0,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? 999 : 0),
    netDollars: equity,
    projectedNet: equity * projectionCapital / capital,
    avgDollars: scaled.length ? equity / scaled.length : 0,
    projectedAvgDollars: scaled.length ? (equity * projectionCapital / capital) / scaled.length : 0,
    maxDrawdownDollars,
    maxLossStreak,
    avgMfeR: scaled.length ? scaled.reduce((sum, trade) => sum + (trade.mfeR || 0), 0) / scaled.length : 0,
    avgMaeR: scaled.length ? scaled.reduce((sum, trade) => sum + (trade.maeR || 0), 0) / scaled.length : 0,
    optionWorthyRate: scaled.length ? scaled.filter((trade) => trade.optionWorthy).length / scaled.length * 100 : 0,
  };
}

function replay(trades, threshold, options = {}) {
  const accepted = [];
  const seen = new Set();
  const sorted = trades
    .map((trade) => ({ ...trade, policyScore: trade.profitScore }))
    .filter((trade) => trade.policyScore >= threshold)
    .filter((trade) => !options.optionOnly || (trade.features.optionBurstShape || 0) >= options.optionOnly)
    .filter((trade) => !options.minMomentum || (trade.features.momentumBurst || 0) >= options.minMomentum || (trade.features.priceAcceleration || 0) >= options.minMomentum)
    .filter((trade) => !options.minVolume || (trade.features.volumeQuality || 0) >= options.minVolume || (trade.features.volumeAcceleration || 0) >= options.minVolume)
    .filter((trade) => !options.minRelativeStrength || (trade.features.relativeStrength || 0) >= options.minRelativeStrength)
    .sort((a, b) => (a.entryTime - b.entryTime) || (b.policyScore - a.policyScore));
  for (const trade of sorted) {
    const key = `${trade.symbol}|${trade.entryTime}|${trade.exitTime}|${trade.side}|${Math.round(trade.entry * 10000)}|${Math.round(trade.exit * 10000)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const open = accepted.filter((item) => item.exitTime > trade.entryTime);
    if (open.some((item) => item.symbol === trade.symbol)) continue;
    if (open.length >= (options.maxConcurrent || maxConcurrent)) continue;
    accepted.push(trade);
  }
  return accepted;
}

function score(m) {
  return Math.min(m.projectedNet / 100, 900)
    + Math.min(m.avgDollars / 10, 150)
    + Math.min(m.profitFactor, 20) * 10
    + Math.min(m.trades, 700) * 0.08
    + m.winRate * 0.75
    + Math.min(m.avgMfeR, 3) * 30
    - Math.min(m.maxDrawdownDollars / 1000, 80) * 2.2
    - Math.max(0, m.maxLossStreak - 2) * 18
    + (m.trades >= minTestTrades ? 40 : -80);
}

function tune(name, train, test, options, sizeMode) {
  const scores = train.map((trade) => trade.profitScore).sort((a, b) => a - b);
  const thresholds = [0.55, 0.62, 0.7, 0.78, 0.84, 0.9, 0.94].map((pct) => scores[Math.floor(scores.length * pct)] || 0);
  let bestTrain = null;
  for (const threshold of thresholds) {
    const m = metrics(replay(train, threshold, options), sizeMode);
    const candidate = { threshold, metrics: m, score: score(m) };
    if (!bestTrain || candidate.score > bestTrain.score) bestTrain = candidate;
  }
  const accepted = replay(test, bestTrain.threshold, options);
  const testMetrics = metrics(accepted, sizeMode);
  return { name, threshold: bestTrain.threshold, train: bestTrain.metrics, test: testMetrics, score: score(testMetrics), acceptedTrades: accepted.slice(0, 50), sizeMode, options };
}

const symbols = highBetaUniverse;
const combos = generateCombos(symbols);
const comboPath = join(playbooksDir, `phase9-profit-monster-combos-${runId}.json`);
writeFileSync(comboPath, `${JSON.stringify(combos, null, 2)}\n`);

console.log(`Phase 9 Profit Monster: ${symbols.length} high-beta symbols x ${combos.length} combos on ${interval}/${range}`);
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
  maxBuffer: 1024 * 1024 * 180,
  stdio: ['ignore', 'pipe', 'pipe'],
});
process.stdout.write(output.split('\n').slice(-24).join('\n'));
if (!output.endsWith('\n')) process.stdout.write('\n');
const tradeMatch = output.match(/Trades: (.*\.jsonl)/);
if (!tradeMatch) throw new Error('Backtest did not emit trade ledger path');

const trades = await readTrades(tradeMatch[1]);
const { train, test, cutoff } = splitTrades(trades);
const policies = [
  tune('profit_monster_balanced', train, test, { maxConcurrent: 1, minMomentum: 0.2, minRelativeStrength: 0.55 }, 'fixed'),
  tune('profit_monster_runner', train, test, { maxConcurrent: 2, minMomentum: 0.25, minVolume: 0.35 }, 'fixed'),
  tune('options_burst_profit', train, test, { maxConcurrent: 2, optionOnly: 0.2, minMomentum: 0.2 }, 'fixed'),
  tune('quality_sized_runner', train, test, { maxConcurrent: 2, minMomentum: 0.2, minRelativeStrength: 0.5 }, 'quality'),
  tune('aggressive_profit_stack', train, test, { maxConcurrent: 3, minMomentum: 0.15 }, 'fixed'),
].sort((a, b) => b.score - a.score);

const best = policies[0];
const promote = best.test.trades >= minTestTrades
  && best.test.projectedNet >= 16000
  && best.test.profitFactor >= 3
  && best.test.maxLossStreak <= 4
  && best.test.maxDrawdownDollars <= best.test.netDollars * 0.25;

const payload = {
  updatedAt: new Date().toISOString(),
  phase: 'phase9-profit-monster',
  scope: {
    symbols: symbols.length,
    combos: combos.length,
    range,
    interval,
    capital,
    projectionCapital,
    trainPct,
    cutoff,
    rawTrades: trades.length,
    trainTrades: train.length,
    testTrades: test.length,
  },
  goal: 'profit-first high-beta/options-worthy runner engine',
  guardrails: [
    'selection uses entry-time features only',
    'pnl/MFE/MAE are used only for scoring outcomes after replay',
    'no post-trade move filter is allowed in holdout selection',
  ],
  paths: {
    comboPath,
    tradeLedger: tradeMatch[1],
  },
  policies: policies.map((policy) => ({
    name: policy.name,
    threshold: policy.threshold,
    sizeMode: policy.sizeMode,
    options: policy.options,
    train: policy.train,
    test: policy.test,
    score: policy.score,
    sampleTrades: policy.acceptedTrades.map((trade) => ({
      symbol: trade.symbol,
      side: trade.side,
      triggerMode: trade.combo.triggerMode,
      archetype: trade.archetype,
      family: trade.family,
      entryTime: trade.entryTime,
      exitTime: trade.exitTime,
      pnlDollars: trade.pnlDollars,
      mfeR: trade.mfeR,
      maeR: trade.maeR,
      optionWorthy: trade.optionWorthy,
      policyScore: trade.policyScore,
    })),
  })),
  best: {
    name: best.name,
    threshold: best.threshold,
    train: best.train,
    test: best.test,
    sizeMode: best.sizeMode,
  },
  promotion: {
    promote,
    decision: promote ? 'profit-monster-candidate' : 'research-only-profit-insufficient',
  },
};

const outPath = join(playbooksDir, 'current-phase9-profit-monster.json');
writeFileSync(outPath, `${JSON.stringify(payload, null, 2)}\n`);
appendFileSync(join(playbooksDir, 'phase9-profit-monster-history.jsonl'), `${JSON.stringify(payload)}\n`);

const pinePath = join(generatedDir, 'profit_monster_export.json');
writeFileSync(pinePath, `${JSON.stringify({
  generatedAt: payload.updatedAt,
  decision: payload.promotion.decision,
  best: payload.best,
  policies: payload.policies.map((policy) => ({
    name: policy.name,
    test: policy.test,
    threshold: policy.threshold,
    sizeMode: policy.sizeMode,
  })),
}, null, 2)}\n`);

console.log('\n=== phase 9 profit monster ===');
console.log(`Saved: ${outPath}`);
console.log(`Pine/profit metadata: ${pinePath}`);
console.log(`Raw trades=${trades.length} train=${train.length} test=${test.length}`);
for (const policy of policies) {
  const m = policy.test;
  console.log(`${policy.name}: test trades=${m.trades} win=${m.winRate.toFixed(2)} pf=${m.profitFactor.toFixed(2)} net=$${m.netDollars.toFixed(0)} projected=$${m.projectedNet.toFixed(0)} avg=$${m.avgDollars.toFixed(0)} dd=$${m.maxDrawdownDollars.toFixed(0)} streak=${m.maxLossStreak}`);
}
console.log(`Decision=${payload.promotion.decision}`);
