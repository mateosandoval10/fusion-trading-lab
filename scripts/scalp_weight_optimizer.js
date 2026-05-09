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

const projectionCapital = Number(args.get('projection-capital') || 10000);
const capital = Number(args.get('capital') || 100000);
const range = args.get('range') || '60d';
const interval = args.get('interval') || '5m';
const maxCandidates = Number(args.get('candidates') || 24);
const maxSymbols = Number(args.get('max-symbols') || 80);
const stress = args.get('stress') !== 'false';
const quick = args.get('quick') !== 'false';
const routeMinTrainWin = Number(args.get('min-train-win') || 58);
const routeMinTestWin = Number(args.get('min-test-win') || 60);
const routeMinTrainTrades = Number(args.get('min-train-trades') || 5);
const routeMinTestTrades = Number(args.get('min-test-trades') || 3);
const routeMinPf = Number(args.get('min-profit-factor') || 1.15);
const championPath = join(playbooksDir, 'current-trigger-champion.json');
const currentChampion = existsSync(championPath) ? JSON.parse(readFileSync(championPath, 'utf8')).champion : null;

const defaultSymbols = currentChampion?.acceptedTrades?.length
  ? [...new Set(currentChampion.acceptedTrades.map((trade) => trade.symbol))].sort()
  : ['NVDA', 'TSLA', 'AMD', 'PLTR', 'COIN', 'HOOD', 'SOFI', 'AFRM', 'IONQ', 'NOK', 'OPEN', 'AAL', 'LUV', 'CRSP', 'ONDS', 'QQQ', 'SPY'];
const symbols = (args.get('symbols') || defaultSymbols.join(','))
  .split(',')
  .map((symbol) => symbol.trim().toUpperCase())
  .filter(Boolean)
  .filter((symbol, index, all) => all.indexOf(symbol) === index)
  .slice(0, maxSymbols > 0 ? maxSymbols : undefined);

const baseWeights = {
  'volume-shock:long': {
    bodyQuality: 0.13, closeLocation: 0.12, directionalCandle: 0.12, flowQuality: 0.14,
    cleanVolume: 0.12, volumeAcceleration: 0.09, volumeFlowAgreement: 0.14, momentumBurst: 0.10, marketAlignment: 0.08,
    relativeStrength: 0.08, marketImpulse: 0.06, intradayTrendQuality: 0.06,
    timeEdge: 0.06, relativeVolume: 0.04, volumeQuality: -0.06, rejectionWick: -0.09,
    vwapExtensionRisk: -0.12, failedBreakRisk: -0.14,
  },
  'options-burst:long': {
    optionBurstShape: 0.16, momentumBurst: 0.15, priceAcceleration: 0.12, atrExpansion: 0.11,
    cleanBreakout: 0.10, rangeExpansionQuality: 0.10, closeLocation: 0.10, flowQuality: 0.09, marketAlignment: 0.09,
    relativeStrength: 0.08, marketImpulse: 0.07, priorDayBreakQuality: 0.06,
    timeEdge: 0.08, trendQuality: 0.07, vwapExtensionRisk: -0.10, failedBreakRisk: -0.15,
    rejectionWick: -0.08,
  },
  'momentum-acceleration:long': {
    priceAcceleration: 0.15, emaSlope: 0.13, momentumBurst: 0.13, flowQuality: 0.12,
    closeLocation: 0.11, directionalCandle: 0.10, trendQuality: 0.09, marketAlignment: 0.08,
    relativeStrength: 0.09, marketImpulse: 0.08, intradayTrendQuality: 0.08,
    cleanVolume: 0.07, vwapPressure: 0.06, failedBreakRisk: -0.12, vwapExtensionRisk: -0.10,
  },
  'opening-range:long': {
    cleanBreakout: 0.15, rangeExpansionQuality: 0.10, breakoutQuality: 0.13, closeLocation: 0.12, cleanVolume: 0.10,
    volumeFlowAgreement: 0.10, marketAlignment: 0.09, relativeStrength: 0.07, priorDayBreakQuality: 0.08,
    timeEdge: 0.08, atrExpansion: 0.08,
    trendQuality: 0.07, failedBreakRisk: -0.17, rejectionWick: -0.10, vwapExtensionRisk: -0.08,
  },
};

