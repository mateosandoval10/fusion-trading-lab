#!/usr/bin/env node
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const playbooksDir = join(root, 'optimization-results', 'models', 'playbooks');
const generatedDir = join(root, 'generated');
for (const dir of [playbooksDir, generatedDir]) mkdirSync(dir, { recursive: true });

const championPath = join(playbooksDir, 'current-master-scalp-champion.json');
const phase14Path = join(playbooksDir, 'current-phase14-candidate-validation.json');
const phase13Path = join(playbooksDir, 'current-phase13-satellite-pocket-tuner.json');
if (!existsSync(championPath)) throw new Error(`Missing champion: ${championPath}`);
if (!existsSync(phase14Path)) throw new Error(`Missing Phase 14 validation: ${phase14Path}`);
if (!existsSync(phase13Path)) throw new Error(`Missing Phase 13 candidate: ${phase13Path}`);

const champion = JSON.parse(readFileSync(championPath, 'utf8'));
const validation = JSON.parse(readFileSync(phase14Path, 'utf8'));
const phase13 = JSON.parse(readFileSync(phase13Path, 'utf8'));

const highWin = {
  name: 'High Win Main',
  status: 'active-main',
  mode: 'high_win',
  source: 'current-master-scalp-champion',
  description: 'Conservative route champion for safety-first scalp signals.',
  metrics: champion.champion.metrics,
  rules: {
    routeCount: champion.champion.routes.length,
    routeIds: champion.champion.routes.map((route) => route.id),
    preferredUse: 'default indicator BUY/SELL labels',
    activation: 'always available; prioritize when user wants highest modeled accuracy',
  },
};

const profitMax = {
  name: 'Profit Max Specialist',
  status: validation.activation.activate ? 'active-specialist' : 'watchlist-specialist',
  mode: 'profit_max',
  source: 'phase14-candidate-validation',
  description: 'Aggressive validated satellite fusion mode; much higher modeled profit but lower win rate than main champion.',
  metrics: validation.fused,
  stress: validation.stress,
  satelliteOnly: validation.satelliteOnly,
  validationDecision: validation.activation.decision,
  candidate: validation.candidate,
  rules: {
    bestVariant: validation.bestVariant,
    families: validation.candidate.families,
    triggers: validation.candidate.triggers,
    regimes: validation.candidate.regimes,
    maxTrap: validation.candidate.maxTrap,
    maxVwap: validation.candidate.maxVwap,
    minMomentum: validation.candidate.minMomentum,
    minRelativeStrength: validation.candidate.minRelativeStrength,
    minFastMove: validation.candidate.minFastMove,
    minOptionShape: validation.candidate.minOptionShape,
    requireFastOrOption: validation.candidate.requireFastOrOption,
    preferredUse: 'optional aggressive mode / profit-max labels / paper watchlist',
    activation: 'not main default because win rate missed validation floor; usable as separate specialist',
  },
};

const modeSelector = {
  defaultMode: 'high_win',
  modes: ['high_win', 'profit_max'],
  selectionRules: [
    { condition: 'User wants safest/highest win-rate signal', mode: 'high_win' },
    { condition: 'User wants aggressive modeled profit and accepts lower win rate', mode: 'profit_max' },
    { condition: 'Forward/paper performance of profit_max falls below 85% or loss streak > 2', mode: 'high_win' },
    { condition: 'Profit Max forward performance exceeds 90% with 120+ paper trades', mode: 'consider-main-promotion' },
  ],
  noTradeBadges: [
    'Profit Max is watchlist-only until forward proof improves',
    'High Win is current default',
    'Backtest/paper evidence required before main promotion',
  ],
};

const comparison = {
  highWin: highWin.metrics,
  profitMax: profitMax.metrics,
  profitMaxStress: profitMax.stress,
  deltas: {
    trades: profitMax.metrics.trades - highWin.metrics.trades,
    winRate: profitMax.metrics.winRate - highWin.metrics.winRate,
    netDollars: profitMax.metrics.netDollars - highWin.metrics.netDollars,
    projectedNet: profitMax.metrics.projectedNet - highWin.metrics.projectedNet,
    profitFactor: profitMax.metrics.profitFactor - highWin.metrics.profitFactor,
  },
};

