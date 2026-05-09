#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const outDir = join(root, 'optimization-results', 'models', 'playbooks');
if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

const args = new Map(process.argv.slice(2).map((arg) => {
  const [key, value = 'true'] = arg.replace(/^--/, '').split('=');
  return [key, value];
}));

const symbolFile = args.get('symbol-file') || join(root, 'config', 'scalp-symbols-expanded.txt');
const symbols = (args.get('symbols') || readFileSync(symbolFile, 'utf8')).split(',').map((symbol) => symbol.trim().toUpperCase()).filter(Boolean);
const trainPcts = (args.get('train-pcts') || '0.55,0.65,0.75').split(',').map(Number);
const projectionCapital = args.get('projection-capital') || '10000';
const quick = args.get('quick') === 'true';

const baseSweep = [
  `--symbols=${symbols.join(',')}`,
  '--interval=5m',
  '--range=60d',
  '--capital=100000',
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
  '--save-trades=true',
];

if (quick) {
  baseSweep.splice(baseSweep.indexOf('--session=all|open|morning|afternoon|powerhour|open-0930|open-1000|open-1030'), 1, '--session=all|open|open-0930');
  baseSweep.splice(baseSweep.indexOf('--direction=both|long|short'), 1, '--direction=both|short');
}

function run(script, extraArgs) {
  const output = execFileSync('node', [script, ...extraArgs], { cwd: root, encoding: 'utf8', maxBuffer: 1024 * 1024 * 80 });
  process.stdout.write(output);
  return output;
}

function summaryPath(output) {
  const path = output.match(/Summary: (.*\.json)/)?.[1];
  if (!path) throw new Error('Missing summary path');
  return path;
}

const windows = [];
for (const trainPct of trainPcts) {
  console.log(`\n=== Rolling window trainPct=${trainPct} ===`);
  const train = summaryPath(run('scripts/local_fusion_backtest.js', [...baseSweep, `--train-pct=${trainPct}`, '--sample=train']));
  const test = summaryPath(run('scripts/local_fusion_backtest.js', [...baseSweep, `--train-pct=${trainPct}`, '--sample=test']));
  const validationOutput = run('scripts/validate_scalp_routes.js', [
    `--train-summary=${train}`,
    `--test-summary=${test}`,
    `--projection-capital=${projectionCapital}`,
  ]);
  const validation = JSON.parse(readFileSync(join(outDir, 'current-walk-forward-scalp-routes.json'), 'utf8'));
  windows.push({ trainPct, train, test, validation: validation.aggregates, validationOutput });
}

const report = {
  updatedAt: new Date().toISOString(),
  symbols: symbols.length,
  trainPcts,
  windows,
  stability: {
    minRecentStableEliteWin: Math.min(...windows.map((window) => window.validation.recentStableElite?.winRate || 0)),
    minRecentStableEliteTrades: Math.min(...windows.map((window) => window.validation.recentStableElite?.trades || 0)),
    totalProjectedNet: windows.reduce((sum, window) => sum + (window.validation.recentStableElite?.projectedNet || 0), 0),
  },
};

const out = join(outDir, 'rolling-scalp-walk-forward.json');
writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
console.log(`Rolling walk-forward saved: ${out}`);
