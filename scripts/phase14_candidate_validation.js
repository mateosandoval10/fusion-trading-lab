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
const freshData = args.get('fresh-data') !== 'false';
const maxConcurrent = Number(args.get('max-concurrent') || 5);
const minTrades = Number(args.get('min-trades') || 120);
const maxSymbols = Number(args.get('max-symbols') || 120);

const championPath = join(playbooksDir, 'current-master-scalp-champion.json');
const phase13Path = join(playbooksDir, 'current-phase13-satellite-pocket-tuner.json');
if (!existsSync(championPath)) throw new Error(`Missing champion: ${championPath}`);
if (!existsSync(phase13Path)) throw new Error(`Missing Phase 13: ${phase13Path}`);
const champion = JSON.parse(readFileSync(championPath, 'utf8'));
const phase13 = JSON.parse(readFileSync(phase13Path, 'utf8'));
const candidate = phase13.best.candidate;

const expandedUniverse = [
  'NVDA','AMD','AVGO','SMCI','ARM','MRVL','MU','SOXL','NVDL','INTC','QCOM','TSM','ASML','ON','AMAT','LRCX',
  'TSLA','RIVN','LCID','QS','NIO','XPEV','CHPT','F','GM',
  'COIN','MSTR','MARA','RIOT','CLSK','WULF','CIFR','IREN','CONL','BITX','HOOD',
  'PLTR','SOFI','AFRM','UPST','RBLX','ROKU','APP','RDDT','IONQ','RGTI','QBTS','AI','PATH','SNOW','DDOG','NET','CRWD','MDB','NOW','TEAM','SHOP','U','TWLO',
  'OPEN','GME','AMC','SNDK','NVTS','RUN','OKLO','SOUN','BBAI','SERV','ACHR','JOBY','LAZR','DNA','IONQ','RKLB',
  'TQQQ','SQQQ','QQQ','SPY','IWM','ARKK','XBI','XLK','SMH','XLE','KRE',
  'AAPL','MSFT','META','AMZN','NFLX','ORCL','UBER','DASH','ABNB','CRM','ADBE','GOOGL','BABA','PDD','SE','MELI',
  'AAL','UAL','DAL','CCL','RCL','NCLH','DKNG','PENN','CELH','CVNA','W','CHWY','PINS','SNAP',
].slice(0, maxSymbols);

