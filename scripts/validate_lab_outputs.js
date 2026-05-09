#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

const required = [
  'models/champions/current-phase19-champion-council-fusion.json',
  'models/pattern-lab/current-pattern-lab.json',
  'models/specialists/pattern-specialist-candidates.json',
  'apps/dashboard/public/data/dashboard.json',
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

console.log('Lab validation passed');
