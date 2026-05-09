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
const candidateCount = Number(args.get('candidates') || 900);
const tradeLedgerArg = args.get('trade-ledger') || '';

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

const featureNames = [
  'confidence', 'alphaQuality', 'intelScore',
  'bodyQuality', 'closeLocation', 'rejectionWick', 'emaSlope', 'priceAcceleration',
  'vwapPressure', 'volumeQuality', 'flowQuality', 'breakoutQuality', 'trendQuality',
  'chopQuality', 'relativeVolume', 'atrExpansion', 'efficiency', 'directionalCandle',
  'cleanVolume', 'volumeAcceleration', 'volumeFlowAgreement', 'vwapExtensionRisk',
  'failedBreakRisk', 'pullbackReclaim', 'momentumBurst', 'cleanBreakout',
  'marketAlignment', 'relativeStrength', 'marketImpulse', 'dayPositionQuality',
  'intradayTrendQuality', 'priorDayBreakQuality', 'priorDayReclaim',
  'rangeExpansionQuality', 'timeEdge', 'optionBurstShape', 'liquiditySweep',
  'stopRunReclaim', 'relVolTodQuality', 'openingDriveQuality', 'compressionRelease',
];

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

function dayKey(timestamp) {
  return new Date(timestamp * 1000).toISOString().slice(0, 10);
}

function weekKey(timestamp) {
  const d = new Date(timestamp * 1000);
  const oneJan = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((d - oneJan) / 86400000) + oneJan.getUTCDay() + 1) / 7);
  return `${d.getUTCFullYear()}-${String(week).padStart(2, '0')}`;
}

function featureValue(trade, name) {
  if (name === 'confidence') return (trade.confidence || 0) / 100;
  if (name === 'alphaQuality') return (trade.alphaQuality || 0) / 100;
  if (name === 'intelScore') return (trade.intelligence?.score || 0) / 100;
  return trade.features?.[name] ?? 0;
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
    const record = {
      ...trade,
      symbol: row.symbol,
      combo,
      features: trade.features || {},
      family: combo.symbolFamily || family(row.symbol),
      archetype: combo.archetype || combo.triggerMode,
      triggerMode: combo.triggerMode,
      session: combo.session,
      win: (trade.pnlDollars || 0) > 0,
      fastMove: Math.max(trade.move5mR || 0, trade.move10mR || 0, trade.move15mR || 0),
      cleanMove: (trade.mfeR || 0) - Math.max(0, trade.maeR || 0) * 0.75,
      routeKey: `${row.symbol}|${combo.triggerMode}|${combo.session}|${combo.direction}|${combo.archetype}`,
    };
    record.vector = featureNames.map((name) => featureValue(record, name));
    rows.push(record);
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

function rng(seed = 1337) {
  let state = seed >>> 0;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return ((state >>> 0) / 4294967296);
  };
}

function baseWeights(kind) {
  const weights = Object.fromEntries(featureNames.map((name) => [name, 0]));
  const set = (name, value) => { weights[name] = value; };
  set('confidence', 1.5);
  set('alphaQuality', 1.2);
  set('intelScore', 0.7);
  set('emaSlope', 1.0);
  set('priceAcceleration', 1.0);
  set('volumeQuality', 0.9);
  set('cleanVolume', 0.7);
  set('volumeAcceleration', 0.75);
  set('vwapPressure', 0.8);
  set('relativeStrength', 1.0);
  set('marketAlignment', 0.6);
  set('trendQuality', 0.7);
  set('intradayTrendQuality', 0.7);
  set('atrExpansion', 0.65);
  set('efficiency', 0.65);
  set('timeEdge', 0.5);
  set('vwapExtensionRisk', -1.1);
  set('failedBreakRisk', -1.4);
  set('rejectionWick', -0.55);
  if (kind === 'options') {
    set('optionBurstShape', 1.8);
    set('momentumBurst', 1.4);
    set('rangeExpansionQuality', 1.0);
    set('flowQuality', 0.9);
  }
  if (kind === 'breakout') {
    set('breakoutQuality', 1.6);
    set('cleanBreakout', 1.35);
    set('openingDriveQuality', 0.9);
    set('compressionRelease', 1.0);
  }
  if (kind === 'lossAvoid') {
    set('vwapExtensionRisk', -2.0);
    set('failedBreakRisk', -2.2);
    set('rejectionWick', -1.2);
    set('chopQuality', 1.1);
  }
  if (kind === 'reclaim') {
    set('pullbackReclaim', 1.25);
    set('stopRunReclaim', 1.2);
    set('priorDayReclaim', 0.8);
    set('vwapPressure', 1.2);
  }
  return featureNames.map((name) => weights[name]);
}

