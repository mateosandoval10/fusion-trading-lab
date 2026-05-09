#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const playbooksDir = join(root, 'optimization-results', 'models', 'playbooks');
if (!existsSync(playbooksDir)) mkdirSync(playbooksDir, { recursive: true });

const symbols = (process.argv.find((arg) => arg.startsWith('--symbols='))?.split('=')[1]
  || 'MSFT,AAPL,TSLA,PLTR,GOOGL,HOOD,AVGO,COIN,ASTS,AI,QS,AFRM,UPST,RIOT,OPEN,LCID,IONQ')
  .split(',')
  .map((symbol) => symbol.trim().toUpperCase())
  .filter(Boolean);

const capital = process.argv.find((arg) => arg.startsWith('--capital='))?.split('=')[1] || '100000';
const baseArgs = [
  `--symbols=${symbols.join(',')}`,
  '--interval=5m',
  '--range=60d',
  `--capital=${capital}`,
  '--playbook=Scalp',
  '--min-conf=70',
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
  '--loss-cooldown-bars=0',
  '--max-vwap-atr=0',
  '--require-conf-rising=false|true',
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
  '--min-trades=40',
  '--min-symbols=6',
  '--promote=false',
];

const challengers = [
  {
    name: 'protected_route_champion',
    args: ['--target-r=0.5', '--time-stop-bars=9', '--session=all', '--direction=short', '--slippage-bps=1', '--spread-bps=2', '--market-mode=off', '--rel-vol-mode=off', '--min-rel-vol-tod=1', '--peer-mode=off', '--news-mode=off', '--position-sizing=fixed', '--min-position-scale=1', '--max-position-scale=1'],
  },
  {
    name: 'route_champion_conf_sized',
    args: ['--target-r=0.5', '--time-stop-bars=9', '--session=all', '--direction=short', '--slippage-bps=1', '--spread-bps=2', '--market-mode=off', '--rel-vol-mode=off', '--min-rel-vol-tod=1', '--peer-mode=off', '--news-mode=off|avoid-spike', '--position-sizing=confidence', '--min-position-scale=0.5', '--max-position-scale=1.25'],
  },
  {
    name: 'route_champion_loss_guard',
    args: ['--target-r=0.5', '--time-stop-bars=9', '--session=all', '--direction=short', '--slippage-bps=1', '--spread-bps=2', '--market-mode=off', '--rel-vol-mode=off', '--min-rel-vol-tod=1', '--peer-mode=off', '--news-mode=off', '--position-sizing=fixed', '--min-position-scale=1', '--max-position-scale=1', '--max-consecutive-losses=1|2', '--cluster-cooldown-bars=6|12', '--loss-cooldown-bars=3|6'],
  },
  {
    name: 'baseline_realistic',
    args: ['--session=all|open', '--direction=both|short', '--slippage-bps=1', '--spread-bps=2', '--market-mode=off', '--rel-vol-mode=off', '--min-rel-vol-tod=1', '--peer-mode=off', '--news-mode=off', '--position-sizing=fixed', '--min-position-scale=1', '--max-position-scale=1'],
  },
  {
    name: 'market_aligned',
    args: ['--session=all|open', '--direction=both|short', '--slippage-bps=1', '--spread-bps=2', '--market-mode=spy|qqq|both', '--rel-vol-mode=off', '--min-rel-vol-tod=1', '--peer-mode=off', '--news-mode=off', '--position-sizing=fixed', '--min-position-scale=1', '--max-position-scale=1'],
  },
  {
    name: 'relative_volume',
    args: ['--session=all|open', '--direction=both|short', '--slippage-bps=1', '--spread-bps=2', '--market-mode=off', '--rel-vol-mode=tod|tod-or-raw', '--min-rel-vol-tod=1.2|1.5', '--peer-mode=off', '--news-mode=off', '--position-sizing=fixed', '--min-position-scale=1', '--max-position-scale=1'],
  },
  {
    name: 'peer_confirmed',
    args: ['--session=all|open', '--direction=both|short', '--slippage-bps=1', '--spread-bps=2', '--market-mode=off|qqq', '--rel-vol-mode=off', '--min-rel-vol-tod=1', '--peer-mode=peer|peer-and-qqq', '--news-mode=off', '--position-sizing=fixed', '--min-position-scale=1', '--max-position-scale=1'],
  },
  {
    name: 'news_filtered_sizing',
    args: ['--session=all|open|open-0930|open-1000|open-1030', '--direction=both|short', '--slippage-bps=1', '--spread-bps=2', '--market-mode=off', '--rel-vol-mode=off', '--min-rel-vol-tod=1', '--peer-mode=off', '--news-mode=avoid-spike', '--position-sizing=fixed|confidence', '--min-position-scale=0.5', '--max-position-scale=1.25'],
  },
];

function runBacktest(name, phase, extraArgs) {
  const args = ['scripts/local_fusion_backtest.js', ...baseArgs, ...extraArgs, `--sample=${phase}`, '--train-pct=0.70'];
  const output = execFileSync('node', args, { cwd: root, encoding: 'utf8', maxBuffer: 1024 * 1024 * 20 });
  const summaryPath = output.match(/Summary: (.*\.json)/)?.[1];
  if (!summaryPath) throw new Error(`${name}/${phase} did not produce a summary path`);
  const data = JSON.parse(readFileSync(summaryPath, 'utf8'));
  return { phase, summaryPath, data };
}

