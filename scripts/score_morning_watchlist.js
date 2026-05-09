#!/usr/bin/env node
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const reportsDir = join(root, 'optimization-results', 'morning-watchlists');
const feedbackDir = join(root, 'optimization-results', 'morning-feedback');
const forwardDir = join(root, 'optimization-results', 'forward-tests');
if (!existsSync(feedbackDir)) mkdirSync(feedbackDir, { recursive: true });
if (!existsSync(forwardDir)) mkdirSync(forwardDir, { recursive: true });

const args = new Map(process.argv.slice(2).map((arg) => {
  const [key, value = 'true'] = arg.replace(/^--/, '').split('=');
  return [key, value];
}));

const label = args.get('label') || '';
const safeLabel = label.replace(/[^a-z0-9_-]+/gi, '-').replace(/^-|-$/g, '').toLowerCase();
const watchlistPath = args.get('watchlist') || join(reportsDir, safeLabel ? `latest-${safeLabel}-morning-watchlist.json` : 'latest-morning-scalp-watchlist.json');
const interval = args.get('interval') || '5m';
const range = args.get('range') || '5d';
const mode = args.get('mode') || 'route';
const capital = Number(args.get('capital') || 100000);

function marketMinutesET(timestamp) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(new Date(timestamp * 1000));
  const hour = Number(parts.find((part) => part.type === 'hour')?.value || 0);
  const minute = Number(parts.find((part) => part.type === 'minute')?.value || 0);
  return (hour === 24 ? 0 : hour) * 60 + minute;
}

function dateET(timestamp) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(timestamp * 1000));
}

