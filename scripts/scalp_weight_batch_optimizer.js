#!/usr/bin/env node
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const outDir = join(root, 'optimization-results');
const playbooksDir = join(outDir, 'models', 'playbooks');
const weightsDir = join(playbooksDir, 'weight-sets');
for (const dir of [playbooksDir, weightsDir]) if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

const args = new Map(process.argv.slice(2).map((arg) => {
  const [key, value = 'true'] = arg.replace(/^--/, '').split('=');
  return [key, value];
}));

const runId = new Date().toISOString().replace(/[:.]/g, '-');
const candidates = Number(args.get('candidates') || 48);
const maxSymbols = Number(args.get('max-symbols') || 80);
const interval = args.get('interval') || '5m';
const range = args.get('range') || '60d';
const capital = Number(args.get('capital') || 100000);
const projectionCapital = Number(args.get('projection-capital') || 10000);
const stress = args.get('stress') === 'true';
const quick = args.get('quick') !== 'false';
const micro = args.get('micro') === 'true';
const championPath = join(playbooksDir, 'current-trigger-champion.json');
const currentChampion = existsSync(championPath) ? JSON.parse(readFileSync(championPath, 'utf8')).champion : null;
const symbolFile = args.get('symbol-file');
const defaultSymbols = currentChampion?.acceptedTrades?.length
  ? [...new Set(currentChampion.acceptedTrades.map((trade) => trade.symbol))].sort()
  : ['NVDA', 'TSLA', 'AMD', 'PLTR', 'COIN', 'HOOD', 'SOFI', 'AFRM', 'IONQ', 'NOK', 'OPEN', 'AAL', 'LUV', 'CRSP', 'ONDS', 'QQQ', 'SPY'];
const symbolSource = args.get('symbols')
  || (symbolFile && existsSync(symbolFile) ? readFileSync(symbolFile, 'utf8') : defaultSymbols.join(','));
const symbols = symbolSource
  .split(/[\s,]+/)
  .map((symbol) => symbol.trim().toUpperCase())
  .filter(Boolean)
  .filter((symbol, index, all) => all.indexOf(symbol) === index)
  .slice(0, maxSymbols > 0 ? maxSymbols : undefined);

