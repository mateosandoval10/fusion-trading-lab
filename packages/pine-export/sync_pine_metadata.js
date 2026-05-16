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
const phase22Path = join(root, 'models', 'champions', 'current-phase22-deep-specialist-tournament.json');
const phase23Path = join(root, 'models', 'champions', 'current-phase23-intelligence-specialist.json');
const phase24Path = join(root, 'models', 'self-improvement', 'current-phase24-self-improvement.json');
const champion = existsSync(championPath) ? JSON.parse(readFileSync(championPath, 'utf8')) : null;
const phase22 = existsSync(phase22Path) ? JSON.parse(readFileSync(phase22Path, 'utf8')) : null;
const phase23 = existsSync(phase23Path) ? JSON.parse(readFileSync(phase23Path, 'utf8')) : null;
const phase24 = existsSync(phase24Path) ? JSON.parse(readFileSync(phase24Path, 'utf8')) : null;
const pine = existsSync(pinePath) ? readFileSync(pinePath, 'utf8') : '';
const activeModeSource = pine.split('\n').find((line) => line.includes('activeScalpMode = input.string')) || '';
const activeModeMatch = activeModeSource.match(/activeScalpMode\s*=\s*input\.string\("([^"]+)".*options=\[([^\]]+)/);

function compactVariant(variant) {
  if (!variant || typeof variant !== 'object') return null;
  return {
    id: variant.id,
    profile: variant.profile,
    goal: variant.goal,
    routeSet: variant.routeSet,
    threshold: variant.threshold,
    metrics: variant.metrics || null,
    holdout: variant.holdout || null,
    stress: variant.stress || null,
    diagnostics: variant.diagnostics || null,
    topSymbols: variant.topSymbols?.slice(0, 8) || [],
    topRoutes: variant.topRoutes?.slice(0, 8) || [],
  };
}

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
  phase22: phase22 ? {
    phase: phase22.phase,
    updatedAt: phase22.updatedAt,
    runId: phase22.runId,
    recommendedId: phase22.recommendedChampion?.id || null,
    metrics: phase22.recommendedChampion?.metrics || null,
    holdout: phase22.recommendedChampion?.holdout || null,
    stress: phase22.recommendedChampion?.stress || null,
  } : null,
  phase23: phase23 ? {
    phase: phase23.phase,
    updatedAt: phase23.updatedAt,
    runId: phase23.runId,
    recommendedId: phase23.recommendedChampion?.id || null,
    metrics: phase23.recommendedChampion?.metrics || null,
    holdout: phase23.recommendedChampion?.holdout || null,
    stress: phase23.recommendedChampion?.stress || null,
    elitePrecision: compactVariant(phase23.categoryChampions?.elitePrecision),
    highWinGuarded: compactVariant(phase23.categoryChampions?.highWinGuarded),
  } : null,
  phase24: phase24 ? {
    phase: phase24.phase,
    updatedAt: phase24.updatedAt,
    runId: phase24.runId,
    safety: phase24.safety,
    bestProfit: compactVariant(phase24.categoryChampions?.bestProfit),
    bestHighWin: compactVariant(phase24.categoryChampions?.bestHighWin),
    bestOptions: compactVariant(phase24.categoryChampions?.bestOptions),
    promoted: phase24.promoted?.slice(0, 8).map(compactVariant) || [],
  } : null,
};

writeFileSync(join(generatedDir, 'pine_metadata.json'), `${JSON.stringify(metadata, null, 2)}\n`);
writeFileSync(join(dashboardDataDir, 'pine_metadata.json'), `${JSON.stringify(metadata, null, 2)}\n`);
console.log(`Pine metadata synced: ${metadata.closedLoopModelId || 'unknown model'}`);
