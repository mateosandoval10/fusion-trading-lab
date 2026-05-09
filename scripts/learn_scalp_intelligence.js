#!/usr/bin/env node
import { createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const playbooksDir = join(root, 'optimization-results', 'models', 'playbooks');
const summariesDir = join(root, 'optimization-results', 'local-summaries');
if (!existsSync(playbooksDir)) mkdirSync(playbooksDir, { recursive: true });

const args = new Map(process.argv.slice(2).map((arg) => {
  const [key, value = 'true'] = arg.replace(/^--/, '').split('=');
  return [key, value];
}));

function latestSummaryPath() {
  const files = readdirSync(summariesDir)
    .filter((file) => file.endsWith('-summary.json'))
    .map((file) => join(summariesDir, file))
    .sort();
  return files.at(-1);
}

const summaryPath = args.get('summary') || latestSummaryPath();
if (!summaryPath) throw new Error('No summary found. Pass --summary=<path>');
const summary = JSON.parse(readFileSync(summaryPath, 'utf8'));
const tradeLogPath = args.get('trades') || summary.paths?.trades;
if (!tradeLogPath || !existsSync(tradeLogPath)) throw new Error(`${summaryPath} has no trade log. Rerun with --save-trades=true`);

const out = args.get('out') || join(playbooksDir, 'current-scalp-intelligence.json');
const minSamples = Number(args.get('min-samples') || 12);
const minBadSamples = Number(args.get('min-bad-samples') || 5);
const recentFraction = Number(args.get('recent-fraction') || 0.35);
const featureNames = [
  'bodyQuality',
  'closeLocation',
  'rejectionWick',
  'emaSlope',
  'priceAcceleration',
  'vwapPressure',
  'volumeQuality',
  'flowQuality',
  'breakoutQuality',
  'trendQuality',
  'chopQuality',
  'relativeVolume',
  'atrExpansion',
  'efficiency',
  'directionalCandle',
  'cleanVolume',
  'volumeAcceleration',
  'volumeFlowAgreement',
  'vwapExtensionRisk',
  'failedBreakRisk',
  'pullbackReclaim',
  'momentumBurst',
  'cleanBreakout',
  'marketAlignment',
  'relativeStrength',
  'marketImpulse',
  'dayPositionQuality',
  'intradayTrendQuality',
  'priorDayBreakQuality',
  'priorDayReclaim',
  'rangeExpansionQuality',
  'timeEdge',
  'optionBurstShape',
  'liquiditySweep',
  'stopRunReclaim',
  'relVolTodQuality',
  'openingDriveQuality',
  'compressionRelease',
];

const symbolFamilies = {
  semis: new Set(['NVDA', 'AMD', 'AVGO', 'SMCI', 'MU', 'INTC', 'ARM', 'QCOM', 'MRVL', 'ON', 'AMAT', 'LRCX', 'KLAC', 'ASML', 'TSM', 'SMH', 'SOXL', 'SOXS']),
  crypto: new Set(['COIN', 'MARA', 'RIOT', 'CLSK', 'WULF', 'CIFR', 'BTBT', 'HIVE', 'IREN', 'CAN', 'MSTR', 'CONL', 'MSTX', 'MSTU']),
  ev: new Set(['TSLA', 'RIVN', 'LCID', 'NIO', 'XPEV', 'LI', 'QS', 'CHPT', 'BLNK', 'WKHS']),
  softwareAi: new Set(['PLTR', 'AI', 'PATH', 'IONQ', 'RGTI', 'QBTS', 'CRM', 'ADBE', 'NOW', 'MDB', 'SNOW', 'DDOG', 'NET', 'CRWD', 'PANW', 'ZS', 'OKTA']),
  leveragedEtf: new Set(['TQQQ', 'SQQQ', 'SOXL', 'SOXS', 'UVXY', 'LABU', 'LABD', 'TSLL', 'NVDL']),
  pennyMeme: new Set(['OPEN', 'AMC', 'GME', 'KOSS', 'HOLO', 'BNGO', 'OCGN', 'PROK', 'SNDL', 'TLRY', 'CGC', 'ACB', 'BB', 'SPCE', 'FCEL', 'PLUG']),
  etf: new Set(['SPY', 'QQQ', 'IWM', 'DIA', 'XLK', 'XLF', 'XLE', 'XBI', 'ARKK', 'TLT', 'HYG', 'GLD', 'SLV', 'USO']),
};

function symbolFamily(symbol) {
  for (const [family, set] of Object.entries(symbolFamilies)) {
    if (set.has(symbol)) return family;
  }
  return 'other';
}

function emptyStats() {
  return {
    samples: [],
    trades: 0,
    wins: 0,
    losses: 0,
    netDollars: 0,
    featureWinSum: Object.fromEntries(featureNames.map((name) => [name, 0])),
    featureLossSum: Object.fromEntries(featureNames.map((name) => [name, 0])),
  };
}

function addSample(map, key, sample) {
  const stats = map.get(key) || emptyStats();
  stats.samples.push(sample);
  stats.trades += 1;
  stats.wins += sample.win ? 1 : 0;
  stats.losses += sample.win ? 0 : 1;
  stats.netDollars += sample.pnlDollars;
  for (const name of featureNames) {
    if (sample.win) stats.featureWinSum[name] += sample.features[name] ?? 0;
    else stats.featureLossSum[name] += sample.features[name] ?? 0;
  }
  map.set(key, stats);
}

function meanFeature(samples) {
  const out = Object.fromEntries(featureNames.map((name) => [name, 0]));
  if (!samples.length) return out;
  for (const sample of samples) {
    for (const name of featureNames) out[name] += sample.features[name] ?? 0;
  }
  for (const name of featureNames) out[name] /= samples.length;
  return out;
}

function calibration(samples) {
  const bins = [[0, 50], [50, 60], [60, 70], [70, 80], [80, 90], [90, 101]];
  return bins.map(([min, max]) => {
    const rows = samples.filter((sample) => sample.confidence >= min && sample.confidence < max);
    const wins = rows.filter((sample) => sample.win).length;
    return { min, max, trades: rows.length, winRate: rows.length ? wins / rows.length * 100 : null };
  }).filter((row) => row.trades > 0);
}

function badPatterns(samples) {
  const patterns = [];
  for (const name of featureNames) {
    for (const [min, max] of [[0, 0.25], [0.25, 0.5], [0.5, 0.75], [0.75, 1.01]]) {
      const rows = samples.filter((sample) => (sample.features[name] ?? 0) >= min && (sample.features[name] ?? 0) < max);
      if (rows.length < minBadSamples) continue;
      const wins = rows.filter((sample) => sample.win).length;
      const net = rows.reduce((sum, sample) => sum + sample.pnlDollars, 0);
      const winRate = wins / rows.length * 100;
      if (winRate <= 35 && net < 0) patterns.push({ feature: name, trades: rows.length, winRate, netDollars: net, conditions: { [name]: { min, max } } });
    }
  }
  return patterns.sort((a, b) => a.winRate - b.winRate || a.netDollars - b.netDollars).slice(0, 8);
}

function finalizeBucket(key, stats, globalWeights = null) {
  const wins = stats.samples.filter((sample) => sample.win);
  const losses = stats.samples.filter((sample) => !sample.win);
  const winnerPrototype = meanFeature(wins);
  const loserPrototype = meanFeature(losses);
  const rawWeights = {};
  for (const name of featureNames) {
    const winMean = wins.length ? stats.featureWinSum[name] / wins.length : 0;
    const lossMean = losses.length ? stats.featureLossSum[name] / losses.length : 0;
    const edge = winMean - lossMean;
    rawWeights[name] = Math.abs(edge) < 0.015 ? 0 : edge;
  }
  const weightMag = Object.values(rawWeights).reduce((sum, value) => sum + Math.abs(value), 0);
  const weights = weightMag > 0
    ? Object.fromEntries(Object.entries(rawWeights).map(([name, value]) => [name, value / weightMag]))
    : (globalWeights || Object.fromEntries(featureNames.map((name) => [name, 1 / featureNames.length])));
  const sorted = [...stats.samples].sort((a, b) => a.entryTime - b.entryTime);
  const recent = sorted.slice(Math.floor(sorted.length * (1 - recentFraction)));
  const older = sorted.slice(0, Math.floor(sorted.length * (1 - recentFraction)));
  const winRate = stats.trades ? stats.wins / stats.trades * 100 : 0;
  const recentWinRate = recent.length ? recent.filter((sample) => sample.win).length / recent.length * 100 : winRate;
  const olderWinRate = older.length ? older.filter((sample) => sample.win).length / older.length * 100 : winRate;
  return {
    key,
    trades: stats.trades,
    wins: stats.wins,
    losses: stats.losses,
    winRate,
    netDollars: stats.netDollars,
    weights,
    winnerPrototype,
    loserPrototype,
    calibration: calibration(stats.samples),
    drift: {
      recentTrades: recent.length,
      recentWinRate,
      olderWinRate,
      degrading: recent.length >= 5 && older.length >= 8 && recentWinRate + 12 < olderWinRate,
    },
    badPatterns: badPatterns(stats.samples),
    topPositiveFeatures: Object.entries(weights).sort((a, b) => b[1] - a[1]).slice(0, 5),
    topNegativeFeatures: Object.entries(weights).sort((a, b) => a[1] - b[1]).slice(0, 5),
  };
}

const buckets = new Map();
const allSamples = [];
const lines = createInterface({ input: createReadStream(tradeLogPath, { encoding: 'utf8' }), crlfDelay: Infinity });
for await (const line of lines) {
  if (!line) continue;
  const row = JSON.parse(line);
  const features = row.trade?.features;
  if (!features) continue;
  const trigger = row.combo?.triggerMode || row.trade?.intelligence?.trigger || 'base';
  const family = symbolFamily(row.symbol);
  const regime = row.trade?.intelligence?.regime || 'all';
  const sample = {
    symbol: row.symbol,
    trigger,
    family,
    regime,
    side: row.trade.side,
    entryTime: row.trade.entryTime,
    confidence: row.trade.confidence || 0,
    win: (row.trade.pnlDollars || 0) > 0,
    pnlDollars: row.trade.pnlDollars || 0,
    features: Object.fromEntries(featureNames.map((name) => [name, Number(features[name] ?? 0)])),
  };
  allSamples.push(sample);
  addSample(buckets, `${trigger}|${family}|${regime}`, sample);
  addSample(buckets, `${trigger}|${family}|all`, sample);
  addSample(buckets, `${trigger}|all|${regime}`, sample);
  addSample(buckets, `${trigger}|all|all`, sample);
  addSample(buckets, `all|${family}|${regime}`, sample);
  addSample(buckets, 'global', sample);
}

if (!allSamples.length) throw new Error(`${tradeLogPath} has no feature snapshots. Rerun local_fusion_backtest.js after the feature logging patch with --save-trades=true`);

const globalBucket = finalizeBucket('global', buckets.get('global'));
const finalized = {};
for (const [key, stats] of buckets.entries()) {
  if (key !== 'global' && stats.trades < minSamples) continue;
  finalized[key] = finalizeBucket(key, stats, globalBucket.weights);
}

const payload = {
  updatedAt: new Date().toISOString(),
  sourceSummary: summaryPath,
  sourceTrades: tradeLogPath,
  minSamples,
  featureNames,
  samples: allSamples.length,
  globalWeights: globalBucket.weights,
  calibration: globalBucket.calibration,
  buckets: finalized,
  explanation: {
    featureAttribution: 'Weights are signed winner-vs-loser mean feature differences. Positive means higher feature values helped; negative means high values hurt and should be penalized.',
    patternMemory: 'Winner and loser prototypes are feature averages used for similarity scoring.',
    triggerSpecificModels: 'Buckets are keyed as trigger|family|regime with fallbacks.',
    driftDetection: 'Recent win rate is compared against older win rate; degrading buckets get penalized.',
    badPatternBlacklist: 'Low-win, negative-net feature ranges become blocking patterns.',
    confidenceCalibration: 'Confidence bins map raw confidence to observed win rate.',
  },
};

writeFileSync(out, `${JSON.stringify(payload, null, 2)}\n`);
console.log(`Scalp intelligence saved: ${out}`);
console.log(`Samples=${payload.samples} buckets=${Object.keys(payload.buckets).length}`);
console.log('Global top positive:', globalBucket.topPositiveFeatures.map(([k, v]) => `${k}:${v.toFixed(3)}`).join(', '));
console.log('Global top negative:', globalBucket.topNegativeFeatures.map(([k, v]) => `${k}:${v.toFixed(3)}`).join(', '));
