#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const playbooksDir = join(root, 'optimization-results', 'models', 'playbooks');
const reportsDir = join(root, 'optimization-results', 'morning-watchlists');
if (!existsSync(reportsDir)) mkdirSync(reportsDir, { recursive: true });

const args = new Map(process.argv.slice(2).map((arg) => {
  const [key, value = 'true'] = arg.replace(/^--/, '').split('=');
  return [key, value];
}));

const label = args.get('label') || '';
const safeLabel = label.replace(/[^a-z0-9_-]+/gi, '-').replace(/^-|-$/g, '').toLowerCase();
const explicitRoutes = args.has('routes');
const routesPath = args.get('routes') || join(playbooksDir, 'current-walk-forward-scalp-routes.json');
const portfolioPath = args.get('portfolio') || join(playbooksDir, 'current-scalp-portfolio.json');
const championPath = args.get('champion') || join(playbooksDir, 'current-master-scalp-champion.json');
const routerPath = args.get('router') || join(playbooksDir, 'current-phase6-specialist-router.json');
const trustPath = join(root, 'optimization-results', 'forward-tests', 'route-forward-trust.json');
const top = Number(args.get('top') || 30);
const minRouteTrades = Number(args.get('min-route-trades') || 3);
const minRouteWin = Number(args.get('min-route-win') || 60);
const includePremarket = args.get('premarket') !== 'false';
const range = args.get('range') || '10d';
const interval = args.get('interval') || '5m';
const capital = Number(args.get('capital') || 100000);
const portfolioAware = args.get('portfolio-aware') !== 'false';

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function uniqueRoutes(routes) {
  const seen = new Set();
  const out = [];
  for (const route of routes) {
    const key = `${route.symbol}|${route.session}|${route.direction}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(route);
  }
  return out;
}

function routesFromChampion(path) {
  if (!existsSync(path)) return [];
  const champion = readJson(path).champion;
  if (!champion?.routes?.length) return [];
  return champion.routes.map((route) => ({
    ...route,
    test: route.test || {
      trades: route.backtestTrades || 0,
      winRate: route.backtestWinRate || 0,
      netDollars: route.netDollars || 0,
      avgDollars: route.avgDollars || 0,
    },
    train: route.train || {},
    combo: route.combo || {},
  }));
}

function routesFromRouter(path) {
  if (!existsSync(path)) return [];
  const router = readJson(path);
  const routes = router.active?.routes || [];
  return routes.map((route) => ({
    ...route,
    test: route.test || {
      trades: route.backtestTrades || route.trades || 0,
      winRate: route.backtestWinRate || route.winRate || 0,
      netDollars: route.netDollars || 0,
      avgDollars: route.avgDollars || 0,
    },
    train: route.train || {},
    combo: route.combo || {},
  }));
}

function routeKey(route) {
  return `${route.symbol}|${route.session || 'all'}|${route.direction || 'both'}|${route.triggerMode}`;
}

function trustForRoute(route, trust) {
  return trust.routes?.[routeKey(route)]
    || Object.entries(trust.routes || {}).find(([key]) => key.startsWith(`${route.symbol}|`) && key.endsWith(`|${route.triggerMode}`))?.[1]
    || { trades: 0, winRate: 0, netDollars: 0, profitFactor: 0 };
}

function ema(values, length) {
  const alpha = 2 / (length + 1);
  const out = Array(values.length).fill(null);
  let current = null;
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    current = current == null ? value : alpha * value + (1 - alpha) * current;
    out[index] = current;
  }
  return out;
}

function sma(values, length, index = values.length - 1) {
  if (index < length - 1) return null;
  let sum = 0;
  for (let offset = 0; offset < length; offset += 1) sum += values[index - offset] || 0;
  return sum / length;
}

function atr(bars, length = 14) {
  const tr = bars.map((bar, index) => {
    if (index === 0) return bar.high - bar.low;
    return Math.max(bar.high - bar.low, Math.abs(bar.high - bars[index - 1].close), Math.abs(bar.low - bars[index - 1].close));
  });
  return ema(tr, length);
}

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
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(timestamp * 1000));
}

function sessionWindow(session) {
  if (session === 'open-0930') return '9:30–10:00 ET';
  if (session === 'open-1000') return '10:00–10:30 ET';
  if (session === 'open-1030') return '10:30–11:00 ET';
  if (session === 'open') return '9:30–11:00 ET';
  if (session === 'morning') return '9:30–12:00 ET';
  if (session === 'afternoon') return '12:00–16:00 ET';
  if (session === 'powerhour') return '15:00–16:00 ET';
  return 'Any regular session';
}

async function fetchBars(symbol) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=${interval}&includePrePost=${includePremarket ? 'true' : 'false'}&events=div%2Csplits`;
  const response = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!response.ok) throw new Error(`${symbol} HTTP ${response.status}`);
  const data = await response.json();
  const result = data.chart?.result?.[0];
  const timestamps = result?.timestamp || [];
  const quote = result?.indicators?.quote?.[0] || {};
  const bars = timestamps.map((time, index) => ({
    time,
    open: quote.open?.[index],
    high: quote.high?.[index],
    low: quote.low?.[index],
    close: quote.close?.[index],
    volume: quote.volume?.[index] || 0,
  })).filter((bar) => [bar.open, bar.high, bar.low, bar.close].every(Number.isFinite));
  if (bars.length < 50) throw new Error(`${symbol} only returned ${bars.length} bars`);
  return bars;
}