const baseWeights = {
  'volume-shock:long': {
    bodyQuality: 0.13, closeLocation: 0.12, directionalCandle: 0.12, flowQuality: 0.14,
    cleanVolume: 0.12, volumeAcceleration: 0.09, volumeFlowAgreement: 0.14, momentumBurst: 0.10,
    marketAlignment: 0.08, relativeStrength: 0.08, marketImpulse: 0.06, intradayTrendQuality: 0.06,
    timeEdge: 0.06, relativeVolume: 0.04, volumeQuality: -0.06, rejectionWick: -0.09,
    vwapExtensionRisk: -0.12, failedBreakRisk: -0.14,
  },
  'volume-shock:short': {
    bodyQuality: 0.10, closeLocation: 0.10, directionalCandle: 0.11, flowQuality: 0.13,
    cleanVolume: 0.10, volumeFlowAgreement: 0.12, momentumBurst: 0.08, marketAlignment: 0.06,
    volumeQuality: -0.08, rejectionWick: -0.10, vwapExtensionRisk: -0.14, failedBreakRisk: -0.16,
  },
  'options-burst:long': {
    optionBurstShape: 0.16, momentumBurst: 0.15, priceAcceleration: 0.12, atrExpansion: 0.11,
    cleanBreakout: 0.10, rangeExpansionQuality: 0.10, closeLocation: 0.10, flowQuality: 0.09,
    marketAlignment: 0.09, relativeStrength: 0.08, marketImpulse: 0.07, priorDayBreakQuality: 0.06,
    timeEdge: 0.08, trendQuality: 0.07, vwapExtensionRisk: -0.10, failedBreakRisk: -0.15,
    rejectionWick: -0.08,
  },
  'options-burst:short': {
    optionBurstShape: 0.14, momentumBurst: 0.13, priceAcceleration: 0.11, atrExpansion: 0.10,
    cleanBreakout: 0.09, closeLocation: 0.10, flowQuality: 0.08, marketAlignment: 0.07,
    timeEdge: 0.06, trendQuality: 0.06, vwapExtensionRisk: -0.12, failedBreakRisk: -0.16,
    rejectionWick: -0.09,
  },
  'momentum-acceleration:long': {
    priceAcceleration: 0.15, emaSlope: 0.13, momentumBurst: 0.13, flowQuality: 0.12,
    closeLocation: 0.11, directionalCandle: 0.10, trendQuality: 0.09, marketAlignment: 0.08,
    relativeStrength: 0.09, marketImpulse: 0.08, intradayTrendQuality: 0.08,
    cleanVolume: 0.07, vwapPressure: 0.06, failedBreakRisk: -0.12, vwapExtensionRisk: -0.10,
  },
  'momentum-acceleration:short': {
    priceAcceleration: 0.13, emaSlope: 0.12, momentumBurst: 0.12, flowQuality: 0.11,
    closeLocation: 0.10, directionalCandle: 0.09, trendQuality: 0.08, marketAlignment: 0.07,
    cleanVolume: 0.06, vwapPressure: 0.05, failedBreakRisk: -0.13, vwapExtensionRisk: -0.11,
  },
  'opening-range:long': {
    cleanBreakout: 0.15, rangeExpansionQuality: 0.10, breakoutQuality: 0.13, closeLocation: 0.12,
    cleanVolume: 0.10, volumeFlowAgreement: 0.10, marketAlignment: 0.09, relativeStrength: 0.07,
    priorDayBreakQuality: 0.08, timeEdge: 0.08, atrExpansion: 0.08, trendQuality: 0.07,
    failedBreakRisk: -0.17, rejectionWick: -0.10, vwapExtensionRisk: -0.08,
  },
  'opening-range:short': {
    cleanBreakout: 0.13, breakoutQuality: 0.12, closeLocation: 0.11, cleanVolume: 0.09,
    volumeFlowAgreement: 0.09, marketAlignment: 0.07, timeEdge: 0.07, atrExpansion: 0.07,
    trendQuality: 0.06, failedBreakRisk: -0.18, rejectionWick: -0.11, vwapExtensionRisk: -0.09,
  },
  'liquidity-sweep:long': {
    liquiditySweep: 0.20, stopRunReclaim: 0.18, closeLocation: 0.12, flowQuality: 0.10,
    rejectionWick: 0.10, relativeStrength: 0.08, vwapPressure: 0.07,
    failedBreakRisk: -0.16, vwapExtensionRisk: -0.08,
  },
  'liquidity-sweep:short': {
    liquiditySweep: 0.20, stopRunReclaim: 0.18, closeLocation: 0.12, flowQuality: 0.10,
    rejectionWick: 0.10, vwapPressure: 0.06, failedBreakRisk: -0.16, vwapExtensionRisk: -0.08,
  },
  'compression-pop:long': {
    compressionRelease: 0.16, rangeExpansionQuality: 0.14, cleanBreakout: 0.12,
    volumeFlowAgreement: 0.12, relVolTodQuality: 0.10, closeLocation: 0.10,
    marketAlignment: 0.08, vwapExtensionRisk: -0.10, failedBreakRisk: -0.14,
  },
  'compression-pop:short': {
    compressionRelease: 0.16, rangeExpansionQuality: 0.14, cleanBreakout: 0.12,
    volumeFlowAgreement: 0.12, relVolTodQuality: 0.10, closeLocation: 0.10,
    marketAlignment: 0.07, vwapExtensionRisk: -0.11, failedBreakRisk: -0.15,
  },
  'relative-strength-reclaim:long': {
    relativeStrength: 0.18, marketAlignment: 0.12, vwapPressure: 0.12, pullbackReclaim: 0.11,
    closeLocation: 0.10, flowQuality: 0.10, trendQuality: 0.08, failedBreakRisk: -0.13,
    vwapExtensionRisk: -0.10,
  },
  'relative-strength-reclaim:short': {
    relativeStrength: 0.15, marketAlignment: 0.10, vwapPressure: 0.10, pullbackReclaim: 0.10,
    closeLocation: 0.10, flowQuality: 0.09, trendQuality: 0.08, failedBreakRisk: -0.14,
    vwapExtensionRisk: -0.11,
  },
  'trend-pullback-burst:long': {
    trendQuality: 0.14, pullbackReclaim: 0.13, emaSlope: 0.12, flowQuality: 0.10,
    priceAcceleration: 0.10, volumeFlowAgreement: 0.09, closeLocation: 0.09,
    vwapExtensionRisk: -0.12, failedBreakRisk: -0.12,
  },
  'trend-pullback-burst:short': {
    trendQuality: 0.13, pullbackReclaim: 0.12, emaSlope: 0.11, flowQuality: 0.10,
    priceAcceleration: 0.09, volumeFlowAgreement: 0.08, closeLocation: 0.09,
    vwapExtensionRisk: -0.13, failedBreakRisk: -0.13,
  },
  'opening-drive-continuation:long': {
    openingDriveQuality: 0.18, timeEdge: 0.12, trendQuality: 0.11, relativeStrength: 0.10,
    marketImpulse: 0.09, volumeFlowAgreement: 0.10, closeLocation: 0.10, vwapExtensionRisk: -0.12,
  },
  'opening-drive-continuation:short': {
    openingDriveQuality: 0.18, timeEdge: 0.12, trendQuality: 0.11, marketImpulse: 0.09,
    volumeFlowAgreement: 0.10, closeLocation: 0.10, vwapExtensionRisk: -0.12,
  },
};

