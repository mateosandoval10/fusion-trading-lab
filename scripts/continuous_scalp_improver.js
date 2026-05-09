#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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

const symbolFile = args.get('symbol-file') || join(root, 'config', 'scalp-symbols-expanded.txt');
const symbols = (args.get('symbols') || readFileSync(symbolFile, 'utf8'))
  .split(',')
  .map((symbol) => symbol.trim().toUpperCase())
  .filter(Boolean);
const capital = args.get('capital') || '100000';
const range = args.get('range') || '60d';
const interval = args.get('interval') || '5m';
const trainPct = args.get('train-pct') || '0.70';
const minTrainTrades = args.get('min-train-trades') || '8';
const minTestTrades = args.get('min-test-trades') || '3';
const minTrainWin = args.get('min-train-win') || '65';
const minTestWin = args.get('min-test-win') || '60';
const minProfitFactor = args.get('min-profit-factor') || '1.1';
const saveTrades = args.get('save-trades') !== 'false';
const projectionCapital = args.get('projection-capital') || '10000';
const runStress = args.get('stress') !== 'false';

const sweepArgs = [
  `--symbols=${symbols.join(',')}`,
  `--interval=${interval}`,
  `--range=${range}`,
  `--capital=${capital}`,
  '--playbook=Scalp',
  '--min-conf=65|70|75',
  '--target-r=0.35|0.5',
  '--exit-mode=smart',
  '--trail-r=0.5',
  '--time-stop-bars=6|9',
  '--min-lead=70',
  '--min-edge=12',
  '--min-atr-ratio=0.9',
  '--min-adx=14',
  '--min-er=0.10',
  '--vol-mult=1.2',
  '--session=all|open|morning|afternoon|powerhour|open-0930|open-1000|open-1030',
  '--direction=both|long|short',
  '--loss-cooldown-bars=0',
  '--max-vwap-atr=0',
  '--require-conf-rising=false',
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
  '--position-sizing=fixed|confidence',
  '--min-position-scale=0.5',
  '--max-position-scale=1.25',
  '--min-trades=300',
  '--min-symbols=40',
  '--promote=false',
  `--save-trades=${saveTrades}`,
  `--train-pct=${trainPct}`,
];

function runNode(script, extraArgs) {
  const output = execFileSync('node', [script, ...extraArgs], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024 * 80,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  process.stdout.write(output);
  return output;
}

function summaryPathFrom(output) {
  const path = output.match(/Summary: (.*\.json)/)?.[1];
  if (!path) throw new Error('Backtest did not print a summary path');
  return path;
}

const startedAt = new Date().toISOString();
console.log(`Continuous scalp improver started ${startedAt}`);
console.log(`Universe: ${symbols.length} symbols, ${interval}/${range}, capital $${Number(capital).toLocaleString()}`);

const trainOutput = runNode('scripts/local_fusion_backtest.js', [...sweepArgs, '--sample=train']);
const trainSummary = summaryPathFrom(trainOutput);
const testOutput = runNode('scripts/local_fusion_backtest.js', [...sweepArgs, '--sample=test']);
const testSummary = summaryPathFrom(testOutput);
let stressSummary = null;
if (runStress) {
  const stressArgs = sweepArgs
    .filter((arg) => !arg.startsWith('--slippage-bps=') && !arg.startsWith('--spread-bps='))
    .concat(['--slippage-bps=3', '--spread-bps=12', '--sample=test']);
  const stressOutput = runNode('scripts/local_fusion_backtest.js', stressArgs);
  stressSummary = summaryPathFrom(stressOutput);
}

const validateOutput = runNode('scripts/validate_scalp_routes.js', [
  `--train-summary=${trainSummary}`,
  `--test-summary=${testSummary}`,
  ...(stressSummary ? [`--stress-summary=${stressSummary}`] : []),
  `--min-train-trades=${minTrainTrades}`,
  `--min-test-trades=${minTestTrades}`,
  `--min-train-win=${minTrainWin}`,
  `--min-test-win=${minTestWin}`,
  `--min-profit-factor=${minProfitFactor}`,
  `--projection-capital=${projectionCapital}`,
]);
const portfolioOutput = runNode('scripts/build_scalp_portfolio.js', [
  '--tier=highWin',
  '--max-concurrent=3',
  `--projection-capital=${projectionCapital}`,
  '--min-gap-bars=1',
  '--sizing-mode=quality',
  '--family-mode=all',
  '--max-routes-per-symbol=2',
  '--options-mode=bonus',
  '--decay-guard=true',
]);

const currentRoutesPath = join(playbooksDir, 'current-walk-forward-scalp-routes.json');
const current = JSON.parse(readFileSync(currentRoutesPath, 'utf8'));
const currentPortfolioPath = join(playbooksDir, 'current-scalp-portfolio.json');
const currentPortfolio = JSON.parse(readFileSync(currentPortfolioPath, 'utf8'));
const historyPath = join(playbooksDir, 'scalp-improver-history.jsonl');
const record = {
  startedAt,
  finishedAt: new Date().toISOString(),
  symbols: symbols.length,
  interval,
  range,
  capital: Number(capital),
  trainSummary,
  testSummary,
  stressSummary,
  validationPath: currentRoutesPath,
  portfolioPath: currentPortfolioPath,
  aggregates: current.aggregates,
  portfolio: currentPortfolio.portfolio,
};
writeFileSync(historyPath, `${existsSync(historyPath) ? readFileSync(historyPath, 'utf8') : ''}${JSON.stringify(record)}\n`);

console.log(`Improver history appended: ${historyPath}`);
console.log(validateOutput.split('\n').filter((line) => line.includes('routes=')).join('\n'));
console.log(portfolioOutput.split('\n').filter((line) => line.startsWith('Portfolio ')).join('\n'));
