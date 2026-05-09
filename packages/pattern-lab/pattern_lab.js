#!/usr/bin/env node
import { createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import readline from 'node:readline';
import { basename, dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..', '..');

const paths = {
  ledgers: join(root, 'ledgers'),
  localRuns: join(root, 'optimization-results', 'local-runs'),
  champions: join(root, 'models', 'champions'),
  specialists: join(root, 'models', 'specialists'),
  registry: join(root, 'models', 'registry'),
  patternLab: join(root, 'models', 'pattern-lab'),
  reports: join(root, 'reports'),
  dashboardData: join(root, 'apps', 'dashboard', 'public', 'data'),
  forward: join(root, 'optimization-results', 'forward-tests'),
};

for (const path of Object.values(paths)) mkdirSync(path, { recursive: true });

const args = new Map(process.argv.slice(2).map((arg) => {
  const [key, value = 'true'] = arg.replace(/^--/, '').split('=');
  return [key, value];
}));

const minPatternTrades = Number(args.get('min-pattern-trades') || 5);
const maxClusters = Number(args.get('clusters') || 8);
const maxLedgerLines = Number(args.get('max-ledger-lines') || 200000);
const maxLedgerFiles = Number(args.get('max-ledger-files') || 12);
const maxTotalTrades = Number(args.get('max-total-trades') || 500000);
const externalLedgerDirs = [
  ...(args.get('external-ledgers') || process.env.FUSION_EXTERNAL_LEDGER_DIRS || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean),
];

const featureNames = [
  'volumeQuality',
  'cleanVolume',
  'volumeAcceleration',
  'volumeFlowAgreement',
  'bodyQuality',
  'closeLocation',
  'rejectionWick',
  'emaSlope',
  'priceAcceleration',
  'vwapPressure',
  'vwapExtensionRisk',
  'breakoutQuality',
  'cleanBreakout',
  'failedBreakRisk',
  'trendQuality',
  'chopQuality',
  'relativeVolume',
  'relVolTodQuality',
  'atrExpansion',
  'efficiency',
  'directionalCandle',
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
  'openingDriveQuality',
  'compressionRelease',
  'pullbackReclaim',
  'momentumBurst',
];

function readJson(path, fallback = null) {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(path, payload) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(payload, null, 2)}\n`);
}

async function readJsonl(path) {
  if (!existsSync(path)) return [];
  const rows = [];
  const input = createReadStream(path, { encoding: 'utf8' });
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  let count = 0;
  for await (const line of lines) {
    if (!line.trim()) continue;
    count += 1;
    if (maxLedgerLines > 0 && count > maxLedgerLines) break;
    try {
      rows.push(JSON.parse(line));
    } catch {
      // skip malformed ledger rows
    }
  }
  input.destroy();
  return rows;
}

function filesUnder(dir, predicate = () => true) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    const stats = statSync(path);
    if (stats.isDirectory()) out.push(...filesUnder(path, predicate));
    else if (predicate(path)) out.push(path);
  }
  return out;
}

function newestFirst(files) {
  return files
    .filter((path) => existsSync(path))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
}

function asNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function dateFromTime(value) {
  if (!value) return 'unknown';
  const number = Number(value);
  const ms = Number.isFinite(number) ? (number > 100000000000 ? number : number * 1000) : Date.parse(value);
  if (!Number.isFinite(ms)) return 'unknown';
  return new Date(ms).toISOString().slice(0, 10);
}

function symbolFamily(symbol = '') {
  const clean = String(symbol).toUpperCase();
  if (['NVDA', 'AMD', 'AVGO', 'SMCI', 'SMH', 'INTC', 'ARM', 'MU'].includes(clean)) return 'semis-ai';
  if (['COIN', 'MARA', 'RIOT', 'HOOD', 'BTC-USD', 'ETHA', 'IREN', 'WULF'].includes(clean)) return 'crypto-proxy';
  if (['TSLA', 'RIVN', 'LCID', 'QS', 'NIO', 'F'].includes(clean)) return 'ev-auto';
  if (['QQQ', 'SPY', 'IWM', 'UVXY', 'SLV'].includes(clean)) return 'etf-macro';
  if (['OPEN', 'SOFI', 'PLTR', 'RDDT', 'RBLX', 'AFRM', 'HOOD'].includes(clean)) return 'high-beta-growth';
  if (asNumber(clean.replace(/[^0-9.]/g, ''), NaN) < 5) return 'low-priced';
  return 'general';
}

function normalizeFeatureMap(features = {}) {
  const out = {};
  for (const name of featureNames) out[name] = Math.max(0, Math.min(1, asNumber(features[name], 0)));
  return out;
}

function vector(features) {
  return featureNames.map((name) => features[name] ?? 0);
}

function distance(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length; i += 1) {
    const diff = a[i] - b[i];
    sum += diff * diff;
  }
  return Math.sqrt(sum);
}

function meanVector(rows) {
  if (!rows.length) return Array(featureNames.length).fill(0);
  const sums = Array(featureNames.length).fill(0);
  for (const row of rows) {
    const v = vector(row.features);
    for (let i = 0; i < v.length; i += 1) sums[i] += v[i];
  }
  return sums.map((sum) => sum / rows.length);
}

function meanFeatureMap(rows) {
  const v = meanVector(rows);
  return Object.fromEntries(featureNames.map((name, index) => [name, Number(v[index].toFixed(4))]));
}

function metrics(rows) {
  const wins = rows.filter((row) => row.pnlDollars > 0);
  const grossWin = wins.reduce((sum, row) => sum + row.pnlDollars, 0);
  const grossLoss = Math.abs(rows.filter((row) => row.pnlDollars <= 0).reduce((sum, row) => sum + row.pnlDollars, 0));
  const net = rows.reduce((sum, row) => sum + row.pnlDollars, 0);
  const avg = (field) => rows.length ? rows.reduce((sum, row) => sum + asNumber(row[field], 0), 0) / rows.length : 0;
  return {
    trades: rows.length,
    wins: wins.length,
    losses: rows.length - wins.length,
    winRate: rows.length ? wins.length / rows.length * 100 : 0,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? 999 : 0,
    netDollars: net,
    avgDollars: rows.length ? net / rows.length : 0,
    avgMfeR: avg('mfeR'),
    avgMaeR: avg('maeR'),
    optionWorthyRate: rows.length ? rows.filter((row) => row.optionWorthy).length / rows.length * 100 : 0,
    greatTradeRate: rows.length ? rows.filter((row) => row.greatTrade).length / rows.length * 100 : 0,
  };
}

function topFeatureDifferences(winners, losers, limit = 10) {
  const winMean = meanFeatureMap(winners);
  const lossMean = meanFeatureMap(losers);
  return featureNames
    .map((name) => ({
      feature: name,
      winner: winMean[name],
      loser: lossMean[name],
      edge: Number((winMean[name] - lossMean[name]).toFixed(4)),
    }))
    .sort((a, b) => Math.abs(b.edge) - Math.abs(a.edge))
    .slice(0, limit);
}

function patternTags(row) {
  const f = row.features;
  const tags = [];
  if (row.trigger.includes('vwap') || (f.vwapPressure >= 0.75 && f.pullbackReclaim >= 0.45)) tags.push('clean-vwap-reclaim');
  if (row.trigger.includes('opening') || f.openingDriveQuality >= 0.55) tags.push('opening-drive');
  if (row.trigger.includes('compression') || f.compressionRelease >= 0.55) tags.push('compression-pop');
  if (row.trigger.includes('breakout') || f.cleanBreakout >= 0.70) tags.push('clean-breakout');
  if (row.trigger.includes('volume') || f.relativeVolume >= 0.80 || f.relVolTodQuality >= 0.75) tags.push('volume-expansion');
  if (row.trigger.includes('options') || f.optionBurstShape >= 0.65 || row.mfeR >= 1.5) tags.push('options-worthy-burst');
  if (f.liquiditySweep >= 0.45 || f.stopRunReclaim >= 0.45) tags.push('liquidity-sweep-reclaim');
  if (f.vwapExtensionRisk >= 0.70 && row.maeR > 0.50) tags.push('late-chase-risk');
  if (f.failedBreakRisk >= 0.55 && row.pnlDollars <= 0) tags.push('failed-breakout-risk');
  if (f.volumeQuality >= 0.85 && f.volumeFlowAgreement <= 0.35) tags.push('fake-volume-spike');
  if (!tags.length) tags.push('unclassified');
  return tags;
}

function normalizeTrade(row, sourcePath) {
  const trade = row.trade || row;
  const combo = row.combo || trade.combo || {};
  const symbol = String(row.symbol || trade.symbol || combo.symbolFilter || '').toUpperCase();
  if (!symbol) return null;
  const pnlDollars = asNumber(trade.pnlDollars, NaN);
  if (!Number.isFinite(pnlDollars)) return null;
  const features = normalizeFeatureMap(trade.features || row.features || {});
  const side = trade.side || (trade.dir === 1 ? 'long' : trade.dir === -1 ? 'short' : row.side || 'unknown');
  const trigger = String(combo.triggerMode || trade.triggerMode || row.triggerMode || 'unknown').toLowerCase();
  const session = String(combo.session || trade.session || row.session || 'all').toLowerCase();
  const date = dateFromTime(trade.entryTime || row.entryTime || trade.receivedAt || row.receivedAt);
  const source = relative(root, sourcePath).startsWith('..') ? `external/${basename(sourcePath)}` : relative(root, sourcePath);
  const normalized = {
    source,
    symbol,
    family: symbolFamily(symbol),
    side: String(side).toLowerCase(),
    trigger,
    session,
    date,
    pnlDollars,
    win: pnlDollars > 0,
    mfeR: asNumber(trade.mfeR, 0),
    maeR: asNumber(trade.maeR, 0),
    confidence: asNumber(trade.confidence || row.confidence, 0),
    alphaQuality: asNumber(trade.alphaQuality || row.alphaQuality, 0),
    targetR: asNumber(trade.targetR || combo.targetR, 0),
    optionWorthy: Boolean(trade.optionWorthy || asNumber(trade.mfeR, 0) >= 1.5 && asNumber(trade.maeR, 0) <= 0.75),
    greatTrade: Boolean(trade.greatTrade || asNumber(trade.mfeR, 0) >= 2 && asNumber(trade.maeR, 0) <= 0.75),
    features,
  };
  normalized.tags = patternTags(normalized);
  return normalized;
}

async function loadTrades() {
  const rows = [];
  const ledgerFiles = filesUnder(paths.ledgers, (path) => path.endsWith('.jsonl'));
  ledgerFiles.push(...filesUnder(paths.localRuns, (path) => path.endsWith('-trades.jsonl')));
  for (const dir of externalLedgerDirs) {
    ledgerFiles.push(...filesUnder(dir, (path) => path.endsWith('.jsonl')));
  }
  const selectedLedgerFiles = newestFirst(ledgerFiles).slice(0, maxLedgerFiles);
  for (const path of selectedLedgerFiles) {
    for (const row of await readJsonl(path)) {
      const normalized = normalizeTrade(row, path);
      if (normalized) rows.push(normalized);
      if (maxTotalTrades > 0 && rows.length >= maxTotalTrades) return rows;
    }
  }

  const championFiles = filesUnder(paths.champions, (path) => path.endsWith('.json'));
  for (const path of championFiles) {
    const json = readJson(path, {});
    for (const variant of Object.values(json.variants || {})) {
      for (const trade of variant?.portfolio?.trades || []) {
        const normalized = normalizeTrade(trade, path);
        if (normalized) rows.push(normalized);
        if (maxTotalTrades > 0 && rows.length >= maxTotalTrades) return rows;
      }
    }
  }

  const forwardFiles = filesUnder(paths.forward, (path) => path.endsWith('.jsonl'));
  for (const path of forwardFiles) {
    for (const row of await readJsonl(path)) {
      const normalized = normalizeTrade(row, path);
      if (normalized) rows.push({ ...normalized, forward: true });
      if (maxTotalTrades > 0 && rows.length >= maxTotalTrades) return rows;
    }
  }
  return rows;
}

function groupBy(rows, keyFn) {
  const map = new Map();
  for (const row of rows) {
    const key = keyFn(row);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(row);
  }
  return map;
}

function kmeans(rows, k) {
  if (!rows.length) return [];
  const count = Math.min(k, rows.length);
  let centers = Array.from({ length: count }, (_, index) => vector(rows[Math.floor(index * rows.length / count)].features));
  let assignments = Array(rows.length).fill(0);
  for (let iter = 0; iter < 10; iter += 1) {
    assignments = rows.map((row) => {
      const v = vector(row.features);
      let best = 0;
      let bestDistance = Infinity;
      for (let i = 0; i < centers.length; i += 1) {
        const d = distance(v, centers[i]);
        if (d < bestDistance) {
          bestDistance = d;
          best = i;
        }
      }
      return best;
    });
    centers = centers.map((_, centerIndex) => {
      const members = rows.filter((__, rowIndex) => assignments[rowIndex] === centerIndex);
      return members.length ? meanVector(members) : centers[centerIndex];
    });
  }
  return centers.map((center, index) => {
    const members = rows.filter((__, rowIndex) => assignments[rowIndex] === index);
    const rankedFeatures = featureNames
      .map((name, featureIndex) => ({ feature: name, value: Number(center[featureIndex].toFixed(4)) }))
      .sort((a, b) => b.value - a.value)
      .slice(0, 8);
    return {
      id: `cluster-${index + 1}`,
      metrics: metrics(members),
      dominantFeatures: rankedFeatures,
      topTags: [...groupBy(members.flatMap((row) => row.tags.map((tag) => ({ tag }))), (row) => row.tag)]
        .map(([tag, tagged]) => ({ tag, count: tagged.length }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 5),
      prototype: Object.fromEntries(featureNames.map((name, featureIndex) => [name, Number(center[featureIndex].toFixed(4))])),
    };
  }).filter((cluster) => cluster.metrics.trades > 0);
}

function routeKey(row) {
  return [row.symbol, row.family, row.trigger, row.session, row.side].join('|');
}

function buildPatternSummaries(rows) {
  const byTag = [...groupBy(rows.flatMap((row) => row.tags.map((tag) => ({ ...row, tag }))), (row) => row.tag)]
    .map(([tag, taggedRows]) => ({
      tag,
      metrics: metrics(taggedRows),
      winnerPrototype: meanFeatureMap(taggedRows.filter((row) => row.win)),
      loserPrototype: meanFeatureMap(taggedRows.filter((row) => !row.win)),
      edges: topFeatureDifferences(taggedRows.filter((row) => row.win), taggedRows.filter((row) => !row.win), 8),
    }))
    .sort((a, b) => b.metrics.netDollars - a.metrics.netDollars);

  const byRoute = [...groupBy(rows, routeKey)]
    .map(([key, routeRows]) => {
      const [symbol, family, trigger, session, side] = key.split('|');
      return {
        key,
        symbol,
        family,
        trigger,
        session,
        side,
        metrics: metrics(routeRows),
        topTags: [...groupBy(routeRows.flatMap((row) => row.tags.map((tag) => ({ tag }))), (row) => row.tag)]
          .map(([tag, tagged]) => ({ tag, count: tagged.length }))
          .sort((a, b) => b.count - a.count)
          .slice(0, 5),
        winnerPrototype: meanFeatureMap(routeRows.filter((row) => row.win)),
        loserPrototype: meanFeatureMap(routeRows.filter((row) => !row.win)),
        edges: topFeatureDifferences(routeRows.filter((row) => row.win), routeRows.filter((row) => !row.win), 8),
      };
    })
    .sort((a, b) => b.metrics.netDollars - a.metrics.netDollars);

  return { byTag, byRoute };
}

function generateSpecialistCandidates(patterns) {
  return patterns.byRoute
    .filter((route) => route.metrics.trades >= minPatternTrades)
    .filter((route) => route.metrics.winRate >= 68)
    .filter((route) => route.metrics.netDollars > 0)
    .filter((route) => route.metrics.avgMaeR <= 0.85 || route.metrics.avgMfeR >= 1.2)
    .slice(0, 120)
    .map((route, index) => {
      const positiveEdges = route.edges.filter((edge) => edge.edge > 0).slice(0, 5);
      const avoidEdges = route.edges.filter((edge) => edge.edge < 0).slice(0, 5);
      return {
        id: `pattern-specialist-${String(index + 1).padStart(3, '0')}`,
        status: route.metrics.trades >= 20 && route.metrics.winRate >= 80 && route.metrics.profitFactor >= 2 ? 'candidate-promotable' : 'watchlist',
        routeKey: route.key,
        symbol: route.symbol,
        family: route.family,
        triggerMode: route.trigger,
        session: route.session,
        side: route.side,
        metrics: route.metrics,
        preferredTags: route.topTags.map((item) => item.tag),
        featureBoosts: positiveEdges,
        avoidPatterns: avoidEdges,
        suggestedRules: {
          minConfidence: route.metrics.winRate >= 85 ? 70 : 75,
          minAlphaQuality: route.metrics.avgMaeR <= 0.45 ? 55 : 65,
          targetR: route.metrics.avgMfeR >= 1.5 ? 0.75 : route.metrics.avgMfeR >= 1.0 ? 0.50 : 0.35,
          requireNoAvoidPattern: true,
        },
      };
    });
}

function dailyPerformance(rows) {
  return [...groupBy(rows, (row) => [row.date, row.trigger, row.family].join('|'))]
    .map(([key, group]) => {
      const [date, trigger, family] = key.split('|');
      return { date, specialist: trigger, family, metrics: metrics(group) };
    })
    .sort((a, b) => a.date.localeCompare(b.date) || b.metrics.netDollars - a.metrics.netDollars);
}

const trades = await loadTrades();
const winners = trades.filter((row) => row.win);
const losers = trades.filter((row) => !row.win);
const patterns = buildPatternSummaries(trades);
const candidates = generateSpecialistCandidates(patterns);
const clusters = {
  winners: kmeans(winners, maxClusters),
  losers: kmeans(losers, maxClusters),
  all: kmeans(trades, maxClusters),
};

const report = {
  updatedAt: new Date().toISOString(),
  source: 'pattern-lab-v1',
  config: {
    minPatternTrades,
    maxClusters,
    maxLedgerLines,
    maxLedgerFiles,
    maxTotalTrades,
    externalLedgerDirs: externalLedgerDirs.length ? [`${externalLedgerDirs.length} external ledger director${externalLedgerDirs.length === 1 ? 'y' : 'ies'}`] : [],
    featureCount: featureNames.length,
  },
  data: {
    trades: trades.length,
    winners: winners.length,
    losers: losers.length,
    sources: [...new Set(trades.map((row) => row.source))].slice(0, 200),
  },
  global: {
    metrics: metrics(trades),
    winnerPrototype: meanFeatureMap(winners),
    loserPrototype: meanFeatureMap(losers),
    strongestFeatureEdges: topFeatureDifferences(winners, losers, 15),
  },
  patterns,
  clusters,
  specialistCandidates: candidates,
  dailyPerformance: dailyPerformance(trades).slice(-400),
};

writeJson(join(paths.patternLab, 'current-pattern-lab.json'), report);
writeJson(join(paths.specialists, 'pattern-specialist-candidates.json'), {
  updatedAt: report.updatedAt,
  source: 'pattern-lab-v1',
  candidates,
});
writeJson(join(paths.reports, 'pattern-lab-report.json'), report);
writeJson(join(paths.dashboardData, 'pattern-lab.json'), report);
writeJson(join(paths.registry, 'pattern-lab-registry.json'), {
  updatedAt: report.updatedAt,
  candidateCount: candidates.length,
  promotableCount: candidates.filter((candidate) => candidate.status === 'candidate-promotable').length,
  topCandidates: candidates.slice(0, 25),
});

console.log('Pattern Lab complete');
console.log(`Trades=${report.data.trades} winners=${report.data.winners} losers=${report.data.losers}`);
console.log(`Pattern candidates=${candidates.length}, promotable=${candidates.filter((candidate) => candidate.status === 'candidate-promotable').length}`);
console.log(`Report: ${join(paths.reports, 'pattern-lab-report.json')}`);
