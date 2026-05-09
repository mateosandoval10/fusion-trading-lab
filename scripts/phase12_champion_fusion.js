#!/usr/bin/env node
import { appendFileSync, createReadStream, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const playbooksDir = join(root, 'optimization-results', 'models', 'playbooks');
const generatedDir = join(root, 'generated');
for (const dir of [playbooksDir, generatedDir]) mkdirSync(dir, { recursive: true });

const args = new Map(process.argv.slice(2).map((arg) => {
  const [key, value = 'true'] = arg.replace(/^--/, '').split('=');
  return [key, value];
}));
const runId = new Date().toISOString().replace(/[:.]/g, '-');
const capital = Number(args.get('capital') || 100000);
const projectionCapital = Number(args.get('projection-capital') || 10000);
const range = args.get('range') || '60d';
const interval = args.get('interval') || '5m';
const trainPct = Number(args.get('train-pct') || 0.65);
const minTestTrades = Number(args.get('min-test-trades') || 150);
const maxConcurrent = Number(args.get('max-concurrent') || 2);
const satelliteLedgerArg = args.get('satellite-ledger') || '';

const championPath = join(playbooksDir, 'current-master-scalp-champion.json');
const phase11Path = join(playbooksDir, 'current-phase11-regime-router.json');
if (!existsSync(championPath)) throw new Error(`Missing champion file: ${championPath}`);
if (!existsSync(phase11Path)) throw new Error(`Missing Phase 11 file: ${phase11Path}`);
const champion = JSON.parse(readFileSync(championPath, 'utf8'));
const phase11 = JSON.parse(readFileSync(phase11Path, 'utf8'));

function dayKey(timestamp) { return new Date(timestamp * 1000).toISOString().slice(0, 10); }
function weekKey(timestamp) {
  const d = new Date(timestamp * 1000);
  const oneJan = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((d - oneJan) / 86400000) + oneJan.getUTCDay() + 1) / 7);
  return `${d.getUTCFullYear()}-${String(week).padStart(2, '0')}`;
}
function family(symbol) {
  if (['NVDA', 'AMD', 'AVGO', 'SMCI', 'ARM', 'MRVL', 'MU', 'SOXL', 'NVDL'].includes(symbol)) return 'semis';
  if (['COIN', 'MSTR', 'MARA', 'RIOT', 'CLSK', 'WULF', 'CIFR', 'IREN', 'CONL'].includes(symbol)) return 'crypto';
  if (['TSLA', 'RIVN', 'LCID', 'QS', 'NIO', 'XPEV', 'CHPT'].includes(symbol)) return 'ev';
  if (['PLTR', 'AI', 'PATH', 'IONQ', 'RGTI', 'QBTS', 'SNOW', 'DDOG', 'NET', 'CRWD'].includes(symbol)) return 'softwareAi';
  if (['OPEN', 'GME', 'AMC', 'SNDK', 'NVTS', 'RUN', 'OKLO'].includes(symbol)) return 'pennyMeme';
  if (['TQQQ', 'SQQQ', 'QQQ', 'SPY', 'IWM', 'ARKK', 'XBI'].includes(symbol)) return 'etf';
  return 'liquidMomentum';
}
function regimeOf(features, combo) {
  const f = features || {};
  const trap = (f.failedBreakRisk || 0) + (f.rejectionWick || 0) + (f.vwapExtensionRisk || 0);
  if (trap > 1.45) return 'trap_risk';
  if ((f.chopQuality || 0) < 0.45 || ((f.efficiency || 0) < 0.35 && (f.atrExpansion || 0) < 0.55)) return 'chop_risk';
  if ((f.vwapExtensionRisk || 0) > 0.75 && (f.momentumBurst || 0) < 0.6) return 'exhaustion_risk';
  if ((f.openingDriveQuality || 0) > 0.74 && combo.session === 'open-0930') return 'open_drive';
  if ((f.compressionRelease || 0) > 0.72 && (f.rangeExpansionQuality || 0) > 0.62) return 'squeeze_expansion';
  if ((f.optionBurstShape || 0) > 0.72 && (f.momentumBurst || 0) > 0.62) return 'options_burst';
  if ((f.pullbackReclaim || 0) > 0.58 || (f.stopRunReclaim || 0) > 0.72 || (f.priorDayReclaim || 0) > 0.6) return 'vwap_reclaim';
  if ((f.breakoutQuality || 0) > 0.68 && (f.cleanBreakout || 0) > 0.52) return 'clean_breakout';
  if ((f.volumeQuality || 0) > 0.75 && (f.volumeAcceleration || 0) > 0.65) return 'volume_expansion';
  if ((f.trendQuality || 0) > 0.72 && (f.emaSlope || 0) > 0.62) return 'clean_momentum';
  return 'mixed';
}
async function readTrades(path, source) {
  const rows = [];
  const input = createReadStream(path, { encoding: 'utf8' });
  const lines = createInterface({ input, crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    const row = JSON.parse(line);
    const trade = row.trade || {};
    const combo = row.combo || {};
    const features = trade.features || {};
    const symbol = row.symbol || trade.symbol;
    rows.push({
      ...trade,
      symbol,
      combo,
      source,
      family: combo.symbolFamily || family(symbol),
      triggerMode: combo.triggerMode,
      session: combo.session,
      direction: combo.direction,
      archetype: combo.archetype || combo.triggerMode,
      regime: regimeOf(features, combo),
      features,
      fastMove: Math.max(trade.move5mR || 0, trade.move10mR || 0, trade.move15mR || 0),
    });
  }
  rows.sort((a, b) => a.entryTime - b.entryTime);
  return rows;
}
function splitCutoff(trades) {
  const times = [...new Set(trades.map((trade) => trade.entryTime))].sort((a, b) => a - b);
  return times[Math.floor(times.length * trainPct)] || times.at(-1);
}
function metrics(trades, stressBps = 0) {
  let equity = 0, grossWin = 0, grossLoss = 0, peak = 0, maxDrawdownDollars = 0, maxLossStreak = 0, lossStreak = 0;
  const scaled = trades.map((trade) => {
    const stressCost = (trade.notional || capital) * stressBps / 10000;
    return { ...trade, pnlDollars: (trade.pnlDollars || 0) - stressCost };
  });
  for (const trade of scaled) {
    equity += trade.pnlDollars;
    if (trade.pnlDollars > 0) grossWin += trade.pnlDollars; else grossLoss += Math.abs(trade.pnlDollars);
    peak = Math.max(peak, equity);
    maxDrawdownDollars = Math.max(maxDrawdownDollars, peak - equity);
    if (trade.pnlDollars <= 0) { lossStreak += 1; maxLossStreak = Math.max(maxLossStreak, lossStreak); } else lossStreak = 0;
  }
  return {
    trades: scaled.length,
    wins: scaled.filter((t) => t.pnlDollars > 0).length,
    losses: scaled.filter((t) => t.pnlDollars <= 0).length,
    winRate: scaled.length ? scaled.filter((t) => t.pnlDollars > 0).length / scaled.length * 100 : 0,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? 999 : 0),
    netDollars: equity,
    projectedNet: equity * projectionCapital / capital,
    avgDollars: scaled.length ? equity / scaled.length : 0,
    projectedAvgDollars: scaled.length ? (equity * projectionCapital / capital) / scaled.length : 0,
    maxDrawdownDollars,
    maxLossStreak,
    avgMfeR: scaled.length ? scaled.reduce((s, t) => s + (t.mfeR || 0), 0) / scaled.length : 0,
    avgMaeR: scaled.length ? scaled.reduce((s, t) => s + (t.maeR || 0), 0) / scaled.length : 0,
    optionWorthyRate: scaled.length ? scaled.filter((t) => t.optionWorthy).length / scaled.length * 100 : 0,
    fastMoveRate: scaled.length ? scaled.filter((t) => t.fastMove >= 0.5).length / scaled.length * 100 : 0,
    uniqueDays: new Set(scaled.map((t) => dayKey(t.entryTime))).size,
    uniqueWeeks: new Set(scaled.map((t) => weekKey(t.entryTime))).size,
  };
}
function keyOf(trade) {
  return `${trade.symbol}|${trade.entryTime}|${trade.exitTime}|${trade.side}|${Math.round(trade.entry * 10000)}|${Math.round(trade.exit * 10000)}`;
}
function qualityScore(trade) {
  const f = trade.features || {};
  return (trade.source === 'core' ? 10000 : 0)
    + (trade.policyScore || 0)
    + (trade.confidence || 0) * 0.9
    + (trade.alphaQuality || 0) * 0.55
    + (f.optionBurstShape || 0) * 35
    + (f.momentumBurst || 0) * 30
    + (f.volumeQuality || 0) * 22
    + (f.relativeStrength || 0) * 28
    - (f.failedBreakRisk || 0) * 60
    - (f.vwapExtensionRisk || 0) * 45;
}
function replay(trades, maxOpen = maxConcurrent) {
  const accepted = [];
  const seen = new Set();
  const sorted = trades.map((trade) => ({ ...trade, fusionScore: qualityScore(trade) })).sort((a, b) => (a.entryTime - b.entryTime) || (b.fusionScore - a.fusionScore));
  for (const trade of sorted) {
    const key = keyOf(trade);
    if (seen.has(key)) continue;
    seen.add(key);
    const open = accepted.filter((item) => item.exitTime > trade.entryTime);
    if (open.some((item) => item.symbol === trade.symbol)) continue;
    if (open.length >= maxOpen) continue;
    accepted.push(trade);
  }
  return accepted;
}
function summarizeBy(key, trades) {
  const buckets = new Map();
  for (const trade of trades) {
    const bucket = trade[key] || 'unknown';
    if (!buckets.has(bucket)) buckets.set(bucket, []);
    buckets.get(bucket).push(trade);
  }
  return [...buckets.entries()].map(([name, rows]) => ({ name, ...metrics(rows) })).sort((a, b) => b.netDollars - a.netDollars).slice(0, 14);
}
function variantScore(m, s) {
  return Math.min(m.projectedNet / 80, 900) + m.winRate * 1.35 + Math.min(m.profitFactor, 30) * 12 + Math.min(m.trades, 700) * 0.12
    - Math.min(m.maxDrawdownDollars / 1000, 80) * 2.8 - Math.max(0, m.maxLossStreak - 2) * 25
    + Math.min(s.projectedNet / 120, 250) + Math.min(s.profitFactor, 12) * 6;
}

