#!/usr/bin/env node
import { createReadStream, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const playbooksDir = join(root, 'optimization-results', 'models', 'playbooks');
if (!existsSync(playbooksDir)) mkdirSync(playbooksDir, { recursive: true });

const args = new Map(process.argv.slice(2).map((arg) => {
  const [key, value = 'true'] = arg.replace(/^--/, '').split('=');
  return [key, value];
}));

const trainSummaryPath = args.get('train-summary');
const testSummaryPath = args.get('test-summary');
const stressSummaryPath = args.get('stress-summary');
if (!trainSummaryPath || !testSummaryPath) {
  throw new Error('Usage: node scripts/validate_scalp_routes.js --train-summary=<path> --test-summary=<path>');
}

const minTrainTrades = Number(args.get('min-train-trades') || 8);
const minTestTrades = Number(args.get('min-test-trades') || 3);
const minTrainWin = Number(args.get('min-train-win') || 65);
const minTestWin = Number(args.get('min-test-win') || 60);
const minProfitFactor = Number(args.get('min-profit-factor') || 1.1);
const projectionCapital = Number(args.get('projection-capital') || 10000);
const feedbackHistoryPath = join(root, 'optimization-results', 'morning-feedback', 'morning-feedback-history.jsonl');

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function comboKey(symbol, combo) {
  return `${symbol}|${JSON.stringify(combo)}`;
}

function routeKey(row) {
  return `${row.symbol}|${row.combo.session}|${row.combo.direction}`;
}

function compactMetrics(metrics) {
  return {
    trades: metrics.trades,
    winRate: metrics.winRate,
    profitFactor: metrics.profitFactor,
    netDollars: metrics.netDollars || 0,
    avgDollars: metrics.avgDollars || 0,
    avgR: metrics.avgR || 0,
    maxDrawdownDollars: metrics.maxDrawdownDollars || 0,
    maxLossStreak: metrics.maxLossStreak || 0,
  };
}

const families = {
  semis: new Set(['NVDA', 'AMD', 'AVGO', 'SMCI', 'MU', 'INTC', 'ARM', 'QCOM', 'MRVL', 'ON', 'AMAT', 'LRCX', 'KLAC', 'ASML', 'TSM', 'SMH', 'SOXL', 'SOXS']),
  crypto: new Set(['COIN', 'MARA', 'RIOT', 'CLSK', 'WULF', 'CIFR', 'BTBT', 'HIVE', 'IREN', 'CAN', 'MSTR', 'CONL', 'MSTX', 'MSTU']),
  ev: new Set(['TSLA', 'RIVN', 'LCID', 'NIO', 'XPEV', 'LI', 'QS', 'CHPT', 'BLNK', 'WKHS']),
  softwareAi: new Set(['PLTR', 'AI', 'PATH', 'IONQ', 'RGTI', 'QBTS', 'CRM', 'ADBE', 'NOW', 'MDB', 'SNOW', 'DDOG', 'NET', 'CRWD', 'PANW', 'ZS', 'OKTA']),
  leveragedEtf: new Set(['TQQQ', 'SQQQ', 'SOXL', 'SOXS', 'UVXY', 'LABU', 'LABD', 'TSLL', 'NVDL']),
  pennyMeme: new Set(['OPEN', 'AMC', 'GME', 'KOSS', 'HOLO', 'BNGO', 'OCGN', 'PROK', 'SNDL', 'TLRY', 'CGC', 'ACB', 'BB', 'SPCE', 'FCEL', 'PLUG']),
  travelConsumer: new Set(['CCL', 'NCLH', 'RCL', 'AAL', 'DAL', 'UAL', 'LUV', 'ABNB', 'DASH', 'UBER', 'LYFT', 'DKNG', 'SHOP', 'AFRM']),
  megaCapTech: new Set(['AAPL', 'MSFT', 'AMZN', 'META', 'GOOGL', 'GOOG', 'NFLX', 'ORCL']),
  etf: new Set(['SPY', 'QQQ', 'IWM', 'DIA', 'XLK', 'XLF', 'XLE', 'XBI', 'ARKK', 'TLT', 'HYG', 'GLD', 'SLV', 'USO', 'XLY', 'XLC', 'XLV', 'XLI', 'XLU', 'XLP', 'KRE', 'KWEB', 'FXI', 'EEM', 'EFA', 'XOP', 'TAN', 'HACK', 'IGV', 'IBB']),
};

function symbolFamily(symbol) {
  for (const [family, symbols] of Object.entries(families)) {
    if (symbols.has(symbol)) return family;
  }
  return 'other';
}

function routeQuality(row) {
  const stressWin = row.stress?.winRate ?? row.test.winRate;
  const stressNetOk = row.stress ? row.stress.netDollars > 0 : true;
  const decay = row.recent.trades > 0 ? row.recent.winRate - row.test.winRate : 0;
  return row.test.winRate * 0.9
    + row.recent.winRate * 0.55
    + Math.min(row.test.profitFactor, 12) * 5
    + Math.min(row.test.avgDollars / 10, 80)
    + Math.min(row.test.trades, 30) * 0.9
    + Math.min(stressWin, 100) * 0.2
    + (stressNetOk ? 10 : -35)
    + Math.max(-25, Math.min(25, decay)) * 0.9
    - Math.min(row.test.maxDrawdownDollars / 500, 30)
    - row.test.maxLossStreak * 8;
}

function feedbackBySymbol() {
  if (!existsSync(feedbackHistoryPath)) return new Map();
  const stats = new Map();
  for (const line of readFileSync(feedbackHistoryPath, 'utf8').trim().split('\n').filter(Boolean)) {
    try {
      const record = JSON.parse(line);
      for (const result of record.results || []) {
        if (result.hit == null) continue;
        const item = stats.get(result.symbol) || { picks: 0, hits: 0, clean: 0 };
        item.picks += 1;
        item.hits += result.hit ? 1 : 0;
        item.clean += result.clean ? 1 : 0;
        stats.set(result.symbol, item);
      }
    } catch {
      // ignore malformed history rows
    }
  }
  return new Map([...stats.entries()].map(([symbol, item]) => [symbol, {
    ...item,
    hitRate: item.picks ? item.hits / item.picks * 100 : 0,
    cleanRate: item.picks ? item.clean / item.picks * 100 : 0,
  }]));
}

const feedbackStats = feedbackBySymbol();

function scoreRow(row) {
  const m = row.metrics;
  return (m.winRate || 0) * 1.2
    + Math.min(m.profitFactor || 0, 20) * 8
    + Math.min((m.netDollars || 0) / 1000, 50) * 2
    + Math.min(m.trades || 0, 40) * 0.8
    - Math.min((m.maxDrawdownDollars || 0) / 1000, 50) * 1.4
    - (m.maxLossStreak || 0) * 4;
}

async function readJsonl(path) {
  const rows = [];
  const lines = createInterface({
    input: createReadStream(path, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });
  for await (const line of lines) {
    if (!line) continue;
    rows.push(JSON.parse(line));
  }
  return rows;
}

async function loadRows(summaryPath) {
  const summary = readJson(summaryPath);
  const runPath = summary.paths?.run;
  if (!runPath) throw new Error(`${summaryPath} missing paths.run`);
  return {
    summary,
    rows: await readJsonl(runPath),
  };
}

async function loadTradeBuckets(summary, maxTradesPerCombo = 120) {
  const tradesPath = summary.paths?.trades;
  const buckets = new Map();
  if (!tradesPath || !existsSync(tradesPath)) return buckets;
  const lines = createInterface({
    input: createReadStream(tradesPath, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });
  for await (const line of lines) {
    if (!line) continue;
    const item = JSON.parse(line);
    const key = comboKey(item.symbol, item.combo);
    const list = buckets.get(key) || [];
    list.push(item.trade);
    while (list.length > maxTradesPerCombo) list.shift();
    buckets.set(key, list);
  }
  return buckets;
}

const trainData = await loadRows(trainSummaryPath);
const testData = await loadRows(testSummaryPath);
const trainRows = trainData.rows;
const testRows = testData.rows;
const testTradesByCombo = await loadTradeBuckets(testData.summary);
const testByCombo = new Map(testRows.map((row) => [comboKey(row.symbol, row.combo), row]));
const stressData = stressSummaryPath ? await loadRows(stressSummaryPath) : null;
const stressByCombo = stressData ? new Map(stressData.rows.map((row) => [comboKey(row.symbol, row.combo), row])) : new Map();

function recentMetrics(trades, recentFraction = 0.4) {
  const sorted = [...trades].sort((a, b) => (a.entryTime || 0) - (b.entryTime || 0));
  const recent = sorted.slice(Math.max(0, Math.floor(sorted.length * (1 - recentFraction))));
  const wins = recent.filter((trade) => (trade.pnlDollars || 0) > 0);
  const netDollars = recent.reduce((sum, trade) => sum + (trade.pnlDollars || 0), 0);
  return {
    trades: recent.length,
    winRate: recent.length ? wins.length / recent.length * 100 : 0,
    netDollars,
    avgDollars: recent.length ? netDollars / recent.length : 0,
  };
}

const bestTrainByRoute = new Map();
for (const row of trainRows) {
  if (row.combo.playbook !== 'Scalp') continue;
  const m = row.metrics;
  if (m.trades < minTrainTrades || m.winRate < minTrainWin || m.netDollars <= 0 || m.profitFactor < minProfitFactor) continue;
  const key = routeKey(row);
  const current = bestTrainByRoute.get(key);
  if (!current || scoreRow(row) > scoreRow(current)) bestTrainByRoute.set(key, row);
}

const validated = [];
const rejected = [];
for (const train of bestTrainByRoute.values()) {
  const test = testByCombo.get(comboKey(train.symbol, train.combo));
  if (!test) continue;
  const m = test.metrics;
  const passed = m.trades >= minTestTrades
    && m.winRate >= minTestWin
    && m.netDollars > 0
    && m.profitFactor >= minProfitFactor;
  const item = {
    symbol: train.symbol,
    family: symbolFamily(train.symbol),
    session: train.combo.session,
    direction: train.combo.direction,
    combo: train.combo,
    train: compactMetrics(train.metrics),
    test: compactMetrics(test.metrics),
    stress: stressByCombo.has(comboKey(train.symbol, train.combo)) ? compactMetrics(stressByCombo.get(comboKey(train.symbol, train.combo)).metrics) : null,
    recent: recentMetrics(testTradesByCombo.get(comboKey(train.symbol, train.combo)) || []),
    feedback: feedbackStats.get(train.symbol) || null,
    score: scoreRow(test) + scoreRow(train) * 0.35,
    capital: test.capital || train.capital || 100000,
  };
  item.qualityScore = routeQuality(item);
  if (item.feedback && item.feedback.picks >= 3) {
    item.qualityScore += (item.feedback.hitRate - 60) * 0.35 + (item.feedback.cleanRate - 45) * 0.2;
  }
  (passed ? validated : rejected).push(item);
}

validated.sort((a, b) => b.qualityScore - a.qualityScore);
rejected.sort((a, b) => b.score - a.score);

function aggregate(rows) {
  const trades = rows.reduce((sum, row) => sum + row.test.trades, 0);
  const wins = rows.reduce((sum, row) => sum + row.test.trades * row.test.winRate / 100, 0);
  const netDollars = rows.reduce((sum, row) => sum + row.test.netDollars, 0);
  const sourceCapital = rows[0]?.capital || 100000;
  const projectionScale = sourceCapital > 0 ? projectionCapital / sourceCapital : 0.1;
  const projectedNet = netDollars * projectionScale;
  const avgDrawdown = rows.length ? rows.reduce((sum, row) => sum + row.test.maxDrawdownDollars, 0) / rows.length : 0;
  const avgLossStreak = rows.length ? rows.reduce((sum, row) => sum + row.test.maxLossStreak, 0) / rows.length : 0;
  return {
    routes: rows.length,
    trades,
    winRate: trades ? wins / trades * 100 : 0,
    netDollars,
    avgDollars: trades ? netDollars / trades : 0,
    projectionCapital,
    projectedNet,
    projectedReturnPct: projectionCapital > 0 ? projectedNet / projectionCapital * 100 : 0,
    projectedAvgDollars: trades ? projectedNet / trades : 0,
    avgDrawdown,
    avgLossStreak,
  };
}

const tiers = {
  allValidated: validated,
  highWin: validated.filter((row) => row.test.winRate >= 70 && row.test.trades >= 5),
  elite: validated.filter((row) => row.test.winRate >= 80 && row.test.trades >= 5),
  highSample: validated.filter((row) => row.test.trades >= 10),
};

function bestPerSymbol(rows) {
  const seen = new Set();
  const picked = [];
  for (const row of rows) {
    if (seen.has(row.symbol)) continue;
    seen.add(row.symbol);
    picked.push(row);
  }
  return picked;
}

tiers.bestPerSymbol = bestPerSymbol(validated);
tiers.bestPerSymbolHighWin = bestPerSymbol(tiers.highWin);
tiers.profitFirst = validated.filter((row) => row.test.trades >= 5 && row.test.avgDollars >= 350 && row.test.winRate >= 60);
tiers.profitFirstElite = validated.filter((row) => row.test.trades >= 5 && row.test.avgDollars >= 400 && row.test.winRate >= 75);
tiers.recentStable = validated.filter((row) => row.test.trades >= 5 && row.recent.trades >= 2 && row.recent.winRate >= 60 && row.recent.netDollars > 0);
tiers.recentStableElite = validated.filter((row) => row.test.trades >= 5 && row.test.winRate >= 75 && row.recent.trades >= 2 && row.recent.winRate >= 75 && row.recent.netDollars > 0);
tiers.recentProfitElite = validated.filter((row) => row.test.trades >= 5 && row.test.winRate >= 75 && row.test.avgDollars >= 400 && row.recent.trades >= 2 && row.recent.winRate >= 75 && row.recent.netDollars > 0);
tiers.stressSurvivors = validated.filter((row) => row.stress && row.test.trades >= 5 && row.test.winRate >= 70 && row.stress.netDollars > 0 && row.stress.profitFactor >= 1.05);
tiers.qualityElite = validated.filter((row) => row.qualityScore >= 185 && row.test.trades >= 5 && row.recent.trades >= 2);

const familyAggregates = {};
for (const family of [...new Set(validated.map((row) => row.family))]) {
  const rows = validated.filter((row) => row.family === family);
  familyAggregates[family] = aggregate(rows);
}

const payload = {
  updatedAt: new Date().toISOString(),
  trainSummaryPath,
  testSummaryPath,
  stressSummaryPath: stressSummaryPath || null,
  thresholds: { minTrainTrades, minTestTrades, minTrainWin, minTestWin, minProfitFactor },
  aggregates: Object.fromEntries(Object.entries(tiers).map(([name, rows]) => [name, aggregate(rows)])),
  familyAggregates,
  validated,
  rejected,
};

const out = join(playbooksDir, 'current-walk-forward-scalp-routes.json');
const liveOut = join(playbooksDir, 'current-live-scalp-champions.json');
writeFileSync(out, `${JSON.stringify(payload, null, 2)}\n`);
writeFileSync(liveOut, `${JSON.stringify({
  updatedAt: payload.updatedAt,
  source: out,
  best: {
    name: 'walk_forward_validated_routes',
    test: payload.aggregates.allValidated,
    highWin: payload.aggregates.highWin,
    elite: payload.aggregates.elite,
    highSample: payload.aggregates.highSample,
  },
  routes: validated.slice(0, 100),
}, null, 2)}\n`);

console.log(`Validated routes saved: ${out}`);
console.log(`Live scalp champions saved: ${liveOut}`);
for (const [name, metrics] of Object.entries(payload.aggregates)) {
  console.log(`${name}: routes=${metrics.routes} trades=${metrics.trades} win=${metrics.winRate.toFixed(2)} net=$${metrics.netDollars.toFixed(0)} avg=$${metrics.avgDollars.toFixed(0)}`);
}