function family(symbol) {
  if (['NVDA','AMD','AVGO','SMCI','ARM','MRVL','MU','SOXL','NVDL','INTC','QCOM','TSM','ASML','ON','AMAT','LRCX','SMH'].includes(symbol)) return 'semis';
  if (['COIN','MSTR','MARA','RIOT','CLSK','WULF','CIFR','IREN','CONL','BITX'].includes(symbol)) return 'crypto';
  if (['TSLA','RIVN','LCID','QS','NIO','XPEV','CHPT','F','GM'].includes(symbol)) return 'ev';
  if (['PLTR','AI','PATH','IONQ','RGTI','QBTS','SNOW','DDOG','NET','CRWD','MDB','NOW','TEAM','SHOP','U','TWLO'].includes(symbol)) return 'softwareAi';
  if (['OPEN','GME','AMC','SNDK','NVTS','RUN','OKLO','SOUN','BBAI','SERV','ACHR','JOBY','LAZR','DNA','RKLB'].includes(symbol)) return 'pennyMeme';
  if (['TQQQ','SQQQ','QQQ','SPY','IWM','ARKK','XBI','XLK','XLE','KRE'].includes(symbol)) return 'etf';
  if (['AAL','UAL','DAL','CCL','RCL','NCLH','ABNB','UBER','DASH'].includes(symbol)) return 'travelConsumer';
  return 'liquidMomentum';
}
function generateSatelliteCombos(symbols) {
  const engines = [
    { name: 'volume_shock_runner', triggerMode: 'volume-shock', targetR: 0.75, trailR: 0.5, timeStopBars: 9, minConf: 70, minAlphaQuality: 60, volMult: 1.8, volumeQuality: 'clean', relVolMode: 'tod', minRelVolTod: 1.2 },
    { name: 'open_drive_runner', triggerMode: 'opening-drive-continuation', targetR: 1, trailR: 0.75, timeStopBars: 12, minConf: 72, minAlphaQuality: 60, dailyContext: 'trend-day' },
    { name: 'momentum_runner', triggerMode: 'momentum-acceleration', targetR: 0.75, trailR: 0.5, timeStopBars: 9, minConf: 72, minAlphaQuality: 65, requireConfRising: true },
    { name: 'profit_breakout_075', triggerMode: 'breakout', targetR: 0.75, trailR: 0.5, timeStopBars: 9, minConf: 70, minAlphaQuality: 60, volMult: 1.2, openingRange: 'break-15m', dailyContext: 'range-expansion' },
    { name: 'hybrid_runner', triggerMode: 'hybrid-consensus', targetR: 0.75, trailR: 0.5, timeStopBars: 9, minConf: 75, minAlphaQuality: 65, requireConfRising: true },
    { name: 'relative_strength_runner', triggerMode: 'relative-strength-reclaim', targetR: 1, trailR: 0.75, timeStopBars: 12, minConf: 72, minAlphaQuality: 65, marketMode: 'qqq' },
  ].filter((engine) => candidate.triggers.includes(engine.triggerMode));
  const sessions = ['open-0930','open-1000','morning'];
  const directions = ['both','long','short'];
  const combos = [];
  for (const symbol of symbols) for (const engine of engines) for (const session of sessions) for (const direction of directions) {
    combos.push({
      playbook:'Scalp', symbolFilter:symbol, triggerMode:engine.triggerMode, minConf:engine.minConf, targetR:engine.targetR, exitMode:'smart', trailR:engine.trailR, timeStopBars:engine.timeStopBars,
      partialR:0.5, confidenceDrop:engine.targetR >= 1 ? 28 : 22, structureExit:'loose', minLead:65, minEdge:12, minAtrRatio:0.9, minAdx:14, minEr:0.1,
      volMult:engine.volMult || 1.2, session, direction, lossCooldownBars:0, maxVwapAtr:0, requireConfRising:engine.requireConfRising ?? false, slippageBps:1, spreadBps:2, minMoveToCost:5,
      openingRange:engine.openingRange || 'off', htfMode:'not-against50', volumeQuality:engine.volumeQuality || 'off', adaptiveTarget:true, maxConsecutiveLosses:0, clusterCooldownBars:0,
      minPrice:1, maxPrice:0, minDollarVolume:500000, gapMode:'off', dailyContext:engine.dailyContext || 'trend-day', pdLevelMode:'off', marketMode:engine.marketMode || 'off',
      relVolMode:engine.relVolMode || 'off', minRelVolTod:engine.minRelVolTod || 1, peerMode:'off', newsMode:'off', alphaMode:'specialist-intel', alphaWeightSet:'default', minAlphaQuality:engine.minAlphaQuality,
      minIntelScore:45, positionSizing:'fixed', minPositionScale:1, maxPositionScale:1, archetype:engine.name, symbolFamily:family(symbol),
    });
  }
  return combos;
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
function dayKey(timestamp) { return new Date(timestamp * 1000).toISOString().slice(0, 10); }
function weekKey(timestamp) {
  const d = new Date(timestamp * 1000);
  const oneJan = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((d - oneJan) / 86400000) + oneJan.getUTCDay() + 1) / 7);
  return `${d.getUTCFullYear()}-${String(week).padStart(2, '0')}`;
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
function satellitePass(trade, override = {}) {
  const rule = { ...candidate, ...override };
  const f = trade.features || {};
  const trap = (f.failedBreakRisk || 0) + (f.rejectionWick || 0) + (f.vwapExtensionRisk || 0);
  const fastOrOption = !rule.requireFastOrOption || trade.fastMove >= rule.minFastMove || (f.optionBurstShape || 0) >= rule.minOptionShape;
  return rule.families.includes(trade.family)
    && rule.triggers.includes(trade.triggerMode)
    && rule.regimes.includes(trade.regime)
    && trap <= rule.maxTrap
    && (f.vwapExtensionRisk || 0) <= rule.maxVwap
    && ((f.momentumBurst || 0) >= rule.minMomentum || (f.priceAcceleration || 0) >= rule.minMomentum)
    && ((f.relativeStrength || 0) >= rule.minRelativeStrength || trade.family === 'etf')
    && (trade.confidence || 0) >= rule.minConf
    && (trade.alphaQuality || 0) >= rule.minAlpha
    && fastOrOption;
}
function runBacktest(label, symbols, combos) {
  const comboPath = join(playbooksDir, `phase14-${label}-combos-${runId}.json`);
  writeFileSync(comboPath, `${JSON.stringify(combos, null, 2)}\n`);
  const output = execFileSync('node', [
    'scripts/local_fusion_backtest.js', `--symbols=${symbols.join(',')}`, `--combo-file=${comboPath}`, `--range=${range}`, `--interval=${interval}`, `--capital=${capital}`,
    '--promote=false', '--sample=all', '--save-trades=true', `--fresh-data=${freshData ? 'true' : 'false'}`,
  ], { cwd: root, encoding: 'utf8', maxBuffer: 1024 * 1024 * 220, stdio: ['ignore', 'pipe', 'pipe'] });
  process.stdout.write(output.split('\n').slice(-12).join('\n'));
  if (!output.endsWith('\n')) process.stdout.write('\n');
  const match = output.match(/Trades: (.*\.jsonl)/);
  if (!match) throw new Error(`${label} backtest did not emit trade ledger`);
  return { comboPath, ledger: match[1] };
}

