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
if (shouldBacktest) {
  run('node', ['scripts/phase19_champion_council_fusion.js', '--fresh-data=true']);
}

run('node', ['packages/pattern-lab/pattern_lab.js']);
run('node', ['packages/pine-export/sync_pine_metadata.js']);
run('node', ['scripts/build_dashboard_data.js']);
run('node', ['scripts/validate_lab_outputs.js']);

console.log('\nNightly lab run complete');
