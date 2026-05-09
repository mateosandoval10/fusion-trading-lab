#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..', '..');

const generatedDir = join(root, 'generated');
const dashboardDataDir = join(root, 'apps', 'dashboard', 'public', 'data');
mkdirSync(generatedDir, { recursive: true });
mkdirSync(dashboardDataDir, { recursive: true });

const pinePath = join(generatedDir, 'fusionv3_codex_clean_tradingview.pine');
const championPath = join(root, 'models', 'champions', 'current-phase19-champion-council-fusion.json');
const champion = existsSync(championPath) ? JSON.parse(readFileSync(championPath, 'utf8')) : null;
const pine = existsSync(pinePath) ? readFileSync(pinePath, 'utf8') : '';
const activeModeSource = pine.split('\n').find((line) => line.includes('activeScalpMode = input.string')) || '';
const activeModeMatch = activeModeSource.match(/activeScalpMode\s*=\s*input\.string\("([^"]+)".*options=\[([^\]]+)/);

const metadata = {
  updatedAt: new Date().toISOString(),
  pinePath,
  pineBytes: pine.length,
  hasClosedLoopAlert: pine.includes('alert(closedLoopPayload'),
  closedLoopModelId: pine.match(/closedLoopModelId\s*=\s*input\.string\("([^"]+)"/)?.[1] || null,
  activeScalpModes: activeModeMatch?.[2]
    ?.replaceAll('"', '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean) || [],
  champion: champion ? {
    phase: champion.phase,
    updatedAt: champion.updatedAt,
    bestVariant: champion.bestVariant,
    qualified: champion.bestVariantQualified,
    metrics: champion.variants?.[champion.bestVariant]?.portfolio?.metrics || null,
    holdout: champion.variants?.[champion.bestVariant]?.portfolio?.holdout || null,
  } : null,
};

writeFileSync(join(generatedDir, 'pine_metadata.json'), `${JSON.stringify(metadata, null, 2)}\n`);
writeFileSync(join(dashboardDataDir, 'pine_metadata.json'), `${JSON.stringify(metadata, null, 2)}\n`);
console.log(`Pine metadata synced: ${metadata.closedLoopModelId || 'unknown model'}`);
