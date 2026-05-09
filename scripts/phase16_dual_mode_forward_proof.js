#!/usr/bin/env node
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const playbooksDir = join(root, 'optimization-results', 'models', 'playbooks');
const forwardDir = join(root, 'optimization-results', 'forward-tests');
const generatedDir = join(root, 'generated');
for (const dir of [playbooksDir, forwardDir, generatedDir]) mkdirSync(dir, { recursive: true });

const args = new Map(process.argv.slice(2).map((arg) => {
  const [key, value = 'true'] = arg.replace(/^--/, '').split('=');
  return [key, value];
}));

const capital = Number(args.get('capital') || 100000);
const projectionCapital = Number(args.get('projection-capital') || 10000);
const interval = args.get('interval') || '5m';
const range = args.get('range') || '5d';
const freshData = args.get('fresh-data') !== 'false';
const maxConcurrent = Number(args.get('max-concurrent') || 5);
const startEt = args.get('start-et') || '09:30';
const endEt = args.get('end-et') || '10:30';
const targetDate = args.get('date') || dateET(Math.floor(Date.now() / 1000));
const activeModesPath = join(playbooksDir, 'current-active-scalp-modes.json');
const championPath = join(playbooksDir, 'current-master-scalp-champion.json');
const phase14Path = join(playbooksDir, 'current-phase14-candidate-validation.json');
if (!existsSync(activeModesPath)) throw new Error(`Missing active modes: ${activeModesPath}. Run npm run scalp:phase15 first.`);
if (!existsSync(championPath)) throw new Error(`Missing champion: ${championPath}`);
if (!existsSync(phase14Path)) throw new Error(`Missing Phase 14 validation: ${phase14Path}`);

const activeModes = readJson(activeModesPath);
const champion = readJson(championPath);
const phase14 = readJson(phase14Path);
const profitCandidate = activeModes.activeModes.profit_max.candidate;