async function fetchBars(symbol) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=${interval}&includePrePost=false`;
  const response = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!response.ok) throw new Error(`${symbol} HTTP ${response.status}`);
  const data = await response.json();
  const result = data.chart?.result?.[0];
  const timestamps = result?.timestamp || [];
  const quote = result?.indicators?.quote?.[0] || {};
  return timestamps.map((time, index) => ({
    time,
    open: quote.open?.[index],
    high: quote.high?.[index],
    low: quote.low?.[index],
    close: quote.close?.[index],
    volume: quote.volume?.[index] || 0,
  })).filter((bar) => [bar.open, bar.high, bar.low, bar.close].every(Number.isFinite));
}

function sessionBounds(session) {
  if (session === 'open-0930') return [570, 600];
  if (session === 'open-1000') return [600, 630];
  if (session === 'open-1030') return [630, 660];
  if (session === 'open') return [570, 660];
  if (session === 'morning') return [570, 720];
  if (session === 'afternoon') return [720, 960];
  if (session === 'powerhour') return [900, 960];
  return [570, 960];
}

function scorePick(pick, bars) {
  const generatedDay = dateET(Date.parse(pick.live.lastTime) / 1000 || bars.at(-1).time);
  const [start, end] = sessionBounds(pick.session);
  const dayBars = bars.filter((bar) => dateET(bar.time) === generatedDay && marketMinutesET(bar.time) >= start && marketMinutesET(bar.time) < end);
  if (dayBars.length < 2) return { symbol: pick.symbol, status: 'not-enough-bars' };
  const entry = dayBars[0].open;
  const direction = pick.direction.startsWith('SHORT') ? -1 : 1;
  const high = Math.max(...dayBars.map((bar) => bar.high));
  const low = Math.min(...dayBars.map((bar) => bar.low));
  const close = dayBars.at(-1).close;
  const favorablePct = direction === 1 ? (high - entry) / entry * 100 : (entry - low) / entry * 100;
  const adversePct = direction === 1 ? (entry - low) / entry * 100 : (high - entry) / entry * 100;
  const closePct = direction * (close - entry) / entry * 100;
  const hit = favorablePct >= Math.max(0.25, Math.abs(pick.riskPlan?.targetR || 0.35) * 0.5);
  return {
    symbol: pick.symbol,
    triggerMode: pick.combo?.triggerMode,
    session: pick.session,
    routeDirection: pick.combo?.direction || pick.direction,
    session: pick.session,
    direction: pick.direction,
    entry,
    close,
    favorablePct,
    adversePct,
    closePct,
    hit,
    clean: hit && adversePct <= favorablePct,
    bars: dayBars.length,
  };
}

function comboArg(name, value) {
  if (value == null) return null;
  return `--${name}=${value}`;
}

function argsForCombo(pick) {
  const combo = pick.combo || {};
  return [
    comboArg('symbols', pick.symbol),
    comboArg('interval', interval),
    comboArg('range', range),
    comboArg('capital', capital),
    comboArg('playbook', combo.playbook || 'Scalp'),
    comboArg('trigger-mode', combo.triggerMode || 'base'),
    comboArg('min-conf', combo.minConf ?? 65),
    comboArg('target-r', combo.targetR ?? 0.35),
    comboArg('exit-mode', combo.exitMode || 'smart'),
    comboArg('trail-r', combo.trailR ?? 0.5),
    comboArg('time-stop-bars', combo.timeStopBars ?? 6),
    comboArg('partial-r', combo.partialR ?? 1),
    comboArg('confidence-drop', combo.confidenceDrop ?? 25),
    comboArg('structure-exit', combo.structureExit || 'strict'),
    comboArg('min-lead', combo.minLead ?? 65),
    comboArg('min-edge', combo.minEdge ?? 12),
    comboArg('min-atr-ratio', combo.minAtrRatio ?? 0.9),
    comboArg('min-adx', combo.minAdx ?? 14),
    comboArg('min-er', combo.minEr ?? 0.1),
    comboArg('vol-mult', combo.volMult ?? 1.2),
    comboArg('session', combo.session || pick.session || 'all'),
    comboArg('direction', combo.direction || (pick.direction?.startsWith('SHORT') ? 'short' : 'long')),
    comboArg('loss-cooldown-bars', combo.lossCooldownBars ?? 0),
    comboArg('max-vwap-atr', combo.maxVwapAtr ?? 0),
    comboArg('require-conf-rising', combo.requireConfRising ?? true),
    comboArg('slippage-bps', combo.slippageBps ?? 1),
    comboArg('spread-bps', combo.spreadBps ?? 2),
    comboArg('min-move-to-cost', combo.minMoveToCost ?? 5),
    comboArg('opening-range', combo.openingRange || 'off'),
    comboArg('htf-mode', combo.htfMode || 'not-against50'),
    comboArg('volume-quality', combo.volumeQuality || 'off'),
    comboArg('adaptive-target', combo.adaptiveTarget ?? false),
    comboArg('max-consecutive-losses', combo.maxConsecutiveLosses ?? 0),
    comboArg('cluster-cooldown-bars', combo.clusterCooldownBars ?? 0),
    comboArg('min-price', combo.minPrice ?? 1),
    comboArg('max-price', combo.maxPrice ?? 0),
    comboArg('min-dollar-volume', combo.minDollarVolume ?? 500000),
    comboArg('gap-mode', combo.gapMode || 'off'),
    comboArg('daily-context', combo.dailyContext || 'trend-day'),
    comboArg('pd-level-mode', combo.pdLevelMode || 'off'),
    comboArg('market-mode', combo.marketMode || 'off'),
    comboArg('rel-vol-mode', combo.relVolMode || 'off'),
    comboArg('min-rel-vol-tod', combo.minRelVolTod ?? 0),
    comboArg('peer-mode', combo.peerMode || 'off'),
    comboArg('news-mode', combo.newsMode || 'off'),
    comboArg('alpha-mode', combo.alphaMode || 'default'),
    comboArg('min-alpha-quality', combo.minAlphaQuality ?? 0),
    comboArg('intelligence-mode', (combo.minIntelScore ?? 0) > 0 ? 'gate' : 'off'),
    comboArg('min-intel-score', combo.minIntelScore ?? 0),
    comboArg('position-sizing', combo.positionSizing || 'fixed'),
    comboArg('min-position-scale', combo.minPositionScale ?? 1),
    comboArg('max-position-scale', combo.maxPositionScale ?? 1),
    comboArg('sample', 'all'),
    comboArg('train-pct', 0.7),
    comboArg('save-trades', true),
    comboArg('promote', false),
    comboArg('min-trades', 0),
    comboArg('min-symbols', 1),
  ].filter(Boolean);
}

function summaryPathFrom(output) {
  return output.match(/Summary: (.*\.json)/)?.[1] || null;
}

function scorePickByRoute(pick) {
  const generatedDay = dateET(Date.parse(pick.live.lastTime) / 1000);
  const output = execFileSync('node', ['scripts/local_fusion_backtest.js', ...argsForCombo(pick)], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024 * 80,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const summaryPath = summaryPathFrom(output);
  if (!summaryPath) return { symbol: pick.symbol, status: 'no-summary' };
  const summary = JSON.parse(readFileSync(summaryPath, 'utf8'));
  const tradesPath = summary.paths?.trades;
  if (!tradesPath || !existsSync(tradesPath)) {
    return {
      symbol: pick.symbol,
      triggerMode: pick.combo?.triggerMode,
      session: pick.session,
      routeDirection: pick.combo?.direction || pick.direction,
      direction: pick.direction,
      status: 'no-trigger',
      summaryPath,
      generatedDay,
    };
  }
  const trades = readFileSync(tradesPath, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((row) => row.symbol === pick.symbol && dateET(row.trade.entryTime) === generatedDay);
  if (trades.length === 0) {
    return {
      symbol: pick.symbol,
      triggerMode: pick.combo?.triggerMode,
      session: pick.session,
      routeDirection: pick.combo?.direction || pick.direction,
      direction: pick.direction,
      status: 'no-trigger',
      summaryPath,
      generatedDay,
    };
  }
  const trade = trades.sort((a, b) => a.trade.entryTime - b.trade.entryTime)[0].trade;
  return {
    symbol: pick.symbol,
    triggerMode: pick.combo?.triggerMode,
    session: pick.session,
    routeDirection: pick.combo?.direction || pick.direction,
    direction: trade.side?.toUpperCase() || pick.direction,
    status: 'triggered',
    entryTime: new Date(trade.entryTime * 1000).toISOString(),
    exitTime: new Date(trade.exitTime * 1000).toISOString(),
    entry: trade.entry,
    exit: trade.exit,
    reason: trade.reason,
    pnlDollars: trade.pnlDollars,
    pnlR: trade.pnlR,
    mfeR: trade.mfeR,
    maeR: trade.maeR,
    hit: trade.pnlDollars > 0,
    clean: trade.pnlDollars > 0 && trade.maeR <= Math.max(0.75, trade.mfeR),
    optionWorthy: trade.optionWorthy,
    summaryPath,
  };
}

const watchlist = JSON.parse(readFileSync(watchlistPath, 'utf8'));
const results = [];
for (const pick of watchlist.watchlist || []) {
  try {
    if (mode === 'open-close') {
      const bars = await fetchBars(pick.symbol);
      results.push(scorePick(pick, bars));
    } else {
      results.push(scorePickByRoute(pick));
    }
  } catch (error) {
    results.push({ symbol: pick.symbol, status: error.message });
  }
}

const scored = results.filter((item) => item.hit != null);
const hits = scored.filter((item) => item.hit);
const clean = scored.filter((item) => item.clean);
const routeMode = mode !== 'open-close';
const payload = {
  generatedAt: new Date().toISOString(),
  watchlistPath,
  mode: routeMode ? 'route-trigger' : 'open-close',
  count: scored.length,
  hitRate: scored.length ? hits.length / scored.length * 100 : 0,
  cleanHitRate: scored.length ? clean.length / scored.length * 100 : 0,
  avgFavorablePct: !routeMode && scored.length ? scored.reduce((sum, item) => sum + item.favorablePct, 0) / scored.length : null,
  avgAdversePct: !routeMode && scored.length ? scored.reduce((sum, item) => sum + item.adversePct, 0) / scored.length : null,
  netDollars: routeMode ? scored.reduce((sum, item) => sum + (item.pnlDollars || 0), 0) : null,
  avgPnlDollars: routeMode && scored.length ? scored.reduce((sum, item) => sum + (item.pnlDollars || 0), 0) / scored.length : null,
  avgR: routeMode && scored.length ? scored.reduce((sum, item) => sum + (item.pnlR || 0), 0) / scored.length : null,
  results,
  trades: routeMode ? scored.filter((item) => item.status === 'triggered').map((item) => ({
    symbol: item.symbol,
    triggerMode: item.triggerMode,
    session: item.session,
    direction: item.routeDirection,
    side: item.direction,
    entryTime: item.entryTime,
    exitTime: item.exitTime,
    pnlDollars: item.pnlDollars,
    pnlR: item.pnlR,
    mfeR: item.mfeR,
    maeR: item.maeR,
  })) : [],
};

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const filePrefix = safeLabel ? `morning-${safeLabel}-feedback` : 'morning-feedback';
const out = join(feedbackDir, `${filePrefix}-${stamp}.json`);
const latest = join(feedbackDir, safeLabel ? `latest-${safeLabel}-morning-feedback.json` : 'latest-morning-feedback.json');
writeFileSync(out, `${JSON.stringify(payload, null, 2)}\n`);
writeFileSync(latest, `${JSON.stringify(payload, null, 2)}\n`);
if (safeLabel) writeFileSync(join(feedbackDir, 'latest-morning-feedback.json'), `${JSON.stringify(payload, null, 2)}\n`);
const historyPath = join(feedbackDir, 'morning-feedback-history.jsonl');
writeFileSync(historyPath, `${existsSync(historyPath) ? readFileSync(historyPath, 'utf8') : ''}${JSON.stringify(payload)}\n`);
const forwardLedgerPath = join(forwardDir, 'champion-forward-performance-ledger.jsonl');
appendFileSync(forwardLedgerPath, `${JSON.stringify({
  generatedAt: payload.generatedAt,
  mode: 'morning-watchlist-feedback',
  metrics: {
    trades: payload.count,
    winRate: payload.hitRate,
    netDollars: payload.netDollars,
    avgDollars: payload.avgPnlDollars,
    avgR: payload.avgR,
  },
  outputPath: out,
})}\n`);
const trustPath = join(forwardDir, 'route-forward-trust.json');
const trust = existsSync(trustPath) ? JSON.parse(readFileSync(trustPath, 'utf8')) : { updatedAt: null, routes: {} };
for (const trade of payload.trades) {
  const key = `${trade.symbol}|${trade.session || 'all'}|${trade.direction || trade.side}|${trade.triggerMode}`;
  const item = trust.routes[key] || { trades: 0, wins: 0, netDollars: 0, grossWin: 0, grossLoss: 0, lastSeen: null };
  item.trades += 1;
  if ((trade.pnlDollars || 0) > 0) item.wins += 1;
  item.netDollars += trade.pnlDollars || 0;
  if ((trade.pnlDollars || 0) > 0) item.grossWin += trade.pnlDollars || 0;
  else item.grossLoss += Math.abs(trade.pnlDollars || 0);
  item.lastSeen = payload.generatedAt;
  item.winRate = item.trades ? item.wins / item.trades * 100 : 0;
  item.profitFactor = item.grossLoss > 0 ? item.grossWin / item.grossLoss : (item.grossWin > 0 ? 999 : 0);
  trust.routes[key] = item;
}
trust.updatedAt = payload.generatedAt;
writeFileSync(trustPath, `${JSON.stringify(trust, null, 2)}\n`);
console.log(`Morning feedback saved: ${out}`);
console.log(`Forward ledger updated: ${forwardLedgerPath}`);
console.log(`Forward trust updated: ${trustPath}`);
if (routeMode) {
  console.log(`Picks triggered=${payload.count} win=${payload.hitRate.toFixed(1)}% clean=${payload.cleanHitRate.toFixed(1)}% net=$${(payload.netDollars ?? 0).toFixed(0)} avg=$${(payload.avgPnlDollars ?? 0).toFixed(0)} avgR=${(payload.avgR ?? 0).toFixed(3)}`);
} else {
  console.log(`Picks scored=${payload.count} hit=${payload.hitRate.toFixed(1)}% clean=${payload.cleanHitRate.toFixed(1)}% fav=${payload.avgFavorablePct.toFixed(2)}% adv=${payload.avgAdversePct.toFixed(2)}%`);
}