function generateCandidates(count) {
  const random = rng(20260504);
  const seeds = ['balanced', 'options', 'breakout', 'lossAvoid', 'reclaim'];
  const candidates = [];
  for (const seed of seeds) {
    candidates.push({
      name: `seed_${seed}`,
      weights: baseWeights(seed),
      waitGap: 0.28,
      maxConcurrent,
      sizeMode: 'fixed',
    });
  }
  for (let i = 0; i < count; i += 1) {
    const seed = seeds[Math.floor(random() * seeds.length)];
    const base = baseWeights(seed);
    const volatility = 0.25 + random() * 0.9;
    const weights = base.map((weight, index) => {
      const risk = ['vwapExtensionRisk', 'failedBreakRisk', 'rejectionWick'].includes(featureNames[index]);
      const shock = (random() - 0.5) * volatility;
      return weight + shock + (risk ? -(random() * 0.65) : 0);
    });
    candidates.push({
      name: `meta_${seed}_${i}`,
      weights,
      waitGap: 0.12 + random() * 0.45,
      maxConcurrent: 1 + Math.floor(random() * 3),
      sizeMode: random() > 0.72 ? 'quality' : 'fixed',
    });
  }
  return candidates;
}

function metaScore(trade, candidate) {
  let score = 0;
  for (let i = 0; i < featureNames.length; i += 1) score += trade.vector[i] * candidate.weights[i];
  if (trade.triggerMode === 'options-burst') score += 0.35;
  if (trade.triggerMode === 'hybrid-consensus') score += 0.25;
  if (trade.triggerMode === 'volume-shock') score -= 0.10;
  if (trade.session === 'open-0930') score += 0.2;
  if (trade.session === 'morning') score -= 0.04;
  if (trade.family === 'crypto') score += 0.15;
  if (trade.family === 'pennyMeme') score -= 0.25;
  if (trade.side === 'short') score -= 0.05;
  return score;
}

function withScores(trades, candidate) {
  return trades.map((trade) => {
    const score = metaScore(trade, candidate);
    return {
      ...trade,
      policyScore: score,
      action: score >= candidate.threshold ? 'take' : score >= candidate.threshold - candidate.waitGap ? 'wait' : 'skip',
    };
  });
}

