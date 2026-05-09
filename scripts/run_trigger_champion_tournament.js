#!/usr/bin/env node
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const playbooksDir = join(root, 'optimization-results', 'models', 'playbooks');
if (!existsSync(playbooksDir)) mkdirSync(playbooksDir, { recursive: true });

const args = new Map(process.argv.slice(2).map((arg) => {
  const [key, value = 'true'] = arg.replace(/^--/, '').split('=');
  return [key, value];
}));

const projectionCapital = Number(args.get('projection-capital') || 10000);
const capital = Number(args.get('capital') || 100000);
const range = args.get('range') || '60d';
const interval = args.get('interval') || '5m';
const maxSymbols = Number(args.get('max-symbols') || 0);
const symbolFile = args.get('symbol-file') || join(root, 'config', 'scalp-symbols-expanded.txt');
const symbols = (args.get('symbols') || readFileSync(symbolFile, 'utf8'))
  .split(/[\s,]+/)
  .map((symbol) => symbol.trim().toUpperCase())
  .filter(Boolean)
  .filter((symbol, index, all) => all.indexOf(symbol) === index)
  .slice(0, maxSymbols > 0 ? maxSymbols : undefined);

const triggerModes = [
  'base',
  'ema-cross',
  'score-cross',
  'vwap-reclaim',
  'ema-pullback',
  'breakout',
  'failed-reversal',
  'momentum-acceleration',
  'mean-reversion',
  'trend-continuation',
  'squeeze-expansion',
  'opening-range',
  'volume-shock',
  'options-burst',
  'confirmed-no-repaint',
  'hybrid-consensus',
];

const commonArgs = [
  `--symbols=${symbols.join(',')}`,
  `--interval=${interval}`,
  `--range=${range}`,
  `--capital=${capital}`,
  '--playbook=Scalp',
  `--trigger-mode=${triggerModes.join('|')}`,
  '--min-conf=65|70',
  '--target-r=0.35|0.5',
  '--exit-mode=smart',
  '--trail-r=0.5',
  '--time-stop-bars=6|9',
  '--min-lead=65',
  '--min-edge=12',
  '--min-atr-ratio=0.9',
  '--min-adx=14',
  '--min-er=0.10',
  '--vol-mult=1.2',
  '--session=all|open|open-0930|open-1000|morning',
  '--direction=both|long|short',
  '--loss-cooldown-bars=0',
  '--max-vwap-atr=0',
  '--require-conf-rising=true',
  '--slippage-bps=1',
  '--spread-bps=2',
  '--min-move-to-cost=5',
  '--opening-range=off',
  '--htf-mode=not-against50',
  '--volume-quality=off',
  '--adaptive-target=false',
  '--max-consecutive-losses=0',
  '--cluster-cooldown-bars=0',
  '--min-price=1',
  '--max-price=0',
  '--min-dollar-volume=500000',
  '--gap-mode=off',
  '--daily-context=trend-day',
  '--pd-level-mode=off',
  '--market-mode=off',
  '--rel-vol-mode=off',
  '--min-rel-vol-tod=1',
  '--peer-mode=off',
  '--news-mode=off',
  '--min-alpha-quality=0|55|65',
  '--position-sizing=fixed',
  '--min-position-scale=1',
  '--max-position-scale=1',
  '--min-trades=80',
  `--min-symbols=${Math.min(20, symbols.length)}`,
  '--promote=false',
];