const championRoutes = champion.champion?.routes || [];
const championCombos = championRoutes.map((route) => ({ ...route.combo, symbolFilter: route.symbol, routeId: route.id, symbolFamily: route.family || family(route.symbol) }));
const championSymbols = [...new Set(championRoutes.map((route) => route.symbol))].filter(Boolean);
const championComboPath = join(playbooksDir, `phase12-core-champion-combos-${runId}.json`);
writeFileSync(championComboPath, `${JSON.stringify(championCombos, null, 2)}\n`);
console.log(`Phase 12 Champion Fusion: regenerating core champion ${championSymbols.length} symbols x ${championCombos.length} routes`);
const coreOutput = execFileSync('node', [
  'scripts/local_fusion_backtest.js', `--symbols=${championSymbols.join(',')}`, `--combo-file=${championComboPath}`,
  `--range=${range}`, `--interval=${interval}`, `--capital=${capital}`, '--promote=false', '--sample=all', '--save-trades=true', '--fresh-data=false',
], { cwd: root, encoding: 'utf8', maxBuffer: 1024 * 1024 * 160, stdio: ['ignore', 'pipe', 'pipe'] });
process.stdout.write(coreOutput.split('\n').slice(-14).join('\n'));
if (!coreOutput.endsWith('\n')) process.stdout.write('\n');
const coreMatch = coreOutput.match(/Trades: (.*\.jsonl)/);
if (!coreMatch) throw new Error('Core backtest did not emit trade ledger path');
const coreLedger = coreMatch[1];

