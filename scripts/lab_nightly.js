#!/usr/bin/env node
import { existsSync, mkdirSync, copyFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

function run(command, args) {
  console.log(`\n$ ${command} ${args.join(' ')}`);
  execFileSync(command, args, { cwd: root, stdio: 'inherit' });
}

function syncLegacyModels() {
  const playbooks = join(root, 'optimization-results', 'models', 'playbooks');
  mkdirSync(playbooks, { recursive: true });
  const copies = [
    ['models/champions/current-phase19-champion-council-fusion.json', 'optimization-results/models/playbooks/current-phase19-champion-council-fusion.json'],
    ['models/registry/current-active-scalp-modes.json', 'optimization-results/models/playbooks/current-active-scalp-modes.json'],
    ['models/specialists/current-phase17-specialist-tournament.json', 'optimization-results/models/playbooks/current-phase17-specialist-tournament.json'],
    ['models/specialists/current-live-scalp-champions.json', 'optimization-results/models/playbooks/current-live-scalp-champions.json'],
  ];
  for (const [from, to] of copies) {
    const source = join(root, from);
    const target = join(root, to);
    if (existsSync(source)) {
      mkdirSync(dirname(target), { recursive: true });
      copyFileSync(source, target);
    }
  }
}

syncLegacyModels();

const shouldBacktest = process.argv.includes('--backtest');
const shouldPattern = process.argv.includes('--pattern') || process.env.FUSION_RUN_PATTERN_LAB === 'true';
const shouldSelfImprove = process.argv.includes('--self-improve') || process.env.FUSION_RUN_PHASE24 === 'true';
const hasFullCanonical = existsSync(join(root, 'optimization-results', 'canonical', 'canonical-trades.full.jsonl'));

if (shouldBacktest) {
  run('node', ['scripts/phase19_champion_council_fusion.js', '--fresh-data=true']);
}

if (shouldPattern) {
  run('node', ['packages/pattern-lab/pattern_lab.js']);
} else {
  console.log('\nSkipping Pattern Lab by default to avoid overwriting committed canonical outputs without full raw ledgers.');
  console.log('Use --pattern or FUSION_RUN_PATTERN_LAB=true when full input ledgers are available.');
}

if (shouldSelfImprove && hasFullCanonical) {
  run('node', ['scripts/phase24_self_improvement_loop.js']);
  run('node', ['scripts/options_data_probe.js']);
} else if (shouldSelfImprove) {
  console.log('\nSkipping Phase24 self-improvement because optimization-results/canonical/canonical-trades.full.jsonl is not present.');
}

run('node', ['packages/pine-export/sync_pine_metadata.js']);
run('node', ['scripts/build_dashboard_data.js']);
run('node', ['scripts/validate_lab_outputs.js']);

console.log('\nNightly lab run complete');
