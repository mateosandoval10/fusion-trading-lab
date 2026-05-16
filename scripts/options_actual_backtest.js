#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

const paths = {
  phase26Ledgers: join(root, 'apps', 'dashboard', 'public', 'data', 'phase26-generalization-trade-ledgers.json'),
  phase25Ledgers: join(root, 'apps', 'dashboard', 'public', 'data', 'phase25-fresh-symbol-trade-ledgers.json'),
  phase24Ledgers: join(root, 'apps', 'dashboard', 'public', 'data', 'phase24-trade-ledgers.json'),
  phase23Ledgers: join(root, 'apps', 'dashboard', 'public', 'data', 'phase23-intelligence-trade-ledgers.json'),
  phase22Ledgers: join(root, 'apps', 'dashboard', 'public', 'data', 'phase22-trade-ledgers.json'),
  reports: join(root, 'reports', 'options'),
  dashboardData: join(root, 'apps', 'dashboard', 'public', 'data'),
  generated: join(root, 'generated', 'options'),
  cache: join(root, 'optimization-results', 'data-cache', 'options-actual'),
};

for (const path of [paths.reports, paths.dashboardData, paths.generated, paths.cache]) mkdirSync(path, { recursive: true });

function loadLocalEnv() {
  for (const file of ['.env.local', '.env']) {
    const envPath = join(root, file);
    if (!existsSync(envPath)) continue;
    const lines = readFileSync(envPath, 'utf8').split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
      if (!match) continue;
      const [, key, rawValue] = match;
      if (process.env[key]) continue;
      process.env[key] = rawValue.replace(/^['"]|['"]$/g, '');
    }
  }
}

loadLocalEnv();

const args = new Map(process.argv.slice(2).map((arg) => {
  const [key, value = 'true'] = arg.replace(/^--/, '').split('=');
  return [key, value];
}));

const polygonCallsPerMinute = Number(args.get('polygon-calls-per-minute') || process.env.POLYGON_CALLS_PER_MINUTE || 5);
const polygonMinIntervalMs = polygonCallsPerMinute > 0 ? Math.ceil(60_000 / polygonCallsPerMinute) : 0;
let lastPolygonCallAt = 0;

function readJson(path, fallback = null) {
  if (!existsSync(path)) return fallback;
  return JSON.parse(readFileSync(path, 'utf8'));
}

function writeJson(path, payload) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(payload, null, 2)}\n`);
}

function n(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function dateOnly(value) {
  if (!value) return null;
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const parsed = n(value, NaN);
  const date = Number.isFinite(parsed)
    ? new Date((parsed > 100000000000 ? parsed : parsed * 1000))
    : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
}

function epochMs(value) {
  const parsed = n(value, NaN);
  if (Number.isFinite(parsed)) return parsed > 100000000000 ? parsed : parsed * 1000;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.getTime();
}

function iso(value) {
  const ms = epochMs(value);
  return ms ? new Date(ms).toISOString() : null;
}

function addDays(yyyyMmDd, days) {
  const date = new Date(`${yyyyMmDd}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function optionTypeForTrade(trade) {
  return trade.side === 'short' ? 'put' : 'call';
}

function loadLedger(selector) {
  const [phase = 'phase26', category = 'bestOverall'] = String(selector || '').split(':');
  const sourceMap = {
    phase26: paths.phase26Ledgers,
    phase25: paths.phase25Ledgers,
    phase24: paths.phase24Ledgers,
    phase23: paths.phase23Ledgers,
    phase22: paths.phase22Ledgers,
  };
  const payload = readJson(sourceMap[phase], { ledgers: {}, categoryMap: {} });
  const id = payload.categoryMap?.[category];
  const ledger = id ? payload.ledgers?.[id] : null;
  return {
    phase,
    category,
    id,
    ledger,
    availableCategories: Object.keys(payload.categoryMap || {}),
  };
}

function normalizeTrade(trade, index) {
  const entryMs = epochMs(trade.entryIso || trade.entryTime);
  const exitMs = epochMs(trade.exitIso || trade.exitTime);
  return {
    sourceIndex: trade.index ?? index + 1,
    symbol: trade.symbol,
    side: trade.side,
    optionType: optionTypeForTrade(trade),
    date: trade.date || dateOnly(entryMs),
    entryMs,
    exitMs,
    entryIso: iso(entryMs),
    exitIso: iso(exitMs),
    entryUnderlying: n(trade.entry, 0),
    exitUnderlying: n(trade.exit, 0),
    setup: trade.setup || trade.trigger || 'unknown',
    regime: trade.regime || 'unknown',
    confidence: trade.confidence,
    mfeR: trade.mfeR,
    maeR: trade.maeR,
    pnlDollars: trade.pnlDollars,
    selectedRouteKey: trade.selectedRouteKey,
  };
}