let satelliteLedger = satelliteLedgerArg || phase11.paths?.tradeLedger;
if (!satelliteLedger || !existsSync(satelliteLedger)) throw new Error('Missing satellite ledger; run Phase 11 first or pass --satellite-ledger');
const coreTradesAll = await readTrades(coreLedger, 'core');
const satTradesAll = await readTrades(satelliteLedger, 'satellite');
const cutoff = Math.max(splitCutoff(coreTradesAll), phase11.scope?.cutoff || splitCutoff(satTradesAll));
const coreHoldout = coreTradesAll.filter((trade) => trade.entryTime > cutoff);
const satHoldoutAll = satTradesAll.filter((trade) => trade.entryTime > cutoff);

const p11Candidate = phase11.best.candidate;
const p11PositiveFamilies = new Set((phase11.best.byFamily || []).filter((x) => x.netDollars > 0 && x.profitFactor >= 1.4 && x.winRate >= 72).map((x) => x.name));
const p11PositiveTriggers = new Set((phase11.best.byTrigger || []).filter((x) => x.netDollars > 0 && x.profitFactor >= 1.4 && x.winRate >= 72).map((x) => x.name));
const p11PositiveRegimes = new Set((phase11.best.byRegime || []).filter((x) => x.netDollars > 0 && x.profitFactor >= 1.4 && x.winRate >= 72).map((x) => x.name));

