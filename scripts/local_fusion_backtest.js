#!/usr/bin/env node
import { existsSync, mkdirSync, writeFileSync, appendFileSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const outDir = join(root, 'optimization-results');
const runsDir = join(outDir, 'local-runs');
const summariesDir = join(outDir, 'local-summaries');
const modelsDir = join(outDir, 'models');
const playbooksDir = join(modelsDir, 'playbooks');
const dataCacheDir = join(outDir, 'data-cache');
for (const dir of [runsDir, summariesDir, modelsDir, playbooksDir, dataCacheDir]) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

const args = new Map(process.argv.slice(2).map((arg) => {
  const [key, value = 'true'] = arg.replace(/^--/, '').split('=');
  return [key, value];
}));

const runId = new Date().toISOString().replace(/[:.]/g, '-');
const runPath = join(runsDir, `local-fusion-${runId}.jsonl`);
const tradeLogPath = join(runsDir, `local-fusion-${runId}-trades.jsonl`);
const summaryPath = join(summariesDir, `local-fusion-${runId}-summary.json`);
const localBestPath = join(modelsDir, 'current-best-local-model.json');
const playbookBestPath = join(playbooksDir, 'current-best-playbooks.json');
const playbookHistoryPath = join(playbooksDir, 'promotion-history.jsonl');
const symbols = (args.get('symbols') || 'NVDA,TSLA,AMD,PLTR,RIVN,COIN,HOOD,SMCI,AVGO,QQQ,AAPL,NFLX')
  .split(',')
  .map((symbol) => symbol.trim().toUpperCase())
  .filter(Boolean);
const interval = args.get('interval') || '5m';
const range = args.get('range') || (interval.endsWith('m') ? '60d' : '5y');
const promote = args.get('promote') !== 'false';
const minTrades = Number(args.get('min-trades') || 25);
const minSymbols = Number(args.get('min-symbols') || Math.min(5, symbols.length));
const capital = Number(args.get('capital') || 100000);
const sample = args.get('sample') || 'all';
const trainPct = Number(args.get('train-pct') || 0.70);
const saveTrades = args.get('save-trades') === 'true';
const freshData = args.get('fresh-data') === 'true';
const intelligencePath = args.get('intelligence-model') || join(playbooksDir, 'current-scalp-intelligence.json');
const intelligenceMode = args.get('intelligence-mode') || 'off';
const minIntelScore = Number(args.get('min-intel-score') || 0);
const comboFile = args.get('combo-file') || '';
const intelligenceModel = intelligenceMode !== 'off' && existsSync(intelligencePath) ? JSON.parse(readFileSync(intelligencePath, 'utf8')) : null;
const alphaWeightsPath = args.get('alpha-weights') || '';
const alphaWeightsModel = alphaWeightsPath && existsSync(alphaWeightsPath) ? JSON.parse(readFileSync(alphaWeightsPath, 'utf8')) : null;

const listArg = (name, fallback, mapper = (value) => value) => (args.get(name) || fallback.join('|'))
  .split('|')
  .map((value) => value.trim())
  .filter(Boolean)
  .map(mapper);

const playbookProfiles = {
  Scalp: {
    targets: [0.25, 0.35, 0.5, 0.75, 1],
    minTrades: 80,
    minWinRate: 55,
    minProfitFactor: 1.05,
    scoreWeights: { winRate: 0.9, profitFactor: 12, net: 0.9, avgR: 14, optionWorthy: 0.05, greatTrade: 0.1, mae: 8 },
  },
  DayTrade: {
    targets: [1, 1.5, 2],
    minTrades: 50,
    minWinRate: 48,
    minProfitFactor: 1.15,
    scoreWeights: { winRate: 0.55, profitFactor: 16, net: 1.3, avgR: 20, optionWorthy: 0.18, greatTrade: 0.25, mae: 8 },
  },
  OptionsBurst: {
    targets: [2, 3, 4, 5],
    minTrades: 25,
    minWinRate: 35,
    minProfitFactor: 1.25,
    scoreWeights: { winRate: 0.3, profitFactor: 20, net: 1.6, avgR: 28, optionWorthy: 0.55, greatTrade: 0.65, mae: 7 },
  },
  Breakout: {
    targets: [1.5, 2, 3, 4],
    minTrades: 30,
    minWinRate: 40,
    minProfitFactor: 1.2,
    scoreWeights: { winRate: 0.4, profitFactor: 18, net: 1.5, avgR: 24, optionWorthy: 0.35, greatTrade: 0.45, mae: 7 },
  },
  Reversal: {
    targets: [1, 1.5, 2, 3],
    minTrades: 25,
    minWinRate: 45,
    minProfitFactor: 1.15,
    scoreWeights: { winRate: 0.55, profitFactor: 16, net: 1.2, avgR: 20, optionWorthy: 0.2, greatTrade: 0.3, mae: 9 },
  },
  VWAPReclaim: {
    targets: [1, 1.5, 2, 3],
    minTrades: 35,
    minWinRate: 48,
    minProfitFactor: 1.15,
    scoreWeights: { winRate: 0.6, profitFactor: 16, net: 1.3, avgR: 20, optionWorthy: 0.2, greatTrade: 0.3, mae: 8 },
  },
};

const grid = {
  playbook: listArg('playbook', Object.keys(playbookProfiles)),
  triggerMode: listArg('trigger-mode', ['base']),
  minConf: listArg('min-conf', [65, 70, 75, 80], Number),
  targetR: listArg('target-r', [0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4], Number),
  exitMode: listArg('exit-mode', ['smart']),
  trailR: listArg('trail-r', [1.0, 1.5], Number),
  timeStopBars: listArg('time-stop-bars', [6, 12, 24], Number),
  partialR: listArg('partial-r', [1], Number),
  confidenceDrop: listArg('confidence-drop', [25], Number),
  structureExit: listArg('structure-exit', ['strict']),
  minLead: listArg('min-lead', [60, 65, 70], Number),
  minEdge: listArg('min-edge', [12, 18, 24], Number),
  minAtrRatio: listArg('min-atr-ratio', [0.95, 1.05, 1.15], Number),
  minAdx: listArg('min-adx', [14, 18, 22], Number),
  minEr: listArg('min-er', [0.12, 0.18, 0.24], Number),
  volMult: listArg('vol-mult', [1.0, 1.2, 1.5], Number),
  session: listArg('session', ['all']),
  direction: listArg('direction', ['both']),
  lossCooldownBars: listArg('loss-cooldown-bars', [0], Number),
  maxVwapAtr: listArg('max-vwap-atr', [0], Number),
  requireConfRising: listArg('require-conf-rising', [false], (value) => value === true || value === 'true'),
  slippageBps: listArg('slippage-bps', [0], Number),
  spreadBps: listArg('spread-bps', [0], Number),
  minMoveToCost: listArg('min-move-to-cost', [0], Number),
  openingRange: listArg('opening-range', ['off']),
  htfMode: listArg('htf-mode', ['off']),
  volumeQuality: listArg('volume-quality', ['off']),
  adaptiveTarget: listArg('adaptive-target', [false], (value) => value === true || value === 'true'),
  maxConsecutiveLosses: listArg('max-consecutive-losses', [0], Number),
  clusterCooldownBars: listArg('cluster-cooldown-bars', [0], Number),
  minPrice: listArg('min-price', [0], Number),
  maxPrice: listArg('max-price', [0], Number),
  minDollarVolume: listArg('min-dollar-volume', [0], Number),
  gapMode: listArg('gap-mode', ['off']),
  dailyContext: listArg('daily-context', ['off']),
  pdLevelMode: listArg('pd-level-mode', ['off']),
  marketMode: listArg('market-mode', ['off']),
  relVolMode: listArg('rel-vol-mode', ['off']),
  minRelVolTod: listArg('min-rel-vol-tod', [0], Number),
  peerMode: listArg('peer-mode', ['off']),
  newsMode: listArg('news-mode', ['off']),
  alphaMode: listArg('alpha-mode', ['default']),
  alphaWeightSet: listArg('alpha-weight-set', ['default']),
  minAlphaQuality: listArg('min-alpha-quality', [0], Number),
  minIntelScore: listArg('min-intel-score', [minIntelScore], Number),
  positionSizing: listArg('position-sizing', ['fixed']),
  minPositionScale: listArg('min-position-scale', [1], Number),
  maxPositionScale: listArg('max-position-scale', [1], Number),
};

function* combos() {
  const keys = Object.keys(grid);
  function* walk(index, combo) {
    if (index === keys.length) {
      const profile = playbookProfiles[combo.playbook];
      if (profile?.targets.includes(combo.targetR)) yield combo;
      return;
    }
    const key = keys[index];
    for (const value of grid[key]) yield* walk(index + 1, { ...combo, [key]: value });
  }
  yield* walk(0, {});
}

function intervalMinutes(value) {
  const match = String(value).match(/^(\d+)([mhd])$/);
  if (!match) return 5;
  const amount = Number(match[1]);
  if (match[2] === 'h') return amount * 60;
  if (match[2] === 'd') return amount * 390;
  return amount;
}

function marketMinutesET(timestamp) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(new Date(timestamp * 1000));
  const hour = Number(parts.find((part) => part.type === 'hour')?.value || 0);
  const minute = Number(parts.find((part) => part.type === 'minute')?.value || 0);
  return (hour === 24 ? 0 : hour) * 60 + minute;
}

function sessionOk(timestamp, session) {
  if (!session || session === 'all') return true;
  const minutes = typeof timestamp === 'number' && timestamp > 1000000000 ? marketMinutesET(timestamp) : timestamp;
  if (session === 'open') return minutes >= 9 * 60 + 30 && minutes < 11 * 60;
  if (session === 'open-0930') return minutes >= 9 * 60 + 30 && minutes < 10 * 60;
  if (session === 'open-1000') return minutes >= 10 * 60 && minutes < 10 * 60 + 30;
  if (session === 'open-1030') return minutes >= 10 * 60 + 30 && minutes < 11 * 60;
  if (session === 'midday') return minutes >= 11 * 60 && minutes < 14 * 60 + 30;
  if (session === 'powerhour') return minutes >= 15 * 60 && minutes < 16 * 60;
  if (session === 'morning') return minutes >= 9 * 60 + 30 && minutes < 12 * 60;
  if (session === 'afternoon') return minutes >= 12 * 60 && minutes < 16 * 60;
  return true;
}