function dailyContext(bars) {
  const days = new Map();
  for (const bar of bars) {
    const day = dateET(bar.time);
    const item = days.get(day) || { date: day, open: bar.open, high: -Infinity, low: Infinity, close: bar.close, volume: 0, regularVolume: 0 };
    item.high = Math.max(item.high, bar.high);
    item.low = Math.min(item.low, bar.low);
    item.close = bar.close;
    item.volume += bar.volume || 0;
    const minutes = marketMinutesET(bar.time);
    if (minutes >= 570 && minutes < 960) item.regularVolume += bar.volume || 0;
    days.set(day, item);
  }
  const ordered = [...days.values()].sort((a, b) => a.date.localeCompare(b.date));
  return { today: ordered.at(-1), previous: ordered.at(-2), history: ordered };
}

function vwapForToday(bars) {
  const lastDay = dateET(bars.at(-1).time);
  let pv = 0;
  let vv = 0;
  for (const bar of bars) {
    if (dateET(bar.time) !== lastDay) continue;
    const typical = (bar.high + bar.low + bar.close) / 3;
    pv += typical * bar.volume;
    vv += bar.volume;
  }
  return vv > 0 ? pv / vv : bars.at(-1).close;
}

function directionText(direction, route) {
  if (direction === 'long') return 'LONG';
  if (direction === 'short') return 'SHORT';
  return route.test.winRate >= 80 ? 'BOTH / wait for trigger' : 'BOTH';
}

function scoreCandidate(route, snapshot, market) {
  const dir = route.direction === 'short' ? -1 : route.direction === 'long' ? 1 : 0;
  const gapAligned = dir === 0 ? Math.abs(snapshot.gapPct) >= 0.15 : dir === 1 ? snapshot.gapPct >= -0.5 : snapshot.gapPct <= 0.5;
  const trendAligned = dir === 0 ? true : dir === 1 ? snapshot.close >= snapshot.ema21 : snapshot.close <= snapshot.ema21;
  const vwapAligned = dir === 0 ? true : dir === 1 ? snapshot.close >= snapshot.vwap : snapshot.close <= snapshot.vwap;
  const marketAligned = dir === 0 ? true : dir === 1 ? market.qTrend >= 0 && market.sTrend >= 0 : market.qTrend <= 0 && market.sTrend <= 0;
  const trust = route.forwardTrust || { trades: 0, winRate: 0, netDollars: 0 };
  const forwardBonus = trust.trades >= 3
    ? (trust.winRate >= route.test.winRate - 5 ? 18 : -22) + Math.max(-16, Math.min(18, trust.netDollars / 250))
    : -4;
  const regimeBonus = route.robustness?.marketRegimes?.[market.regime]?.netDollars > 0 ? 8 : 0;
  const routeQuality = route.test.winRate * 0.55
    + Math.min(route.test.avgDollars / 10, 45)
    + Math.min(route.test.trades, 20) * 0.8
    + Math.min(route.qualityScore || 0, 240) * 0.12
    + (route.recent?.winRate >= route.test.winRate ? 6 : -4)
    + forwardBonus
    + regimeBonus;
  const liveQuality = (gapAligned ? 8 : -6)
    + (trendAligned ? 8 : -7)
    + (vwapAligned ? 6 : -5)
    + (marketAligned ? 5 : -4)
    + Math.min(snapshot.relVolume, 3) * 4
    + Math.min(Math.abs(snapshot.gapPct), 4) * 1.5;
  return routeQuality + liveQuality;
}