const satBase = satHoldoutAll.filter((trade) => {
  const f = trade.features || {};
  const trapScore = (f.failedBreakRisk || 0) + (f.rejectionWick || 0) + (f.vwapExtensionRisk || 0);
  return !['trap_risk', 'chop_risk', 'exhaustion_risk'].includes(trade.regime)
    && trapScore <= p11Candidate.maxTrapScore
    && (f.vwapExtensionRisk || 0) <= p11Candidate.maxVwapRisk
    && ((f.momentumBurst || 0) >= p11Candidate.minMomentum || (f.priceAcceleration || 0) >= p11Candidate.minMomentum)
    && ((f.relativeStrength || 0) >= p11Candidate.minRelativeStrength || trade.family === 'etf');
});
const variants = [
  { name: 'core_only_replay', trades: coreHoldout, maxOpen: maxConcurrent },
  { name: 'core_plus_all_phase11_satellites', trades: [...coreHoldout, ...satBase], maxOpen: maxConcurrent },
  { name: 'core_plus_positive_family_trigger_regime', trades: [...coreHoldout, ...satBase.filter((t) => p11PositiveFamilies.has(t.family) && p11PositiveTriggers.has(t.triggerMode) && p11PositiveRegimes.has(t.regime))], maxOpen: maxConcurrent },
  { name: 'core_plus_software_crypto_ev', trades: [...coreHoldout, ...satBase.filter((t) => ['softwareAi', 'crypto', 'ev'].includes(t.family) && p11PositiveRegimes.has(t.regime))], maxOpen: maxConcurrent },
  { name: 'core_plus_volume_open_only', trades: [...coreHoldout, ...satBase.filter((t) => ['volume-shock', 'opening-drive-continuation'].includes(t.triggerMode) && ['softwareAi', 'crypto', 'ev', 'pennyMeme'].includes(t.family))], maxOpen: maxConcurrent },
  { name: 'core_plus_strict_fast_mfe', trades: [...coreHoldout, ...satBase.filter((t) => p11PositiveFamilies.has(t.family) && p11PositiveRegimes.has(t.regime) && (t.fastMove >= 0.5 || (t.features.optionBurstShape || 0) >= 0.7))], maxOpen: maxConcurrent },
  { name: 'core_plus_no_semis_liquid', trades: [...coreHoldout, ...satBase.filter((t) => !['semis', 'liquidMomentum'].includes(t.family) && p11PositiveRegimes.has(t.regime))], maxOpen: maxConcurrent },
].map((variant) => {
  const accepted = replay(variant.trades, variant.maxOpen);
  const m = metrics(accepted);
  const s = metrics(accepted, 6);
  return { ...variant, accepted, metrics: m, stress: s, score: variantScore(m, s) };
}).sort((a, b) => b.score - a.score);

const best = variants[0];
const currentStats = champion.champion?.metrics;
const promote = best.name !== 'core_only_replay'
  && best.metrics.trades >= minTestTrades
  && best.metrics.winRate >= Math.max(80, (variants.find((v) => v.name === 'core_only_replay')?.metrics.winRate || 0) - 1)
  && best.metrics.netDollars > (variants.find((v) => v.name === 'core_only_replay')?.metrics.netDollars || 0) * 1.08
  && best.stress.netDollars > 0
  && (!currentStats || best.metrics.projectedNet >= (currentStats.projectedNet || 0) * 0.7);