function candidateStrikeTargets(trade, config) {
  const entry = Math.max(0.01, trade.entryUnderlying);
  const offsets = config.strikeOffsetsPct;
  return offsets.map((offset) => {
    const raw = trade.optionType === 'call' ? entry * (1 + offset) : entry * (1 - offset);
    return { offset, raw };
  });
}

function pickNearestContract(contracts, trade, config) {
  const targets = candidateStrikeTargets(trade, config);
  const entryDate = dateOnly(trade.entryMs);
  const minDte = Number(config.minDte);
  const maxDte = Number(config.maxDte);
  const candidates = contracts
    .filter((contract) => contract.contract_type === trade.optionType)
    .filter((contract) => contract.expiration_date >= addDays(entryDate, minDte))
    .filter((contract) => contract.expiration_date <= addDays(entryDate, maxDte))
    .map((contract) => {
      const strike = n(contract.strike_price, 0);
      const expirationMs = epochMs(`${contract.expiration_date}T00:00:00.000Z`);
      const dte = Math.round((expirationMs - epochMs(`${entryDate}T00:00:00.000Z`)) / 86400000);
      const nearest = targets
        .map((target) => ({
          offset: target.offset,
          distance: Math.abs(strike - target.raw),
          raw: target.raw,
        }))
        .sort((a, b) => a.distance - b.distance)[0];
      return {
        ...contract,
        strike,
        dte,
        targetOffsetPct: nearest?.offset ?? 0,
        score: Math.abs(dte - config.preferredDte) * entryBidPenalty(config.dteWeight) + (nearest?.distance || 0),
      };
    })
    .sort((a, b) => a.score - b.score || a.dte - b.dte);
  return candidates[0] || null;
}

function entryBidPenalty(value) {
  return Number.isFinite(Number(value)) ? Number(value) : 3;
}

async function readCache(path) {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf8'));
}

async function writeCache(path, payload) {
  writeJson(path, payload);
}

async function polygonGet(url) {
  const apiKey = process.env.POLYGON_API_KEY;
  if (!apiKey) {
    return {
      ok: false,
      missingKey: true,
      status: 'missing_api_key',
      message: 'POLYGON_API_KEY is required for exact intraday historical option quotes.',
    };
  }
  if (polygonMinIntervalMs > 0) {
    const waitMs = Math.max(0, lastPolygonCallAt + polygonMinIntervalMs - Date.now());
    if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
    lastPolygonCallAt = Date.now();
  }
  url.searchParams.set('apiKey', apiKey);
  const response = await fetch(url);
  const payload = await response.json();
  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      message: payload.error || payload.message || `HTTP ${response.status}`,
      payload,
    };
  }
  return { ok: true, payload };
}

async function polygonContracts(trade, config) {
  const entryDate = dateOnly(trade.entryMs);
  const cachePath = join(paths.cache, `polygon-contracts-${trade.symbol}-${entryDate}-${trade.optionType}.json`);
  const cached = await readCache(cachePath);
  if (cached) return cached;
  const url = new URL('https://api.polygon.io/v3/reference/options/contracts');
  url.searchParams.set('underlying_ticker', trade.symbol);
  url.searchParams.set('contract_type', trade.optionType);
  url.searchParams.set('as_of', entryDate);
  url.searchParams.set('expiration_date.gte', addDays(entryDate, config.minDte));
  url.searchParams.set('expiration_date.lte', addDays(entryDate, config.maxDte));
  url.searchParams.set('limit', '1000');
  const result = await polygonGet(url);
  if (!result.ok) return result;
  const contracts = result.payload.results || [];
  const output = { ok: true, provider: 'polygon', contracts };
  await writeCache(cachePath, output);
  return output;
}

async function polygonQuoteAt(optionTicker, timestampMs, side, config) {
  const windowMs = Math.max(60_000, Number(config.quoteSearchWindowMinutes || 10) * 60_000);
  const startNs = BigInt(Math.round(timestampMs)) * 1_000_000n;
  const endNs = BigInt(Math.round(timestampMs + windowMs)) * 1_000_000n;
  const cachePath = join(paths.cache, `polygon-quote-${optionTicker}-${timestampMs}-${side}.json`);
  const cached = await readCache(cachePath);
  if (cached) return cached;
  const url = new URL(`https://api.polygon.io/v3/quotes/${encodeURIComponent(optionTicker)}`);
  url.searchParams.set('timestamp.gte', startNs.toString());
  url.searchParams.set('timestamp.lte', endNs.toString());
  url.searchParams.set('order', 'asc');
  url.searchParams.set('sort', 'timestamp');
  url.searchParams.set('limit', '1');
  const result = await polygonGet(url);
  if (!result.ok) return result;
  const quote = result.payload.results?.[0] || null;
  const output = quote ? { ok: true, provider: 'polygon', quote } : {
    ok: false,
    provider: 'polygon',
    status: 'no_quote_in_window',
    message: `No ${optionTicker} quote found within ${config.quoteSearchWindowMinutes} minutes of ${new Date(timestampMs).toISOString()}.`,
  };
  await writeCache(cachePath, output);
  return output;
}