function readJson(path) { return JSON.parse(readFileSync(path, 'utf8')); }
function parseMinute(value) {
  const match = String(value).match(/^(\d{1,2}):(\d{2})$/);
  if (!match) throw new Error(`Expected HH:MM ET, got ${value}`);
  return Number(match[1]) * 60 + Number(match[2]);
}
function marketMinutesET(timestamp) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour12: false, hour: '2-digit', minute: '2-digit' }).formatToParts(new Date(timestamp * 1000));
  const hour = Number(parts.find((part) => part.type === 'hour')?.value || 0);
  const minute = Number(parts.find((part) => part.type === 'minute')?.value || 0);
  return (hour === 24 ? 0 : hour) * 60 + minute;
}
function dateET(timestamp) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(timestamp * 1000));
}
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
function enrichRow(row, source, mode) {
  const trade = row.trade || {};
  const combo = row.combo || {};
  const features = trade.features || {};
  const symbol = row.symbol || trade.symbol;
  return { ...trade, symbol, combo, source, mode, features, family: combo.symbolFamily || family(symbol), triggerMode: combo.triggerMode, session: combo.session, direction: combo.direction, regime: regimeOf(features, combo), fastMove: Math.max(trade.move5mR || 0, trade.move10mR || 0, trade.move15mR || 0) };
}
function keyOf(trade) { return `${trade.symbol}|${trade.entryTime}|${trade.exitTime}|${trade.side}|${Math.round(trade.entry * 10000)}|${Math.round(trade.exit * 10000)}`; }
function signalKey(trade) { return `${trade.mode}|${trade.symbol}|${trade.triggerMode}|${trade.side}|${trade.entryTime}`; }
function qualityScore(trade) {
  const f = trade.features || {};
  return (trade.source === 'core' ? 10000 : 0) + (trade.confidence || 0) * 0.9 + (trade.alphaQuality || 0) * 0.55 + (f.optionBurstShape || 0) * 35 + (f.momentumBurst || 0) * 30 + (f.volumeQuality || 0) * 22 + (f.relativeStrength || 0) * 28 - (f.failedBreakRisk || 0) * 60 - (f.vwapExtensionRisk || 0) * 45;
}
function satellitePass(trade) {
  const c = profitCandidate;
  const f = trade.features || {};
  const trap = (f.failedBreakRisk || 0) + (f.rejectionWick || 0) + (f.vwapExtensionRisk || 0);
  const fastOrOption = !c.requireFastOrOption || trade.fastMove >= c.minFastMove || (f.optionBurstShape || 0) >= c.minOptionShape;
  return c.families.includes(trade.family) && c.triggers.includes(trade.triggerMode) && c.regimes.includes(trade.regime) && trap <= c.maxTrap && (f.vwapExtensionRisk || 0) <= c.maxVwap && ((f.momentumBurst || 0) >= c.minMomentum || (f.priceAcceleration || 0) >= c.minMomentum) && ((f.relativeStrength || 0) >= c.minRelativeStrength || trade.family === 'etf') && (trade.confidence || 0) >= c.minConf && (trade.alphaQuality || 0) >= c.minAlpha && fastOrOption;
}
function replay(trades, maxOpen) {
  const accepted = [];
  const seen = new Set();
  const bySignal = new Map();
  for (const trade of trades) {
    const current = bySignal.get(signalKey(trade));
    if (!current || qualityScore(trade) > qualityScore(current)) bySignal.set(signalKey(trade), trade);
  }
  const sorted = [...bySignal.values()].map((trade) => ({ ...trade, forwardScore: qualityScore(trade) })).sort((a, b) => (a.entryTime - b.entryTime) || (b.forwardScore - a.forwardScore));
  for (const trade of sorted) {
    const key = keyOf(trade);
    if (seen.has(key)) continue;
    seen.add(key);
    const open = accepted.filter((item) => item.exitTime > trade.entryTime);
    if (open.some((item) => item.mode === trade.mode && item.symbol === trade.symbol)) continue;
    if (open.filter((item) => item.mode === trade.mode).length >= maxOpen) continue;
    accepted.push(trade);
  }
  return accepted;
}
function metrics(trades) {
  const wins = trades.filter((trade) => (trade.pnlDollars || 0) > 0);
  const losses = trades.filter((trade) => (trade.pnlDollars || 0) <= 0);
  const grossWin = wins.reduce((sum, trade) => sum + (trade.pnlDollars || 0), 0);
  const grossLoss = Math.abs(losses.reduce((sum, trade) => sum + (trade.pnlDollars || 0), 0));
  const netDollars = grossWin - grossLoss;
  return { trades: trades.length, wins: wins.length, losses: losses.length, winRate: trades.length ? wins.length / trades.length * 100 : 0, profitFactor: grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? 999 : 0), netDollars, projectedNet: netDollars * projectionCapital / capital, avgDollars: trades.length ? netDollars / trades.length : 0, projectedAvgDollars: trades.length ? netDollars * projectionCapital / capital / trades.length : 0 };
}
function runLocal(label, symbols, comboPath) {
  if (!symbols.length) return [];
  const output = execFileSync('node', ['scripts/local_fusion_backtest.js', `--symbols=${symbols.join(',')}`, `--combo-file=${comboPath}`, `--range=${range}`, `--interval=${interval}`, `--capital=${capital}`, `--fresh-data=${freshData ? 'true' : 'false'}`, '--promote=false', '--sample=all', '--save-trades=true', '--min-trades=0', '--min-symbols=1'], { cwd: root, encoding: 'utf8', maxBuffer: 1024 * 1024 * 180, stdio: ['ignore', 'pipe', 'pipe'] });
  process.stdout.write(output.split('\n').slice(-8).join('\n'));
  if (!output.endsWith('\n')) process.stdout.write('\n');
  const path = output.match(/Trades: (.*\.jsonl)/)?.[1];
  if (!path || !existsSync(path)) return [];
  return readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
}
function writeCombos(label, combos) {
  const path = join(playbooksDir, `phase16-${label}-combos-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  writeFileSync(path, `${JSON.stringify(combos, null, 2)}\n`);
  return path;
}
function routeKey(trade) { return `${trade.mode}|${trade.symbol}|${trade.session || 'all'}|${trade.direction || trade.side}|${trade.triggerMode}`; }
function updateTrust(payload) {
  const trustPath = join(forwardDir, 'dual-mode-forward-trust.json');
  const trust = existsSync(trustPath) ? readJson(trustPath) : { updatedAt: null, modes: {}, routes: {} };
  for (const trade of payload.trades) {
    const modeItem = trust.modes[trade.mode] || { trades: 0, wins: 0, netDollars: 0, grossWin: 0, grossLoss: 0, lossStreak: 0, quarantined: false };
    modeItem.trades += 1;
    if ((trade.pnlDollars || 0) > 0) { modeItem.wins += 1; modeItem.grossWin += trade.pnlDollars || 0; modeItem.lossStreak = 0; }
    else { modeItem.grossLoss += Math.abs(trade.pnlDollars || 0); modeItem.lossStreak += 1; }
    modeItem.netDollars += trade.pnlDollars || 0;
    modeItem.winRate = modeItem.trades ? modeItem.wins / modeItem.trades * 100 : 0;
    modeItem.profitFactor = modeItem.grossLoss > 0 ? modeItem.grossWin / modeItem.grossLoss : (modeItem.grossWin > 0 ? 999 : 0);
    modeItem.quarantined = modeItem.lossStreak >= (trade.mode === 'profit_max' ? 2 : 3);
    trust.modes[trade.mode] = modeItem;
    const key = routeKey(trade);
    const route = trust.routes[key] || { trades: 0, wins: 0, netDollars: 0, grossWin: 0, grossLoss: 0, lossStreak: 0, quarantined: false };
    route.trades += 1;
    if ((trade.pnlDollars || 0) > 0) { route.wins += 1; route.grossWin += trade.pnlDollars || 0; route.lossStreak = 0; }
    else { route.grossLoss += Math.abs(trade.pnlDollars || 0); route.lossStreak += 1; }
    route.netDollars += trade.pnlDollars || 0;
    route.winRate = route.trades ? route.wins / route.trades * 100 : 0;
    route.profitFactor = route.grossLoss > 0 ? route.grossWin / route.grossLoss : (route.grossWin > 0 ? 999 : 0);
    route.quarantined = route.lossStreak >= (trade.mode === 'profit_max' ? 2 : 3);
    route.lastSeen = payload.generatedAt;
    trust.routes[key] = route;
  }
  trust.updatedAt = payload.generatedAt;
  writeFileSync(trustPath, `${JSON.stringify(trust, null, 2)}\n`);
  return { trustPath, trust };
}

const startMinute = parseMinute(startEt);
const endMinute = parseMinute(endEt);
const coreRoutes = champion.champion.routes || [];
const coreCombos = coreRoutes.map((route) => ({ ...route.combo, symbolFilter: route.symbol, symbolFamily: route.family || family(route.symbol), routeId: route.id }));
const coreSymbols = [...new Set(coreRoutes.map((route) => route.symbol))];
const coreComboPath = writeCombos('high-win-core', coreCombos);
const satelliteComboPath = phase14.paths.satelliteComboPath;
const satelliteCombos = existsSync(satelliteComboPath) ? readJson(satelliteComboPath) : [];
const satelliteSymbols = [...new Set(satelliteCombos.map((combo) => combo.symbolFilter).filter(Boolean))];
console.log(`Phase 16 Forward Proof ${targetDate} ${startEt}-${endEt} ET fresh=${freshData}`);
console.log(`High Win universe=${coreSymbols.length}, Profit Max satellite universe=${satelliteSymbols.length}`);
const coreRows = runLocal('high_win', coreSymbols, coreComboPath);
const satRows = runLocal('profit_max', satelliteSymbols, satelliteComboPath);
const inWindow = (trade) => dateET(trade.entryTime) === targetDate && marketMinutesET(trade.entryTime) >= startMinute && marketMinutesET(trade.entryTime) < endMinute;
const highWinRaw = coreRows.map((row) => enrichRow(row, 'core', 'high_win')).filter(inWindow);
const profitRaw = [
  ...coreRows.map((row) => enrichRow(row, 'core', 'profit_max')),
  ...satRows.map((row) => enrichRow(row, 'satellite', 'profit_max')).filter(satellitePass),
].filter(inWindow);
const highWinTrades = replay(highWinRaw, maxConcurrent);
const profitTrades = replay(profitRaw, maxConcurrent);
const payload = {
  generatedAt: new Date().toISOString(),
  phase: 'phase16-dual-mode-forward-proof',
  targetDate,
  window: `${startEt}-${endEt} ET`,
  capital,
  projectionCapital,
  guardrails: ['paper only; no orders placed', 'High Win and Profit Max scored separately', 'Profit Max remains specialist unless forward trust clears promotion thresholds', 'routes quarantine after live/paper loss clusters'],
  paths: { activeModesPath, championPath, phase14Path, coreComboPath, satelliteComboPath },
  rawCounts: { highWinRaw: highWinRaw.length, profitRaw: profitRaw.length, highWinAccepted: highWinTrades.length, profitAccepted: profitTrades.length },
  modes: { high_win: metrics(highWinTrades), profit_max: metrics(profitTrades) },
  trades: [...highWinTrades, ...profitTrades].map((trade) => ({ mode: trade.mode, source: trade.source, symbol: trade.symbol, side: trade.side, family: trade.family, triggerMode: trade.triggerMode, session: trade.session, direction: trade.direction, regime: trade.regime, entryTime: new Date(trade.entryTime * 1000).toISOString(), exitTime: new Date(trade.exitTime * 1000).toISOString(), entry: trade.entry, exit: trade.exit, reason: trade.reason, pnlDollars: trade.pnlDollars, pnlR: trade.pnlR, mfeR: trade.mfeR, maeR: trade.maeR, confidence: trade.confidence, alphaQuality: trade.alphaQuality })),
};
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const outPath = join(forwardDir, `dual-mode-forward-proof-${targetDate}-${stamp}.json`);
const latestPath = join(forwardDir, 'latest-dual-mode-forward-proof.json');
const ledgerPath = join(forwardDir, 'dual-mode-forward-ledger.jsonl');
writeFileSync(outPath, `${JSON.stringify(payload, null, 2)}\n`);
writeFileSync(latestPath, `${JSON.stringify(payload, null, 2)}\n`);
appendFileSync(ledgerPath, `${JSON.stringify({ generatedAt: payload.generatedAt, targetDate, window: payload.window, modes: payload.modes, rawCounts: payload.rawCounts, outputPath: outPath })}\n`);
const { trustPath, trust } = updateTrust(payload);
const status = {
  updatedAt: payload.generatedAt,
  defaultMode: activeModes.defaultMode,
  latestForwardProof: latestPath,
  ledgerPath,
  trustPath,
  modes: payload.modes,
  trust: trust.modes,
  promotionReadiness: {
    profitMaxCanPromote: (trust.modes.profit_max?.trades || 0) >= 120 && (trust.modes.profit_max?.winRate || 0) >= 90 && (trust.modes.profit_max?.profitFactor || 0) >= 3,
    highWinHealthy: !trust.modes.high_win?.quarantined,
  },
};
const statusPath = join(forwardDir, 'dual-mode-forward-status.json');
writeFileSync(statusPath, `${JSON.stringify(status, null, 2)}\n`);
const exportPath = join(generatedDir, 'forward_proof_status_export.json');
writeFileSync(exportPath, `${JSON.stringify({ generatedAt: payload.generatedAt, defaultMode: activeModes.defaultMode, latest: payload.modes, trust: trust.modes, promotionReadiness: status.promotionReadiness }, null, 2)}\n`);
console.log(`\nForward proof saved: ${outPath}`);
console.log(`Latest: ${latestPath}`);
console.log(`Ledger: ${ledgerPath}`);
console.log(`Trust: ${trustPath}`);
console.log(`Status: ${statusPath}`);
console.log(`High Win: trades=${payload.modes.high_win.trades} win=${payload.modes.high_win.winRate.toFixed(2)} pf=${payload.modes.high_win.profitFactor.toFixed(2)} net=$${payload.modes.high_win.netDollars.toFixed(0)}`);
console.log(`Profit Max: trades=${payload.modes.profit_max.trades} win=${payload.modes.profit_max.winRate.toFixed(2)} pf=${payload.modes.profit_max.profitFactor.toFixed(2)} net=$${payload.modes.profit_max.netDollars.toFixed(0)}`);
console.log(`Profit Max promotion ready=${status.promotionReadiness.profitMaxCanPromote}`);