const genes = [
  { name: 'balanced', scale: {}, blend: { specialist: 0.55, intelligence: 0.45, badPatternPenalty: 18 } },
  { name: 'flow-volume', scale: { flowQuality: 1.2, volumeFlowAgreement: 1.24, cleanVolume: 1.16, volumeAcceleration: 1.18, volumeQuality: 0.68, rejectionWick: 1.18, failedBreakRisk: 1.15 }, blend: { specialist: 0.62, intelligence: 0.38, badPatternPenalty: 22 } },
  { name: 'relative-strength', scale: { relativeStrength: 1.5, marketImpulse: 1.25, intradayTrendQuality: 1.2, dayPositionQuality: 1.15, failedBreakRisk: 1.16 }, blend: { specialist: 0.60, intelligence: 0.40, badPatternPenalty: 24 } },
  { name: 'profit-momentum', scale: { momentumBurst: 1.28, priceAcceleration: 1.2, optionBurstShape: 1.22, atrExpansion: 1.15, relativeStrength: 1.15 }, blend: { specialist: 0.58, intelligence: 0.42, badPatternPenalty: 18 } },
  { name: 'vwap-safe', scale: { vwapPressure: 1.25, vwapExtensionRisk: 1.48, failedBreakRisk: 1.2, closeLocation: 1.12, rejectionWick: 1.18 }, blend: { specialist: 0.62, intelligence: 0.38, badPatternPenalty: 25 } },
  { name: 'break-reclaim', scale: { priorDayBreakQuality: 1.55, priorDayReclaim: 1.35, rangeExpansionQuality: 1.28, cleanBreakout: 1.15, failedBreakRisk: 1.24 }, blend: { specialist: 0.63, intelligence: 0.37, badPatternPenalty: 25 } },
  { name: 'strict-clean', scale: { closeLocation: 1.18, directionalCandle: 1.15, cleanVolume: 1.18, failedBreakRisk: 1.38, vwapExtensionRisk: 1.26, rejectionWick: 1.30 }, blend: { specialist: 0.66, intelligence: 0.34, badPatternPenalty: 30 } },
  { name: 'sweep-reclaim', scale: { liquiditySweep: 1.55, stopRunReclaim: 1.42, rejectionWick: 1.22, pullbackReclaim: 1.18, failedBreakRisk: 1.28, vwapExtensionRisk: 1.10 }, blend: { specialist: 0.64, intelligence: 0.36, badPatternPenalty: 26 } },
  { name: 'compression-release', scale: { compressionRelease: 1.55, rangeExpansionQuality: 1.32, relVolTodQuality: 1.24, cleanBreakout: 1.20, volumeFlowAgreement: 1.16, failedBreakRisk: 1.22 }, blend: { specialist: 0.61, intelligence: 0.39, badPatternPenalty: 24 } },
  { name: 'open-drive', scale: { openingDriveQuality: 1.55, timeEdge: 1.34, trendQuality: 1.18, marketImpulse: 1.18, relativeStrength: 1.14, vwapExtensionRisk: 1.16 }, blend: { specialist: 0.63, intelligence: 0.37, badPatternPenalty: 23 } },
];

function seeded(index) {
  const x = Math.sin(index * 127.1 + 23.77) * 10000;
  return x - Math.floor(x);
}