function replay(scoredTrades, options = {}) {
  const accepted = [];
  const seen = new Set();
  const sorted = scoredTrades
    .filter((trade) => trade.action === 'take')
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

function metrics(trades, sizeMode = 'fixed', stressBps = 0) {
  let equity = 0;
  let grossWin = 0;
  let grossLoss = 0;
  let peak = 0;
  let maxDrawdownDollars = 0;
  let maxLossStreak = 0;
  let lossStreak = 0;
  const scaled = trades.map((trade) => {
    const qualityScale = Math.max(0.35, Math.min(1.15, 0.35 + (trade.policyScore || 0) / 8));
    const scale = sizeMode === 'quality' ? qualityScale : 1;
    const stressCost = (trade.notional || capital) * (stressBps / 10000);
    const pnlDollars = ((trade.pnlDollars || 0) - stressCost) * scale;
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
  const days = new Set(scaled.map((trade) => dayKey(trade.entryTime)));
  const weeks = new Set(scaled.map((trade) => weekKey(trade.entryTime)));
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
    fastMoveRate: scaled.length ? scaled.filter((trade) => trade.fastMove >= 0.5).length / scaled.length * 100 : 0,
    uniqueDays: days.size,
    uniqueWeeks: weeks.size,
  };
}

function objective(m, stress, minTrades) {
  return Math.min(m.projectedNet / 100, 700)
    + Math.min(m.avgDollars / 8, 160)
    + Math.min(m.profitFactor, 25) * 9
    + m.winRate * 0.9
    + Math.min(m.trades, 650) * 0.08
    + Math.min(m.fastMoveRate, 100) * 0.18
    + Math.min(m.optionWorthyRate, 100) * 0.12
    - Math.min(m.maxDrawdownDollars / 1000, 60) * 2.5
    - Math.max(0, m.maxLossStreak - 2) * 22
    - Math.max(0, minTrades - m.trades) * 3.0
    - Math.max(0, 8 - m.uniqueDays) * 12
    - Math.max(0, 3 - m.uniqueWeeks) * 20
    + Math.min(stress.profitFactor, 10) * 6
    + Math.min(stress.projectedNet / 120, 200);
}

function tuneCandidate(candidate, train, test, minTrades) {
  const trainScores = train.map((trade) => metaScore(trade, candidate)).sort((a, b) => a - b);
  const quantiles = [0.18, 0.26, 0.34, 0.42, 0.50, 0.58, 0.64, 0.70, 0.76, 0.82, 0.88, 0.92, 0.95, 0.97];
  let best = null;
  for (const quantile of quantiles) {
    const threshold = trainScores[Math.floor(trainScores.length * quantile)] || 0;
    const tuned = { ...candidate, threshold };
    const trainAccepted = replay(withScores(train, tuned), tuned);
    const trainMetrics = metrics(trainAccepted, tuned.sizeMode);
    const trainStress = metrics(trainAccepted, tuned.sizeMode, 6);
    const trainScore = objective(trainMetrics, trainStress, minTrades);
    if (!best || trainScore > best.trainScore) {
      best = { candidate: tuned, trainMetrics, trainStress, trainScore };
    }
  }
  const testScored = withScores(test, best.candidate);
  const accepted = replay(testScored, best.candidate);
  const testMetrics = metrics(accepted, best.candidate.sizeMode);
  const stressMetrics = metrics(accepted, best.candidate.sizeMode, 6);
  const waited = testScored.filter((trade) => trade.action === 'wait').length;
  const skipped = testScored.filter((trade) => trade.action === 'skip').length;
  return {
    ...best,
    testMetrics,
    stressMetrics,
    score: objective(testMetrics, stressMetrics, minTrades),
    accepted,
    actionCounts: { take: accepted.length, wait: waited, skip: skipped },
  };
}

function topFeatureWeights(candidate, limit = 14) {
  return featureNames
    .map((name, index) => ({ name, weight: candidate.weights[index] }))
    .sort((a, b) => Math.abs(b.weight) - Math.abs(a.weight))
    .slice(0, limit);
}

function summarizeBy(key, trades) {
  const buckets = new Map();
  for (const trade of trades) {
    const bucket = trade[key] || trade.combo?.[key] || 'unknown';
    if (!buckets.has(bucket)) buckets.set(bucket, []);
    buckets.get(bucket).push(trade);
  }
  return [...buckets.entries()]
    .map(([name, rows]) => ({ name, ...metrics(rows) }))
    .sort((a, b) => b.netDollars - a.netDollars)
    .slice(0, 12);
}

const symbols = universe;
let tradeLedger = tradeLedgerArg;
let comboPath = null;
if (!tradeLedger) {
  const combos = generateCombos(symbols);
  comboPath = join(playbooksDir, `phase10-meta-entry-combos-${runId}.json`);
  writeFileSync(comboPath, `${JSON.stringify(combos, null, 2)}\n`);
  console.log(`Phase 10 Meta Entry: ${symbols.length} symbols x ${combos.length} route combos x ${candidateCount} meta candidates on ${interval}/${range}`);
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
  process.stdout.write(output.split('\n').slice(-18).join('\n'));
  if (!output.endsWith('\n')) process.stdout.write('\n');
  const tradeMatch = output.match(/Trades: (.*\.jsonl)/);
  if (!tradeMatch) throw new Error('Backtest did not emit trade ledger path');
  tradeLedger = tradeMatch[1];
} else {
  console.log(`Phase 10 Meta Entry: reusing trade ledger ${tradeLedger}`);
}

const trades = await readTrades(tradeLedger);
const { train, test, cutoff } = splitTrades(trades);
const candidates = generateCandidates(candidateCount);
const tuned = candidates
  .map((candidate) => tuneCandidate(candidate, train, test, minTestTrades))
  .sort((a, b) => b.score - a.score);

const top = tuned.slice(0, 20);
const best = top[0];
const currentChampionPath = join(playbooksDir, 'current-master-scalp-champion.json');
const currentChampion = existsSync(currentChampionPath) ? JSON.parse(readFileSync(currentChampionPath, 'utf8')) : null;
const currentStats = currentChampion?.champion?.test || currentChampion?.best?.test || currentChampion?.champion || null;

const promotable = best.testMetrics.trades >= minTestTrades
  && best.testMetrics.uniqueDays >= 8
  && best.testMetrics.uniqueWeeks >= 3
  && best.stressMetrics.netDollars > 0
  && best.testMetrics.profitFactor >= 2.5
  && best.testMetrics.maxLossStreak <= 3
  && (!currentStats || (
    best.testMetrics.winRate >= (currentStats.winRate || 0) - 1.0
    && best.testMetrics.projectedNet >= (currentStats.projectedNet || 0) * 1.08
  ));

const payload = {
  updatedAt: new Date().toISOString(),
  phase: 'phase10-meta-entry-tournament',
  scope: {
    symbols: symbols.length,
    routeCombos: comboPath ? generateCombos(symbols).length : null,
    metaCandidates: candidates.length,
    range,
    interval,
    capital,
    projectionCapital,
    trainPct,
    cutoff,
    rawTrades: trades.length,
    trainTrades: train.length,
    testTrades: test.length,
    minTestTrades,
  },
  goal: 'learn entry-time take/wait/skip classifier from route features, then replay unseen holdout with stress costs',
  guardrails: [
    'meta model trains thresholds only on chronological train trades',
    'holdout selection uses entry-time feature vector only',
    'post-trade PnL/MFE/MAE only score candidates after replay',
    'stress metrics subtract extra modeled bps from each accepted trade',
  ],
  paths: { comboPath, tradeLedger },
  best: {
    name: best.candidate.name,
    threshold: best.candidate.threshold,
    waitGap: best.candidate.waitGap,
    maxConcurrent: best.candidate.maxConcurrent,
    sizeMode: best.candidate.sizeMode,
    train: best.trainMetrics,
    test: best.testMetrics,
    stress: best.stressMetrics,
    actionCounts: best.actionCounts,
    topFeatureWeights: topFeatureWeights(best.candidate),
    byFamily: summarizeBy('family', best.accepted),
    byTrigger: summarizeBy('triggerMode', best.accepted),
    sampleTrades: best.accepted.slice(0, 60).map((trade) => ({
      symbol: trade.symbol,
      side: trade.side,
      family: trade.family,
      triggerMode: trade.triggerMode,
      archetype: trade.archetype,
      entryTime: trade.entryTime,
      exitTime: trade.exitTime,
      entry: trade.entry,
      exit: trade.exit,
      pnlDollars: trade.pnlDollars,
      pnlR: trade.pnlR,
      mfeR: trade.mfeR,
      maeR: trade.maeR,
      optionWorthy: trade.optionWorthy,
      metaScore: trade.policyScore,
    })),
  },
  leaderboard: top.map((item) => ({
    name: item.candidate.name,
    score: item.score,
    threshold: item.candidate.threshold,
    waitGap: item.candidate.waitGap,
    maxConcurrent: item.candidate.maxConcurrent,
    sizeMode: item.candidate.sizeMode,
    train: item.trainMetrics,
    test: item.testMetrics,
    stress: item.stressMetrics,
    actionCounts: item.actionCounts,
    topFeatureWeights: topFeatureWeights(item.candidate, 8),
  })),
  promotion: {
    promote: promotable,
    decision: promotable ? 'promote-meta-entry-candidate' : 'research-only-not-better-than-champion',
    comparedTo: currentStats,
  },
};

const outPath = join(playbooksDir, 'current-phase10-meta-entry.json');
writeFileSync(outPath, `${JSON.stringify(payload, null, 2)}\n`);
appendFileSync(join(playbooksDir, 'phase10-meta-entry-history.jsonl'), `${JSON.stringify(payload)}\n`);

const exportPath = join(generatedDir, 'meta_entry_export.json');
writeFileSync(exportPath, `${JSON.stringify({
  generatedAt: payload.updatedAt,
  decision: payload.promotion.decision,
  best: payload.best,
  guardrails: payload.guardrails,
}, null, 2)}\n`);

console.log('\n=== phase 10 meta entry ===');
console.log(`Saved: ${outPath}`);
console.log(`Pine/meta metadata: ${exportPath}`);
console.log(`Raw trades=${trades.length} train=${train.length} test=${test.length}`);
for (const item of top.slice(0, 8)) {
  const m = item.testMetrics;
  const s = item.stressMetrics;
  console.log(`${item.candidate.name}: test trades=${m.trades} win=${m.winRate.toFixed(2)} pf=${m.profitFactor.toFixed(2)} net=$${m.netDollars.toFixed(0)} projected=$${m.projectedNet.toFixed(0)} avg=$${m.avgDollars.toFixed(0)} dd=$${m.maxDrawdownDollars.toFixed(0)} stressNet=$${s.netDollars.toFixed(0)} days=${m.uniqueDays} weeks=${m.uniqueWeeks} wait=${item.actionCounts.wait}`);
}
console.log(`Decision=${payload.promotion.decision}`);