const genes = [
  { name: 'balanced-base', scale: {}, blend: { specialist: 0.55, intelligence: 0.45, badPatternPenalty: 18 }, thresholds: { minAlphaQuality: '55|65', minIntelScore: '45|55', targetR: '0.35|0.5', timeStopBars: '6|9', triggerMode: 'volume-shock|options-burst|momentum-acceleration' } },
  { name: 'flow-volume-plus', scale: { flowQuality: 1.18, volumeFlowAgreement: 1.22, cleanVolume: 1.18, volumeAcceleration: 1.16, volumeQuality: 0.70, rejectionWick: 1.20, failedBreakRisk: 1.15 }, blend: { specialist: 0.62, intelligence: 0.38, badPatternPenalty: 22 }, thresholds: { minAlphaQuality: '55|65|75', minIntelScore: '45|55', targetR: '0.35|0.5', timeStopBars: '6', triggerMode: 'volume-shock|options-burst' } },
  { name: 'profit-momentum', scale: { momentumBurst: 1.25, priceAcceleration: 1.18, optionBurstShape: 1.20, atrExpansion: 1.12, marketAlignment: 1.12, relativeStrength: 1.18, marketImpulse: 1.12, vwapExtensionRisk: 1.08 }, blend: { specialist: 0.58, intelligence: 0.42, badPatternPenalty: 18 }, thresholds: { minAlphaQuality: '55|65', minIntelScore: '45|55|65', targetR: '0.5|0.75', timeStopBars: '6|9', triggerMode: 'momentum-acceleration|options-burst' } },
  { name: 'high-win-strict', scale: { closeLocation: 1.20, directionalCandle: 1.18, marketAlignment: 1.20, failedBreakRisk: 1.35, vwapExtensionRisk: 1.25, rejectionWick: 1.30, cleanVolume: 1.10 }, blend: { specialist: 0.65, intelligence: 0.35, badPatternPenalty: 28 }, thresholds: { minAlphaQuality: '75|80', minIntelScore: '55|65|75', targetR: '0.35|0.5', timeStopBars: '6', triggerMode: 'volume-shock|momentum-acceleration|options-burst' } },
  { name: 'vwap-safe', scale: { vwapPressure: 1.25, vwapExtensionRisk: 1.45, failedBreakRisk: 1.15, pullbackReclaim: 1.12, closeLocation: 1.10 }, blend: { specialist: 0.60, intelligence: 0.40, badPatternPenalty: 24 }, thresholds: { minAlphaQuality: '65|75', minIntelScore: '45|55|65', targetR: '0.35|0.5', timeStopBars: '6|9', triggerMode: 'volume-shock|momentum-acceleration' } },
  { name: 'open-session-edge', scale: { timeEdge: 1.35, cleanBreakout: 1.20, breakoutQuality: 1.18, atrExpansion: 1.12, failedBreakRisk: 1.25 }, blend: { specialist: 0.62, intelligence: 0.38, badPatternPenalty: 22 }, thresholds: { minAlphaQuality: '55|65|75', minIntelScore: '45|55', targetR: '0.35|0.5', timeStopBars: '6', triggerMode: 'opening-range|volume-shock|options-burst', session: 'morning|open' } },
  { name: 'relative-strength-leader', scale: { relativeStrength: 1.45, marketImpulse: 1.22, intradayTrendQuality: 1.18, dayPositionQuality: 1.12, volumeFlowAgreement: 1.10, failedBreakRisk: 1.18 }, blend: { specialist: 0.60, intelligence: 0.40, badPatternPenalty: 24 }, thresholds: { minAlphaQuality: '55|65|75', minIntelScore: '45|55|65', targetR: '0.35|0.5', timeStopBars: '6|9', triggerMode: 'volume-shock|momentum-acceleration|options-burst' } },
  { name: 'prior-day-break-reclaim', scale: { priorDayBreakQuality: 1.55, priorDayReclaim: 1.35, rangeExpansionQuality: 1.25, closeLocation: 1.14, rejectionWick: 1.25, failedBreakRisk: 1.22 }, blend: { specialist: 0.63, intelligence: 0.37, badPatternPenalty: 25 }, thresholds: { minAlphaQuality: '55|65|75', minIntelScore: '45|55', targetR: '0.35|0.5', timeStopBars: '6', triggerMode: 'opening-range|volume-shock|options-burst', session: 'all|morning' } },
];

