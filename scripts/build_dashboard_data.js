#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

const dashboardDir = join(root, 'apps', 'dashboard', 'public', 'data');
const reportsDir = join(root, 'reports');
mkdirSync(dashboardDir, { recursive: true });
mkdirSync(reportsDir, { recursive: true });

function readJson(path, fallback = null) {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return fallback;
  }
}

function readJsonl(path) {
  if (!existsSync(path)) return [];
  const raw = readFileSync(path, 'utf8').trim();
  if (!raw) return [];
  return raw.split('\n').filter(Boolean).flatMap((line) => {
    try {
      return [JSON.parse(line)];
    } catch {
      return [];
    }
  });
}

function writeJson(path, payload) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(payload, null, 2)}\n`);
}

function fileInfo(path) {
  if (!existsSync(path)) return null;
  const stats = statSync(path);
  return {
    path,
    updatedAt: stats.mtime.toISOString(),
    bytes: stats.size,
  };
}

function metricCompact(metrics = {}) {
  return {
    trades: metrics.trades || 0,
    winRate: metrics.winRate || 0,
    netDollars: metrics.netDollars || 0,
    avgDollars: metrics.avgDollars || 0,
    profitFactor: metrics.profitFactor || 0,
    maxDrawdownDollars: metrics.maxDrawdownDollars || 0,
    maxLossStreak: metrics.maxLossStreak || 0,
    optionWorthyRate: metrics.optionWorthyRate || 0,
  };
}

function summarizeChampion(champion) {
  if (!champion) return null;
  const bestVariant = champion.bestVariant;
  const record = champion.variants?.[bestVariant];
  return {
    updatedAt: champion.updatedAt,
    phase: champion.phase,
    bestVariant,
    qualified: champion.bestVariantQualified,
    config: champion.config,
    metrics: metricCompact(record?.portfolio?.metrics),
    train: metricCompact(record?.portfolio?.train),
    test: metricCompact(record?.portfolio?.test),
    holdout: metricCompact(record?.portfolio?.holdout),
    stress: metricCompact(record?.portfolio?.stress),
    holdoutStress: metricCompact(record?.portfolio?.holdoutStress),
    byTrigger: record?.byTrigger || [],
    watchlist: champion.watchlists?.[bestVariant] || [],
  };
}

function summarizeSpecialists(activeModes = {}) {
  return Object.entries(activeModes.activeModes || activeModes || {}).map(([key, value]) => ({
    key,
    name: value.name || key,
    status: value.status || 'unknown',
    mode: value.mode || null,
    metrics: metricCompact(value.metrics),
    holdout: metricCompact(value.holdout),
    stress: metricCompact(value.stress),
    notes: value.description || value.activation || '',
  })).sort((a, b) => b.metrics.netDollars - a.metrics.netDollars);
}

function latestFiles(dir, limit = 20) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .map((name) => join(dir, name))
    .filter((path) => statSync(path).isFile())
    .map((path) => fileInfo(path))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, limit);
}

function summarizeForward() {
  const forwardDir = join(root, 'optimization-results', 'forward-tests');
  const latestPhase18 = readJson(join(forwardDir, 'latest-phase18-forward-proven-summary.json'), null);
  const routeTrust = readJson(join(forwardDir, 'phase18-forward-route-trust.json'), { routes: {} });
  const openHour = readJson(join(forwardDir, 'latest-champion-open-hour-forward-test.json'), null);
  const currentWindow = readJson(join(forwardDir, 'latest-champion-current-window-forward-test.json'), null);
  const performanceLedger = readJsonl(join(forwardDir, 'champion-forward-performance-ledger.jsonl')).slice(-200);
  const routeTrustRows = Object.values(routeTrust.routes || {})
    .sort((a, b) => (b.netDollars || 0) - (a.netDollars || 0))
    .slice(0, 50);
  return {
    latestPhase18,
    openHour,
    currentWindow,
    routeTrustUpdatedAt: routeTrust.updatedAt || null,
    topRouteTrust: routeTrustRows,
    recentForwardLedger: performanceLedger,
  };
}

function pineStatus() {
  const pinePath = join(root, 'generated', 'fusionv3_codex_clean_tradingview.pine');
  const pine = existsSync(pinePath) ? readFileSync(pinePath, 'utf8') : '';
  const modelId = pine.match(/closedLoopModelId\s*=\s*input\.string\("([^"]+)"/)?.[1] || 'unknown';
  const activeModeSource = pine.split('\n').find((line) => line.includes('activeScalpMode = input.string')) || '';
  const activeModeLine = activeModeSource.match(/activeScalpMode\s*=\s*input\.string\("([^"]+)".*options=\[([^\]]+)/);
  return {
    ...fileInfo(pinePath),
    modelId,
    defaultMode: activeModeLine?.[1] || 'unknown',
    hasClosedLoopAlert: pine.includes('alert(closedLoopPayload'),
    modeOptions: activeModeLine?.[2]?.replaceAll('"', '').split(',').map((item) => item.trim()).filter(Boolean) || [],
  };
}

const champion = readJson(join(root, 'models', 'champions', 'current-phase19-champion-council-fusion.json'), null);
const activeModes = readJson(join(root, 'models', 'registry', 'current-active-scalp-modes.json'), {});
const patternLab = readJson(join(root, 'models', 'pattern-lab', 'current-pattern-lab.json'), null);
const patternCandidates = readJson(join(root, 'models', 'specialists', 'pattern-specialist-candidates.json'), { candidates: [] });

const dashboard = {
  updatedAt: new Date().toISOString(),
  champion: summarizeChampion(champion),
  specialists: summarizeSpecialists(activeModes),
  patternLab: patternLab ? {
    updatedAt: patternLab.updatedAt,
    data: patternLab.data,
    global: patternLab.global,
    topPatterns: patternLab.patterns?.byTag?.slice(0, 20) || [],
    topRoutes: patternLab.patterns?.byRoute?.slice(0, 30) || [],
    clusters: patternLab.clusters,
    dailyPerformance: patternLab.dailyPerformance || [],
  } : null,
  patternCandidates: patternCandidates.candidates || [],
  forward: summarizeForward(),
  pine: pineStatus(),
  artifacts: {
    reports: latestFiles(reportsDir, 30),
    ledgers: latestFiles(join(root, 'ledgers'), 20),
    generated: latestFiles(join(root, 'generated'), 20),
  },
};

writeJson(join(dashboardDir, 'dashboard.json'), dashboard);
writeJson(join(reportsDir, 'dashboard-summary.json'), dashboard);

console.log('Dashboard data built');
console.log(`Champion=${dashboard.champion?.bestVariant || 'none'} specialists=${dashboard.specialists.length} patternCandidates=${dashboard.patternCandidates.length}`);
console.log(`Data: ${join(dashboardDir, 'dashboard.json')}`);