function quotePrice(quote, action) {
  const bid = n(quote.bid_price ?? quote.bid, NaN);
  const ask = n(quote.ask_price ?? quote.ask, NaN);
  const mid = Number.isFinite(bid) && Number.isFinite(ask) && bid > 0 && ask > 0 ? (bid + ask) / 2 : NaN;
  if (action === 'buy_to_open') return Number.isFinite(ask) && ask > 0 ? ask : mid;
  return Number.isFinite(bid) && bid > 0 ? bid : mid;
}

function quoteIso(quote) {
  const timestamp = n(quote.sip_timestamp ?? quote.participant_timestamp ?? quote.timestamp, 0);
  if (!timestamp) return null;
  return new Date(timestamp > 100000000000000 ? timestamp / 1_000_000 : timestamp).toISOString();
}

async function backtestPolygonTrade(trade, config) {
  const contractsResult = await polygonContracts(trade, config);
  if (!contractsResult.ok) {
    return { status: contractsResult.status, reason: contractsResult.message, provider: 'polygon', trade };
  }
  const contract = pickNearestContract(contractsResult.contracts, trade, config);
  if (!contract) {
    return { status: 'no_contract', reason: 'No listed contract matched DTE/type policy.', provider: 'polygon', trade };
  }
  const optionTicker = contract.ticker || contract.options_ticker;
  const entryQuoteResult = await polygonQuoteAt(optionTicker, trade.entryMs, 'entry', config);
  const exitQuoteResult = await polygonQuoteAt(optionTicker, trade.exitMs, 'exit', config);
  if (!entryQuoteResult.ok) return { status: entryQuoteResult.status, reason: entryQuoteResult.message, provider: 'polygon', contract, trade };
  if (!exitQuoteResult.ok) return { status: exitQuoteResult.status, reason: exitQuoteResult.message, provider: 'polygon', contract, trade };
  const entryPrice = quotePrice(entryQuoteResult.quote, 'buy_to_open');
  const exitPrice = quotePrice(exitQuoteResult.quote, 'sell_to_close');
  if (!Number.isFinite(entryPrice) || !Number.isFinite(exitPrice) || entryPrice <= 0 || exitPrice < 0) {
    return { status: 'bad_quote', reason: 'Entry/exit quote did not contain usable bid/ask prices.', provider: 'polygon', contract, trade };
  }
  const contracts = Math.floor(Number(config.capital) / (entryPrice * 100));
  if (contracts <= 0) {
    return { status: 'insufficient_capital', reason: 'Contract premium exceeded configured capital.', provider: 'polygon', contract, trade };
  }
  const commission = contracts * Number(config.commissionPerContract || 0.65) * 2;
  const pnlDollars = (exitPrice - entryPrice) * contracts * 100 - commission;
  return {
    status: 'filled',
    provider: 'polygon',
    trade,
    contract: {
      optionTicker,
      underlying: trade.symbol,
      optionType: trade.optionType,
      strike: contract.strike,
      expiration: contract.expiration_date,
      dte: contract.dte,
      targetOffsetPct: contract.targetOffsetPct,
    },
    fillModel: {
      entryAction: 'buy_to_open_at_ask',
      exitAction: 'sell_to_close_at_bid',
      contracts,
      capital: Number(config.capital),
      commission,
    },
    entryQuote: {
      time: quoteIso(entryQuoteResult.quote),
      bid: n(entryQuoteResult.quote.bid_price ?? entryQuoteResult.quote.bid, null),
      ask: n(entryQuoteResult.quote.ask_price ?? entryQuoteResult.quote.ask, null),
      fill: entryPrice,
    },
    exitQuote: {
      time: quoteIso(exitQuoteResult.quote),
      bid: n(exitQuoteResult.quote.bid_price ?? exitQuoteResult.quote.bid, null),
      ask: n(exitQuoteResult.quote.ask_price ?? exitQuoteResult.quote.ask, null),
      fill: exitPrice,
    },
    pnlDollars,
    roiPct: pnlDollars / Math.max(1, contracts * entryPrice * 100) * 100,
    dataConfidence: 'exact_intraday_historical_quote',
  };
}

