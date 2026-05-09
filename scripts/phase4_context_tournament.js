#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
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

const runId = new Date().toISOString().replace(/[:.]/g, '-');
const symbolFile = args.get('symbol-file') || join(root, 'config', 'scalp-symbols-fresh-slice-2.txt');
const text = args.get('symbols') || (existsSync(symbolFile) ? readFileSync(symbolFile, 'utf8') : 'NVDA,AMD,TSLA,COIN,QQQ,SPY');
const maxSymbols = Number(args.get('max-symbols') || 50);
const symbols = text.split(/[\s,]+/).map((symbol) => symbol.trim().toUpperCase()).filter(Boolean)
  .filter((symbol, index, all) => all.indexOf(symbol) === index).slice(0, maxSymbols);
const range = args.get('range') || '60d';
const capital = Number(args.get('capital') || 100000);

const profiles = [
  { name: 'market_permission', marketMode: 'aligned', peerMode: 'off', relVolMode: 'off', minRelVolTod: '1', dailyContext: 'trend-day', triggerMode: 'volume-shock|breakout|momentum-acceleration' },
  { name: 'peer_confirmed', marketMode: 'off', peerMode: 'aligned', relVolMode: 'off', minRelVolTod: '1', dailyContext: 'trend-day', triggerMode: 'volume-shock|momentum-acceleration|relative-strength-reclaim' },
  { name: 'clean_relvol', marketMode: 'aligned', peerMode: 'off', relVolMode: 'tod', minRelVolTod: '1.2', dailyContext: 'trend-day', triggerMode: 'volume-shock|breakout|opening-drive-continuation' },
  { name: 'full_context', marketMode: 'aligned', peerMode: 'aligned', relVolMode: 'tod', minRelVolTod: '1.1', dailyContext: 'trend-day', triggerMode: 'momentum-acceleration|breakout|relative-strength-reclaim|opening-drive-continuation' },
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
  return (metrics.winRate || 0) * 1.3
    + Math.min((metrics.projectedNet || 0) / 100, 260)
    + Math.min(metrics.trades || 0, 600) * 0.15
    + Math.min(metrics.profitFactor || 0, 14) * 7
    + Math.min(metrics.avgMonteCarloSurvival || 0, 100) * 0.2;
}

const results = [];
for (const profile of profiles) {
  runNode('scripts/master_scalp_learning_sprint.js', [
    `--symbols=${symbols.join(',')}`,
    `--range=${range}`,
    `--capital=${capital}`,
    '--quick=true',
    '--focused=true',
    `--trigger-mode=${profile.triggerMode}`,
    '--target-r=0.35|0.5',
    '--trail-r=0.35|0.5',
    '--partial-r=0.5|1',
    '--time-stop-bars=6',
    '--confidence-drop=18|25',
    '--structure-exit=loose|strict',
    '--session=open-0930|open-1000',
    '--direction=both|long|short',
    `--market-mode=${profile.marketMode}`,
    `--peer-mode=${profile.peerMode}`,
    `--rel-vol-mode=${profile.relVolMode}`,
    `--min-rel-vol-tod=${profile.minRelVolTod}`,
    `--daily-context=${profile.dailyContext}`,
    '--min-route-trades=5',
    '--min-route-days=3',
    '--min-route-weeks=2',
  ], `phase4 ${profile.name}`);
  const registry = readJson(join(playbooksDir, 'master-scalp-champion-registry.json'));
  const latest = registry.challengers?.[0];
  results.push({ profile, latest, score: score(latest?.metrics) });
}

results.sort((a, b) => b.score - a.score);
const main = existsSync(join(playbooksDir, 'current-master-scalp-champion.json'))
  ? readJson(join(playbooksDir, 'current-master-scalp-champion.json'))
  : null;
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
  best: { profile: best.profile.name, metrics: bestMetrics, snapshotPath: best.latest?.path, score: best.score },
  promotion: { beatsMain, specialist, decision: beatsMain ? 'main-candidate' : specialist ? 'specialist-module' : 'research-only' },
};

const outPath = join(playbooksDir, 'current-phase4-context-tournament.json');
writeFileSync(outPath, `${JSON.stringify(payload, null, 2)}\n`);
appendFileSync(join(playbooksDir, 'phase4-context-tournament-history.jsonl'), `${JSON.stringify(payload)}\n`);
if (beatsMain) writeFileSync(join(playbooksDir, 'current-phase4-main-candidate.json'), `${JSON.stringify(payload, null, 2)}\n`);
if (specialist) writeFileSync(join(playbooksDir, 'current-phase4-specialist-candidate.json'), `${JSON.stringify(payload, null, 2)}\n`);

console.log('\n=== phase 4 complete ===');
console.log(`Saved: ${outPath}`);
console.log(`Best profile=${payload.best.profile} trades=${bestMetrics.trades || 0} win=${(bestMetrics.winRate || 0).toFixed(2)} pf=${(bestMetrics.profitFactor || 0).toFixed(2)} projected=$${(bestMetrics.projectedNet || 0).toFixed(0)}`);
console.log(`Decision=${payload.promotion.decision}`);
