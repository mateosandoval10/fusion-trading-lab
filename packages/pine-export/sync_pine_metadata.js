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
const phase26Path = join(root, 'models', 'generalization', 'current-phase26-generalization-engine.json');
const phase27Path = join(root, 'models', 'promotions', 'current-phase27-promotion-audit.json');
const optionsOverlayPath = join(root, 'models', 'options', 'current-phase27-options-overlay.json');
const champion = readJson(championPath);
const phase22 = readJson(phase22Path);
const phase23 = readJson(phase23Path);
const phase24 = readJson(phase24Path);
const phase26 = readJson(phase26Path);
const phase27 = readJson(phase27Path);
const optionsOverlay = readJson(optionsOverlayPath);
const pine = existsSync(pinePath) ? readFileSync(pinePath, 'utf8') : '';
const activeModeSource = pine.split('\n').find((line) => line.includes('activeScalpMode = input.string')) || '';
const activeModeMatch = activeModeSource.match(/activeScalpMode\s*=\s*input\.string\("([^"]+)".*options=\[([^\]]+)/);

function readJson(path) {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf8'));
}

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
  phase26: phase26 ? {
    phase: phase26.phase,
    updatedAt: phase26.updatedAt,
    runId: phase26.runId,
    safety: phase26.safety,
    bestOverall: compactVariant(phase26.categoryChampions?.bestOverall),
    bestProfit: compactVariant(phase26.categoryChampions?.bestProfit),
    bestHighWin: compactVariant(phase26.categoryChampions?.bestHighWin),
    promoted: phase26.promoted?.slice(0, 8).map(compactVariant) || [],
  } : null,
  phase27: phase27 ? {
    phase: phase27.phase,
    updatedAt: phase27.updatedAt,
    runId: phase27.runId,
    safety: phase27.safety,
    promotedChampion: phase27.promotedChampion ? {
      modeName: phase27.promotedChampion.modeName,
      modelId: phase27.promotedChampion.modelId,
      pineModelId: phase27.promotedChampion.pineModelId,
      status: phase27.promotedChampion.status,
      safeToPromote: phase27.promotedChampion.safeToPromote,
      metrics: phase27.promotedChampion.metrics?.metrics || null,
      holdout: phase27.promotedChampion.metrics?.holdout || null,
      deepStress: phase27.promotedChampion.metrics?.deepStress || null,
      whitelist: phase27.promotedChampion.whitelist?.slice(0, 80) || [],
    } : null,
    auditFindings: phase27.auditFindings || [],
    optionsOverlaySummary: phase27.optionsOverlaySummary || null,
  } : null,
  optionsOverlay: optionsOverlay ? {
    phase: optionsOverlay.phase,
    updatedAt: optionsOverlay.updatedAt,
    safety: optionsOverlay.safety,
    source: optionsOverlay.source,
    totals: optionsOverlay.totals,
    dataConfidence: optionsOverlay.dataConfidence,
    topRows: optionsOverlay.rows?.slice(0, 20).map((row) => ({
      symbol: row.symbol,
      side: row.side,
      setup: row.setup,
      date: row.date,
      minutesHeld: row.minutesHeld,
      equityPnlOn10k: row.equityPnlOn10k,
      rule: row.systematic?.rule,
      contractType: row.systematic?.contractType,
      dte: row.systematic?.dte,
      strike: row.systematic?.strike,
      profitOnCapital: row.systematic?.profitOnCapital,
      roiPct: row.systematic?.roiPct,
    })) || [],
  } : null,
};

writeFileSync(join(generatedDir, 'pine_metadata.json'), `${JSON.stringify(metadata, null, 2)}\n`);
writeFileSync(join(dashboardDataDir, 'pine_metadata.json'), `${JSON.stringify(metadata, null, 2)}\n`);
console.log(`Pine metadata synced: ${metadata.closedLoopModelId || 'unknown model'}`);