function runNode(script, scriptArgs, label) {
  console.log(`\n=== ${label} ===`);
  const output = execFileSync('node', [script, ...scriptArgs], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024 * 120,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  process.stdout.write(output);
  return output;
}

function summaryPathFrom(output, label) {
  const match = output.match(/Summary: (.*\.json)/);
  if (!match) throw new Error(`${label} did not emit a summary path`);
  return match[1];
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function portfolioScore(portfolio) {
  const m = portfolio.portfolio;
  return m.winRate * 2.2
    + Math.min(m.profitFactor, 20) * 10
    + Math.min(m.projectedNet / 100, 250)
    + Math.min(m.trades, 800) * 0.12
    - Math.min(m.maxDrawdownDollars / 100, 80)
    - m.maxLossStreak * 16;
}

const trainOutput = runNode('scripts/local_fusion_backtest.js', [...commonArgs, '--sample=train', '--train-pct=0.70', '--save-trades=false'], 'trigger tournament train');
const trainSummary = summaryPathFrom(trainOutput, 'train');

const testOutput = runNode('scripts/local_fusion_backtest.js', [...commonArgs, '--sample=test', '--train-pct=0.70', '--save-trades=true'], 'trigger tournament test');
const testSummary = summaryPathFrom(testOutput, 'test');

const stressArgs = commonArgs
  .filter((arg) => !arg.startsWith('--slippage-bps=') && !arg.startsWith('--spread-bps='))
  .concat(['--slippage-bps=3', '--spread-bps=12', '--sample=test', '--train-pct=0.70', '--save-trades=false']);
const stressOutput = runNode('scripts/local_fusion_backtest.js', stressArgs, 'trigger tournament stress');
const stressSummary = summaryPathFrom(stressOutput, 'stress');

runNode('scripts/validate_scalp_routes.js', [
  `--train-summary=${trainSummary}`,
  `--test-summary=${testSummary}`,
  `--stress-summary=${stressSummary}`,
  `--projection-capital=${projectionCapital}`,
  '--min-train-trades=8',
  '--min-test-trades=3',
  '--min-train-win=65',
  '--min-test-win=60',
  '--min-profit-factor=1.1',
], 'walk-forward validation');

const tiers = ['recentProfitElite', 'qualityElite', 'profitFirstElite', 'elite', 'highWin', 'allValidated'];
const maxConcurrentValues = [1, 2, 3, 5, 8];
const sizingModes = ['quality', 'fixed'];
const familyModes = ['all', 'best'];
const routeCaps = [1, 2, 3];
const leaderboard = [];

for (const tier of tiers) {
  for (const maxConcurrent of maxConcurrentValues) {
    for (const sizingMode of sizingModes) {
      for (const familyMode of familyModes) {
        for (const maxRoutesPerSymbol of routeCaps) {
          const output = runNode('scripts/build_scalp_portfolio.js', [
            `--tier=${tier}`,
            `--max-concurrent=${maxConcurrent}`,
            `--projection-capital=${projectionCapital}`,
            '--min-gap-bars=1',
            `--sizing-mode=${sizingMode}`,
            `--family-mode=${familyMode}`,
            `--max-routes-per-symbol=${maxRoutesPerSymbol}`,
            '--options-mode=bonus',
            '--decay-guard=true',
          ], `portfolio ${tier} concurrent=${maxConcurrent} sizing=${sizingMode} family=${familyMode} cap=${maxRoutesPerSymbol}`);
          const portfolio = readJson(join(playbooksDir, 'current-scalp-portfolio.json'));
          leaderboard.push({
            score: portfolioScore(portfolio),
            tier,
            maxConcurrent,
            sizingMode,
            familyMode,
            maxRoutesPerSymbol,
            output: output.trim().split('\n').slice(-2),
            portfolio,
          });
        }
      }
    }
  }
}

leaderboard.sort((a, b) => b.score - a.score);
const best = leaderboard[0];
const championPath = join(playbooksDir, 'current-trigger-champion.json');
const leaderboardPath = join(playbooksDir, 'trigger-challenger-leaderboard.json');
const historyPath = join(playbooksDir, 'trigger-champion-history.jsonl');
const currentPortfolioPath = join(playbooksDir, 'current-scalp-portfolio.json');
const payload = {
  updatedAt: new Date().toISOString(),
  tournament: {
    symbols: symbols.length,
    interval,
    range,
    capital,
    projectionCapital,
    triggerModes,
    trainSummary,
    testSummary,
    stressSummary,
  },
  champion: {
    score: best.score,
    tier: best.tier,
    maxConcurrent: best.maxConcurrent,
    sizingMode: best.sizingMode,
    familyMode: best.familyMode,
    maxRoutesPerSymbol: best.maxRoutesPerSymbol,
    selectedRoutes: best.portfolio.selectedRoutes,
    rawCandidates: best.portfolio.rawCandidates,
    portfolio: best.portfolio.portfolio,
    settings: best.portfolio.settings,
    acceptedTrades: best.portfolio.acceptedTrades,
  },
  topChallengers: leaderboard.slice(0, 25).map((row) => ({
    score: row.score,
    tier: row.tier,
    maxConcurrent: row.maxConcurrent,
    sizingMode: row.sizingMode,
    familyMode: row.familyMode,
    maxRoutesPerSymbol: row.maxRoutesPerSymbol,
    selectedRoutes: row.portfolio.selectedRoutes,
    portfolio: row.portfolio.portfolio,
    rawCandidates: row.portfolio.rawCandidates,
  })),
};

writeFileSync(championPath, `${JSON.stringify(payload, null, 2)}\n`);
writeFileSync(leaderboardPath, `${JSON.stringify(payload.topChallengers, null, 2)}\n`);
writeFileSync(currentPortfolioPath, `${JSON.stringify(best.portfolio, null, 2)}\n`);
appendFileSync(historyPath, `${JSON.stringify({ event: 'promoted', ...payload })}\n`);

console.log('\n=== promoted trigger champion ===');
console.log(`Champion saved: ${championPath}`);
console.log(`Leaderboard saved: ${leaderboardPath}`);
console.log(`Current portfolio promoted: ${currentPortfolioPath}`);
console.log(`Symbols=${symbols.length} routes=${payload.champion.selectedRoutes}`);
console.log(`Trades=${payload.champion.portfolio.trades} win=${payload.champion.portfolio.winRate.toFixed(2)} pf=${payload.champion.portfolio.profitFactor.toFixed(2)} net=$${payload.champion.portfolio.netDollars.toFixed(0)} projected=$${payload.champion.portfolio.projectedNet.toFixed(0)} avg=$${payload.champion.portfolio.projectedAvgDollars.toFixed(2)} maxDD=$${payload.champion.portfolio.maxDrawdownDollars.toFixed(0)} score=${payload.champion.score.toFixed(2)}`);
