#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

const required = [
  'models/champions/current-phase19-champion-council-fusion.json',
  'models/champions/current-phase23-intelligence-specialist.json',
  'models/self-improvement/current-phase24-self-improvement.json',
  'models/fresh-symbol/current-phase25-fresh-symbol-tournament.json',
  'models/generalization/current-phase26-generalization-engine.json',
  'models/pattern-lab/current-pattern-lab.json',
  'models/specialists/pattern-specialist-candidates.json',
  'models/specialists/phase21-specialist-factory.json',
  'data/canonical/canonical-summary.json',
  'apps/dashboard/public/data/dashboard.json',
  'apps/dashboard/public/data/canonical-data.json',
  'apps/dashboard/public/data/phase23-intelligence-specialist.json',
  'apps/dashboard/public/data/phase23-intelligence-trade-ledgers.json',
  'apps/dashboard/public/data/phase24-self-improvement.json',
  'apps/dashboard/public/data/phase24-trade-ledgers.json',
  'apps/dashboard/public/data/phase25-fresh-symbol-tournament.json',
  'apps/dashboard/public/data/phase25-fresh-symbol-trade-ledgers.json',
  'apps/dashboard/public/data/phase26-generalization-engine.json',
  'apps/dashboard/public/data/phase26-generalization-trade-ledgers.json',
  'apps/dashboard/public/data/options-data-probe.json',
  'apps/dashboard/public/data/tradingview-mcp-snapshot.json',
  'apps/dashboard/public/data/phase22-trade-ledgers.json',
  'apps/dashboard/public/index.html',
  'generated/fusionv3_codex_clean_tradingview.pine',
];

const missing = required.filter((path) => !existsSync(join(root, path)));
if (missing.length) {
  console.error(`Missing required lab outputs:\\n${missing.join('\\n')}`);
  process.exit(1);
}

const dashboard = JSON.parse(readFileSync(join(root, 'apps/dashboard/public/data/dashboard.json'), 'utf8'));
if (!dashboard.champion?.bestVariant) throw new Error('Dashboard has no champion bestVariant');
if (!dashboard.pine?.hasClosedLoopAlert) throw new Error('Pine export does not expose closed-loop alert payload');
if (!dashboard.canonical?.stats?.canonicalTrades) throw new Error('Dashboard has no canonical trade spine');
if (dashboard.canonical.stats.canonicalTrades < 1000) throw new Error('Canonical trade spine is unexpectedly small; rerun with the full ledger source before publishing');
if (!Array.isArray(dashboard.specialistFactory)) throw new Error('Dashboard has no Phase21 specialist factory list');
if (!dashboard.phase23?.recommendedChampion) throw new Error('Dashboard has no Phase23 recommended champion');
if (!dashboard.phase24?.categoryChampions?.bestProfit) throw new Error('Dashboard has no Phase24 best profit champion');
if (!dashboard.phase25?.categoryChampions?.bestProfit) throw new Error('Dashboard has no Phase25 fresh-symbol best profit champion');
if (!dashboard.phase26?.categoryChampions?.bestOverall) throw new Error('Dashboard has no Phase26 generalization champion');
if (!dashboard.phase26?.improvementCoverage?.length) throw new Error('Dashboard has no Phase26 implementation coverage');
if (!dashboard.optionsProbe?.rows?.length) throw new Error('Dashboard has no options probe rows');
if (!dashboard.tradingViewMcp?.quote?.symbol) throw new Error('Dashboard has no TradingView MCP snapshot');
const phase22Trades = JSON.parse(readFileSync(join(root, 'apps/dashboard/public/data/phase22-trade-ledgers.json'), 'utf8'));
if (!phase22Trades.ledgers || !Object.keys(phase22Trades.ledgers).length) throw new Error('Phase22 trade ledgers are empty');
const phase23Trades = JSON.parse(readFileSync(join(root, 'apps/dashboard/public/data/phase23-intelligence-trade-ledgers.json'), 'utf8'));
if (!phase23Trades.ledgers || !Object.keys(phase23Trades.ledgers).length) throw new Error('Phase23 trade ledgers are empty');
const phase24Trades = JSON.parse(readFileSync(join(root, 'apps/dashboard/public/data/phase24-trade-ledgers.json'), 'utf8'));
if (!phase24Trades.ledgers || !Object.keys(phase24Trades.ledgers).length) throw new Error('Phase24 trade ledgers are empty');
const phase25Trades = JSON.parse(readFileSync(join(root, 'apps/dashboard/public/data/phase25-fresh-symbol-trade-ledgers.json'), 'utf8'));
if (!phase25Trades.ledgers || !Object.keys(phase25Trades.ledgers).length) throw new Error('Phase25 trade ledgers are empty');
const phase26Trades = JSON.parse(readFileSync(join(root, 'apps/dashboard/public/data/phase26-generalization-trade-ledgers.json'), 'utf8'));
if (!phase26Trades.ledgers || !Object.keys(phase26Trades.ledgers).length) throw new Error('Phase26 trade ledgers are empty');

console.log('Lab validation passed');