function mutate(base, gene, index) {
  const out = JSON.parse(JSON.stringify(base));
  for (const family of Object.keys(out)) {
    for (const [name, value] of Object.entries(out[family])) {
      const sign = value < 0 ? -1 : 1;
      const baseAbs = Math.abs(value);
      const geneScale = gene.scale[name] ?? 1;
      const broad = 1 + (seeded(index + name.length * 13 + family.length * 7) - 0.5) * 0.22;
      const micro = 1 + (seeded(index * 3 + name.length) - 0.5) * 0.06;
      out[family][name] = Number((Math.max(0.005, Math.min(0.42, baseAbs * geneScale * broad * micro)) * sign).toFixed(4));
    }
  }
  return out;
}

const sets = {};
const setMeta = [];
for (let index = 0; index < candidates; index += 1) {
  const gene = genes[index % genes.length];
  const setName = `${String(index).padStart(4, '0')}-${gene.name}`;
  const specialist = Number((0.50 + seeded(index + 99) * 0.22).toFixed(3));
  const blend = {
    specialist,
    intelligence: Number((1 - specialist).toFixed(3)),
    badPatternPenalty: Math.round((gene.blend.badPatternPenalty ?? 20) + (seeded(index + 44) - 0.5) * 8),
  };
  sets[setName] = { sourceGene: gene.name, blend, weights: mutate(baseWeights, gene, index) };
  setMeta.push({ setName, gene: gene.name, blend });
}
const weightsPath = join(weightsDir, `batch-${runId}.json`);
writeFileSync(weightsPath, `${JSON.stringify({ createdAt: new Date().toISOString(), optimizer: 'scalp_weight_batch_optimizer', sets }, null, 2)}\n`);
const setNames = Object.keys(sets).join('|');