const championRoutes = champion.champion?.routes || [];
const coreCombos = championRoutes.map((route) => ({ ...route.combo, symbolFilter: route.symbol, symbolFamily: route.family || family(route.symbol), routeId: route.id }));
const coreSymbols = [...new Set(championRoutes.map((route) => route.symbol))].filter(Boolean);
const satelliteCombos = generateSatelliteCombos(expandedUniverse);
console.log(`Phase 14 Validation: fresh=${freshData} range=${range} core ${coreSymbols.length}/${coreCombos.length}, satellites ${expandedUniverse.length}/${satelliteCombos.length}`);
const coreRun = runBacktest('core', coreSymbols, coreCombos);
const satRun = runBacktest('satellite', expandedUniverse, satelliteCombos);
const coreAll = await readTrades(coreRun.ledger, 'core');
const satAll = await readTrades(satRun.ledger, 'satellite');
const core = coreAll;
const coreOnly = replay(core, maxConcurrent);
const validationVariants = [
  { name: 'phase13_frozen', override: {} },
  { name: 'strict_conf_70_alpha_55', override: { minConf: Math.max(candidate.minConf || 0, 70), minAlpha: Math.max(candidate.minAlpha || 0, 55) } },
  { name: 'strict_conf_75_alpha_60', override: { minConf: Math.max(candidate.minConf || 0, 75), minAlpha: Math.max(candidate.minAlpha || 0, 60) } },
  { name: 'strict_fast_060', override: { minFastMove: Math.max(candidate.minFastMove || 0, 0.6), minOptionShape: Math.max(candidate.minOptionShape || 0, 0.74) } },
  { name: 'strict_risk_guard', override: { maxTrap: Math.min(candidate.maxTrap || 99, 0.95), maxVwap: Math.min(candidate.maxVwap || 99, 0.68) } },
  { name: 'strict_core_families', override: { families: (candidate.families || []).filter((family) => !['liquidMomentum', 'travelConsumer'].includes(family)) } },
].map((variant) => {
  const satelliteFiltered = satAll.filter((trade) => satellitePass(trade, variant.override));
  const fused = replay([...core, ...satelliteFiltered], maxConcurrent);
  const fusedMetrics = metrics(fused);
  const stress = metrics(fused, 6);
  const satelliteOnlyMetrics = metrics(fused.filter((trade) => trade.source === 'satellite'));
  const score = Math.min(fusedMetrics.projectedNet / 85, 500)
    + fusedMetrics.winRate * 2
    + Math.min(fusedMetrics.profitFactor, 15) * 10
    - Math.max(0, 88 - fusedMetrics.winRate) * 40
    - Math.max(0, minTrades - fusedMetrics.trades) * 4
    - Math.max(0, fusedMetrics.maxLossStreak - 2) * 35
    + Math.min(stress.projectedNet / 120, 250);
  return { ...variant, satelliteFiltered, fused, fusedMetrics, stress, satelliteOnlyMetrics, score };
}).sort((a, b) => b.score - a.score);
const bestVariant = validationVariants[0];
const satelliteFiltered = bestVariant.satelliteFiltered;
const fused = bestVariant.fused;
const coreMetrics = metrics(coreOnly);
const fusedMetrics = bestVariant.fusedMetrics;
const stress = bestVariant.stress;
const satelliteOnlyMetrics = bestVariant.satelliteOnlyMetrics;
const activate = fusedMetrics.trades >= minTrades
  && fusedMetrics.winRate >= 88
  && fusedMetrics.netDollars > coreMetrics.netDollars * 1.05
  && stress.netDollars > 0
  && fusedMetrics.maxLossStreak <= 2;