function compact(row) {
  if (!row) return null;
  return {
    symbols: row.symbols,
    trades: row.totalTrades,
    winRate: row.avgWinRate,
    profitFactor: row.avgProfitFactor,
    netDollars: row.totalNetDollars,
    avgDollars: row.avgDollars,
    avgR: row.avgR,
    avgMaxDrawdownDollars: row.avgMaxDrawdownDollars,
    avgMaxLossStreak: row.avgMaxLossStreak,
    combo: row.combo,
  };
}

const lab = [];
for (const challenger of challengers) {
  console.log(`\n=== ${challenger.name} train ===`);
  const train = runBacktest(challenger.name, 'train', challenger.args);
  const trainBest = train.data.promotion.playbooks.Scalp.candidate || train.data.summary[0];
  const comboArgs = Object.entries(trainBest.combo).flatMap(([key, value]) => [`--${key.replace(/[A-Z]/g, (char) => `-${char.toLowerCase()}`)}=${value}`]);
  console.log(`train trades=${trainBest.totalTrades} win=${trainBest.avgWinRate.toFixed(2)} net=$${trainBest.totalNetDollars.toFixed(0)}`);

  console.log(`=== ${challenger.name} test ===`);
  const test = runBacktest(challenger.name, 'test', comboArgs);
  const testBest = test.data.summary[0];
  console.log(`test trades=${testBest.totalTrades} win=${testBest.avgWinRate.toFixed(2)} net=$${testBest.totalNetDollars.toFixed(0)}`);

  console.log(`=== ${challenger.name} stress ===`);
  const stressArgs = comboArgs
    .filter((arg) => !arg.startsWith('--slippage-bps=') && !arg.startsWith('--spread-bps='))
    .concat(['--slippage-bps=3', '--spread-bps=12']);
  const stress = runBacktest(challenger.name, 'test', stressArgs);
  const stressBest = stress.data.summary[0];
  console.log(`stress trades=${stressBest.totalTrades} win=${stressBest.avgWinRate.toFixed(2)} net=$${stressBest.totalNetDollars.toFixed(0)}`);

  const promoted = testBest.totalTrades >= 20
    && testBest.avgWinRate >= 62
    && testBest.totalNetDollars > 0
    && testBest.avgProfitFactor >= 1.2
    && stressBest.totalNetDollars > 0
    && (testBest.avgMaxLossStreak ?? 99) <= 3;

  lab.push({
    name: challenger.name,
    promoted,
    train: compact(trainBest),
    test: compact(testBest),
    stress: compact(stressBest),
    paths: { train: train.summaryPath, test: test.summaryPath, stress: stress.summaryPath },
    routingLeaderboard: test.data.routingLeaderboard?.slice(0, 30) || [],
    liveWhitelist: test.data.liveWhitelist || [],
  });
}

const champions = lab
  .filter((row) => row.promoted)
  .sort((a, b) => (b.test.winRate - a.test.winRate) || (b.test.netDollars - a.test.netDollars));
const demoted = lab.filter((row) => !row.promoted);
const routeChampionPath = join(playbooksDir, 'current-best-scalp-routing-whitelist.json');
const protectedRouteChampion = existsSync(routeChampionPath) ? JSON.parse(readFileSync(routeChampionPath, 'utf8')).champion : null;
const out = join(playbooksDir, 'current-best-scalp-challenger-lab.json');
const liveChampionsPath = join(playbooksDir, 'current-live-scalp-champions.json');
const demotedPath = join(playbooksDir, 'current-demoted-scalp-routes.json');
const payload = {
  updatedAt: new Date().toISOString(),
  symbols,
  protectedRouteChampion,
  promotionRules: {
    minTestTrades: 20,
    minTestWinRate: 62,
    minTestProfitFactor: 1.2,
    requirePositiveTestNet: true,
    requirePositiveStressNet: true,
    maxAvgLossStreak: 3,
  },
  champions,
  demoted,
  challengers: lab,
};
writeFileSync(out, `${JSON.stringify({
  ...payload,
}, null, 2)}\n`);
writeFileSync(liveChampionsPath, `${JSON.stringify({
  updatedAt: payload.updatedAt,
  symbols,
  champions,
  best: champions[0] || null,
}, null, 2)}\n`);
writeFileSync(demotedPath, `${JSON.stringify({
  updatedAt: payload.updatedAt,
  symbols,
  demoted,
}, null, 2)}\n`);

console.log(`\nChallenger lab saved: ${out}`);
console.log(`Live champions saved: ${liveChampionsPath}`);
console.log(`Demoted routes saved: ${demotedPath}`);
console.log('\nChampions:');
for (const champion of champions) {
  console.log(`${champion.name}: test trades=${champion.test.trades} win=${champion.test.winRate.toFixed(2)} net=$${champion.test.netDollars.toFixed(0)} stressNet=$${champion.stress.netDollars.toFixed(0)}`);
}