const payload = {
  updatedAt: new Date().toISOString(),
  phase: 'phase15-dual-champion-system',
  goal: 'separate high-win default signals from aggressive profit-max specialist instead of forcing one model to optimize both',
  guardrails: [
    'High Win remains default main champion',
    'Profit Max is not silently promoted because validation win rate missed the floor',
    'Both modes are exported separately for indicator/dashboard/paper testing',
    'Future forward results should update mode trust independently',
  ],
  highWin,
  profitMax,
  modeSelector,
  comparison,
  sourcePaths: { championPath, phase13Path, phase14Path, validationCoreLedger: validation.paths.coreLedger, validationSatelliteLedger: validation.paths.satelliteLedger },
};

const outPath = join(playbooksDir, 'current-phase15-dual-champion-system.json');
writeFileSync(outPath, `${JSON.stringify(payload, null, 2)}\n`);
appendFileSync(join(playbooksDir, 'phase15-dual-champion-system-history.jsonl'), `${JSON.stringify(payload)}\n`);

const activePath = join(playbooksDir, 'current-active-scalp-modes.json');
writeFileSync(activePath, `${JSON.stringify({
  updatedAt: payload.updatedAt,
  defaultMode: modeSelector.defaultMode,
  activeModes: {
    high_win: highWin,
    profit_max: profitMax,
  },
  comparison,
  modeSelector,
}, null, 2)}\n`);

const pineExportPath = join(generatedDir, 'dual_champion_modes_export.json');
writeFileSync(pineExportPath, `${JSON.stringify({
  generatedAt: payload.updatedAt,
  defaultMode: modeSelector.defaultMode,
  modes: {
    high_win: {
      label: 'High Win Main',
      status: highWin.status,
      winRate: highWin.metrics.winRate,
      trades: highWin.metrics.trades,
      netDollars: highWin.metrics.netDollars,
      profitFactor: highWin.metrics.profitFactor,
      dashboardBadge: `HIGH WIN · ${highWin.metrics.winRate.toFixed(1)}% · ${highWin.metrics.trades} trades`,
    },
    profit_max: {
      label: 'Profit Max Specialist',
      status: profitMax.status,
      winRate: profitMax.metrics.winRate,
      trades: profitMax.metrics.trades,
      netDollars: profitMax.metrics.netDollars,
      profitFactor: profitMax.metrics.profitFactor,
      stressNetDollars: profitMax.stress.netDollars,
      dashboardBadge: `PROFIT MAX · ${profitMax.metrics.winRate.toFixed(1)}% · $${Math.round(profitMax.metrics.netDollars).toLocaleString()}`,
      warning: 'Aggressive mode; not default until forward proof improves.',
    },
  },
  selectorRows: modeSelector.noTradeBadges,
}, null, 2)}\n`);

console.log('\n=== phase 15 dual champion system ===');
console.log(`Saved: ${outPath}`);
console.log(`Active modes: ${activePath}`);
console.log(`Pine/export metadata: ${pineExportPath}`);
console.log(`High Win: trades=${highWin.metrics.trades} win=${highWin.metrics.winRate.toFixed(2)} pf=${highWin.metrics.profitFactor.toFixed(2)} net=$${highWin.metrics.netDollars.toFixed(0)} projected=$${highWin.metrics.projectedNet.toFixed(0)}`);
console.log(`Profit Max: trades=${profitMax.metrics.trades} win=${profitMax.metrics.winRate.toFixed(2)} pf=${profitMax.metrics.profitFactor.toFixed(2)} net=$${profitMax.metrics.netDollars.toFixed(0)} projected=$${profitMax.metrics.projectedNet.toFixed(0)} status=${profitMax.status}`);
console.log(`Default mode=${modeSelector.defaultMode}`);
