#!/usr/bin/env node
import { appendFileSync, createReadStream, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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
const capital = Number(args.get('capital') || 100000);
const projectionCapital = Number(args.get('projection-capital') || 10000);
const candidates = Number(args.get('candidates') || 3000);
const minTrades = Number(args.get('min-trades') || 150);
const maxConcurrent = Number(args.get('max-concurrent') || 5);

const phase12Path = join(playbooksDir, 'current-phase12-champion-fusion.json');
const phase11Path = join(playbooksDir, 'current-phase11-regime-router.json');
if (!existsSync(phase12Path)) throw new Error(`Missing Phase 12: ${phase12Path}`);
if (!existsSync(phase11Path)) throw new Error(`Missing Phase 11: ${phase11Path}`);
const phase12 = JSON.parse(readFileSync(phase12Path, 'utf8'));
const phase11 = JSON.parse(readFileSync(phase11Path, 'utf8'));
const coreLedger = phase12.paths.coreLedger;
const satelliteLedger = phase12.paths.satelliteLedger;
const cutoff = phase12.scope.cutoff;

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
    rows.push({ ...trade, symbol, combo, features, source, family: combo.symbolFamily || family(symbol), triggerMode: combo.triggerMode, session: combo.session, direction: combo.direction, regime: regimeOf(features, combo), fastMove: Math.max(trade.move5mR || 0, trade.move10mR || 0, trade.move15mR || 0) });
  }
  rows.sort((a, b) => a.entryTime - b.entryTime);
  return rows;
}
function rng(seed = 131313) {
  let state = seed >>> 0;
  return () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return ((state >>> 0) / 4294967296); };
}
function keyOf(trade) { return `${trade.symbol}|${trade.entryTime}|${trade.exitTime}|${trade.side}|${Math.round(trade.entry * 10000)}|${Math.round(trade.exit * 10000)}`; }
function qualityScore(trade) {
  const f = trade.features || {};
  return (trade.source === 'core' ? 10000 : 0) + (trade.policyScore || 0) + (trade.confidence || 0) * 0.9 + (trade.alphaQuality || 0) * 0.55
    + (f.optionBurstShape || 0) * 35 + (f.momentumBurst || 0) * 30 + (f.volumeQuality || 0) * 22 + (f.relativeStrength || 0) * 28
    - (f.failedBreakRisk || 0) * 60 - (f.vwapExtensionRisk || 0) * 45;
}
function replay(trades, maxOpen) {
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
function metrics(trades, stressBps = 0) {
  let equity = 0, grossWin = 0, grossLoss = 0, peak = 0, maxDrawdownDollars = 0, maxLossStreak = 0, lossStreak = 0;
  const scaled = trades.map((trade) => ({ ...trade, pnlDollars: (trade.pnlDollars || 0) - (trade.notional || capital) * stressBps / 10000 }));
  for (const trade of scaled) {
    equity += trade.pnlDollars;
    if (trade.pnlDollars > 0) grossWin += trade.pnlDollars; else grossLoss += Math.abs(trade.pnlDollars);
    peak = Math.max(peak, equity);
    maxDrawdownDollars = Math.max(maxDrawdownDollars, peak - equity);
    if (trade.pnlDollars <= 0) { lossStreak += 1; maxLossStreak = Math.max(maxLossStreak, lossStreak); } else lossStreak = 0;
  }
  return { trades: scaled.length, wins: scaled.filter((t) => t.pnlDollars > 0).length, losses: scaled.filter((t) => t.pnlDollars <= 0).length, winRate: scaled.length ? scaled.filter((t) => t.pnlDollars > 0).length / scaled.length * 100 : 0, profitFactor: grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? 999 : 0), netDollars: equity, projectedNet: equity * projectionCapital / capital, avgDollars: scaled.length ? equity / scaled.length : 0, projectedAvgDollars: scaled.length ? equity * projectionCapital / capital / scaled.length : 0, maxDrawdownDollars, maxLossStreak, avgMfeR: scaled.length ? scaled.reduce((s, t) => s + (t.mfeR || 0), 0) / scaled.length : 0, avgMaeR: scaled.length ? scaled.reduce((s, t) => s + (t.maeR || 0), 0) / scaled.length : 0, optionWorthyRate: scaled.length ? scaled.filter((t) => t.optionWorthy).length / scaled.length * 100 : 0, fastMoveRate: scaled.length ? scaled.filter((t) => t.fastMove >= 0.5).length / scaled.length * 100 : 0, uniqueDays: new Set(scaled.map((t) => dayKey(t.entryTime))).size, uniqueWeeks: new Set(scaled.map((t) => weekKey(t.entryTime))).size };
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
function candidateScore(m, s) {
  return Math.min(m.projectedNet / 65, 1000) + m.winRate * 1.8 + Math.min(m.profitFactor, 30) * 13 + Math.min(m.trades, 300) * 0.25
    + Math.min(m.fastMoveRate, 100) * 0.2 - Math.max(0, minTrades - m.trades) * 4.8
    - Math.min(m.maxDrawdownDollars / 1000, 80) * 3.2 - Math.max(0, m.maxLossStreak - 1) * 34
    + Math.min(s.projectedNet / 100, 350) + Math.min(s.profitFactor, 12) * 7;
}
function generateCandidates(count) {
  const random = rng(20260504);
  const regimes = ['clean_momentum', 'clean_breakout', 'open_drive', 'options_burst', 'volume_expansion', 'squeeze_expansion'];
  const families = ['softwareAi', 'crypto', 'ev', 'pennyMeme', 'semis', 'etf'];
  const triggers = ['volume-shock', 'opening-drive-continuation', 'momentum-acceleration', 'breakout', 'hybrid-consensus', 'relative-strength-reclaim'];
  const out = [];
  out.push({ name: 'phase12_strict_fast_mfe_seed', families: ['softwareAi', 'crypto', 'ev', 'pennyMeme', 'semis', 'etf'], triggers, regimes: ['clean_momentum', 'clean_breakout', 'open_drive', 'options_burst'], maxTrap: 1.15, maxVwap: 0.82, minMomentum: 0.43, minRelativeStrength: 0.45, minFastMove: 0.5, minOptionShape: 0.7, requireFastOrOption: true, minConf: 0, minAlpha: 0, maxOpen: maxConcurrent });
  out.push({ name: 'phase12_software_crypto_ev_seed', families: ['softwareAi', 'crypto', 'ev'], triggers, regimes: ['clean_momentum', 'clean_breakout', 'open_drive', 'options_burst'], maxTrap: 1.17, maxVwap: 0.95, minMomentum: 0.43, minRelativeStrength: 0.45, minFastMove: 0, minOptionShape: 0, requireFastOrOption: false, minConf: 0, minAlpha: 0, maxOpen: maxConcurrent });
  for (let i = 0; i < count; i += 1) {
    const famCount = 2 + Math.floor(random() * 4);
    const trigCount = 2 + Math.floor(random() * 4);
    const regCount = 2 + Math.floor(random() * 4);
    const pick = (arr, n) => [...arr].sort(() => random() - 0.5).slice(0, n);
    out.push({
      name: `satellite_mutation_${i}`,
      families: pick(families, famCount),
      triggers: pick(triggers, trigCount),
      regimes: pick(regimes, regCount),
      maxTrap: 0.88 + random() * 0.55,
      maxVwap: 0.52 + random() * 0.42,
      minMomentum: 0.24 + random() * 0.45,
      minRelativeStrength: 0.24 + random() * 0.45,
      minFastMove: random() > 0.55 ? 0.45 + random() * 0.25 : 0,
      minOptionShape: random() > 0.62 ? 0.58 + random() * 0.25 : 0,
      requireFastOrOption: random() > 0.46,
      minConf: random() > 0.5 ? 68 + random() * 16 : 0,
      minAlpha: random() > 0.55 ? 58 + random() * 18 : 0,
      maxOpen: 3 + Math.floor(random() * Math.max(1, maxConcurrent - 2)),
    });
  }
  return out;
}
function satellitePass(trade, c) {
  const f = trade.features || {};
  const trap = (f.failedBreakRisk || 0) + (f.rejectionWick || 0) + (f.vwapExtensionRisk || 0);
  const fastOrOption = !c.requireFastOrOption || trade.fastMove >= c.minFastMove || (f.optionBurstShape || 0) >= c.minOptionShape;
  return c.families.includes(trade.family)
    && c.triggers.includes(trade.triggerMode)
    && c.regimes.includes(trade.regime)
    && trap <= c.maxTrap
    && (f.vwapExtensionRisk || 0) <= c.maxVwap
    && ((f.momentumBurst || 0) >= c.minMomentum || (f.priceAcceleration || 0) >= c.minMomentum)
    && ((f.relativeStrength || 0) >= c.minRelativeStrength || trade.family === 'etf')
    && (trade.confidence || 0) >= c.minConf
    && (trade.alphaQuality || 0) >= c.minAlpha
    && fastOrOption;
}

const coreAll = await readTrades(coreLedger, 'core');
const satAll = await readTrades(satelliteLedger, 'satellite');
const core = coreAll.filter((t) => t.entryTime > cutoff);
const sat = satAll.filter((t) => t.entryTime > cutoff && !['trap_risk', 'chop_risk', 'exhaustion_risk'].includes(t.regime));
const results = generateCandidates(candidates).map((candidate) => {
  const satellite = sat.filter((trade) => satellitePass(trade, candidate));
  const accepted = replay([...core, ...satellite], candidate.maxOpen);
  const m = metrics(accepted);
  const s = metrics(accepted, 6);
  return { candidate, accepted, satellite, metrics: m, stress: s, score: candidateScore(m, s) };
}).sort((a, b) => b.score - a.score);
const top = results.slice(0, 30);
const best = top[0];
const phase12Best = phase12.best.metrics;
const promote = best.metrics.trades >= minTrades && best.metrics.winRate >= 90 && best.metrics.netDollars > phase12Best.netDollars * 1.03 && best.stress.netDollars > 0 && best.metrics.maxLossStreak <= 2;
const payload = {
  updatedAt: new Date().toISOString(),
  phase: 'phase13-satellite-pocket-tuner',
  scope: { capital, projectionCapital, candidates: candidates + 2, cutoff, coreTrades: core.length, satellitePool: sat.length, minTrades, maxConcurrent },
  goal: 'mutate Phase 12 satellite pocket to reach 150-200 trades while preserving 90%+ win rate',
  guardrails: ['all candidate filters use entry-time features and Phase 11/12 learned pockets only', 'core champion trades keep priority in conflict replay', 'promotion requires 90%+ win, stress survival, and improvement over Phase 12 best'],
  paths: { coreLedger, satelliteLedger, phase12Path, phase11Path },
  best: { name: best.candidate.name, candidate: best.candidate, metrics: best.metrics, stress: best.stress, addedSatelliteTrades: best.accepted.filter((t) => t.source === 'satellite').length, satellitePoolAccepted: best.satellite.length, bySource: summarizeBy('source', best.accepted), byFamily: summarizeBy('family', best.accepted), byTrigger: summarizeBy('triggerMode', best.accepted), byRegime: summarizeBy('regime', best.accepted), sampleTrades: best.accepted.slice(0, 90).map((t) => ({ source: t.source, symbol: t.symbol, side: t.side, family: t.family, triggerMode: t.triggerMode, regime: t.regime, entryTime: t.entryTime, exitTime: t.exitTime, entry: t.entry, exit: t.exit, pnlDollars: t.pnlDollars, pnlR: t.pnlR, mfeR: t.mfeR, maeR: t.maeR })) },
  leaderboard: top.map((r) => ({ name: r.candidate.name, score: r.score, candidate: r.candidate, metrics: r.metrics, stress: r.stress, addedSatelliteTrades: r.accepted.filter((t) => t.source === 'satellite').length, satellitePoolAccepted: r.satellite.length })),
  promotion: { promote, decision: promote ? 'promote-satellite-pocket-candidate' : 'research-only-not-enough-safe-trades', comparedToPhase12: phase12Best },
};
const outPath = join(playbooksDir, 'current-phase13-satellite-pocket-tuner.json');
writeFileSync(outPath, `${JSON.stringify(payload, null, 2)}\n`);
appendFileSync(join(playbooksDir, 'phase13-satellite-pocket-tuner-history.jsonl'), `${JSON.stringify(payload)}\n`);
const exportPath = join(generatedDir, 'satellite_pocket_export.json');
writeFileSync(exportPath, `${JSON.stringify({ generatedAt: payload.updatedAt, decision: payload.promotion.decision, best: payload.best, leaderboard: payload.leaderboard.slice(0, 10) }, null, 2)}\n`);
console.log('\n=== phase 13 satellite pocket tuner ===');
console.log(`Saved: ${outPath}`);
console.log(`Pine/satellite metadata: ${exportPath}`);
console.log(`Core=${core.length} SatellitePool=${sat.length}`);
for (const item of top.slice(0, 12)) {
  const m = item.metrics;
  console.log(`${item.candidate.name}: trades=${m.trades} sat=${item.accepted.filter((t) => t.source === 'satellite').length} win=${m.winRate.toFixed(2)} pf=${m.profitFactor.toFixed(2)} net=$${m.netDollars.toFixed(0)} projected=$${m.projectedNet.toFixed(0)} avg=$${m.avgDollars.toFixed(0)} dd=$${m.maxDrawdownDollars.toFixed(0)} stress=$${item.stress.netDollars.toFixed(0)}`);
}
console.log(`Decision=${payload.promotion.decision}`);
