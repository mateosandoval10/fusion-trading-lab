#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const playbooksDir = join(root, 'optimization-results', 'models', 'playbooks');
for (const dir of [playbooksDir]) if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

const args = new Map(process.argv.slice(2).map((arg) => {
  const [key, value = 'true'] = arg.replace(/^--/, '').split('=');
  return [key, value];
}));

const runId = new Date().toISOString().replace(/[:.]/g, '-');
const symbolFile = args.get('symbol-file') || join(root, 'config', 'scalp-symbols-fresh-slice.txt');
const symbolText = args.get('symbols') || (existsSync(symbolFile) ? readFileSync(symbolFile, 'utf8') : 'NVDA,TSLA,AMD,PLTR,COIN,QQQ,SPY');
const maxSymbols = Number(args.get('max-symbols') || 80);
const symbols = symbolText.split(/[\s,]+/).map((symbol) => symbol.trim().toUpperCase()).filter(Boolean)
  .filter((symbol, index, all) => all.indexOf(symbol) === index).slice(0, maxSymbols);
const range = args.get('range') || '60d';
const capital = Number(args.get('capital') || 100000);

const exitProfiles = [
  {
    name: 'fast_take_profit',
    triggerMode: 'volume-shock|breakout|momentum-acceleration',
    targetR: '0.35',
    trailR: '0.25',
    partialR: '0.5',
    timeStopBars: '3',
    confidenceDrop: '15',
    structureExit: 'strict',
  },
  {
    name: 'balanced_runner',
    triggerMode: 'volume-shock|breakout|momentum-acceleration|opening-drive-continuation',
    targetR: '0.5',
    trailR: '0.35',
    partialR: '0.5',
    timeStopBars: '6',
    confidenceDrop: '18',
    structureExit: 'loose',
  },
  {
    name: 'profit_runner',
    triggerMode: 'momentum-acceleration|options-burst|opening-drive-continuation',
    targetR: '0.75',
    trailR: '0.5',
    partialR: '0.75',
    timeStopBars: '9',
    confidenceDrop: '25',
    structureExit: 'loose',
  },
  {
    name: 'loose_runner',
    triggerMode: 'momentum-acceleration|options-burst|breakout',
    targetR: '1',
    trailR: '0.75',
    partialR: '1',
    timeStopBars: '12',
    confidenceDrop: '32',
    structureExit: 'off',
  },
];

function runNode(script, scriptArgs, label) {
  console.log(`\n=== ${label} ===`);
  const output = execFileSync('node', [script, ...scriptArgs], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024 * 240,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  process.stdout.write(output.split('\n').slice(-18).join('\n'));
  if (!output.endsWith('\n')) process.stdout.write('\n');
  return output;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function score(metrics = {}) {
  return (metrics.winRate || 0) * 1.25
    + Math.min((metrics.projectedNet || 0) / 100, 260)
    + Math.min(metrics.trades || 0, 600) * 0.14
    + Math.min(metrics.profitFactor || 0, 14) * 7
    + Math.min(metrics.projectedAvgDollars || 0, 160) * 0.35
    - Math.max(0, 90 - (metrics.winRate || 0)) * 1.5;
}

const results = [];
for (const profile of exitProfiles) {
  runNode('scripts/master_scalp_learning_sprint.js', [
    `--symbols=${symbols.join(',')}`,
    `--range=${range}`,
    `--capital=${capital}`,
    '--quick=true',
    '--focused=true',
    '--trigger-mode=' + profile.triggerMode,
    '--session=open-0930|open-1000',
    '--direction=both|long',
    '--min-alpha-quality=55',
    '--target-r=' + profile.targetR,
    '--trail-r=' + profile.trailR,
    '--partial-r=' + profile.partialR,
    '--time-stop-bars=' + profile.timeStopBars,
    '--confidence-drop=' + profile.confidenceDrop,
    '--structure-exit=' + profile.structureExit,
    '--min-route-trades=5',
    '--min-route-days=3',
    '--min-route-weeks=2',
  ], `phase3 ${profile.name}`);
  const registry = readJson(join(playbooksDir, 'master-scalp-champion-registry.json'));
  const latest = registry.challengers?.[0];
  results.push({ profile, latest, score: score(latest?.metrics) });
}

results.sort((a, b) => b.score - a.score);
const mainPath = join(playbooksDir, 'current-master-scalp-champion.json');
const main = existsSync(mainPath) ? readJson(mainPath) : null;
const current = main?.champion?.metrics || {};
const best = results[0];
const bestMetrics = best.latest?.metrics || {};
const beatsMain = bestMetrics.trades >= Math.min(500, (current.trades || 0) * 0.75)
  && bestMetrics.winRate >= (current.winRate || 0) - 1
  && bestMetrics.projectedNet >= (current.projectedNet || 0)
  && bestMetrics.profitFactor >= Math.min(current.profitFactor || 0, 10);
const specialist = !beatsMain && bestMetrics.winRate >= 84 && bestMetrics.profitFactor >= 4 && bestMetrics.projectedNet > 0;
const payload = {
  updatedAt: new Date().toISOString(),
  runId,
  symbols: symbols.length,
  currentMain: current,
  results,
  best: {
    profile: best.profile.name,
    metrics: bestMetrics,
    snapshotPath: best.latest?.path,
    score: best.score,
  },
  promotion: {
    beatsMain,
    specialist,
    decision: beatsMain ? 'main-candidate' : specialist ? 'specialist-module' : 'research-only',
  },
};

const outPath = join(playbooksDir, 'current-phase3-exit-tournament.json');
writeFileSync(outPath, `${JSON.stringify(payload, null, 2)}\n`);
appendFileSync(join(playbooksDir, 'phase3-exit-tournament-history.jsonl'), `${JSON.stringify(payload)}\n`);
if (beatsMain) writeFileSync(join(playbooksDir, 'current-phase3-main-candidate.json'), `${JSON.stringify(payload, null, 2)}\n`);
if (specialist) writeFileSync(join(playbooksDir, 'current-phase3-specialist-candidate.json'), `${JSON.stringify(payload, null, 2)}\n`);

console.log('\n=== phase 3 complete ===');
console.log(`Saved: ${outPath}`);
console.log(`Best profile=${payload.best.profile} trades=${bestMetrics.trades || 0} win=${(bestMetrics.winRate || 0).toFixed(2)} pf=${(bestMetrics.profitFactor || 0).toFixed(2)} projected=$${(bestMetrics.projectedNet || 0).toFixed(0)} avg=$${(bestMetrics.projectedAvgDollars || 0).toFixed(2)}`);
console.log(`Decision=${payload.promotion.decision}`);