function readJson(path) {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

async function fetchBars(symbol) {
  const cachePath = join(dataCacheDir, `${symbol.replace(/[^A-Z0-9.-]/gi, '_')}-${range}-${interval}.json`);
  if (!freshData && existsSync(cachePath)) {
    try {
      const cached = JSON.parse(readFileSync(cachePath, 'utf8'));
      if (Array.isArray(cached?.bars) && cached.bars.length >= 120) return cached.bars;
    } catch {
      // fall through and refresh bad cache
    }
  }
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=${interval}&includePrePost=false&events=div%2Csplits`;
  let data = null;
  let lastError = null;
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try {
      const response = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
      if (!response.ok) throw new Error(`${symbol} HTTP ${response.status}`);
      data = await response.json();
      break;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 750 * attempt));
    }
  }
  if (!data) throw lastError || new Error(`${symbol} fetch failed`);
  const result = data.chart?.result?.[0];
  const timestamps = result?.timestamp || [];
  const quote = result?.indicators?.quote?.[0] || {};
  const bars = timestamps.map((time, index) => ({
    time,
    open: quote.open?.[index],
    high: quote.high?.[index],
    low: quote.low?.[index],
    close: quote.close?.[index],
    volume: quote.volume?.[index] || 0,
  })).filter((bar) => [bar.open, bar.high, bar.low, bar.close].every(Number.isFinite));
  if (bars.length < 120) throw new Error(`${symbol} only returned ${bars.length} usable bars`);
  writeFileSync(cachePath, `${JSON.stringify({ fetchedAt: new Date().toISOString(), symbol, range, interval, bars })}\n`);
  return bars;
}

function sma(values, length, index) {
  if (index < length - 1) return null;
  let sum = 0;
  for (let offset = 0; offset < length; offset += 1) sum += values[index - offset] ?? 0;
  return sum / length;
}

function emaSeries(values, length) {
  const alpha = 2 / (length + 1);
  const out = Array(values.length).fill(null);
  let current = null;
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    current = current == null ? value : alpha * value + (1 - alpha) * current;
    out[index] = current;
  }
  return out;
}

function rsiSeries(closes, length = 14) {
  const out = Array(closes.length).fill(null);
  let avgGain = 0;
  let avgLoss = 0;
  for (let index = 1; index < closes.length; index += 1) {
    const change = closes[index] - closes[index - 1];
    const gain = Math.max(change, 0);
    const loss = Math.max(-change, 0);
    if (index <= length) {
      avgGain += gain;
      avgLoss += loss;
      if (index === length) {
        avgGain /= length;
        avgLoss /= length;
      }
    } else {
      avgGain = (avgGain * (length - 1) + gain) / length;
      avgLoss = (avgLoss * (length - 1) + loss) / length;
    }
    if (index >= length) out[index] = avgLoss === 0 ? 100 : 100 - (100 / (1 + avgGain / avgLoss));
  }
  return out;
}

function atrSeries(bars, length = 14) {
  const tr = bars.map((bar, index) => {
    if (index === 0) return bar.high - bar.low;
    return Math.max(bar.high - bar.low, Math.abs(bar.high - bars[index - 1].close), Math.abs(bar.low - bars[index - 1].close));
  });
  return emaSeries(tr, length);
}

function macdSeries(closes) {
  const fast = emaSeries(closes, 12);
  const slow = emaSeries(closes, 26);
  const macd = closes.map((_, index) => fast[index] - slow[index]);
  const signal = emaSeries(macd, 9);
  return { macd, signal };
}

function adxSeries(bars, length = 14) {
  const plusDm = Array(bars.length).fill(0);
  const minusDm = Array(bars.length).fill(0);
  const tr = Array(bars.length).fill(0);
  for (let index = 1; index < bars.length; index += 1) {
    const up = bars[index].high - bars[index - 1].high;
    const down = bars[index - 1].low - bars[index].low;
    plusDm[index] = up > down && up > 0 ? up : 0;
    minusDm[index] = down > up && down > 0 ? down : 0;
    tr[index] = Math.max(bars[index].high - bars[index].low, Math.abs(bars[index].high - bars[index - 1].close), Math.abs(bars[index].low - bars[index - 1].close));
  }
  const atr = emaSeries(tr, length);
  const plus = emaSeries(plusDm, length);
  const minus = emaSeries(minusDm, length);
  const dx = bars.map((_, index) => {
    const pdi = atr[index] ? 100 * plus[index] / atr[index] : 0;
    const mdi = atr[index] ? 100 * minus[index] / atr[index] : 0;
    return (pdi + mdi) > 0 ? 100 * Math.abs(pdi - mdi) / (pdi + mdi) : 0;
  });
  return emaSeries(dx, length);
}

function efficiencyRatio(closes, length, index) {
  if (index < length) return 0;
  const direction = Math.abs(closes[index] - closes[index - length]);
  let volatility = 0;
  for (let i = index - length + 1; i <= index; i += 1) volatility += Math.abs(closes[i] - closes[i - 1]);
  return volatility > 0 ? direction / volatility : 0;
}

function mfiSeries(bars, length = 14) {
  const typical = bars.map((bar) => (bar.high + bar.low + bar.close) / 3);
  const out = Array(bars.length).fill(null);
  for (let index = length; index < bars.length; index += 1) {
    let pos = 0;
    let neg = 0;
    for (let i = index - length + 1; i <= index; i += 1) {
      const flow = typical[i] * bars[i].volume;
      if (typical[i] >= typical[i - 1]) pos += flow;
      else neg += flow;
    }
    out[index] = neg === 0 ? 100 : 100 - (100 / (1 + pos / neg));
  }
  return out;
}

function scoreForBar(ctx, index) {
  const { bars, closes, ema9, ema21, ema50, vwap, rsi, macd, signal, adx, volAvg, mfi } = ctx;
  const bar = bars[index];
  const bull = [
    bar.close > vwap[index],
    rsi[index] > 50,
    macd[index] > signal[index],
    ema9[index] > ema21[index],
    adx[index] > 25 && bar.close > ema9[index],
    bar.volume > volAvg[index] && bar.close > bar.open,
    closes[index] > ema50[index],
    bar.close > ema21[index],
    mfi[index] > 50,
  ].filter(Boolean).length;
  const bear = [
    bar.close < vwap[index],
    rsi[index] < 50,
    macd[index] < signal[index],
    ema9[index] < ema21[index],
    adx[index] > 25 && bar.close < ema9[index],
    bar.volume > volAvg[index] && bar.close < bar.open,
    closes[index] < ema50[index],
    bar.close < ema21[index],
    mfi[index] < 50,
  ].filter(Boolean).length;
  return { bullPct: bull / 9 * 100, bearPct: bear / 9 * 100 };
}

function prepare(bars) {
  const closes = bars.map((bar) => bar.close);
  const volumes = bars.map((bar) => bar.volume);
  const timeToIndex = new Map(bars.map((bar, index) => [bar.time, index]));
  const ema9 = emaSeries(closes, 9);
  const ema21 = emaSeries(closes, 21);
  const ema50 = emaSeries(closes, 50);
  const atr = atrSeries(bars, 14);
  const atr50 = atr.map((_, index) => sma(atr, 50, index));
  const rsi = rsiSeries(closes, 14);
  const { macd, signal } = macdSeries(closes);
  const adx = adxSeries(bars, 14);
  const mfi = mfiSeries(bars, 14);
  const volAvg = volumes.map((_, index) => sma(volumes, 20, index) || 0);
  const volAvg3 = volumes.map((_, index) => sma(volumes, 3, index) || 0);
  const marketMinutes = bars.map((bar) => marketMinutesET(bar.time));
  const relVolTod = Array(bars.length).fill(1);
  const todBuckets = new Map();
  for (let index = 0; index < bars.length; index += 1) {
    const minute = marketMinutes[index];
    const bucket = todBuckets.get(minute) || [];
    const recent = bucket.slice(-20);
    const avg = recent.length ? recent.reduce((sum, value) => sum + value, 0) / recent.length : null;
    relVolTod[index] = avg && avg > 0 ? volumes[index] / avg : 1;
    bucket.push(volumes[index]);
    todBuckets.set(minute, bucket);
  }
  const vwap = [];
  const orHigh15 = Array(bars.length).fill(null);
  const orLow15 = Array(bars.length).fill(null);
  const orHigh30 = Array(bars.length).fill(null);
  const orLow30 = Array(bars.length).fill(null);
  const dayOpen = Array(bars.length).fill(null);
  const prevDayHigh = Array(bars.length).fill(null);
  const prevDayLow = Array(bars.length).fill(null);
  const prevDayClose = Array(bars.length).fill(null);
  const prevDayRange = Array(bars.length).fill(null);
  const dayAtrPct = Array(bars.length).fill(null);
  const dayHigh = Array(bars.length).fill(null);
  const dayLow = Array(bars.length).fill(null);
  let pv = 0;
  let vv = 0;
  let lastDay = null;
  let currentDayOpen = null;
  let currentDayHigh = -Infinity;
  let currentDayLow = Infinity;
  let lastCompleteHigh = null;
  let lastCompleteLow = null;
  let lastCompleteClose = null;
  let lastCompleteRange = null;
  const completedRanges = [];
  let dayHigh15 = -Infinity;
  let dayLow15 = Infinity;
  let dayHigh30 = -Infinity;
  let dayLow30 = Infinity;
  for (let index = 0; index < bars.length; index += 1) {
    const day = new Date(bars[index].time * 1000).toISOString().slice(0, 10);
    if (day !== lastDay) {
      if (lastDay !== null) {
        lastCompleteHigh = currentDayHigh;
        lastCompleteLow = currentDayLow;
        lastCompleteClose = bars[index - 1].close;
        lastCompleteRange = currentDayHigh - currentDayLow;
        completedRanges.push(lastCompleteRange);
        if (completedRanges.length > 20) completedRanges.shift();
      }
      pv = 0;
      vv = 0;
      lastDay = day;
      currentDayOpen = bars[index].open;
      currentDayHigh = -Infinity;
      currentDayLow = Infinity;
      dayHigh15 = -Infinity;
      dayLow15 = Infinity;
      dayHigh30 = -Infinity;
      dayLow30 = Infinity;
    }
    currentDayHigh = Math.max(currentDayHigh, bars[index].high);
    currentDayLow = Math.min(currentDayLow, bars[index].low);
    dayHigh[index] = currentDayHigh;
    dayLow[index] = currentDayLow;
    dayOpen[index] = currentDayOpen;
    prevDayHigh[index] = lastCompleteHigh;
    prevDayLow[index] = lastCompleteLow;
    prevDayClose[index] = lastCompleteClose;
    prevDayRange[index] = lastCompleteRange;
    dayAtrPct[index] = completedRanges.length ? lastCompleteRange / Math.max(completedRanges.reduce((sum, value) => sum + value, 0) / completedRanges.length, 0.01) : null;
    const minutes = marketMinutes[index];
    if (minutes >= 9 * 60 + 30 && minutes < 9 * 60 + 45) {
      dayHigh15 = Math.max(dayHigh15, bars[index].high);
      dayLow15 = Math.min(dayLow15, bars[index].low);
    }
    if (minutes >= 9 * 60 + 30 && minutes < 10 * 60) {
      dayHigh30 = Math.max(dayHigh30, bars[index].high);
      dayLow30 = Math.min(dayLow30, bars[index].low);
    }
    if (minutes >= 9 * 60 + 45 && Number.isFinite(dayHigh15) && Number.isFinite(dayLow15)) {
      orHigh15[index] = dayHigh15;
      orLow15[index] = dayLow15;
    }
    if (minutes >= 10 * 60 && Number.isFinite(dayHigh30) && Number.isFinite(dayLow30)) {
      orHigh30[index] = dayHigh30;
      orLow30[index] = dayLow30;
    }
    const typical = (bars[index].high + bars[index].low + bars[index].close) / 3;
    pv += typical * bars[index].volume;
    vv += bars[index].volume;
    vwap[index] = vv > 0 ? pv / vv : typical;
  }
  return { bars, closes, timeToIndex, ema9, ema21, ema50, atr, atr50, rsi, macd, signal, adx, mfi, volAvg, volAvg3, relVolTod, vwap, marketMinutes, orHigh15, orLow15, orHigh30, orLow30, dayOpen, dayHigh, dayLow, prevDayHigh, prevDayLow, prevDayClose, prevDayRange, dayAtrPct };
}

function rollingHigh(bars, index, length) {
  let value = -Infinity;
  for (let offset = 1; offset <= length && index - offset >= 0; offset += 1) value = Math.max(value, bars[index - offset].high);
  return value;
}

function rollingLow(bars, index, length) {
  let value = Infinity;
  for (let offset = 1; offset <= length && index - offset >= 0; offset += 1) value = Math.min(value, bars[index - offset].low);
  return value;
}

function openingRangeOk(ctx, index, dir, mode) {
  if (!mode || mode === 'off') return true;
  const bar = ctx.bars[index];
  const previous = ctx.bars[index - 1];
  const high15 = ctx.orHigh15[index];
  const low15 = ctx.orLow15[index];
  const high30 = ctx.orHigh30[index];
  const low30 = ctx.orLow30[index];
  if (mode === 'break15') return high15 != null && (dir === 1 ? bar.close > high15 : bar.close < low15);
  if (mode === 'break30') return high30 != null && (dir === 1 ? bar.close > high30 : bar.close < low30);
  if (mode === 'reclaim15') return high15 != null && (dir === 1 ? previous.close <= low15 && bar.close > low15 : previous.close >= high15 && bar.close < high15);
  if (mode === 'reclaim30') return high30 != null && (dir === 1 ? previous.close <= low30 && bar.close > low30 : previous.close >= high30 && bar.close < high30);
  if (mode === 'near15') return high15 != null && Math.min(Math.abs(bar.close - high15), Math.abs(bar.close - low15)) <= Math.max(ctx.atr[index], 0.01);
  return true;
}

function htfOk(ctx, index, dir, mode) {
  if (!mode || mode === 'off') return true;
  const close = ctx.closes[index];
  const ema50 = ctx.ema50[index];
  const ema50Prev = ctx.ema50[Math.max(0, index - 6)];
  const trendUp = close > ema50 && ema50 >= ema50Prev;
  const trendDown = close < ema50 && ema50 <= ema50Prev;
  const slopeUp = ema50 > ema50Prev;
  const slopeDown = ema50 < ema50Prev;
  if (mode === 'align50') return dir === 1 ? trendUp : trendDown;
  if (mode === 'slope50') return dir === 1 ? slopeUp : slopeDown;
  if (mode === 'not-against50') return dir === 1 ? !trendDown : !trendUp;
  return true;
}

function volumeQualityOk(ctx, index, combo) {
  if (!combo.volumeQuality || combo.volumeQuality === 'off') return true;
  const bar = ctx.bars[index];
  const previousBar = ctx.bars[index - 1];
  const avg20 = Math.max(ctx.volAvg[index], 1);
  const avg3 = Math.max(ctx.volAvg3[index], 1);
  const range = Math.max(bar.high - bar.low, 0.01);
  const bodyShare = Math.abs(bar.close - bar.open) / range;
  const closeLocationLong = (bar.close - bar.low) / range;
  const closeLocationShort = (bar.high - bar.close) / range;
  if (combo.volumeQuality === 'sustained') return avg3 >= avg20 * combo.volMult * 0.75;
  if (combo.volumeQuality === 'clean') return avg3 >= avg20 * combo.volMult * 0.75 && bar.volume <= avg3 * 3.0;
  if (combo.volumeQuality === 'real-expansion') {
    const sustained = avg3 >= avg20 * combo.volMult * 0.72;
    const notOnePrint = bar.volume <= Math.max(avg3 * 3.8, avg20 * 5.0);
    const directional = bodyShare >= 0.38 || closeLocationLong >= 0.72 || closeLocationShort >= 0.72;
    const expandingRange = (bar.high - bar.low) >= Math.max(previousBar.high - previousBar.low, 0.01) * 0.82;
    return sustained && notOnePrint && directional && expandingRange;
  }
  return true;
}

function targetRForCombo(ctx, index, combo) {
  if (!combo.adaptiveTarget) return combo.targetR;
  const atrRatio = ctx.atr50[index] ? ctx.atr[index] / ctx.atr50[index] : 1;
  const er = efficiencyRatio(ctx.closes, 10, index);
  const relVol = ctx.bars[index].volume / Math.max(ctx.volAvg[index], 1);
  const range = Math.max(ctx.bars[index].high - ctx.bars[index].low, 0.01);
  const closeLocation = Math.max(
    (ctx.bars[index].close - ctx.bars[index].low) / range,
    (ctx.bars[index].high - ctx.bars[index].close) / range,
  );
  if (atrRatio >= 1.25 && er >= 0.18 && relVol >= 1.35 && closeLocation >= 0.65) return Math.max(combo.targetR, 0.75);
  if (atrRatio >= 1.08 && er >= 0.14 && relVol >= 1.1) return Math.max(combo.targetR, 0.5);
  if (atrRatio <= 0.9 || er <= 0.10) return Math.min(combo.targetR, 0.35);
  return combo.targetR;
}

function structureExitHit(ctx, index, position, mode) {
  if (!mode || mode === 'off') return false;
  const close = ctx.bars[index].close;
  const emaFail = position.dir === 1 ? close < ctx.ema21[index] : close > ctx.ema21[index];
  const vwapFail = position.dir === 1 ? close < ctx.vwap[index] : close > ctx.vwap[index];
  if (mode === 'ema-only') return emaFail;
  if (mode === 'vwap-only') return vwapFail;
  if (mode === 'loose') return emaFail && vwapFail;
  return emaFail || vwapFail;
}

function liquidityOk(ctx, index, combo) {
  const price = ctx.bars[index].close;
  const dollarVolume = price * Math.max(ctx.volAvg[index], 0);
  if (combo.minPrice > 0 && price < combo.minPrice) return false;
  if (combo.maxPrice > 0 && price > combo.maxPrice) return false;
  if (combo.minDollarVolume > 0 && dollarVolume < combo.minDollarVolume) return false;
  return true;
}

function gapOk(ctx, index, dir, mode) {
  if (!mode || mode === 'off') return true;
  const previousClose = ctx.prevDayClose[index];
  const open = ctx.dayOpen[index];
  const previousRange = Math.max(ctx.prevDayRange[index] ?? 0, 0.01);
  if (previousClose == null || open == null) return false;
  const gapR = (open - previousClose) / previousRange;
  if (mode === 'gap-with') return dir === 1 ? gapR > 0.15 : gapR < -0.15;
  if (mode === 'gap-against') return dir === 1 ? gapR < -0.15 : gapR > 0.15;
  if (mode === 'no-big-gap') return Math.abs(gapR) < 0.6;
  return true;
}

function dailyContextOk(ctx, index, dir, mode) {
  if (!mode || mode === 'off') return true;
  const pct = ctx.dayAtrPct[index];
  if (pct == null) return false;
  const close = ctx.bars[index].close;
  const open = ctx.dayOpen[index];
  if (mode === 'range-expansion') return pct >= 0.9;
  if (mode === 'trend-day') return pct >= 0.9 && (dir === 1 ? close >= open : close <= open);
  if (mode === 'quiet-to-expand') return pct <= 1.15 && Math.abs(close - open) / Math.max(ctx.atr[index], 0.01) >= 0.5;
  return true;
}

function priorDayLevelOk(ctx, index, dir, mode) {
  if (!mode || mode === 'off') return true;
  const bar = ctx.bars[index];
  const high = ctx.prevDayHigh[index];
  const low = ctx.prevDayLow[index];
  if (high == null || low == null) return false;
  if (mode === 'break-pd') return dir === 1 ? bar.close > high : bar.close < low;
  if (mode === 'inside-pd') return bar.close <= high && bar.close >= low;
  if (mode === 'near-pd') return Math.min(Math.abs(bar.close - high), Math.abs(bar.close - low)) <= Math.max(ctx.atr[index], 0.01);
  return true;
}

function marketAlignmentOk(ctx, index, dir, mode) {
  if (!mode || mode === 'off') return true;
  const bar = ctx.bars[index];
  const refs = mode === 'spy' ? ['SPY'] : mode === 'qqq' ? ['QQQ'] : ['SPY', 'QQQ'];
  for (const ref of refs) {
    const market = ctx.marketRefs?.[ref];
    const marketIndex = market?.timeToIndex.get(bar.time);
    if (marketIndex == null || marketIndex < 6) return false;
    const close = market.closes[marketIndex];
    const ema21 = market.ema21[marketIndex];
    const ema50 = market.ema50[marketIndex];
    const ema50Prev = market.ema50[marketIndex - 6];
    const trendUp = close > ema21 && close > ema50 && ema50 >= ema50Prev;
    const trendDown = close < ema21 && close < ema50 && ema50 <= ema50Prev;
    if (dir === 1 && !trendUp) return false;
    if (dir === -1 && !trendDown) return false;
  }
  return true;
}

function relativeVolumeOk(ctx, index, combo) {
  if (!combo.relVolMode || combo.relVolMode === 'off') return true;
  const rel = ctx.relVolTod[index] ?? 1;
  if (combo.relVolMode === 'tod') return rel >= combo.minRelVolTod;
  if (combo.relVolMode === 'tod-or-raw') return rel >= combo.minRelVolTod || ctx.bars[index].volume >= ctx.volAvg[index] * combo.volMult;
  return true;
}

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

function regimeLabel(ctx, index, facts) {
  const atrRatio = facts.atrRatio ?? (ctx.atr50[index] ? ctx.atr[index] / ctx.atr50[index] : 1);
  const er = facts.er ?? efficiencyRatio(ctx.closes, 10, index);
  const close = ctx.closes[index];
  const ema21 = ctx.ema21[index];
  const ema50 = ctx.ema50[index];
  const dayOpen = ctx.dayOpen[index] ?? close;
  const gap = ctx.prevDayRange[index] ? Math.abs((dayOpen - (ctx.prevDayClose[index] ?? dayOpen)) / ctx.prevDayRange[index]) : 0;
  if (gap >= 0.7 && atrRatio >= 1.05) return 'opening-panic';
  if (atrRatio >= 1.15 && er >= 0.25 && close > ema21 && ema21 > ema50) return 'high-vol-uptrend';
  if (atrRatio >= 1.15 && er >= 0.25 && close < ema21 && ema21 < ema50) return 'high-vol-downtrend';
  if (atrRatio >= 1.10 && er < 0.18) return 'high-vol-chop';
  if (atrRatio <= 0.95 && er >= 0.22) return 'low-vol-grind';
  if (atrRatio <= 0.95 && er < 0.18) return 'squeeze-base';
  if (close > ema21 && ema21 > ema50) return 'uptrend';
  if (close < ema21 && ema21 < ema50) return 'downtrend';
  return 'mixed';
}

function clamp01(value) {
  return Math.max(0, Math.min(1, value));
}

function scalpAlphaFeatures(ctx, index, dir, facts) {
  const bar = ctx.bars[index];
  const previousBar = ctx.bars[index - 1];
  const range = Math.max(bar.high - bar.low, 0.01);
  const atr = Math.max(ctx.atr[index], 0.01);
  const body = Math.abs(bar.close - bar.open);
  const closeLocation = dir === 1 ? (bar.close - bar.low) / range : (bar.high - bar.close) / range;
  const rejectionWick = dir === 1 ? (Math.min(bar.open, bar.close) - bar.low) / range : (bar.high - Math.max(bar.open, bar.close)) / range;
  const emaSlope = dir * (ctx.ema9[index] - ctx.ema9[Math.max(0, index - 3)]) / atr;
  const priceAccel = dir * ((bar.close - previousBar.close) + (previousBar.close - ctx.bars[index - 2].close)) / atr;
  const vwapDistance = dir * (bar.close - ctx.vwap[index]) / atr;
  const vwapPressure = vwapDistance >= 0 ? clamp01(1 - Math.abs(vwapDistance - 0.35) / 1.35) : 0;
  const vwapExtensionRisk = clamp01((Math.abs(bar.close - ctx.vwap[index]) / atr - 0.7) / 1.6);
  const relVolume = bar.volume / Math.max(ctx.volAvg[index], 1);
  const volumeQuality = relVolume >= 1 ? clamp01((relVolume - 1) / 2.5) : 0;
  const sustainedVolume = ctx.volAvg3[index] / Math.max(ctx.volAvg[index], 1);
  const cleanVolume = clamp01((sustainedVolume - 0.8) / 1.8) * clamp01(1 - Math.max(0, relVolume - sustainedVolume * 3) / 5);
  const volumeAcceleration = clamp01((bar.volume / Math.max(ctx.volAvg3[index - 1] || ctx.volAvg[index], 1) - 0.9) / 2.1);
  const flowQuality = dir === 1 ? clamp01((facts.flow + 0.15) / 0.75) : clamp01((-facts.flow + 0.15) / 0.75);
  const directionalCandle = clamp01(dir * (bar.close - bar.open) / range * 0.5 + 0.5);
  const volumeFlowAgreement = volumeQuality * flowQuality;
  const breakoutDistance = dir === 1
    ? (bar.close - rollingHigh(ctx.bars, index, 20)) / atr
    : (rollingLow(ctx.bars, index, 20) - bar.close) / atr;
  const breakoutQuality = clamp01((breakoutDistance + 0.15) / 0.65);
  const failedBreakRisk = breakoutQuality > 0.4 ? clamp01(1 - closeLocation) * clamp01(1 - volumeQuality) : 0;
  const trendStack = dir === 1
    ? Number(ctx.ema9[index] > ctx.ema21[index]) + Number(ctx.ema21[index] > ctx.ema50[index]) + Number(bar.close > ctx.vwap[index])
    : Number(ctx.ema9[index] < ctx.ema21[index]) + Number(ctx.ema21[index] < ctx.ema50[index]) + Number(bar.close < ctx.vwap[index]);
  const trendQuality = trendStack / 3;
  const pullbackReclaim = rejectionWick * vwapPressure * clamp01((emaSlope + 0.05) / 0.45);
  const momentumBurst = clamp01((priceAccel + 0.10) / 0.85) * volumeFlowAgreement * closeLocation;
  const cleanBreakout = breakoutQuality * closeLocation * cleanVolume;
  const chopPenalty = clamp01((facts.er - 0.08) / 0.35);
  const dayRange = Math.max((ctx.dayHigh[index] ?? bar.high) - (ctx.dayLow[index] ?? bar.low), 0.01);
  const minute = ctx.marketMinutes[index];
  const openWindow = minute >= 9 * 60 + 30 && minute < 10 * 60 + 30 ? 1 : 0;
  const middayWindow = minute >= 11 * 60 && minute < 14 * 60 + 30 ? 1 : 0;
  const powerHourWindow = minute >= 15 * 60 && minute < 16 * 60 ? 1 : 0;
  const dayPosition = dir === 1
    ? (bar.close - (ctx.dayLow[index] ?? bar.low)) / dayRange
    : ((ctx.dayHigh[index] ?? bar.high) - bar.close) / dayRange;
  const intradayTrend = dir * (bar.close - (ctx.dayOpen[index] ?? bar.open)) / atr;
  const priorDayBreak = dir === 1
    ? (ctx.prevDayHigh[index] != null ? (bar.close - ctx.prevDayHigh[index]) / atr : 0)
    : (ctx.prevDayLow[index] != null ? (ctx.prevDayLow[index] - bar.close) / atr : 0);
  const priorDayReclaim = dir === 1
    ? (ctx.prevDayLow[index] != null && previousBar.close < ctx.prevDayLow[index] && bar.close > ctx.prevDayLow[index] ? 1 : 0)
    : (ctx.prevDayHigh[index] != null && previousBar.close > ctx.prevDayHigh[index] && bar.close < ctx.prevDayHigh[index] ? 1 : 0);
  const rangeExpansionQuality = clamp01(((bar.high - bar.low) / atr - 0.45) / 1.25) * closeLocation;
  const sweepLookbackHigh = rollingHigh(ctx.bars, Math.max(2, index - 1), 12);
  const sweepLookbackLow = rollingLow(ctx.bars, Math.max(2, index - 1), 12);
  const sweptLow = bar.low < sweepLookbackLow && bar.close > sweepLookbackLow;
  const sweptHigh = bar.high > sweepLookbackHigh && bar.close < sweepLookbackHigh;
  const liquiditySweep = dir === 1 ? Number(sweptLow) : Number(sweptHigh);
  const stopRunReclaim = liquiditySweep * closeLocation * Math.max(flowQuality, 0.2);
  const relVolTodRaw = ctx.relVolTod?.[index] ?? relVolume;
  const relVolTodQuality = clamp01((relVolTodRaw - 0.8) / 2.2);
  const openingDriveQuality = openWindow
    ? clamp01(Math.abs(bar.close - (ctx.dayOpen[index] ?? bar.open)) / atr / 1.4) * trendQuality * closeLocation
    : 0;
  const compressionRelease = clamp01((1 - Math.min(1, (ctx.prevDayRange[index] ?? atr) / Math.max(atr * 8, 0.01))) * 0.45 + rangeExpansionQuality * 0.55);
  const marketScore = (() => {
    const refs = ['SPY', 'QQQ'];
    let ok = 0;
    let seen = 0;
    for (const ref of refs) {
      const market = ctx.marketRefs?.[ref];
      const marketIndex = market?.timeToIndex.get(bar.time);
      if (marketIndex == null || marketIndex < 6) continue;
      seen += 1;
      const trendUp = market.closes[marketIndex] > market.ema21[marketIndex] && market.ema21[marketIndex] > market.ema50[marketIndex];
      const trendDown = market.closes[marketIndex] < market.ema21[marketIndex] && market.ema21[marketIndex] < market.ema50[marketIndex];
      if (dir === 1 && trendUp) ok += 1;
      if (dir === -1 && trendDown) ok += 1;
    }
    return seen ? ok / seen : 0.5;
  })();
  const relativeStrength = (() => {
    const refs = ['QQQ', 'SPY'];
    let score = 0;
    let seen = 0;
    const lookback = 6;
    const symbolReturn = index >= lookback ? (bar.close - ctx.closes[index - lookback]) / Math.max(ctx.closes[index - lookback], 0.01) : 0;
    for (const ref of refs) {
      const market = ctx.marketRefs?.[ref];
      const marketIndex = market?.timeToIndex.get(bar.time);
      if (marketIndex == null || marketIndex < lookback) continue;
      const marketReturn = (market.closes[marketIndex] - market.closes[marketIndex - lookback]) / Math.max(market.closes[marketIndex - lookback], 0.01);
      score += clamp01((dir * (symbolReturn - marketReturn) + 0.006) / 0.024);
      seen += 1;
    }
    return seen ? score / seen : 0.5;
  })();
  const marketImpulse = (() => {
    const refs = ['QQQ', 'SPY'];
    let score = 0;
    let seen = 0;
    const lookback = 3;
    for (const ref of refs) {
      const market = ctx.marketRefs?.[ref];
      const marketIndex = market?.timeToIndex.get(bar.time);
      if (marketIndex == null || marketIndex < lookback) continue;
      const marketAtr = Math.max(market.atr?.[marketIndex] ?? 0.01, 0.01);
      const impulse = dir * (market.closes[marketIndex] - market.closes[marketIndex - lookback]) / marketAtr;
      score += clamp01((impulse + 0.08) / 0.55);
      seen += 1;
    }
    return seen ? score / seen : 0.5;
  })();
  const timeEdge = openWindow ? 1 : powerHourWindow ? 0.65 : middayWindow ? 0.25 : 0.45;
  const optionBurstShape = momentumBurst * clamp01((Math.abs(bar.close - previousBar.close) / atr - 0.15) / 0.8);
  return {
    bodyQuality: clamp01(body / range),
    closeLocation: clamp01(closeLocation),
    rejectionWick: clamp01(rejectionWick),
    emaSlope: clamp01((emaSlope + 0.05) / 0.45),
    priceAcceleration: clamp01((priceAccel + 0.10) / 0.85),
    vwapPressure,
    volumeQuality,
    flowQuality,
    breakoutQuality,
    trendQuality,
    chopQuality: chopPenalty,
    relativeVolume: clamp01(relVolume / 4),
    atrExpansion: clamp01(((facts.atrRatio ?? 1) - 0.85) / 0.65),
    efficiency: clamp01(((facts.er ?? 0) - 0.05) / 0.45),
    directionalCandle,
    cleanVolume,
    volumeAcceleration,
    volumeFlowAgreement,
    vwapExtensionRisk,
    failedBreakRisk,
    pullbackReclaim,
    momentumBurst,
    cleanBreakout,
    marketAlignment: marketScore,
    relativeStrength,
    marketImpulse,
    dayPositionQuality: clamp01(dayPosition),
    intradayTrendQuality: clamp01((intradayTrend + 0.15) / 1.2),
    priorDayBreakQuality: clamp01((priorDayBreak + 0.10) / 0.9),
    priorDayReclaim,
    rangeExpansionQuality,
    timeEdge,
    optionBurstShape,
    liquiditySweep,
    stopRunReclaim,
    relVolTodQuality,
    openingDriveQuality,
    compressionRelease,
  };
}

const defaultAlphaWeights = {
  bodyQuality: 0.12,
  closeLocation: 0.13,
  rejectionWick: 0.08,
  emaSlope: 0.13,
  priceAcceleration: 0.13,
  vwapPressure: 0.11,
  volumeQuality: 0.10,
  flowQuality: 0.09,
  breakoutQuality: 0.07,
  trendQuality: 0.09,
  chopQuality: 0.05,
  directionalCandle: 0.06,
  cleanVolume: 0.08,
  volumeAcceleration: 0.06,
  volumeFlowAgreement: 0.08,
  vwapExtensionRisk: -0.08,
  failedBreakRisk: -0.10,
  pullbackReclaim: 0.08,
  momentumBurst: 0.10,
  cleanBreakout: 0.08,
  marketAlignment: 0.07,
  relativeStrength: 0.08,
  marketImpulse: 0.06,
  dayPositionQuality: 0.07,
  intradayTrendQuality: 0.07,
  priorDayBreakQuality: 0.05,
  priorDayReclaim: 0.04,
  rangeExpansionQuality: 0.06,
  timeEdge: 0.04,
  optionBurstShape: 0.06,
  liquiditySweep: 0.07,
  stopRunReclaim: 0.08,
  relVolTodQuality: 0.05,
  openingDriveQuality: 0.06,
  compressionRelease: 0.06,
};

const specialistAlphaWeights = {
  'volume-shock:long': {
    bodyQuality: 0.13,
    closeLocation: 0.12,
    directionalCandle: 0.12,
    flowQuality: 0.14,
    cleanVolume: 0.12,
    volumeAcceleration: 0.09,
    volumeFlowAgreement: 0.14,
    momentumBurst: 0.10,
    marketAlignment: 0.08,
    relativeStrength: 0.08,
    marketImpulse: 0.06,
    intradayTrendQuality: 0.06,
    timeEdge: 0.06,
    relativeVolume: 0.04,
    volumeQuality: -0.06,
    rejectionWick: -0.09,
    vwapExtensionRisk: -0.12,
    failedBreakRisk: -0.14,
  },
  'volume-shock:short': {
    bodyQuality: 0.10,
    closeLocation: 0.10,
    directionalCandle: 0.11,
    flowQuality: 0.13,
    cleanVolume: 0.10,
    volumeFlowAgreement: 0.12,
    momentumBurst: 0.08,
    marketAlignment: 0.06,
    volumeQuality: -0.08,
    rejectionWick: -0.10,
    vwapExtensionRisk: -0.14,
    failedBreakRisk: -0.16,
  },
  'options-burst:long': {
    optionBurstShape: 0.16,
    momentumBurst: 0.15,
    priceAcceleration: 0.12,
    atrExpansion: 0.11,
    cleanBreakout: 0.10,
    rangeExpansionQuality: 0.10,
    closeLocation: 0.10,
    flowQuality: 0.09,
    marketAlignment: 0.09,
    relativeStrength: 0.08,
    marketImpulse: 0.07,
    priorDayBreakQuality: 0.06,
    timeEdge: 0.08,
    trendQuality: 0.07,
    vwapExtensionRisk: -0.10,
    failedBreakRisk: -0.15,
    rejectionWick: -0.08,
  },
  'options-burst:short': {
    optionBurstShape: 0.14,
    momentumBurst: 0.13,
    priceAcceleration: 0.11,
    atrExpansion: 0.10,
    cleanBreakout: 0.09,
    closeLocation: 0.10,
    flowQuality: 0.08,
    marketAlignment: 0.07,
    timeEdge: 0.06,
    trendQuality: 0.06,
    vwapExtensionRisk: -0.12,
    failedBreakRisk: -0.16,
    rejectionWick: -0.09,
  },
  'momentum-acceleration:long': {
    priceAcceleration: 0.15,
    emaSlope: 0.13,
    momentumBurst: 0.13,
    flowQuality: 0.12,
    closeLocation: 0.11,
    directionalCandle: 0.10,
    trendQuality: 0.09,
    marketAlignment: 0.08,
    relativeStrength: 0.09,
    marketImpulse: 0.08,
    intradayTrendQuality: 0.08,
    cleanVolume: 0.07,
    vwapPressure: 0.06,
    failedBreakRisk: -0.12,
    vwapExtensionRisk: -0.10,
  },
  'momentum-acceleration:short': {
    priceAcceleration: 0.13,
    emaSlope: 0.12,
    momentumBurst: 0.12,
    flowQuality: 0.11,
    closeLocation: 0.10,
    directionalCandle: 0.09,
    trendQuality: 0.08,
    marketAlignment: 0.07,
    cleanVolume: 0.06,
    vwapPressure: 0.05,
    failedBreakRisk: -0.13,
    vwapExtensionRisk: -0.11,
  },
  'opening-range:long': {
    cleanBreakout: 0.15,
    rangeExpansionQuality: 0.10,
    breakoutQuality: 0.13,
    closeLocation: 0.12,
    cleanVolume: 0.10,
    volumeFlowAgreement: 0.10,
    marketAlignment: 0.09,
    relativeStrength: 0.07,
    priorDayBreakQuality: 0.08,
    timeEdge: 0.08,
    atrExpansion: 0.08,
    trendQuality: 0.07,
    failedBreakRisk: -0.17,
    rejectionWick: -0.10,
    vwapExtensionRisk: -0.08,
  },
  'opening-range:short': {
    cleanBreakout: 0.13,
    breakoutQuality: 0.12,
    closeLocation: 0.11,
    cleanVolume: 0.09,
    volumeFlowAgreement: 0.09,
    marketAlignment: 0.07,
    timeEdge: 0.07,
    atrExpansion: 0.07,
    trendQuality: 0.06,
    failedBreakRisk: -0.18,
    rejectionWick: -0.11,
    vwapExtensionRisk: -0.09,
  },
  'hybrid-consensus:long': {
    bodyQuality: 0.10,
    closeLocation: 0.11,
    emaSlope: 0.10,
    priceAcceleration: 0.10,
    flowQuality: 0.11,
    trendQuality: 0.10,
    marketAlignment: 0.09,
    relativeStrength: 0.08,
    marketImpulse: 0.06,
    volumeFlowAgreement: 0.09,
    cleanBreakout: 0.08,
    rangeExpansionQuality: 0.07,
    momentumBurst: 0.08,
    failedBreakRisk: -0.13,
    vwapExtensionRisk: -0.10,
  },
  'hybrid-consensus:short': {
    bodyQuality: 0.09,
    closeLocation: 0.10,
    emaSlope: 0.09,
    priceAcceleration: 0.09,
    flowQuality: 0.10,
    trendQuality: 0.09,
    marketAlignment: 0.08,
    volumeFlowAgreement: 0.08,
    cleanBreakout: 0.07,
    momentumBurst: 0.07,
    failedBreakRisk: -0.14,
    vwapExtensionRisk: -0.11,
  },
  'liquidity-sweep:long': {
    liquiditySweep: 0.20,
    stopRunReclaim: 0.18,
    closeLocation: 0.12,
    flowQuality: 0.10,
    rejectionWick: 0.10,
    relativeStrength: 0.08,
    vwapPressure: 0.07,
    failedBreakRisk: -0.16,
    vwapExtensionRisk: -0.08,
  },
  'liquidity-sweep:short': {
    liquiditySweep: 0.20,
    stopRunReclaim: 0.18,
    closeLocation: 0.12,
    flowQuality: 0.10,
    rejectionWick: 0.10,
    vwapPressure: 0.06,
    failedBreakRisk: -0.16,
    vwapExtensionRisk: -0.08,
  },
  'compression-pop:long': {
    compressionRelease: 0.16,
    rangeExpansionQuality: 0.14,
    cleanBreakout: 0.12,
    volumeFlowAgreement: 0.12,
    relVolTodQuality: 0.10,
    closeLocation: 0.10,
    marketAlignment: 0.08,
    vwapExtensionRisk: -0.10,
    failedBreakRisk: -0.14,
  },
  'compression-pop:short': {
    compressionRelease: 0.16,
    rangeExpansionQuality: 0.14,
    cleanBreakout: 0.12,
    volumeFlowAgreement: 0.12,
    relVolTodQuality: 0.10,
    closeLocation: 0.10,
    marketAlignment: 0.07,
    vwapExtensionRisk: -0.11,
    failedBreakRisk: -0.15,
  },
  'opening-drive-continuation:long': {
    openingDriveQuality: 0.18,
    timeEdge: 0.12,
    trendQuality: 0.11,
    relativeStrength: 0.10,
    marketImpulse: 0.09,
    volumeFlowAgreement: 0.10,
    closeLocation: 0.10,
    vwapExtensionRisk: -0.12,
  },
  'opening-drive-continuation:short': {
    openingDriveQuality: 0.18,
    timeEdge: 0.12,
    trendQuality: 0.11,
    marketImpulse: 0.09,
    volumeFlowAgreement: 0.10,
    closeLocation: 0.10,
    vwapExtensionRisk: -0.12,
  },
};

function specialistWeightsFor(combo, dir) {
  const trigger = combo.triggerMode || 'base';
  const side = dir === 1 ? 'long' : 'short';
  const set = combo.alphaWeightSet || 'default';
  const external = alphaWeightsModel?.sets?.[set]?.weights;
  if (external?.[`${trigger}:${side}`]) return external[`${trigger}:${side}`];
  if (external?.[trigger]) return external[trigger];
  if (external?.default) return external.default;
  return specialistAlphaWeights[`${trigger}:${side}`] || defaultAlphaWeights;
}

function weightedFeatureScore(features, weights = defaultAlphaWeights) {
  let weighted = 0;
  let total = 0;
  for (const [name, value] of Object.entries(features)) {
    const weight = weights[name] ?? 0;
    if (weight === 0) continue;
    weighted += (weight > 0 ? value : 1 - value) * Math.abs(weight);
    total += Math.abs(weight);
  }
  return total > 0 ? Math.round(clamp01(weighted / total) * 100) : 0;
}

function alphaScoreForCombo(features, combo, dir, intelligence = null) {
  const defaultScore = weightedFeatureScore(features);
  if (!combo.alphaMode || combo.alphaMode === 'default') return defaultScore;
  const specialistScore = weightedFeatureScore(features, specialistWeightsFor(combo, dir));
  if (combo.alphaMode === 'specialist') return specialistScore;
  if (combo.alphaMode === 'specialist-blend') return Math.round(defaultScore * 0.30 + specialistScore * 0.70);
  if (combo.alphaMode === 'specialist-intel') {
    const intelScore = intelligence?.score ?? specialistScore;
    const blend = alphaWeightsModel?.sets?.[combo.alphaWeightSet || 'default']?.blend || {};
    const specialistShare = blend.specialist ?? 0.55;
    const intelShare = blend.intelligence ?? 0.45;
    const badPatternPenalty = intelligence?.badPattern ? (blend.badPatternPenalty ?? 18) : 0;
    return Math.round(Math.max(0, Math.min(100, specialistScore * specialistShare + intelScore * intelShare - badPatternPenalty)));
  }
  return defaultScore;
}

function modelBucket(model, trigger, family, regime) {
  return model?.buckets?.[`${trigger}|${family}|${regime}`]
    || model?.buckets?.[`${trigger}|${family}|all`]
    || model?.buckets?.[`${trigger}|all|${regime}`]
    || model?.buckets?.[`${trigger}|all|all`]
    || model?.buckets?.global
    || null;
}

function cosineSimilarity(a, b) {
  let dot = 0;
  let amag = 0;
  let bmag = 0;
  for (const key of Object.keys(a)) {
    const av = a[key] ?? 0;
    const bv = b[key] ?? 0;
    dot += av * bv;
    amag += av * av;
    bmag += bv * bv;
  }
  return amag > 0 && bmag > 0 ? dot / Math.sqrt(amag * bmag) : 0;
}

function intelligenceScore(ctx, index, dir, combo, facts, features) {
  const trigger = combo.triggerMode || 'base';
  const family = symbolFamily(ctx.symbol);
  const regime = regimeLabel(ctx, index, facts);
  const bucket = modelBucket(intelligenceModel, trigger, family, regime);
  const weights = bucket?.weights || intelligenceModel?.globalWeights || defaultAlphaWeights;
  const weightedScore = weightedFeatureScore(features, weights);
  const winnerSim = bucket?.winnerPrototype ? cosineSimilarity(features, bucket.winnerPrototype) : 0.5;
  const loserSim = bucket?.loserPrototype ? cosineSimilarity(features, bucket.loserPrototype) : 0.5;
  const similarityScore = clamp01((winnerSim - loserSim + 1) / 2) * 100;
  const rawConfidence = dir === 1 ? facts.current.bullPct : facts.current.bearPct;
  const calibration = bucket?.calibration?.find((item) => rawConfidence >= item.min && rawConfidence < item.max)?.winRate
    ?? intelligenceModel?.calibration?.find((item) => rawConfidence >= item.min && rawConfidence < item.max)?.winRate
    ?? rawConfidence;
  const driftPenalty = bucket?.drift?.degrading ? 12 : 0;
  const badPattern = (bucket?.badPatterns || []).some((pattern) => (
    Object.entries(pattern.conditions || {}).every(([name, bounds]) => {
      const value = features[name] ?? 0;
      return value >= (bounds.min ?? 0) && value <= (bounds.max ?? 1);
    })
  ));
  const score = weightedScore * 0.45 + similarityScore * 0.25 + calibration * 0.30 - driftPenalty - (badPattern ? 35 : 0);
  return {
    score: Math.round(Math.max(0, Math.min(100, score))),
    weightedScore,
    similarityScore: Math.round(similarityScore),
    calibration,
    badPattern,
    trigger,
    family,
    regime,
    bucketKey: bucket?.key || 'fallback',
  };
}

function scalpAlphaQuality(ctx, index, dir, facts) {
  return weightedFeatureScore(scalpAlphaFeatures(ctx, index, dir, facts));
}

const peerGroups = {
  semis: new Set(['NVDA', 'AMD', 'AVGO', 'SMCI', 'INTC']),
  crypto: new Set(['COIN', 'MARA', 'RIOT', 'HOOD']),
  ev: new Set(['TSLA', 'RIVN', 'LCID', 'QS', 'CHPT']),
  ai: new Set(['AI', 'BBAI', 'SOUN', 'PLTR', 'IONQ']),
};

function peerRefsForSymbol(symbol) {
  if (peerGroups.semis.has(symbol)) return ['SMH'];
  if (peerGroups.crypto.has(symbol)) return ['BTC-USD'];
  if (peerGroups.ev.has(symbol)) return ['TSLA'];
  if (peerGroups.ai.has(symbol)) return ['QQQ'];
  return ['QQQ'];
}

function peerAlignmentOk(ctx, index, dir, mode) {
  if (!mode || mode === 'off') return true;
  const bar = ctx.bars[index];
  const refs = mode === 'peer' ? peerRefsForSymbol(ctx.symbol) : [...new Set([...peerRefsForSymbol(ctx.symbol), 'QQQ'])];
  for (const ref of refs) {
    const peer = ctx.peerRefs?.[ref] || ctx.marketRefs?.[ref];
    const peerIndex = peer?.timeToIndex.get(bar.time);
    if (peerIndex == null || peerIndex < 6) return false;
    const close = peer.closes[peerIndex];
    const ema21 = peer.ema21[peerIndex];
    const ema50 = peer.ema50[peerIndex];
    const okLong = close > ema21 && close > ema50;
    const okShort = close < ema21 && close < ema50;
    if (dir === 1 && !okLong) return false;
    if (dir === -1 && !okShort) return false;
  }
  return true;
}

function newsOk(ctx, index, combo) {
  if (!combo.newsMode || combo.newsMode === 'off') return true;
  const previousClose = ctx.prevDayClose[index];
  const previousRange = Math.max(ctx.prevDayRange[index] ?? 0, 0.01);
  const gapR = previousClose == null ? 0 : Math.abs((ctx.dayOpen[index] - previousClose) / previousRange);
  const rawVol = ctx.bars[index].volume / Math.max(ctx.volAvg[index], 1);
  const todVol = ctx.relVolTod[index] ?? 1;
  if (combo.newsMode === 'avoid-spike') return gapR < 1.0 && rawVol < 5.0 && todVol < 5.0;
  if (combo.newsMode === 'momentum-only') return gapR >= 0.4 || rawVol >= 2.5 || todVol >= 2.5;
  return true;
}

function positionScaleForCombo(confidence, combo) {
  if (!combo.positionSizing || combo.positionSizing === 'fixed') return 1;
  const raw = 0.5 + Math.max(0, confidence - 65) / 35;
  return Math.max(combo.minPositionScale, Math.min(combo.maxPositionScale, raw));
}

function sampleBounds(length) {
  const split = Math.max(100, Math.min(length - 1, Math.floor(length * trainPct)));
  if (sample === 'train') return { start: 80, end: split };
  if (sample === 'test') return { start: Math.max(80, split), end: length };
  return { start: 80, end: length };
}

function playbookSignal(ctx, index, combo, facts) {
  const bar = ctx.bars[index];
  const previousBar = ctx.bars[index - 1];
  const previousHigh = rollingHigh(ctx.bars, index, 20);
  const previousLow = rollingLow(ctx.bars, index, 20);
  const rsi = ctx.rsi[index] ?? 50;
  const previousRsi = ctx.rsi[index - 1] ?? 50;
  const vwapCrossUp = previousBar.close <= ctx.vwap[index - 1] && bar.close > ctx.vwap[index];
  const vwapCrossDown = previousBar.close >= ctx.vwap[index - 1] && bar.close < ctx.vwap[index];
  const emaReclaimUp = previousBar.close <= ctx.ema21[index - 1] && bar.close > ctx.ema21[index];
  const emaReclaimDown = previousBar.close >= ctx.ema21[index - 1] && bar.close < ctx.ema21[index];
  const squeeze = facts.atrRatio <= 1.05 && facts.er < 0.22;
  const expansion = facts.atrRatio >= Math.max(combo.minAtrRatio, 1.0) && facts.volumeOk;
  const momentumUp = facts.flow >= 0.05 && ctx.macd[index] > ctx.signal[index];
  const momentumDown = facts.flow <= -0.05 && ctx.macd[index] < ctx.signal[index];
  const scoreBuy = facts.current.bullPct >= combo.minLead && facts.bullEdge >= combo.minEdge && facts.current.bullPct >= combo.minConf;
  const scoreSell = facts.current.bearPct >= combo.minLead && facts.bearEdge >= combo.minEdge && facts.current.bearPct >= combo.minConf;
  const alphaBuyOk = !combo.minAlphaQuality || facts.alphaBuy >= combo.minAlphaQuality;
  const alphaSellOk = !combo.minAlphaQuality || facts.alphaSell >= combo.minAlphaQuality;

  if (combo.playbook === 'Scalp') {
    const mode = combo.triggerMode || 'base';
    const prevAtrRatio = ctx.atr50[index - 1] ? ctx.atr[index - 1] / ctx.atr50[index - 1] : facts.atrRatio;
    const squeezeWas = prevAtrRatio <= 1.05 && efficiencyRatio(ctx.closes, 10, index - 1) < 0.22;
    const priorHigh = previousHigh;
    const priorLow = previousLow;
    const openRangeHigh = ctx.orHigh15?.[index] ?? ctx.orHigh30?.[index];
    const openRangeLow = ctx.orLow15?.[index] ?? ctx.orLow30?.[index];
    const sweepHigh = rollingHigh(ctx.bars, Math.max(2, index - 1), 12);
    const sweepLow = rollingLow(ctx.bars, Math.max(2, index - 1), 12);
    const volumeShock = bar.volume >= ctx.volAvg[index] * Math.max(combo.volMult * 1.5, 2.0);
    const emaTrendUp = ctx.ema9[index] > ctx.ema21[index] && ctx.ema21[index] > ctx.ema50[index];
    const emaTrendDown = ctx.ema9[index] < ctx.ema21[index] && ctx.ema21[index] < ctx.ema50[index];
    const emaPullbackBuy = ctx.ema9[index] > ctx.ema21[index] && previousBar.low <= ctx.ema21[index - 1] && bar.close > ctx.ema9[index] && facts.flow >= 0;
    const emaPullbackSell = ctx.ema9[index] < ctx.ema21[index] && previousBar.high >= ctx.ema21[index - 1] && bar.close < ctx.ema9[index] && facts.flow <= 0;
    const breakoutBuy = bar.close > priorHigh && bar.close > ctx.vwap[index];
    const breakoutSell = bar.close < priorLow && bar.close < ctx.vwap[index];
    const failedReversalBuy = previousBar.low < priorLow && bar.close > priorLow && (vwapCrossUp || emaReclaimUp || bar.close > previousBar.high);
    const failedReversalSell = previousBar.high > priorHigh && bar.close < priorHigh && (vwapCrossDown || emaReclaimDown || bar.close < previousBar.low);
    const momentumAccelBuy = facts.current.bullPct > facts.previous.bullPct && facts.volumeOk && momentumUp && bar.close > previousBar.close && facts.bullEdge > 0;
    const momentumAccelSell = facts.current.bearPct > facts.previous.bearPct && facts.volumeOk && momentumDown && bar.close < previousBar.close && facts.bearEdge > 0;
    const meanReversionBuy = previousRsi < 35 && rsi > previousRsi && (vwapCrossUp || emaReclaimUp || bar.close > previousBar.high);
    const meanReversionSell = previousRsi > 65 && rsi < previousRsi && (vwapCrossDown || emaReclaimDown || bar.close < previousBar.low);
    const trendContinuationBuy = emaTrendUp && emaPullbackBuy && bar.close > ctx.vwap[index];
    const trendContinuationSell = emaTrendDown && emaPullbackSell && bar.close < ctx.vwap[index];
    const squeezeExpansionBuy = squeezeWas && expansion && momentumUp && bar.close > previousBar.high;
    const squeezeExpansionSell = squeezeWas && expansion && momentumDown && bar.close < previousBar.low;
    const openingRangeBuy = openRangeHigh != null && bar.close > openRangeHigh && facts.flow >= 0;
    const openingRangeSell = openRangeLow != null && bar.close < openRangeLow && facts.flow <= 0;
    const volumeShockBuy = volumeShock && facts.flow > 0.15 && bar.close > previousBar.close;
    const volumeShockSell = volumeShock && facts.flow < -0.15 && bar.close < previousBar.close;
    const optionsBurstBuy = expansion && facts.volumeOk && facts.bullEdge >= combo.minEdge * 1.5 && (breakoutBuy || momentumAccelBuy || squeezeExpansionBuy);
    const optionsBurstSell = expansion && facts.volumeOk && facts.bearEdge >= combo.minEdge * 1.5 && (breakoutSell || momentumAccelSell || squeezeExpansionSell);
    const confirmedBuy = bar.close > ctx.ema21[index] && bar.close > ctx.vwap[index] && facts.flow >= 0 && facts.current.bullPct >= facts.previous.bullPct;
    const confirmedSell = bar.close < ctx.ema21[index] && bar.close < ctx.vwap[index] && facts.flow <= 0 && facts.current.bearPct >= facts.previous.bearPct;
    const liquiditySweepBuy = bar.low < sweepLow && bar.close > sweepLow && bar.close > previousBar.close && facts.flow >= 0;
    const liquiditySweepSell = bar.high > sweepHigh && bar.close < sweepHigh && bar.close < previousBar.close && facts.flow <= 0;
    const compressionPopBuy = squeezeWas && expansion && bar.close > previousBar.high && bar.close > ctx.vwap[index] && facts.flow >= 0.08;
    const compressionPopSell = squeezeWas && expansion && bar.close < previousBar.low && bar.close < ctx.vwap[index] && facts.flow <= -0.08;
    const relativeStrengthReclaimBuy = (vwapCrossUp || emaReclaimUp) && bar.close > ctx.ema9[index] && facts.flow >= 0.05 && facts.alphaBuy >= combo.minAlphaQuality + 5;
    const relativeStrengthReclaimSell = (vwapCrossDown || emaReclaimDown) && bar.close < ctx.ema9[index] && facts.flow <= -0.05 && facts.alphaSell >= combo.minAlphaQuality + 5;
    const trendPullbackBurstBuy = emaTrendUp && previousBar.low <= ctx.ema21[index - 1] && bar.close > previousBar.high && expansion && facts.flow >= 0.05;
    const trendPullbackBurstSell = emaTrendDown && previousBar.high >= ctx.ema21[index - 1] && bar.close < previousBar.low && expansion && facts.flow <= -0.05;
    const openingDriveContinuationBuy = ctx.marketMinutes[index] < 10 * 60 + 30 && bar.close > ctx.dayOpen[index] && emaTrendUp && bar.close > previousBar.high && facts.flow >= 0.05;
    const openingDriveContinuationSell = ctx.marketMinutes[index] < 10 * 60 + 30 && bar.close < ctx.dayOpen[index] && emaTrendDown && bar.close < previousBar.low && facts.flow <= -0.05;
    const buyVotes = [
      facts.buyCross,
      facts.bullScoreCross,
      vwapCrossUp,
      emaPullbackBuy,
      breakoutBuy,
      failedReversalBuy,
      momentumAccelBuy,
      meanReversionBuy,
      trendContinuationBuy,
      squeezeExpansionBuy,
      openingRangeBuy,
      volumeShockBuy,
      optionsBurstBuy,
      liquiditySweepBuy,
      compressionPopBuy,
      relativeStrengthReclaimBuy,
      trendPullbackBurstBuy,
      openingDriveContinuationBuy,
    ].filter(Boolean).length;
    const sellVotes = [
      facts.sellCross,
      facts.bearScoreCross,
      vwapCrossDown,
      emaPullbackSell,
      breakoutSell,
      failedReversalSell,
      momentumAccelSell,
      meanReversionSell,
      trendContinuationSell,
      squeezeExpansionSell,
      openingRangeSell,
      volumeShockSell,
      optionsBurstSell,
      liquiditySweepSell,
      compressionPopSell,
      relativeStrengthReclaimSell,
      trendPullbackBurstSell,
      openingDriveContinuationSell,
    ].filter(Boolean).length;
    const triggerMap = {
      base: {
        buy: (facts.buyCross || facts.bullScoreCross || vwapCrossUp) && bar.close > ctx.ema9[index] && facts.flow >= 0,
        sell: (facts.sellCross || facts.bearScoreCross || vwapCrossDown) && bar.close < ctx.ema9[index] && facts.flow <= 0,
      },
      'ema-cross': { buy: facts.buyCross && bar.close > ctx.ema9[index], sell: facts.sellCross && bar.close < ctx.ema9[index] },
      'score-cross': { buy: facts.bullScoreCross && facts.flow >= 0, sell: facts.bearScoreCross && facts.flow <= 0 },
      'vwap-reclaim': { buy: vwapCrossUp && bar.close > ctx.ema9[index], sell: vwapCrossDown && bar.close < ctx.ema9[index] },
      'ema-pullback': { buy: emaPullbackBuy, sell: emaPullbackSell },
      breakout: { buy: breakoutBuy, sell: breakoutSell },
      'failed-reversal': { buy: failedReversalBuy, sell: failedReversalSell },
      'momentum-acceleration': { buy: momentumAccelBuy, sell: momentumAccelSell },
      'mean-reversion': { buy: meanReversionBuy, sell: meanReversionSell },
      'trend-continuation': { buy: trendContinuationBuy, sell: trendContinuationSell },
      'squeeze-expansion': { buy: squeezeExpansionBuy, sell: squeezeExpansionSell },
      'opening-range': { buy: openingRangeBuy, sell: openingRangeSell },
      'volume-shock': { buy: volumeShockBuy, sell: volumeShockSell },
      'options-burst': { buy: optionsBurstBuy, sell: optionsBurstSell },
      'confirmed-no-repaint': { buy: confirmedBuy, sell: confirmedSell },
      'liquidity-sweep': { buy: liquiditySweepBuy, sell: liquiditySweepSell },
      'compression-pop': { buy: compressionPopBuy, sell: compressionPopSell },
      'relative-strength-reclaim': { buy: relativeStrengthReclaimBuy, sell: relativeStrengthReclaimSell },
      'trend-pullback-burst': { buy: trendPullbackBurstBuy, sell: trendPullbackBurstSell },
      'opening-drive-continuation': { buy: openingDriveContinuationBuy, sell: openingDriveContinuationSell },
      'hybrid-consensus': { buy: buyVotes >= 2 && confirmedBuy, sell: sellVotes >= 2 && confirmedSell },
    };
    const selected = triggerMap[mode] || triggerMap.base;
    return {
      buy: facts.common && scoreBuy && alphaBuyOk && selected.buy,
      sell: facts.common && scoreSell && alphaSellOk && selected.sell,
    };
  }

  if (combo.playbook === 'DayTrade') {
    return {
      buy: facts.common && scoreBuy && alphaBuyOk && (facts.buyCross || facts.bullScoreCross || emaReclaimUp) && bar.close > ctx.ema9[index] && bar.close > ctx.vwap[index] && momentumUp,
      sell: facts.common && scoreSell && alphaSellOk && (facts.sellCross || facts.bearScoreCross || emaReclaimDown) && bar.close < ctx.ema9[index] && bar.close < ctx.vwap[index] && momentumDown,
    };
  }

  if (combo.playbook === 'OptionsBurst') {
    return {
      buy: facts.common && scoreBuy && alphaBuyOk && expansion && facts.volumeOk && (bar.close > previousHigh || facts.bullScoreCross) && bar.close > ctx.vwap[index] && ctx.ema9[index] > ctx.ema21[index] && momentumUp,
      sell: facts.common && scoreSell && alphaSellOk && expansion && facts.volumeOk && (bar.close < previousLow || facts.bearScoreCross) && bar.close < ctx.vwap[index] && ctx.ema9[index] < ctx.ema21[index] && momentumDown,
    };
  }

  if (combo.playbook === 'Breakout') {
    return {
      buy: facts.common && scoreBuy && alphaBuyOk && expansion && bar.close > previousHigh && ctx.ema9[index] > ctx.ema21[index],
      sell: facts.common && scoreSell && alphaSellOk && expansion && bar.close < previousLow && ctx.ema9[index] < ctx.ema21[index],
    };
  }

  if (combo.playbook === 'Reversal') {
    const buyReversal = previousRsi < 35 && rsi > previousRsi && (vwapCrossUp || emaReclaimUp || bar.close > previousBar.high);
    const sellReversal = previousRsi > 65 && rsi < previousRsi && (vwapCrossDown || emaReclaimDown || bar.close < previousBar.low);
    return {
      buy: facts.common && scoreBuy && alphaBuyOk && buyReversal && facts.flow >= 0,
      sell: facts.common && scoreSell && alphaSellOk && sellReversal && facts.flow <= 0,
    };
  }

  if (combo.playbook === 'VWAPReclaim') {
    return {
      buy: facts.common && scoreBuy && alphaBuyOk && vwapCrossUp && bar.close > ctx.ema9[index] && facts.flow >= 0.05,
      sell: facts.common && scoreSell && alphaSellOk && vwapCrossDown && bar.close < ctx.ema9[index] && facts.flow <= -0.05,
    };
  }

  return {
    buy: facts.common && scoreBuy && alphaBuyOk && (facts.buyCross || facts.bullScoreCross) && bar.close > ctx.ema9[index] && bar.close > ctx.vwap[index] && facts.flow >= 0.05,
    sell: facts.common && scoreSell && alphaSellOk && (facts.sellCross || facts.bearScoreCross) && bar.close < ctx.ema9[index] && bar.close < ctx.vwap[index] && facts.flow <= -0.05,
  };
}

function backtest(ctx, combo) {
  const trades = [];
  let position = null;
  let cooldownUntil = -1;
  let consecutiveLosses = 0;
  const bounds = sampleBounds(ctx.bars.length);
  const barMinutes = intervalMinutes(interval);
  const horizonBars = [5, 10, 15, 30, 60].map((minutes) => ({ minutes, bars: Math.max(1, Math.round(minutes / barMinutes)) }));
  const updateLossCluster = (pnl, index) => {
    if (pnl > 0) {
      consecutiveLosses = 0;
      return;
    }
    consecutiveLosses += 1;
    if (combo.maxConsecutiveLosses > 0 && consecutiveLosses >= combo.maxConsecutiveLosses && combo.clusterCooldownBars > 0) {
      cooldownUntil = Math.max(cooldownUntil, index + combo.clusterCooldownBars);
      consecutiveLosses = 0;
    }
  };
  const closePosition = (bar, reason, index) => {
    const exit = bar.close;
    const pnl = position.realized + position.remaining * position.dir * (exit - position.entry) - position.costPerShare;
    const pnlDollars = pnl * position.shares;
    const trade = {
      ...position,
      exit,
      exitTime: bar.time,
      reason,
      pnl,
      pnlDollars,
      pnlR: pnl / position.risk,
      win: pnl > 0,
      optionWorthy: position.mfeR >= 1.5 && position.maeR <= 0.75,
      greatTrade: position.confidence >= 70 && position.mfeR >= 2 && position.maeR <= 0.75,
    };
    trades.push(trade);
    if (pnl <= 0 && combo.lossCooldownBars > 0) cooldownUntil = index + combo.lossCooldownBars;
    updateLossCluster(pnl, index);
    position = null;
  };

  for (let index = bounds.start; index < bounds.end; index += 1) {
    const bar = ctx.bars[index];
    if (position) {
      const barsHeld = index - position.entryIndex;
      const favorable = position.dir === 1 ? bar.high - position.entry : position.entry - bar.low;
      const adverse = position.dir === 1 ? position.entry - bar.low : bar.high - position.entry;
      position.mfe = Math.max(position.mfe, favorable);
      position.mae = Math.max(position.mae, adverse);
      position.mfeR = position.mfe / position.risk;
      position.maeR = position.mae / position.risk;
      position.best = position.dir === 1 ? Math.max(position.best, bar.high) : Math.min(position.best, bar.low);
      for (const horizon of horizonBars) {
        if (barsHeld === horizon.bars && position[`move${horizon.minutes}mR`] == null) {
          position[`move${horizon.minutes}mR`] = position.dir * (bar.close - position.entry) / position.risk;
        }
      }

      const current = scoreForBar(ctx, index);
      const liveConf = position.dir === 1 ? current.bullPct : current.bearPct;
      const confidenceCollapse = combo.exitMode === 'smart' && liveConf <= Math.max(35, position.confidence - combo.confidenceDrop);
      const reclaimFailure = combo.exitMode === 'smart' && structureExitHit(ctx, index, position, combo.structureExit);
      const timeStop = combo.exitMode === 'smart' && barsHeld >= combo.timeStopBars && !position.partialHit && position.mfeR < Math.max(0.35, combo.partialR * 0.75);

      if (combo.exitMode === 'smart' && position.partialHit) {
        const trailStop = position.dir === 1 ? position.best - position.risk * combo.trailR : position.best + position.risk * combo.trailR;
        position.stop = position.dir === 1 ? Math.max(position.stop, trailStop) : Math.min(position.stop, trailStop);
      }

      const hitStop = position.dir === 1 ? bar.low <= position.stop : bar.high >= position.stop;
      const hitTarget = position.dir === 1 ? bar.high >= position.target : bar.low <= position.target;
      const hitPartial = combo.exitMode === 'smart' && !position.partialHit && (position.dir === 1 ? bar.high >= position.entry + position.risk * combo.partialR : bar.low <= position.entry - position.risk * combo.partialR);

      if (hitStop) {
        const pnl = position.realized + position.remaining * position.dir * (position.stop - position.entry) - position.costPerShare;
        const pnlDollars = pnl * position.shares;
        trades.push({
          ...position,
          exit: position.stop,
          exitTime: bar.time,
          reason: 'stop',
          pnl,
          pnlDollars,
          pnlR: pnl / position.risk,
          win: pnl > 0,
          optionWorthy: position.mfeR >= 1.5 && position.maeR <= 0.75,
          greatTrade: position.confidence >= 70 && position.mfeR >= 2 && position.maeR <= 0.75,
        });
        if (pnl <= 0 && combo.lossCooldownBars > 0) cooldownUntil = index + combo.lossCooldownBars;
        updateLossCluster(pnl, index);
        position = null;
      } else if (hitPartial) {
        position.realized += 0.5 * position.risk * combo.partialR;
        position.remaining = 0.5;
        position.partialHit = true;
        position.stop = position.entry;
      } else if (hitTarget) {
        const pnl = position.realized + position.remaining * position.dir * (position.target - position.entry) - position.costPerShare;
        const pnlDollars = pnl * position.shares;
        trades.push({
          ...position,
          exit: position.target,
          exitTime: bar.time,
          reason: 'target',
          pnl,
          pnlDollars,
          pnlR: pnl / position.risk,
          win: pnl > 0,
          optionWorthy: position.mfeR >= 1.5 && position.maeR <= 0.75,
          greatTrade: position.confidence >= 70 && position.mfeR >= 2 && position.maeR <= 0.75,
        });
        if (pnl <= 0 && combo.lossCooldownBars > 0) cooldownUntil = index + combo.lossCooldownBars;
        updateLossCluster(pnl, index);
        position = null;
      } else if (confidenceCollapse || reclaimFailure || timeStop) {
        closePosition(bar, timeStop ? 'time-stop' : confidenceCollapse ? 'confidence-collapse' : 'reclaim-failure', index);
      }
      if (position) continue;
    }

    if (index <= cooldownUntil || !sessionOk(ctx.marketMinutes[index], combo.session)) continue;

    const previous = scoreForBar(ctx, index - 1);
    const current = scoreForBar(ctx, index);
    const bullEdge = current.bullPct - current.bearPct;
    const bearEdge = current.bearPct - current.bullPct;
    const atrRatio = ctx.atr50[index] ? ctx.atr[index] / ctx.atr50[index] : 1;
    const er = efficiencyRatio(ctx.closes, 10, index);
    const flow = (bar.close - bar.open) / Math.max(bar.high - bar.low, 0.01);
    const buyCross = ctx.ema9[index] > ctx.ema21[index] && ctx.ema9[index - 1] <= ctx.ema21[index - 1];
    const sellCross = ctx.ema9[index] < ctx.ema21[index] && ctx.ema9[index - 1] >= ctx.ema21[index - 1];
    const bullScoreCross = current.bullPct >= combo.minLead && previous.bullPct < combo.minLead;
    const bearScoreCross = current.bearPct >= combo.minLead && previous.bearPct < combo.minLead;
    const volumeOk = bar.volume >= ctx.volAvg[index] * combo.volMult;
    const common = atrRatio >= combo.minAtrRatio && ctx.adx[index] >= combo.minAdx && er >= combo.minEr && volumeOk && volumeQualityOk(ctx, index, combo) && relativeVolumeOk(ctx, index, combo) && liquidityOk(ctx, index, combo) && newsOk(ctx, index, combo);
    const alphaFacts = { er, flow };
    alphaFacts.atrRatio = atrRatio;
    const intelFacts = { current, previous, bullEdge, bearEdge, atrRatio, er, flow };
    const alphaBuyFeatures = scalpAlphaFeatures(ctx, index, 1, alphaFacts);
    const alphaSellFeatures = scalpAlphaFeatures(ctx, index, -1, alphaFacts);
    const buyIntelligence = intelligenceModel ? intelligenceScore(ctx, index, 1, combo, intelFacts, alphaBuyFeatures) : null;
    const sellIntelligence = intelligenceModel ? intelligenceScore(ctx, index, -1, combo, intelFacts, alphaSellFeatures) : null;
    const alphaBuy = alphaScoreForCombo(alphaBuyFeatures, combo, 1, buyIntelligence);
    const alphaSell = alphaScoreForCombo(alphaSellFeatures, combo, -1, sellIntelligence);
    const vwapDistanceR = Math.abs(bar.close - ctx.vwap[index]) / Math.max(ctx.atr[index], 0.01);
    const vwapDistanceOk = combo.maxVwapAtr <= 0 || vwapDistanceR <= combo.maxVwapAtr;
    const bullConfRising = !combo.requireConfRising || (current.bullPct > previous.bullPct && bullEdge >= (previous.bullPct - previous.bearPct));
    const bearConfRising = !combo.requireConfRising || (current.bearPct > previous.bearPct && bearEdge >= (previous.bearPct - previous.bullPct));
    const { buy, sell } = playbookSignal(ctx, index, combo, {
      current,
      previous,
      bullEdge,
      bearEdge,
      atrRatio,
      er,
      flow,
      buyCross,
      sellCross,
      bullScoreCross,
      bearScoreCross,
      volumeOk,
      common,
      alphaBuy,
      alphaSell,
    });
    const costPerShare = bar.close * ((combo.spreadBps || 0) + 2 * (combo.slippageBps || 0)) / 10000;
    const targetR = targetRForCombo(ctx, index, combo);
    const risk = Math.max(ctx.atr[index] * 1.5, 0.01);
    const moveToCostOk = !combo.minMoveToCost || costPerShare <= 0 || (risk * targetR) / costPerShare >= combo.minMoveToCost;
    const buyIntelOk = intelligenceMode === 'off' || !buyIntelligence || (!buyIntelligence.badPattern && buyIntelligence.score >= combo.minIntelScore);
    const sellIntelOk = intelligenceMode === 'off' || !sellIntelligence || (!sellIntelligence.badPattern && sellIntelligence.score >= combo.minIntelScore);
    const allowBuy = combo.direction !== 'short' && buyIntelOk && vwapDistanceOk && bullConfRising && openingRangeOk(ctx, index, 1, combo.openingRange) && htfOk(ctx, index, 1, combo.htfMode) && marketAlignmentOk(ctx, index, 1, combo.marketMode) && peerAlignmentOk(ctx, index, 1, combo.peerMode) && gapOk(ctx, index, 1, combo.gapMode) && dailyContextOk(ctx, index, 1, combo.dailyContext) && priorDayLevelOk(ctx, index, 1, combo.pdLevelMode) && moveToCostOk;
    const allowSell = combo.direction !== 'long' && sellIntelOk && vwapDistanceOk && bearConfRising && openingRangeOk(ctx, index, -1, combo.openingRange) && htfOk(ctx, index, -1, combo.htfMode) && marketAlignmentOk(ctx, index, -1, combo.marketMode) && peerAlignmentOk(ctx, index, -1, combo.peerMode) && gapOk(ctx, index, -1, combo.gapMode) && dailyContextOk(ctx, index, -1, combo.dailyContext) && priorDayLevelOk(ctx, index, -1, combo.pdLevelMode) && moveToCostOk;
    const finalBuy = buy && allowBuy;
    const finalSell = sell && allowSell;
    if (finalBuy || finalSell) {
      const dir = finalBuy ? 1 : -1;
      const selectedIntel = dir === 1 ? buyIntelligence : sellIntelligence;
      const selectedFeatures = dir === 1 ? alphaBuyFeatures : alphaSellFeatures;
      const confidence = Math.round(Math.max(current.bullPct, current.bearPct) * 0.60 + (dir === 1 ? alphaBuy : alphaSell) * 0.20 + (selectedIntel?.score ?? Math.max(current.bullPct, current.bearPct)) * 0.20);
      const positionScale = positionScaleForCombo(confidence, combo);
      const shares = Math.floor(capital * positionScale / Math.max(bar.close, 0.01));
      position = {
        dir,
        entry: bar.close,
        entryIndex: index,
        entryTime: bar.time,
        stop: bar.close - dir * risk,
        target: bar.close + dir * risk * targetR,
        risk,
        targetR,
        partialR: combo.partialR,
        trailR: combo.trailR,
        timeStopBars: combo.timeStopBars,
        confidenceDrop: combo.confidenceDrop,
        structureExit: combo.structureExit,
        costPerShare,
        shares,
        notional: shares * bar.close,
        confidence,
        alphaQuality: dir === 1 ? alphaBuy : alphaSell,
        intelligence: selectedIntel,
        features: selectedFeatures,
        positionScale,
        best: bar.close,
        mfe: 0,
        mae: 0,
        mfeR: 0,
        maeR: 0,
        realized: 0,
        remaining: 1,
        partialHit: false,
        move5mR: null,
        move10mR: null,
        move15mR: null,
        move30mR: null,
        move60mR: null,
      };
    }
  }

  const wins = trades.filter((trade) => trade.win);
  const losses = trades.filter((trade) => !trade.win);
  const grossWin = wins.reduce((sum, trade) => sum + trade.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((sum, trade) => sum + trade.pnl, 0));
  const net = trades.reduce((sum, trade) => sum + trade.pnl, 0);
  const grossWinDollars = wins.reduce((sum, trade) => sum + (trade.pnlDollars || 0), 0);
  const grossLossDollars = Math.abs(losses.reduce((sum, trade) => sum + (trade.pnlDollars || 0), 0));
  const netDollars = trades.reduce((sum, trade) => sum + (trade.pnlDollars || 0), 0);
  let equity = 0;
  let peakEquity = 0;
  let maxDrawdownDollars = 0;
  let maxLossStreak = 0;
  let currentLossStreak = 0;
  for (const trade of trades) {
    equity += trade.pnlDollars || 0;
    peakEquity = Math.max(peakEquity, equity);
    maxDrawdownDollars = Math.max(maxDrawdownDollars, peakEquity - equity);
    if (trade.win) currentLossStreak = 0;
    else {
      currentLossStreak += 1;
      maxLossStreak = Math.max(maxLossStreak, currentLossStreak);
    }
  }
  const avg = (field) => trades.length ? trades.reduce((sum, trade) => sum + (trade[field] ?? 0), 0) / trades.length : 0;
  const count = (predicate) => trades.filter(predicate).length;
  return {
    trades: trades.length,
    wins: wins.length,
    losses: losses.length,
    winRate: trades.length ? wins.length / trades.length * 100 : 0,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? 999 : 0),
    net,
    netDollars,
    maxDrawdownDollars,
    maxLossStreak,
    drawdownReturnRatio: maxDrawdownDollars > 0 ? netDollars / maxDrawdownDollars : (netDollars > 0 ? 999 : 0),
    avgDollars: trades.length ? netDollars / trades.length : 0,
    returnOnCapitalPct: capital > 0 ? netDollars / capital * 100 : 0,
    profitFactorDollars: grossLossDollars > 0 ? grossWinDollars / grossLossDollars : (grossWinDollars > 0 ? 999 : 0),
    avgTrade: trades.length ? net / trades.length : 0,
    avgR: avg('pnlR'),
    avgMfeR: avg('mfeR'),
    avgMaeR: avg('maeR'),
    rr1Rate: trades.length ? count((trade) => trade.mfeR >= 1) / trades.length * 100 : 0,
    rr2Rate: trades.length ? count((trade) => trade.mfeR >= 2) / trades.length * 100 : 0,
    rr3Rate: trades.length ? count((trade) => trade.mfeR >= 3) / trades.length * 100 : 0,
    rr5Rate: trades.length ? count((trade) => trade.mfeR >= 5) / trades.length * 100 : 0,
    optionWorthyRate: trades.length ? count((trade) => trade.optionWorthy) / trades.length * 100 : 0,
    greatTradeRate: trades.length ? count((trade) => trade.greatTrade) / trades.length * 100 : 0,
    partialHitRate: trades.length ? count((trade) => trade.partialHit) / trades.length * 100 : 0,
    avgMove5mR: avg('move5mR'),
    avgMove10mR: avg('move10mR'),
    avgMove15mR: avg('move15mR'),
    avgMove30mR: avg('move30mR'),
    avgMove60mR: avg('move60mR'),
    tradeDetails: saveTrades ? trades.map((trade) => ({
      dir: trade.dir,
      side: trade.dir === 1 ? 'long' : 'short',
      entryTime: trade.entryTime,
      exitTime: trade.exitTime,
      entry: trade.entry,
      exit: trade.exit,
      reason: trade.reason,
      shares: trade.shares,
      notional: trade.notional,
      confidence: trade.confidence,
      alphaQuality: trade.alphaQuality,
      intelligence: trade.intelligence,
      features: trade.features,
      positionScale: trade.positionScale,
      risk: trade.risk,
      targetR: trade.targetR,
      pnl: trade.pnl,
      pnlDollars: trade.pnlDollars,
      pnlR: trade.pnlR,
      mfeR: trade.mfeR,
      maeR: trade.maeR,
      partialHit: trade.partialHit,
      optionWorthy: trade.optionWorthy,
      greatTrade: trade.greatTrade,
      move5mR: trade.move5mR,
      move10mR: trade.move10mR,
      move15mR: trade.move15mR,
      move30mR: trade.move30mR,
      move60mR: trade.move60mR,
    })) : undefined,
  };
}

function backtestOld(ctx, combo) {
  const trades = [];
  let position = null;
  for (let index = 80; index < ctx.bars.length; index += 1) {
    const bar = ctx.bars[index];
    if (position) {
      const hitStop = position.dir === 1 ? bar.low <= position.stop : bar.high >= position.stop;
      const hitTarget = position.dir === 1 ? bar.high >= position.target : bar.low <= position.target;
      if (hitStop || hitTarget) {
        const exit = hitStop ? position.stop : position.target;
        const pnl = position.dir * (exit - position.entry);
        trades.push({ ...position, exit, exitTime: bar.time, pnl, win: pnl > 0 });
        position = null;
      }
      if (position) continue;
    }

    const previous = scoreForBar(ctx, index - 1);
    const current = scoreForBar(ctx, index);
    const bullEdge = current.bullPct - current.bearPct;
    const bearEdge = current.bearPct - current.bullPct;
    const atrRatio = ctx.atr50[index] ? ctx.atr[index] / ctx.atr50[index] : 1;
    const er = efficiencyRatio(ctx.closes, 10, index);
    const flow = (bar.close - bar.open) / Math.max(bar.high - bar.low, 0.01);
    const buyCross = ctx.ema9[index] > ctx.ema21[index] && ctx.ema9[index - 1] <= ctx.ema21[index - 1];
    const sellCross = ctx.ema9[index] < ctx.ema21[index] && ctx.ema9[index - 1] >= ctx.ema21[index - 1];
    const bullScoreCross = current.bullPct >= combo.minLead && previous.bullPct < combo.minLead;
    const bearScoreCross = current.bearPct >= combo.minLead && previous.bearPct < combo.minLead;
    const common = atrRatio >= combo.minAtrRatio && ctx.adx[index] >= combo.minAdx && er >= combo.minEr && bar.volume >= ctx.volAvg[index] * combo.volMult;
    const buy = common && (buyCross || bullScoreCross) && bar.close > ctx.ema9[index] && bar.close > ctx.vwap[index] && flow >= 0.05 && current.bullPct >= combo.minLead && bullEdge >= combo.minEdge && current.bullPct >= combo.minConf;
    const sell = common && (sellCross || bearScoreCross) && bar.close < ctx.ema9[index] && bar.close < ctx.vwap[index] && flow <= -0.05 && current.bearPct >= combo.minLead && bearEdge >= combo.minEdge && current.bearPct >= combo.minConf;
    if (buy || sell) {
      const dir = buy ? 1 : -1;
      const risk = Math.max(ctx.atr[index] * 1.5, 0.01);
      position = {
        dir,
        entry: bar.close,
        entryTime: bar.time,
        stop: bar.close - dir * risk,
        target: bar.close + dir * risk * combo.targetR,
        risk,
        confidence: Math.max(current.bullPct, current.bearPct),
      };
    }
  }
  const wins = trades.filter((trade) => trade.win);
  const losses = trades.filter((trade) => !trade.win);
  const grossWin = wins.reduce((sum, trade) => sum + trade.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((sum, trade) => sum + trade.pnl, 0));
  const net = trades.reduce((sum, trade) => sum + trade.pnl, 0);
  return {
    trades: trades.length,
    wins: wins.length,
    losses: losses.length,
    winRate: trades.length ? wins.length / trades.length * 100 : 0,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? 999 : 0),
    net,
    avgTrade: trades.length ? net / trades.length : 0,
  };
}

function score(row) {
  if (row.metrics.trades === 0) return -1e9;
  const m = row.metrics;
  const profile = playbookProfiles[row.combo.playbook] || playbookProfiles.DayTrade;
  const weights = profile.scoreWeights;
  const samplePenalty = m.trades < 10 ? (10 - m.trades) * 12 : 0;
  return m.winRate * weights.winRate
    + Math.min(m.profitFactor, 10) * weights.profitFactor
    + m.net * weights.net
    + (m.avgR || 0) * weights.avgR
    + (m.optionWorthyRate || 0) * weights.optionWorthy
    + (m.greatTradeRate || 0) * weights.greatTrade
    + Math.min(m.drawdownReturnRatio || 0, 10) * 2
    - (m.avgMaeR || 0) * weights.mae
    - (m.maxLossStreak || 0) * 3
    - Math.min((m.maxDrawdownDollars || 0) / 1000, 50)
    - samplePenalty;
}

const allCombos = comboFile
  ? JSON.parse(readFileSync(comboFile, 'utf8'))
  : [...combos()];
console.log(`Local run ${runId}: ${symbols.length} symbols x ${allCombos.length} combos on ${interval}/${range}`);

const marketRefs = {};
for (const ref of ['SPY', 'QQQ', 'SMH', 'BTC-USD', 'TSLA']) {
  try {
    const bars = await fetchBars(ref);
    marketRefs[ref] = prepare(bars);
  } catch (error) {
    console.error(`${ref} market ref unavailable: ${error.message}`);
  }
}

const byCombo = new Map();
const routeMap = new Map();
function collectRow(row) {
  const key = JSON.stringify(row.combo);
  const item = byCombo.get(key) || { combo: row.combo, symbols: new Set(), rows: 0, trades: 0, winRate: 0, profitFactor: 0, net: 0, netDollars: 0, returnOnCapitalPct: 0, avgDollars: 0, avgTrade: 0, avgR: 0, avgMfeR: 0, avgMaeR: 0, rr2Rate: 0, rr3Rate: 0, optionWorthyRate: 0, greatTradeRate: 0, score: 0 };
  item.symbols.add(row.symbol);
  item.rows += 1;
  item.trades += row.metrics.trades;
  item.winRate += row.metrics.winRate;
  item.profitFactor += Math.min(row.metrics.profitFactor, 20);
  item.net += row.metrics.net;
  item.netDollars += row.metrics.netDollars || 0;
  item.returnOnCapitalPct += row.metrics.returnOnCapitalPct || 0;
  item.avgDollars += row.metrics.avgDollars || 0;
  item.avgTrade += row.metrics.avgTrade;
  item.avgR += row.metrics.avgR || 0;
  item.avgMfeR += row.metrics.avgMfeR || 0;
  item.avgMaeR += row.metrics.avgMaeR || 0;
  item.rr2Rate += row.metrics.rr2Rate || 0;
  item.rr3Rate += row.metrics.rr3Rate || 0;
  item.optionWorthyRate += row.metrics.optionWorthyRate || 0;
  item.greatTradeRate += row.metrics.greatTradeRate || 0;
  item.score += row.score;
  item.maxDrawdownDollars = (item.maxDrawdownDollars || 0) + (row.metrics.maxDrawdownDollars || 0);
  item.maxLossStreak = (item.maxLossStreak || 0) + (row.metrics.maxLossStreak || 0);
  byCombo.set(key, item);

  const routeKey = `${row.symbol}|${row.combo.session}|${row.combo.direction}`;
  const current = routeMap.get(routeKey);
  if (!current || row.score > current.score) routeMap.set(routeKey, row);
}

for (const symbol of symbols) {
  try {
    const bars = await fetchBars(symbol);
    const ctx = prepare(bars);
    ctx.marketRefs = marketRefs;
    ctx.peerRefs = marketRefs;
    ctx.symbol = symbol;
    console.log(`${symbol}: ${bars.length} bars`);
    for (const combo of allCombos) {
      if (combo.symbolFilter && combo.symbolFilter !== symbol) continue;
      const metrics = backtest(ctx, combo);
      const tradeDetails = metrics.tradeDetails || [];
      delete metrics.tradeDetails;
      const row = { runId, timestamp: new Date().toISOString(), source: 'local-yahoo', symbol, interval, range, sample, trainPct, capital, bars: bars.length, combo, metrics };
      row.score = score(row);
      collectRow(row);
      appendFileSync(runPath, `${JSON.stringify(row)}\n`);
      if (saveTrades && tradeDetails.length > 0) {
        for (const trade of tradeDetails) {
          appendFileSync(tradeLogPath, `${JSON.stringify({
            runId,
            timestamp: row.timestamp,
            source: row.source,
            symbol,
            interval,
            range,
            sample,
            trainPct,
            capital,
            combo,
            trade,
          })}\n`);
        }
      }
    }
  } catch (error) {
    console.error(`${symbol}: ${error.message}`);
  }
}

const summary = [...byCombo.values()].map((item) => ({
  combo: item.combo,
  symbols: item.symbols.size,
  rows: item.rows,
  totalTrades: item.trades,
  avgWinRate: item.winRate / item.rows,
  avgProfitFactor: item.profitFactor / item.rows,
  totalNet: item.net,
  totalNetDollars: item.netDollars,
  avgMaxDrawdownDollars: (item.maxDrawdownDollars || 0) / item.rows,
  avgMaxLossStreak: (item.maxLossStreak || 0) / item.rows,
  avgReturnOnCapitalPct: item.returnOnCapitalPct / item.rows,
  avgDollars: item.avgDollars / item.rows,
  avgTrade: item.avgTrade / item.rows,
  avgR: item.avgR / item.rows,
  avgMfeR: item.avgMfeR / item.rows,
  avgMaeR: item.avgMaeR / item.rows,
  rr2Rate: item.rr2Rate / item.rows,
  rr3Rate: item.rr3Rate / item.rows,
  optionWorthyRate: item.optionWorthyRate / item.rows,
  greatTradeRate: item.greatTradeRate / item.rows,
  avgScore: item.score / item.rows,
})).sort((a, b) => b.avgScore - a.avgScore);

const routingLeaderboard = [...routeMap.values()]
  .filter((row) => row.metrics.trades >= 8 && row.metrics.netDollars > 0 && row.metrics.profitFactor >= 1.2)
  .map((row) => ({
    symbol: row.symbol,
    session: row.combo.session,
    direction: row.combo.direction,
    trades: row.metrics.trades,
    winRate: row.metrics.winRate,
    profitFactor: row.metrics.profitFactor,
    netDollars: row.metrics.netDollars,
    avgDollars: row.metrics.avgDollars,
    avgR: row.metrics.avgR,
    score: row.score,
    combo: row.combo,
  }))
  .sort((a, b) => b.score - a.score);

const liveWhitelist = routingLeaderboard
  .filter((row) => row.trades >= 10 && row.winRate >= 65 && row.netDollars > 0)
  .slice(0, 50);

const qualifiedGlobalCandidate = summary.find((row) => row.symbols >= minSymbols && row.totalTrades >= minTrades && row.avgProfitFactor >= 1.2 && row.totalNet > 0 && row.totalNetDollars > 0 && row.avgR > 0 && row.optionWorthyRate >= 20) || null;
const candidate = qualifiedGlobalCandidate || summary[0] || null;
const previous = readJson(localBestPath);
const promoted = Boolean(promote && qualifiedGlobalCandidate && qualifiedGlobalCandidate.avgScore > (previous?.avgScore ?? -Infinity));
if (promoted) writeFileSync(localBestPath, `${JSON.stringify({ promotedAt: new Date().toISOString(), runId, sourceRuns: runPath, sourceSummary: summaryPath, interval, range, symbols, ...candidate }, null, 2)}\n`);

const previousPlaybooks = readJson(playbookBestPath)?.playbooks || {};
const nextPlaybooks = { ...previousPlaybooks };
const playbookCandidates = {};
for (const playbook of Object.keys(playbookProfiles)) {
  const profile = playbookProfiles[playbook];
  const rows = summary.filter((row) => row.combo.playbook === playbook);
  const qualifiedPlaybookCandidate = rows.find((row) => (
    row.symbols >= minSymbols
    && row.totalTrades >= Math.max(minTrades, profile.minTrades)
    && row.avgWinRate >= profile.minWinRate
    && row.avgProfitFactor >= profile.minProfitFactor
    && row.totalNet > 0
    && row.totalNetDollars > 0
    && row.avgR > 0
  )) || null;
  const playbookCandidate = qualifiedPlaybookCandidate || rows[0] || null;
  const previousPlaybook = previousPlaybooks[playbook] || null;
  const playbookPromoted = Boolean(promote && qualifiedPlaybookCandidate && qualifiedPlaybookCandidate.avgScore > (previousPlaybook?.avgScore ?? -Infinity));
  playbookCandidates[playbook] = {
    promoted: playbookPromoted,
    candidate: playbookCandidate,
    previous: previousPlaybook,
    criteria: {
      minSymbols,
      minTrades: Math.max(minTrades, profile.minTrades),
      minWinRate: profile.minWinRate,
      minProfitFactor: profile.minProfitFactor,
      requiresPositiveNet: true,
      requiresPositiveAvgR: true,
    },
  };
  if (playbookPromoted) {
    nextPlaybooks[playbook] = {
      promotedAt: new Date().toISOString(),
      runId,
      sourceRuns: runPath,
      sourceSummary: summaryPath,
      interval,
      range,
      symbols,
      ...playbookCandidate,
    };
    appendFileSync(playbookHistoryPath, `${JSON.stringify({ event: 'promoted', playbook, runId, previous: previousPlaybook, champion: nextPlaybooks[playbook] })}\n`);
  } else if (playbookCandidate) {
    appendFileSync(playbookHistoryPath, `${JSON.stringify({ event: 'not_promoted', playbook, runId, candidate: playbookCandidate, previous: previousPlaybook })}\n`);
  }
}

if (promote) {
  writeFileSync(playbookBestPath, `${JSON.stringify({
    updatedAt: new Date().toISOString(),
    runId,
    sourceSummary: summaryPath,
    sourceRuns: runPath,
    playbooks: nextPlaybooks,
  }, null, 2)}\n`);
}

writeFileSync(summaryPath, `${JSON.stringify({
  runId,
  interval,
  range,
  sample,
  trainPct,
  capital,
  symbols,
  playbookProfiles,
  paths: {
    run: runPath,
    trades: saveTrades ? tradeLogPath : null,
    summary: summaryPath,
    localBest: localBestPath,
    playbookBest: playbookBestPath,
  },
  promotion: {
    promoted,
    candidate,
    previous,
    playbooks: playbookCandidates,
  },
  routingLeaderboard: routingLeaderboard.slice(0, 100),
  liveWhitelist,
  summary: summary.slice(0, 100),
}, null, 2)}\n`);

console.log('\nTop 10 local settings:');
for (const row of summary.slice(0, 10)) {
  console.log(`${JSON.stringify(row.combo)} symbols=${row.symbols} trades=${row.totalTrades} win=${row.avgWinRate.toFixed(2)} pf=${row.avgProfitFactor.toFixed(2)} net=$${row.totalNetDollars.toFixed(0)} avg=$${row.avgDollars.toFixed(0)} avgR=${row.avgR.toFixed(3)} opt=${row.optionWorthyRate.toFixed(1)}% score=${row.avgScore.toFixed(2)}`);
}
console.log('\nPlaybook candidates:');
for (const [playbook, record] of Object.entries(playbookCandidates)) {
  const row = record.candidate;
  if (!row) {
    console.log(`${playbook}: no candidate`);
  } else {
    console.log(`${playbook}: ${record.promoted ? 'PROMOTED' : 'kept'} trades=${row.totalTrades} win=${row.avgWinRate.toFixed(2)} pf=${row.avgProfitFactor.toFixed(2)} net=$${row.totalNetDollars.toFixed(0)} avgR=${row.avgR.toFixed(3)} opt=${row.optionWorthyRate.toFixed(1)}%`);
  }
}
console.log(`\nSummary: ${summaryPath}`);
if (saveTrades) console.log(`Trades: ${tradeLogPath}`);
console.log(promoted ? `Promoted local best: ${localBestPath}` : `Local best unchanged: ${localBestPath}`);
console.log(`Playbook champions: ${playbookBestPath}`);