function summarize(results) {
  const filled = results.filter((row) => row.status === 'filled');
  const wins = filled.filter((row) => row.pnlDollars > 0).length;
  const grossWin = filled.filter((row) => row.pnlDollars > 0).reduce((sum, row) => sum + row.pnlDollars, 0);
  const grossLoss = Math.abs(filled.filter((row) => row.pnlDollars <= 0).reduce((sum, row) => sum + row.pnlDollars, 0));
  return {
    signalsTested: results.length,
    exactFilledTrades: filled.length,
    skippedTrades: results.length - filled.length,
    wins,
    losses: filled.length - wins,
    winRate: filled.length ? wins / filled.length * 100 : 0,
    netDollars: filled.reduce((sum, row) => sum + row.pnlDollars, 0),
    avgDollars: filled.length ? filled.reduce((sum, row) => sum + row.pnlDollars, 0) / filled.length : 0,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? 999 : 0,
  };
}

function skipReasons(results) {
  const counts = new Map();
  for (const row of results.filter((item) => item.status !== 'filled')) {
    const key = row.status || 'unknown';
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return [...counts.entries()].map(([status, count]) => ({ status, count })).sort((a, b) => b.count - a.count);
}

const selector = args.get('ledger') || 'phase26:bestOverall';
const provider = args.get('provider') || 'polygon';
const limit = Number(args.get('limit') || 25);
const includeLosses = args.get('include-losses') === 'true';
const config = {
  capital: Number(args.get('capital') || 10000),
  minDte: Number(args.get('min-dte') || 0),
  maxDte: Number(args.get('max-dte') || 14),
  preferredDte: Number(args.get('preferred-dte') || 3),
  dteWeight: Number(args.get('dte-weight') || 3),
  strikeOffsetsPct: String(args.get('strike-offsets') || '0,0.01,0.02')
    .split(',')
    .map((item) => Number(item.trim()))
    .filter((item) => Number.isFinite(item)),
  quoteSearchWindowMinutes: Number(args.get('quote-window-minutes') || 10),
  commissionPerContract: Number(args.get('commission') || 0.65),
};

const loaded = loadLedger(selector);
if (!loaded.ledger) {
  console.error(`Ledger not found for ${selector}. Available: ${loaded.availableCategories.join(', ')}`);
  process.exit(1);
}

const sourceTrades = [...(loaded.ledger.trades || [])]
  .filter((trade) => includeLosses || n(trade.pnlDollars, 0) > 0)
  .map(normalizeTrade)
  .filter((trade) => trade.symbol && trade.entryMs && trade.exitMs && trade.entryUnderlying > 0)
  .slice(0, limit);

let results = [];
if (provider === 'polygon') {
  for (const trade of sourceTrades) {
    results.push(await backtestPolygonTrade(trade, config));
  }
} else {
  results = sourceTrades.map((trade) => ({
    status: 'unsupported_provider',
    provider,
    reason: 'Only polygon exact intraday historical quote adapter is implemented in this script.',
    trade,
  }));
}

const output = {
  updatedAt: new Date().toISOString(),
  phase: 'Actual Historical Options Backtest',
  safety: {
    paperOnly: true,
    noBrokerOrders: true,
    noEstimates: true,
  },
  sourceLedger: {
    selector,
    phase: loaded.phase,
    category: loaded.category,
    id: loaded.id,
    sourceTrades: sourceTrades.length,
  },
  provider,
  providerRequirements: {
    polygon: {
      env: 'POLYGON_API_KEY',
      requiredFor: 'exact intraday historical option contracts and bid/ask quotes',
      configured: Boolean(process.env.POLYGON_API_KEY),
    },
  },
  config,
  summary: summarize(results),
  skipReasons: skipReasons(results),
  rows: results,
};

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const timestamped = join(paths.reports, `actual-options-backtest-${stamp}.json`);
writeJson(timestamped, output);
writeJson(join(paths.reports, 'latest-actual-options-backtest.json'), output);
writeJson(join(paths.dashboardData, 'actual-options-backtest.json'), output);
writeJson(join(paths.generated, 'actual_options_backtest_export.json'), output);

console.log('Actual options backtest complete');
console.log(`Provider=${provider} ledger=${selector} signals=${output.summary.signalsTested} exactFilled=${output.summary.exactFilledTrades} skipped=${output.summary.skippedTrades}`);
console.log(`Win=${output.summary.winRate.toFixed(2)}% net=$${output.summary.netDollars.toFixed(2)} avg=$${output.summary.avgDollars.toFixed(2)} PF=${output.summary.profitFactor.toFixed(2)}`);
console.log(`Report=${timestamped}`);
if (output.skipReasons.length) console.log(`Skip reasons=${output.skipReasons.map((row) => `${row.status}:${row.count}`).join(', ')}`);