const payload = {
  updatedAt: new Date().toISOString(),
  phase: 'phase12-champion-fusion',
  scope: { capital, projectionCapital, range, interval, trainPct, cutoff, championRoutes: championCombos.length, championSymbols: championSymbols.length, coreRawTrades: coreTradesAll.length, coreHoldoutTrades: coreHoldout.length, satelliteRawTrades: satTradesAll.length, satelliteHoldoutTrades: satHoldoutAll.length, satelliteBaseTrades: satBase.length, minTestTrades },
  goal: 'keep current champion core, then add only Phase 11 satellite pockets that improve holdout portfolio performance',
  guardrails: ['core champion is replayed from actual route combos', 'satellite filters use Phase 11 learned train/router rules plus entry-time features', 'core trades receive priority during conflict replay', 'promotion requires improvement over core replay and stress survival'],
  paths: { championComboPath, coreLedger, satelliteLedger, phase11Path, championPath },
  variants: variants.map((v) => ({ name: v.name, metrics: v.metrics, stress: v.stress, score: v.score, addedSatelliteTrades: v.accepted.filter((t) => t.source === 'satellite').length, bySource: summarizeBy('source', v.accepted), byFamily: summarizeBy('family', v.accepted), byTrigger: summarizeBy('triggerMode', v.accepted), byRegime: summarizeBy('regime', v.accepted) })),
  best: { name: best.name, metrics: best.metrics, stress: best.stress, addedSatelliteTrades: best.accepted.filter((t) => t.source === 'satellite').length, bySource: summarizeBy('source', best.accepted), byFamily: summarizeBy('family', best.accepted), byTrigger: summarizeBy('triggerMode', best.accepted), byRegime: summarizeBy('regime', best.accepted), sampleTrades: best.accepted.slice(0, 80).map((t) => ({ source: t.source, symbol: t.symbol, side: t.side, family: t.family, triggerMode: t.triggerMode, regime: t.regime, entryTime: t.entryTime, exitTime: t.exitTime, entry: t.entry, exit: t.exit, pnlDollars: t.pnlDollars, pnlR: t.pnlR, mfeR: t.mfeR, maeR: t.maeR })) },
  promotion: { promote, decision: promote ? 'promote-fused-champion-candidate' : 'research-only-no-safe-fusion-promotion', comparedToCurrentChampion: currentStats, comparedToCoreReplay: variants.find((v) => v.name === 'core_only_replay')?.metrics },
};
const outPath = join(playbooksDir, 'current-phase12-champion-fusion.json');
writeFileSync(outPath, `${JSON.stringify(payload, null, 2)}\n`);
appendFileSync(join(playbooksDir, 'phase12-champion-fusion-history.jsonl'), `${JSON.stringify(payload)}\n`);
const exportPath = join(generatedDir, 'champion_fusion_export.json');
writeFileSync(exportPath, `${JSON.stringify({ generatedAt: payload.updatedAt, decision: payload.promotion.decision, best: payload.best, variants: payload.variants.map((v) => ({ name: v.name, metrics: v.metrics, stress: v.stress, addedSatelliteTrades: v.addedSatelliteTrades })) }, null, 2)}\n`);
console.log('\n=== phase 12 champion fusion ===');
console.log(`Saved: ${outPath}`);
console.log(`Pine/fusion metadata: ${exportPath}`);
console.log(`Core holdout=${coreHoldout.length} Satellite base=${satBase.length}`);
for (const variant of variants) {
  const m = variant.metrics;
  console.log(`${variant.name}: trades=${m.trades} sat=${variant.accepted.filter((t) => t.source === 'satellite').length} win=${m.winRate.toFixed(2)} pf=${m.profitFactor.toFixed(2)} net=$${m.netDollars.toFixed(0)} projected=$${m.projectedNet.toFixed(0)} avg=$${m.avgDollars.toFixed(0)} dd=$${m.maxDrawdownDollars.toFixed(0)} stress=$${variant.stress.netDollars.toFixed(0)}`);
}
console.log(`Decision=${payload.promotion.decision}`);