function runNode(script, scriptArgs, label) {
  console.log(`\n=== ${label} ===`);
  const output = execFileSync('node', [script, ...scriptArgs], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024 * 220,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  process.stdout.write(output.split('\n').slice(-18).join('\n'));
  if (!output.endsWith('\n')) process.stdout.write('\n');
  return output;
}

function summaryPathFrom(output, label) {
  const match = output.match(/Summary: (.*\.json)/);
  if (!match) throw new Error(`${label} missing summary path`);
  return match[1];
}

const quickArgs = quick ? {
  minConf: '65', minAtrRatio: '0.9', minAdx: '14', minEr: '0.10', volMult: '1.2', volumeQuality: 'off|real-expansion', alphaMode: 'specialist-intel',
  minAlphaQuality: '55|65|75', minIntelScore: '45|55|65', targetR: '0.35|0.5|0.75', timeStopBars: '6|9', session: 'open-0930|open-1000|powerhour', triggerMode: 'volume-shock|options-burst|momentum-acceleration|breakout|liquidity-sweep|compression-pop|relative-strength-reclaim|trend-pullback-burst|opening-drive-continuation',
} : {
  minConf: '65|70', minAtrRatio: '0.9|1.0', minAdx: '14|18', minEr: '0.10|0.14', volMult: '1.2|1.5', volumeQuality: 'off|clean|real-expansion', alphaMode: 'specialist-blend|specialist-intel',
  minAlphaQuality: '55|65|75|80', minIntelScore: '45|55|65|75', targetR: '0.35|0.5|0.75', timeStopBars: '6|9', session: 'open-0930|open-1000|powerhour', triggerMode: 'volume-shock|options-burst|momentum-acceleration|opening-range|breakout|liquidity-sweep|compression-pop|relative-strength-reclaim|trend-pullback-burst|opening-drive-continuation',
};
if (micro) {
  quickArgs.minAlphaQuality = args.get('min-alpha-quality') || '55|65';
  quickArgs.minIntelScore = args.get('min-intel-score') || '45|55';
  quickArgs.targetR = args.get('target-r') || '0.35|0.5';
  quickArgs.timeStopBars = args.get('time-stop-bars') || '6';
  quickArgs.session = args.get('session') || 'all';
  quickArgs.triggerMode = args.get('trigger-mode') || 'volume-shock|options-burst';
  quickArgs.volumeQuality = args.get('volume-quality') || 'off';
}

function localArgs(sample, slippage = 1, spread = 2, saveTrades = false) {
  return [
    `--symbols=${symbols.join(',')}`,
    `--interval=${interval}`,
    `--range=${range}`,
    `--capital=${capital}`,
    '--playbook=Scalp',
    `--trigger-mode=${quickArgs.triggerMode}`,
    `--min-conf=${quickArgs.minConf}`,
    `--target-r=${quickArgs.targetR}`,
    '--exit-mode=smart',
    '--trail-r=0.5',
    `--time-stop-bars=${quickArgs.timeStopBars}`,
    '--min-lead=65',
    '--min-edge=12',
    `--min-atr-ratio=${quickArgs.minAtrRatio}`,
    `--min-adx=${quickArgs.minAdx}`,
    `--min-er=${quickArgs.minEr}`,
    `--vol-mult=${quickArgs.volMult}`,
    `--session=${quickArgs.session}`,
    `--direction=${args.get('direction') || 'both|long|short'}`,
    '--require-conf-rising=true',
    `--slippage-bps=${slippage}`,
    `--spread-bps=${spread}`,
    '--min-move-to-cost=5',
    '--opening-range=off',
    '--htf-mode=not-against50',
    `--volume-quality=${quickArgs.volumeQuality}`,
    `--adaptive-target=${args.get('adaptive-target') || 'false|true'}`,
    '--min-price=1',
    '--min-dollar-volume=500000',
    '--daily-context=trend-day',
    `--alpha-mode=${quickArgs.alphaMode}`,
    `--alpha-weights=${weightsPath}`,
    `--alpha-weight-set=${setNames}`,
    `--min-alpha-quality=${quickArgs.minAlphaQuality}`,
    '--intelligence-mode=gate',
    `--min-intel-score=${quickArgs.minIntelScore}`,
    '--position-sizing=fixed',
    '--min-position-scale=1',
    '--max-position-scale=1',
    `--sample=${sample}`,
    '--train-pct=0.70',
    `--save-trades=${saveTrades}`,
    '--promote=false',
    '--min-trades=30',
    `--min-symbols=${Math.min(15, symbols.length)}`,
  ];
}

const trainOut = runNode('scripts/local_fusion_backtest.js', localArgs('train', 1, 2, false), 'batched train');
const testOut = runNode('scripts/local_fusion_backtest.js', localArgs('test', 1, 2, true), 'batched test');
const trainSummary = summaryPathFrom(trainOut, 'train');
const testSummary = summaryPathFrom(testOut, 'test');
let stressSummary = null;
if (stress) {
  const stressOut = runNode('scripts/local_fusion_backtest.js', localArgs('test', 3, 12, false), 'batched stress');
  stressSummary = summaryPathFrom(stressOut, 'stress');
}

runNode('scripts/validate_scalp_routes.js', [
  `--train-summary=${trainSummary}`,
  `--test-summary=${testSummary}`,
  ...(stressSummary ? [`--stress-summary=${stressSummary}`] : []),
  `--projection-capital=${projectionCapital}`,
  '--min-train-trades=3',
  '--min-test-trades=2',
  '--min-train-win=56',
  '--min-test-win=60',
  '--min-profit-factor=1.1',
], 'batched validation');

function readJson(path) { return JSON.parse(readFileSync(path, 'utf8')); }
function portfolioScore(portfolio) {
  const m = portfolio.portfolio;
  return m.winRate * 2.1 + Math.min(m.profitFactor, 20) * 9 + Math.min(m.projectedNet / 100, 300)
    + Math.min(m.trades, 800) * 0.12 + Math.min(m.projectedAvgDollars, 150) * 0.5
    - Math.min(m.maxDrawdownDollars / 100, 80) - m.maxLossStreak * 15;
}
function build(tier) {
  runNode('scripts/build_scalp_portfolio.js', [
    '--routes=optimization-results/models/playbooks/current-walk-forward-scalp-routes.json',
    `--tier=${tier}`,
    '--max-concurrent=8',
    `--projection-capital=${projectionCapital}`,
    '--min-gap-bars=1',
    '--sizing-mode=quality',
    '--family-mode=all',
    '--max-routes-per-symbol=2',
    '--options-mode=bonus',
    '--decay-guard=true',
  ], `portfolio ${tier}`);
  return readJson(join(playbooksDir, 'current-scalp-portfolio.json'));
}
const tiers = ['recentProfitElite', 'qualityElite', 'profitFirstElite', 'elite', 'highWin', 'allValidated'];
const portfolios = tiers.map((tier) => ({ tier, portfolio: build(tier) })).sort((a, b) => portfolioScore(b.portfolio) - portfolioScore(a.portfolio));
const bestPortfolio = portfolios[0];
const routeBook = readJson(join(playbooksDir, 'current-walk-forward-scalp-routes.json'));
const setStats = new Map();
for (const route of routeBook.validated || []) {
  const set = route.combo.alphaWeightSet || 'default';
  const item = setStats.get(set) || { setName: set, routes: 0, trades: 0, wins: 0, netDollars: 0, avgDollars: 0 };
  item.routes += 1;
  item.trades += route.test.trades || 0;
  item.wins += Math.round((route.test.winRate || 0) * (route.test.trades || 0) / 100);
  item.netDollars += route.test.netDollars || 0;
  setStats.set(set, item);
}
const setLeaderboard = [...setStats.values()].map((item) => ({
  ...item,
  winRate: item.trades ? item.wins / item.trades * 100 : 0,
  avgDollars: item.trades ? item.netDollars / item.trades : 0,
  meta: setMeta.find((row) => row.setName === item.setName) || null,
})).sort((a, b) => (b.winRate * 1.5 + b.netDollars / 1000 + b.avgDollars / 10 + b.trades * 0.2) - (a.winRate * 1.5 + a.netDollars / 1000 + a.avgDollars / 10 + a.trades * 0.2));

const champion = currentChampion?.portfolio || null;
const best = bestPortfolio.portfolio.portfolio;
const beatsChampion = champion
  ? best.trades >= Math.min(500, champion.trades * 0.75) && best.winRate >= champion.winRate && best.projectedNet >= champion.projectedNet && best.maxDrawdownDollars <= champion.maxDrawdownDollars * 1.15
  : false;
const specialistPromotion = best.winRate >= 88 && best.profitFactor >= 4 && best.projectedNet > 0;
const payload = {
  updatedAt: new Date().toISOString(), runId, weightsPath, candidates, symbols: symbols.length, trainSummary, testSummary, stressSummary,
  bestPortfolio: { tier: bestPortfolio.tier, score: portfolioScore(bestPortfolio.portfolio), portfolio: bestPortfolio.portfolio.portfolio, selectedRoutes: bestPortfolio.portfolio.selectedRoutes },
  setLeaderboard: setLeaderboard.slice(0, 30),
  currentChampion: champion,
  promotion: { beatsChampion, specialistPromotion, decision: beatsChampion ? 'main-champion-candidate' : specialistPromotion ? 'specialist-module' : 'research-only' },
};
const outPath = join(playbooksDir, 'current-batched-weight-optimizer.json');
writeFileSync(outPath, `${JSON.stringify(payload, null, 2)}\n`);
writeFileSync(join(playbooksDir, 'batched-weight-optimizer-leaderboard.json'), `${JSON.stringify(payload.setLeaderboard, null, 2)}\n`);
appendFileSync(join(playbooksDir, 'batched-weight-optimizer-history.jsonl'), `${JSON.stringify(payload)}\n`);
if (beatsChampion) writeFileSync(join(playbooksDir, 'current-batched-main-candidate.json'), `${JSON.stringify(payload, null, 2)}\n`);
if (specialistPromotion) writeFileSync(join(playbooksDir, 'current-batched-specialist-candidate.json'), `${JSON.stringify(payload, null, 2)}\n`);
console.log('\n=== batched optimizer complete ===');
console.log(`Saved: ${outPath}`);
console.log(`Candidates=${candidates} symbols=${symbols.length} bestTier=${bestPortfolio.tier}`);
console.log(`Trades=${best.trades} win=${best.winRate.toFixed(2)} pf=${best.profitFactor.toFixed(2)} projected=$${best.projectedNet.toFixed(0)} avg=$${best.projectedAvgDollars.toFixed(2)} maxDD=$${best.maxDrawdownDollars.toFixed(0)}`);
console.log(`Decision=${payload.promotion.decision}`);
console.log(`Top sets: ${setLeaderboard.slice(0, 5).map((row) => `${row.setName}:${row.trades}t/${row.winRate.toFixed(1)}%/$${row.netDollars.toFixed(0)}`).join(' | ')}`);