async function marketSnapshot(symbol) {
  const bars = await fetchBars(symbol);
  const closes = bars.map((bar) => bar.close);
  const volumes = bars.map((bar) => bar.volume);
  const regularBars = bars.filter((bar) => {
    const minutes = marketMinutesET(bar.time);
    return minutes >= 570 && minutes < 960 && bar.volume > 0;
  });
  const regularVolumes = regularBars.map((bar) => bar.volume);
  const ema21 = ema(closes, 21);
  const ema50 = ema(closes, 50);
  const atr14 = atr(bars, 14);
  const { today, previous, history } = dailyContext(bars);
  const last = bars.at(-1);
  const vwap = vwapForToday(bars);
  const avgVol20 = sma(regularVolumes, Math.min(20, regularVolumes.length), regularVolumes.length - 1) || sma(volumes, 20) || 1;
  const recentRegularVolumes = regularVolumes.slice(-6);
  const recentLiveVolumes = volumes.slice(-6).filter((value) => value > 0);
  const recentSource = recentLiveVolumes.length >= 3 ? recentLiveVolumes : recentRegularVolumes;
  const recentVol = recentSource.length ? recentSource.reduce((sum, value) => sum + value, 0) / recentSource.length : avgVol20;
  const gapPct = previous?.close ? (today.open - previous.close) / previous.close * 100 : 0;
  const dayRangePct = last.close ? (today.high - today.low) / last.close * 100 : 0;
  const dollarVolume = last.close * avgVol20;
  return {
    symbol,
    close: last.close,
    lastTime: new Date(last.time * 1000).toISOString(),
    ema21: ema21.at(-1),
    ema50: ema50.at(-1),
    atr: atr14.at(-1),
    vwap,
    gapPct,
    dayRangePct,
    relVolume: avgVol20 ? recentVol / avgVol20 : 1,
    dollarVolume,
    today,
    previous,
    days: history.length,
  };
}

function riskPlan(route, snapshot) {
  const targetR = route.combo.targetR || 0.35;
  const atrRisk = Math.max(snapshot.atr || snapshot.close * 0.005, snapshot.close * 0.0025);
  const dir = route.direction === 'short' ? -1 : 1;
  const stop = route.direction === 'short' ? snapshot.close + atrRisk : snapshot.close - atrRisk;
  const target = route.direction === 'short' ? snapshot.close - atrRisk * targetR : snapshot.close + atrRisk * targetR;
  const notionalScale = route.combo.positionSizing === 'confidence' ? Math.min(1.25, Math.max(0.5, route.test.winRate / 80)) : 1;
  return {
    targetR,
    estimatedRiskPerShare: atrRisk,
    suggestedNotional: Math.round(capital * notionalScale),
    stop,
    target,
    bias: dir === -1 ? 'short-biased' : 'long-biased',
  };
}

const routeBook = existsSync(routesPath) ? readJson(routesPath) : { validated: [] };
const portfolio = existsSync(portfolioPath) ? readJson(portfolioPath) : null;
const portfolioSymbols = new Set((portfolio?.acceptedTrades || []).map((trade) => trade.symbol));
const routerRoutes = !explicitRoutes ? routesFromRouter(routerPath) : [];
const championRoutes = routesFromChampion(championPath);
const baseRoutes = !explicitRoutes && routerRoutes.length ? routerRoutes : !explicitRoutes && championRoutes.length ? championRoutes : (routeBook.validated?.length ? routeBook.validated : championRoutes);
const routes = uniqueRoutes(baseRoutes)
  .filter((route) => route.test.trades >= minRouteTrades && route.test.winRate >= minRouteWin && route.test.netDollars > 0)
  .filter((route) => !portfolioAware || portfolioSymbols.size === 0 || portfolioSymbols.has(route.symbol));
const symbols = [...new Set(routes.map((route) => route.symbol).concat(['SPY', 'QQQ']))];

const snapshots = new Map();
for (const symbol of symbols) {
  try {
    snapshots.set(symbol, await marketSnapshot(symbol));
  } catch (error) {
    console.error(`${symbol}: ${error.message}`);
  }
}

const qqq = snapshots.get('QQQ');
const spy = snapshots.get('SPY');
const marketRegime = qqq && spy
  ? (qqq.relVolume >= 1.5 && Math.sign(qqq.close - qqq.ema21) === Math.sign(spy.close - spy.ema21) && Math.sign(qqq.close - qqq.ema21) !== 0)
    ? 'high_vol_trend'
    : Math.abs(qqq.close - qqq.ema21) / Math.max(qqq.atr || 1, 1) < 0.35
      ? 'chop'
      : qqq.gapPct > 0.6
        ? 'gap_up'
        : qqq.gapPct < -0.6
          ? 'gap_down'
          : 'mixed'
  : 'unknown';
