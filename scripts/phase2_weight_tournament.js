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
const symbolsRaw = args.get('symbols') || (existsSync(symbolFile) ? readFileSync(symbolFile, 'utf8') : 'NVDA,TSLA,AMD,PLTR,COIN,QQQ,SPY');
const maxSymbols = Number(args.get('max-symbols') || 30);
const symbols = symbolsRaw
  .split(/[\s,]+/)
  .map((symbol) => symbol.trim().toUpperCase())
  .filter(Boolean)
  .filter((symbol, index, all) => all.indexOf(symbol) === index)
  .slice(0, maxSymbols);
const capital = Number(args.get('capital') || 100000);
const candidates = Number(args.get('candidates') || 3);
const range = args.get('range') || '60d';

const families = [
  {
    name: 'momentum_profit',
    triggers: 'momentum-acceleration|opening-drive-continuation',
    targetR: '0.5|0.75',
    timeStopBars: '6',
    minAlphaQuality: '55|65',
    minIntelScore: '45',
  },
  {
    name: 'structure_reclaim',
    triggers: 'liquidity-sweep|relative-strength-reclaim',
    targetR: '0.35|0.5',
    timeStopBars: '6',
    minAlphaQuality: '55|65',
    minIntelScore: '45',
  },
  {
    name: 'breakout_expansion',
    triggers: 'breakout|compression-pop',
    targetR: '0.35|0.5|0.75',
    timeStopBars: '6',
    minAlphaQuality: '55|65',
    minIntelScore: '45',
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
  process.stdout.write(output.split('\n').slice(-16).join('\n'));
  if (!output.endsWith('\n')) process.stdout.write('\n');
  return output;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function scoreResult(result) {
  const best = result.bestPortfolio?.portfolio || {};
  return (best.winRate || 0) * 1.35
    + Math.min((best.projectedNet || 0) / 100, 250)
    + Math.min(best.trades || 0, 500) * 0.14
    + Math.min(best.profitFactor || 0, 12) * 7
    - Math.min((best.maxDrawdownDollars || 0) / 125, 70)
    - (best.maxLossStreak || 0) * 10;
}

const results = [];
for (const family of families) {
  runNode('scripts/scalp_weight_batch_optimizer.js', [
    `--symbols=${symbols.join(',')}`,
    `--candidates=${candidates}`,
    `--max-symbols=${symbols.length}`,
    `--range=${range}`,
    `--capital=${capital}`,
    '--quick=true',
    '--micro=true',
    '--stress=true',
    `--trigger-mode=${family.triggers}`,
    `--target-r=${family.targetR}`,
    `--time-stop-bars=${family.timeStopBars}`,
    '--session=open-0930',
    '--direction=both|long',
    '--adaptive-target=false',
    '--volume-quality=off',
    `--min-alpha-quality=${family.minAlphaQuality}`,
    `--min-intel-score=${family.minIntelScore}`,
  ], `phase2 ${family.name}`);
  const resultPath = join(playbooksDir, 'current-batched-weight-optimizer.json');
  const result = readJson(resultPath);
  const snapshotPath = join(playbooksDir, `phase2-${family.name}-${runId}.json`);
  writeFileSync(snapshotPath, `${JSON.stringify({ family: family.name, snapshotPath, ...result }, null, 2)}\n`);
  results.push({ family: family.name, snapshotPath, score: scoreResult(result), result });
}

results.sort((a, b) => b.score - a.score);
const mainChampionPath = join(playbooksDir, 'current-master-scalp-champion.json');
const currentMain = existsSync(mainChampionPath) ? readJson(mainChampionPath) : null;
const best = results[0];
const bestMetrics = best?.result?.bestPortfolio?.portfolio || {};
const currentMetrics = currentMain?.champion?.metrics || {};
const beatsMain = bestMetrics.trades >= Math.min(500, (currentMetrics.trades || 0) * 0.75)
  && bestMetrics.winRate >= (currentMetrics.winRate || 0) - 1
  && bestMetrics.projectedNet >= (currentMetrics.projectedNet || 0)
  && bestMetrics.profitFactor >= Math.min(currentMetrics.profitFactor || 0, 10);
const specialist = !beatsMain && bestMetrics.winRate >= 84 && bestMetrics.profitFactor >= 4 && bestMetrics.projectedNet > 0;

const payload = {
  updatedAt: new Date().toISOString(),
  runId,
  symbols: symbols.length,
  candidatesPerFamily: candidates,
  families: results.map(({ family, snapshotPath, score, result }) => ({
    family,
    snapshotPath,
    score,
    decision: result.promotion?.decision,
    metrics: result.bestPortfolio?.portfolio,
    topWeightSets: result.setLeaderboard?.slice(0, 8),
  })),
  currentMain: currentMetrics,
  best: {
    family: best.family,
    snapshotPath: best.snapshotPath,
    score: best.score,
    metrics: bestMetrics,
  },
  promotion: {
    beatsMain,
    specialist,
    decision: beatsMain ? 'main-candidate' : specialist ? 'specialist-module' : 'research-only',
  },
};

const outPath = join(playbooksDir, 'current-phase2-weight-tournament.json');
writeFileSync(outPath, `${JSON.stringify(payload, null, 2)}\n`);
appendFileSync(join(playbooksDir, 'phase2-weight-tournament-history.jsonl'), `${JSON.stringify(payload)}\n`);
if (beatsMain) writeFileSync(join(playbooksDir, 'current-phase2-main-candidate.json'), `${JSON.stringify(payload, null, 2)}\n`);
if (specialist) writeFileSync(join(playbooksDir, 'current-phase2-specialist-candidate.json'), `${JSON.stringify(payload, null, 2)}\n`);

console.log('\n=== phase 2 complete ===');
console.log(`Saved: ${outPath}`);
console.log(`Best family=${payload.best.family} trades=${bestMetrics.trades || 0} win=${(bestMetrics.winRate || 0).toFixed(2)} pf=${(bestMetrics.profitFactor || 0).toFixed(2)} projected=$${(bestMetrics.projectedNet || 0).toFixed(0)} avg=$${(bestMetrics.projectedAvgDollars || 0).toFixed(2)}`);
console.log(`Decision=${payload.promotion.decision}`);