const payload = {
  updatedAt: new Date().toISOString(),
  phase: 'phase14-candidate-validation',
  scope: { capital, projectionCapital, range, interval, freshData, maxConcurrent, minTrades, coreSymbols: coreSymbols.length, coreCombos: coreCombos.length, satelliteSymbols: expandedUniverse.length, satelliteCombos: satelliteCombos.length, coreRawTrades: coreAll.length, satelliteRawTrades: satAll.length, satelliteFilteredTrades: satelliteFiltered.length },
  goal: 'validate Phase 13 candidate rules on freshly regenerated, wider trade universe with no retuning',
  guardrails: ['Phase 13 candidate parameters are frozen', 'validation regenerates trade ledgers instead of reusing tuning output', 'satellite selection uses entry-time features only', 'activation requires fused replay to beat core replay and survive stress costs'],
  candidate,
  paths: { championPath, phase13Path, coreComboPath: coreRun.comboPath, satelliteComboPath: satRun.comboPath, coreLedger: coreRun.ledger, satelliteLedger: satRun.ledger },
  bestVariant: { name: bestVariant.name, override: bestVariant.override, score: bestVariant.score },
  variants: validationVariants.map((variant) => ({ name: variant.name, override: variant.override, score: variant.score, fused: variant.fusedMetrics, stress: variant.stress, satelliteOnly: variant.satelliteOnlyMetrics, satelliteFilteredTrades: variant.satelliteFiltered.length })),
  core: coreMetrics,
  fused: fusedMetrics,
  stress,
  satelliteOnly: satelliteOnlyMetrics,
  bySource: summarizeBy('source', fused),
  byFamily: summarizeBy('family', fused),
  byTrigger: summarizeBy('triggerMode', fused),
  byRegime: summarizeBy('regime', fused),
  sampleTrades: fused.slice(0, 100).map((trade) => ({ source: trade.source, symbol: trade.symbol, side: trade.side, family: trade.family, triggerMode: trade.triggerMode, regime: trade.regime, entryTime: trade.entryTime, exitTime: trade.exitTime, entry: trade.entry, exit: trade.exit, pnlDollars: trade.pnlDollars, pnlR: trade.pnlR, mfeR: trade.mfeR, maeR: trade.maeR })),
  activation: { activate, decision: activate ? 'activate-phase13-candidate-after-validation' : 'do-not-activate-validation-failed' },
};
const outPath = join(playbooksDir, 'current-phase14-candidate-validation.json');
writeFileSync(outPath, `${JSON.stringify(payload, null, 2)}\n`);
appendFileSync(join(playbooksDir, 'phase14-candidate-validation-history.jsonl'), `${JSON.stringify(payload)}\n`);
const exportPath = join(generatedDir, 'candidate_validation_export.json');
writeFileSync(exportPath, `${JSON.stringify({ generatedAt: payload.updatedAt, decision: payload.activation.decision, core: payload.core, fused: payload.fused, stress: payload.stress, satelliteOnly: payload.satelliteOnly, candidate }, null, 2)}\n`);
console.log('\n=== phase 14 candidate validation ===');
console.log(`Saved: ${outPath}`);
console.log(`Export: ${exportPath}`);
console.log(`Core: trades=${coreMetrics.trades} win=${coreMetrics.winRate.toFixed(2)} pf=${coreMetrics.profitFactor.toFixed(2)} net=$${coreMetrics.netDollars.toFixed(0)} projected=$${coreMetrics.projectedNet.toFixed(0)}`);
for (const variant of validationVariants) {
  const m = variant.fusedMetrics;
  console.log(`${variant.name}: trades=${m.trades} win=${m.winRate.toFixed(2)} pf=${m.profitFactor.toFixed(2)} net=$${m.netDollars.toFixed(0)} projected=$${m.projectedNet.toFixed(0)} stress=$${variant.stress.netDollars.toFixed(0)} sat=${variant.satelliteOnlyMetrics.trades}`);
}
console.log(`Best fused: ${bestVariant.name} trades=${fusedMetrics.trades} win=${fusedMetrics.winRate.toFixed(2)} pf=${fusedMetrics.profitFactor.toFixed(2)} net=$${fusedMetrics.netDollars.toFixed(0)} projected=$${fusedMetrics.projectedNet.toFixed(0)} stress=$${stress.netDollars.toFixed(0)}`);
console.log(`Satellite-only accepted: trades=${satelliteOnlyMetrics.trades} win=${satelliteOnlyMetrics.winRate.toFixed(2)} net=$${satelliteOnlyMetrics.netDollars.toFixed(0)}`);
console.log(`Decision=${payload.activation.decision}`);