const market = {
  qTrend: qqq ? Math.sign(qqq.close - qqq.ema21) : 0,
  sTrend: spy ? Math.sign(spy.close - spy.ema21) : 0,
  regime: marketRegime,
  qqq: qqq ? { close: qqq.close, gapPct: qqq.gapPct, relVolume: qqq.relVolume } : null,
  spy: spy ? { close: spy.close, gapPct: spy.gapPct, relVolume: spy.relVolume } : null,
};

const trust = existsSync(trustPath) ? readJson(trustPath) : { routes: {} };
const candidates = [];
for (const route of routes) {
  route.forwardTrust = trustForRoute(route, trust);
  const snapshot = snapshots.get(route.symbol);
  if (!snapshot) continue;
  if (snapshot.dollarVolume < 500000) continue;
  const score = scoreCandidate(route, snapshot, market);
  candidates.push({
    symbol: route.symbol,
    direction: directionText(route.direction, route),
    session: route.session,
    window: sessionWindow(route.session),
    score,
    routeStats: route.test,
    trainStats: route.train,
    combo: route.combo,
    live: {
      close: snapshot.close,
      gapPct: snapshot.gapPct,
      relVolume: snapshot.relVolume,
      dayRangePct: snapshot.dayRangePct,
      vwapDistancePct: (snapshot.close - snapshot.vwap) / snapshot.close * 100,
      aboveEma21: snapshot.close >= snapshot.ema21,
      aboveEma50: snapshot.close >= snapshot.ema50,
      dollarVolume: snapshot.dollarVolume,
      lastTime: snapshot.lastTime,
    },
    context: {
      marketRegime,
      router: route.routerType || route.sourceModule || null,
      forwardTrust: route.forwardTrust,
      forwardProven: route.forwardTrust.trades >= 3 && route.forwardTrust.netDollars > 0,
    },
    riskPlan: riskPlan(route, snapshot),
    notes: [
      `Validated route: ${route.test.trades} holdout trades at ${route.test.winRate.toFixed(1)}%`,
      `Mode: target ${route.combo.targetR}R, time stop ${route.combo.timeStopBars} bars, sizing ${route.combo.positionSizing}`,
      route.direction === 'both' ? 'Wait for indicator trigger; route supports both sides.' : `Prefer ${route.direction.toUpperCase()} triggers for this route.`,
    ],
  });
}

candidates.sort((a, b) => b.score - a.score);
const picked = [];
const seen = new Set();
for (const candidate of candidates) {
  if (seen.has(candidate.symbol)) continue;
  seen.add(candidate.symbol);
  picked.push(candidate);
  if (picked.length >= top) break;
}

const now = new Date();
const stamp = now.toISOString().replace(/[:.]/g, '-');
const filePrefix = safeLabel ? `morning-${safeLabel}-watchlist` : 'morning-scalp-watchlist';
const out = join(reportsDir, `${filePrefix}-${stamp}.json`);
const latest = join(reportsDir, safeLabel ? `latest-${safeLabel}-morning-watchlist.json` : 'latest-morning-scalp-watchlist.json');
const payload = {
  generatedAt: now.toISOString(),
  label: safeLabel || null,
  routesPath,
  assumptions: 'Scanner ranks validated scalp routes using recent Yahoo 5m data, premarket when available, SPY/QQQ context, route win/profit history, gap, trend, VWAP, and relative volume. It is a watchlist, not automatic trading advice.',
  market,
  portfolioAware,
  portfolioPath: portfolioAware && existsSync(portfolioPath) ? portfolioPath : null,
  universe: { routes: routes.length, symbols: symbols.length, candidates: candidates.length },
  watchlist: picked,
};
writeFileSync(out, `${JSON.stringify(payload, null, 2)}\n`);
writeFileSync(latest, `${JSON.stringify(payload, null, 2)}\n`);
if (safeLabel) writeFileSync(join(reportsDir, 'latest-morning-scalp-watchlist.json'), `${JSON.stringify(payload, null, 2)}\n`);

console.log(`Morning watchlist saved: ${out}`);
console.log(`Latest watchlist saved: ${latest}`);
for (const item of picked.slice(0, Math.min(10, picked.length))) {
  console.log(`${item.symbol} ${item.direction} ${item.window} score=${item.score.toFixed(1)} route=${item.routeStats.trades} trades/${item.routeStats.winRate.toFixed(1)}% net=$${item.routeStats.netDollars.toFixed(0)} gap=${item.live.gapPct.toFixed(2)}% rVol=${item.live.relVolume.toFixed(2)}`);
}