function seeded(index) {
  let x = Math.sin(index * 999 + 7) * 10000;
  return x - Math.floor(x);
}

function mutateWeights(gene, candidateIndex) {
  const weights = JSON.parse(JSON.stringify(baseWeights));
  for (const family of Object.keys(weights)) {
    for (const [name, value] of Object.entries(weights[family])) {
      const direction = value < 0 ? -1 : 1;
      const scale = gene.scale[name] ?? 1;
      const jitter = 1 + (seeded(candidateIndex + name.length + family.length) - 0.5) * 0.10;
      const next = Math.max(0.01, Math.min(0.35, Math.abs(value) * scale * jitter));
      weights[family][name] = Number((next * direction).toFixed(4));
    }
  }
  return weights;
}

function candidateModel(gene, index) {
  const setName = `${String(index).padStart(3, '0')}-${gene.name}`;
  return {
    createdAt: new Date().toISOString(),
    optimizer: 'scalp_weight_optimizer',
    sets: {
      [setName]: {
        sourceGene: gene.name,
        blend: gene.blend,
        thresholds: gene.thresholds,
        weights: mutateWeights(gene, index),
      },
    },
  };
}

function runNode(script, scriptArgs, label) {
  console.log(`\n=== ${label} ===`);
  const output = execFileSync('node', [script, ...scriptArgs], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024 * 160,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  process.stdout.write(output.split('\n').slice(-14).join('\n'));
  if (!output.endsWith('\n')) process.stdout.write('\n');
  return output;
}

function summaryPathFrom(output, label) {
  const match = output.match(/Summary: (.*\.json)/);
  if (!match) throw new Error(`${label} did not emit a summary path`);
  return match[1];
}

function metricScore(portfolio) {
  const m = portfolio.portfolio;
  return m.winRate * 2.1
    + Math.min(m.profitFactor, 20) * 9
    + Math.min(m.projectedNet / 100, 300)
    + Math.min(m.trades, 800) * 0.12
    + Math.min(m.projectedAvgDollars, 150) * 0.5
    - Math.min(m.maxDrawdownDollars / 100, 80)
    - m.maxLossStreak * 15;
}

function localArgs(modelPath, setName, thresholds, sample, slippage = 1, spread = 2, saveTrades = false) {
  const quickArgs = quick ? {
    minConf: '65',
    minAtrRatio: '0.9',
    minAdx: '14',
    minEr: '0.10',
    volMult: '1.2',
    volumeQuality: 'off',
    alphaMode: 'specialist-intel',
  } : {
    minConf: '65|70',
    minAtrRatio: '0.9|1.0',
    minAdx: '14|18',
    minEr: '0.10|0.14',
    volMult: '1.2|1.5',
    volumeQuality: 'off|clean',
    alphaMode: 'specialist-blend|specialist-intel',
  };
  return [
    `--symbols=${symbols.join(',')}`,
    `--interval=${interval}`,
    `--range=${range}`,
    `--capital=${capital}`,
    '--playbook=Scalp',
    `--trigger-mode=${thresholds.triggerMode || 'volume-shock|options-burst|momentum-acceleration'}`,
    `--min-conf=${quickArgs.minConf}`,
    `--target-r=${thresholds.targetR || '0.35|0.5'}`,
    '--exit-mode=smart',
    '--trail-r=0.5',
    `--time-stop-bars=${thresholds.timeStopBars || '6|9'}`,
    '--min-lead=65',
    '--min-edge=12',
    `--min-atr-ratio=${quickArgs.minAtrRatio}`,
    `--min-adx=${quickArgs.minAdx}`,
    `--min-er=${quickArgs.minEr}`,
    `--vol-mult=${quickArgs.volMult}`,
    `--session=${thresholds.session || 'all|morning'}`,
    '--direction=long',
    '--require-conf-rising=true',
    `--slippage-bps=${slippage}`,
    `--spread-bps=${spread}`,
    '--min-move-to-cost=5',
    '--opening-range=off',
    '--htf-mode=not-against50',
    `--volume-quality=${quickArgs.volumeQuality}`,
    '--adaptive-target=false',
    '--min-price=1',
    '--min-dollar-volume=500000',
    '--daily-context=trend-day',
    `--alpha-mode=${quickArgs.alphaMode}`,
    `--alpha-weights=${modelPath}`,
    `--alpha-weight-set=${setName}`,
    `--min-alpha-quality=${thresholds.minAlphaQuality || '55|65'}`,
    '--intelligence-mode=gate',
    `--min-intel-score=${thresholds.minIntelScore || '45|55'}`,
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

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function buildPortfolio(routesPath, tier) {
  runNode('scripts/build_scalp_portfolio.js', [
    `--routes=${routesPath}`,
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

const candidates = [];
for (let index = 0; index < maxCandidates; index += 1) {
  const gene = genes[index % genes.length];
  const model = candidateModel(gene, index);
  const setName = Object.keys(model.sets)[0];
  const modelPath = join(weightsDir, `candidate-${setName}.json`);
  writeFileSync(modelPath, `${JSON.stringify(model, null, 2)}\n`);
  const thresholds = model.sets[setName].thresholds;
  const trainOutput = runNode('scripts/local_fusion_backtest.js', localArgs(modelPath, setName, thresholds, 'train', 1, 2, false), `train ${setName}`);
  const testOutput = runNode('scripts/local_fusion_backtest.js', localArgs(modelPath, setName, thresholds, 'test', 1, 2, true), `test ${setName}`);
  const trainSummary = summaryPathFrom(trainOutput, `train ${setName}`);
  const testSummary = summaryPathFrom(testOutput, `test ${setName}`);
  let stressSummary = null;
  if (stress) {
    const stressOutput = runNode('scripts/local_fusion_backtest.js', localArgs(modelPath, setName, thresholds, 'test', 3, 12, false), `stress ${setName}`);
    stressSummary = summaryPathFrom(stressOutput, `stress ${setName}`);
  }
  runNode('scripts/validate_scalp_routes.js', [
    `--train-summary=${trainSummary}`,
    `--test-summary=${testSummary}`,
    ...(stressSummary ? [`--stress-summary=${stressSummary}`] : []),
    `--projection-capital=${projectionCapital}`,
    `--min-train-trades=${routeMinTrainTrades}`,
    `--min-test-trades=${routeMinTestTrades}`,
    `--min-train-win=${routeMinTrainWin}`,
    `--min-test-win=${routeMinTestWin}`,
    `--min-profit-factor=${routeMinPf}`,
  ], `validate ${setName}`);
  const routesPath = join(playbooksDir, 'current-walk-forward-scalp-routes.json');
  const tiers = ['recentProfitElite', 'qualityElite', 'profitFirstElite', 'elite', 'highWin', 'allValidated'];
  const portfolios = tiers.map((tier) => ({ tier, portfolio: buildPortfolio(routesPath, tier) }));
  portfolios.sort((a, b) => metricScore(b.portfolio) - metricScore(a.portfolio));
  const best = portfolios[0];
  const row = {
    setName,
    gene: gene.name,
    modelPath,
    trainSummary,
    testSummary,
    stressSummary,
    routesPath,
    tier: best.tier,
    score: metricScore(best.portfolio),
    portfolio: best.portfolio.portfolio,
    rawCandidates: best.portfolio.rawCandidates,
    selectedRoutes: best.portfolio.selectedRoutes,
  };
  candidates.push(row);
  appendFileSync(join(playbooksDir, 'weight-optimizer-history.jsonl'), `${JSON.stringify({ event: 'candidate', at: new Date().toISOString(), ...row })}\n`);
  console.log(`\nCandidate ${setName}: tier=${row.tier} trades=${row.portfolio.trades} win=${row.portfolio.winRate.toFixed(2)} pf=${row.portfolio.profitFactor.toFixed(2)} projected=$${row.portfolio.projectedNet.toFixed(0)} avg=$${row.portfolio.projectedAvgDollars.toFixed(2)} score=${row.score.toFixed(2)}`);
}

candidates.sort((a, b) => b.score - a.score);
const best = candidates[0];
const championPortfolio = currentChampion?.portfolio || null;
const beatsChampion = championPortfolio
  ? best.portfolio.trades >= Math.min(500, championPortfolio.trades * 0.75)
    && best.portfolio.winRate >= championPortfolio.winRate
    && best.portfolio.projectedNet >= championPortfolio.projectedNet
    && best.portfolio.maxDrawdownDollars <= championPortfolio.maxDrawdownDollars * 1.15
  : false;
const specialistPromotion = best.portfolio.winRate >= 88 && best.portfolio.profitFactor >= 4 && best.portfolio.projectedNet > 0;
const payload = {
  updatedAt: new Date().toISOString(),
  symbols,
  candidatesTested: candidates.length,
  best,
  currentChampion: championPortfolio,
  promotion: {
    beatsChampion,
    specialistPromotion,
    decision: beatsChampion ? 'main-champion-candidate' : specialistPromotion ? 'specialist-module' : 'research-only',
    reason: beatsChampion
      ? 'Meets main champion promotion criteria.'
      : specialistPromotion
        ? 'High-win/high-PF, but not enough trade count/net to replace main champion.'
        : 'Did not clear promotion thresholds.',
  },
  leaderboard: candidates.slice(0, 25),
};
const outPath = join(playbooksDir, 'current-weight-optimizer-challenger.json');
const leaderboardPath = join(playbooksDir, 'weight-optimizer-leaderboard.json');
writeFileSync(outPath, `${JSON.stringify(payload, null, 2)}\n`);
writeFileSync(leaderboardPath, `${JSON.stringify(payload.leaderboard, null, 2)}\n`);
if (beatsChampion) writeFileSync(join(playbooksDir, 'current-weight-optimized-main-candidate.json'), `${JSON.stringify(payload, null, 2)}\n`);
if (specialistPromotion) writeFileSync(join(playbooksDir, 'current-weight-optimized-specialist.json'), `${JSON.stringify(payload, null, 2)}\n`);
appendFileSync(join(playbooksDir, 'weight-optimizer-history.jsonl'), `${JSON.stringify({ event: 'complete', at: new Date().toISOString(), best: payload.best, promotion: payload.promotion })}\n`);

console.log('\n=== weight optimizer complete ===');
console.log(`Saved: ${outPath}`);
console.log(`Best ${best.setName} (${best.gene}) tier=${best.tier}`);
console.log(`Trades=${best.portfolio.trades} win=${best.portfolio.winRate.toFixed(2)} pf=${best.portfolio.profitFactor.toFixed(2)} projected=$${best.portfolio.projectedNet.toFixed(0)} avg=$${best.portfolio.projectedAvgDollars.toFixed(2)} maxDD=$${best.portfolio.maxDrawdownDollars.toFixed(0)}`);
console.log(`Decision: ${payload.promotion.decision} — ${payload.promotion.reason}`);
