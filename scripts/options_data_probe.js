#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

const paths = {
  config: join(root, 'config', 'self_improvement', 'phase24_challenger_space.json'),
  phase22Ledgers: join(root, 'apps', 'dashboard', 'public', 'data', 'phase22-trade-ledgers.json'),
  phase23Ledgers: join(root, 'apps', 'dashboard', 'public', 'data', 'phase23-intelligence-trade-ledgers.json'),
  phase24Ledgers: join(root, 'apps', 'dashboard', 'public', 'data', 'phase24-trade-ledgers.json'),
  reports: join(root, 'reports'),
  dashboardData: join(root, 'apps', 'dashboard', 'public', 'data'),
  generatedOptions: join(root, 'generated', 'options'),
};

for (const path of [paths.reports, paths.dashboardData, paths.generatedOptions]) mkdirSync(path, { recursive: true });

const args = new Map(process.argv.slice(2).map((arg) => {
  const [key, value = 'true'] = arg.replace(/^--/, '').split('=');
  return [key, value];
}));

function readJson(path, fallback = null) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(path, payload) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(payload, null, 2)}\n`);
}

function n(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, n(value, min)));
}

function clamp01(value) {
  return clamp(value, 0, 1);
}

function isoTime(value) {
  const parsed = n(value, 0);
  return parsed ? new Date((parsed > 100000000000 ? parsed : parsed * 1000)).toISOString() : 'n/a';
}

function minutesHeld(trade) {
  const entry = n(trade.entryTime, 0);
  const exit = n(trade.exitTime, 0);
  if (!entry || !exit) return null;
  const entryMs = entry > 100000000000 ? entry : entry * 1000;
  const exitMs = exit > 100000000000 ? exit : exit * 1000;
  return Math.max(0, Math.round((exitMs - entryMs) / 60000));
}

function parseLedgerSelector(selector) {
  const [phase = 'phase22', category = 'profitMax'] = String(selector || '').split(':');
  return { phase, category };
}

function loadLedger(selector) {
  const { phase, category } = parseLedgerSelector(selector);
  const payload = phase === 'phase24'
    ? readJson(paths.phase24Ledgers, { ledgers: {}, categoryMap: {} })
    : phase === 'phase23'
      ? readJson(paths.phase23Ledgers, { ledgers: {}, categoryMap: {} })
      : readJson(paths.phase22Ledgers, { ledgers: {}, categoryMap: {} });
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

function optionEstimateForTrade(trade, optionConfig) {
  const side = trade.side === 'short' ? 'put' : 'call';
  const entry = Math.max(0.01, n(trade.entry, 0));
  const exit = Math.max(0.01, n(trade.exit, entry));
  const dtes = optionConfig.dteCandidates || [0, 1, 3, 7, 14];
  const otms = optionConfig.otmPctCandidates || [0, 0.01, 0.02, 0.05, 0.08, 0.12];
  const heldDays = Math.max(0, (minutesHeld(trade) || 0) / 1440);
  const targetR = Math.max(0.1, n(trade.targetR, 0.5));
  const riskMove = Math.abs(exit - entry) / targetR;
  const oracleUnderlying = side === 'call'
    ? Math.max(exit, entry + riskMove * Math.max(n(trade.mfeR, 0), targetR))
    : Math.min(exit, entry - riskMove * Math.max(n(trade.mfeR, 0), targetR));
  const optionShape = trade.optionWorthy || (trade.tags || []).includes('options-worthy-burst') ? 1 : clamp01(n(trade.mfeR, 0) / 2);
  const volGuess = clamp(0.45 + 0.55 * optionShape, 0.35, 1.65);

  function premium(underlying, strike, dte) {
    const time = Math.sqrt(Math.max(1, dte + 1) / 365);
    const moneyness = Math.abs(strike / underlying - 1);
    const intrinsic = side === 'call' ? Math.max(0, underlying - strike) : Math.max(0, strike - underlying);
    const extrinsic = underlying * volGuess * time * 0.085 * Math.exp(-moneyness * 8);
    return Math.max(0.05, intrinsic + extrinsic);
  }

  let bestAtSystemExit = null;
  let bestOracle = null;
  for (const dte of dtes) {
    if (dte + 0.05 < heldDays) continue;
    for (const otm of otms) {
      const strike = side === 'call' ? entry * (1 + otm) : entry * (1 - otm);
      const entryPremium = premium(entry, strike, dte);
      const exitPremium = premium(exit, strike, Math.max(0, dte - heldDays));
      const oracleExitPremium = premium(oracleUnderlying, strike, Math.max(0, dte - heldDays));
      const contracts10k = Math.floor(10000 / (entryPremium * 100));
      const result = {
        dataConfidence: 'Estimated',
        contractType: side,
        dte,
        strike: Number(strike.toFixed(2)),
        entryPremium: Number(entryPremium.toFixed(2)),
        exitPremium: Number(exitPremium.toFixed(2)),
        oracleExitPremium: Number(oracleExitPremium.toFixed(2)),
        contractsOn10k: contracts10k,
        roiPct: entryPremium > 0 ? (exitPremium - entryPremium) / entryPremium * 100 : 0,
        profitOn10k: contracts10k * (exitPremium - entryPremium) * 100,
        oracleRoiPct: entryPremium > 0 ? (oracleExitPremium - entryPremium) / entryPremium * 100 : 0,
        oracleProfitOn10k: contracts10k * (oracleExitPremium - entryPremium) * 100,
        estimatedOracleUnderlying: Number(oracleUnderlying.toFixed(2)),
        warning: 'Estimated model only. Exact historical option bid/ask data was not available from free sources in this run.',
      };
      if (!bestAtSystemExit || result.profitOn10k > bestAtSystemExit.profitOn10k) bestAtSystemExit = result;
      if (!bestOracle || result.oracleProfitOn10k > bestOracle.oracleProfitOn10k) bestOracle = result;
    }
  }
  return { bestAtSystemExit, bestOracle };
}

async function fetchYahooCurrentChain(symbol) {
  const url = `https://query2.finance.yahoo.com/v7/finance/options/${encodeURIComponent(symbol)}`;
  const response = await fetch(url, {
    headers: {
      'user-agent': 'fusion-trading-lab-options-probe/1.0',
      accept: 'application/json',
    },
  });
  if (!response.ok) throw new Error(`Yahoo current chain HTTP ${response.status}`);
  const payload = await response.json();
  const result = payload.optionChain?.result?.[0];
  const calls = result?.options?.[0]?.calls || [];
  const puts = result?.options?.[0]?.puts || [];
  return {
    provider: 'yahoo_current_chain',
    symbol,
    status: 'available_current_only',
    expirations: result?.expirationDates?.length || 0,
    calls: calls.length,
    puts: puts.length,
    quoteTime: result?.quote?.regularMarketTime || null,
    note: 'Current/delayed chain only; not historical contract backtest data.',
  };
}

async function fetchAlphaVantageHistorical(symbol, date) {
  const apikey = process.env.ALPHAVANTAGE_API_KEY;
  if (!apikey) {
    return {
      provider: 'alpha_vantage_historical_options',
      symbol,
      date,
      status: 'skipped_missing_api_key',
      env: 'ALPHAVANTAGE_API_KEY',
    };
  }
  const url = new URL('https://www.alphavantage.co/query');
  url.searchParams.set('function', 'HISTORICAL_OPTIONS');
  url.searchParams.set('symbol', symbol);
  url.searchParams.set('date', date);
  url.searchParams.set('apikey', apikey);
  const response = await fetch(url);
  const payload = await response.json();
  const rows = Array.isArray(payload.data) ? payload.data : [];
  return {
    provider: 'alpha_vantage_historical_options',
    symbol,
    date,
    status: rows.length ? 'available' : 'unavailable_or_limited',
    rows: rows.length,
    message: payload.Information || payload.Note || payload['Error Message'] || null,
  };
}

async function runProviderProbe(symbols, date, fetchCurrent) {
  const providerResults = [];
  const unique = [...new Set(symbols)].slice(0, Number(args.get('provider-symbol-limit') || 5));
  for (const symbol of unique) {
    providerResults.push(await fetchAlphaVantageHistorical(symbol, date));
    if (fetchCurrent) {
      try {
        providerResults.push(await fetchYahooCurrentChain(symbol));
      } catch (error) {
        providerResults.push({
          provider: 'yahoo_current_chain',
          symbol,
          status: 'error',
          error: error.message,
        });
      }
    } else {
      providerResults.push({
        provider: 'yahoo_current_chain',
        symbol,
        status: 'not_requested',
        note: 'Use --fetch-current=true to test current/delayed free chain access.',
      });
    }
    providerResults.push({
      provider: 'tradingview_mcp_or_manual',
      symbol,
      status: 'manual_or_mcp_required',
      note: 'TradingView can validate live/current chains visually/MCP-side, but this Node script does not scrape TradingView.',
    });
  }
  return providerResults;
}

const config = readJson(paths.config, {});
const optionConfig = config.optionsProbe || {};
const selector = args.get('ledger') || optionConfig.defaultLedger || 'phase22:profitMax';
const limit = Number(args.get('limit') || optionConfig.defaultLimit || 40);
const fetchCurrent = args.get('fetch-current') === 'true';
const loaded = loadLedger(selector);
if (!loaded.ledger) {
  console.error(`Ledger not found for ${selector}. Available: ${loaded.availableCategories.join(', ')}`);
  process.exit(1);
}

const winners = [...(loaded.ledger.trades || [])]
  .filter((trade) => n(trade.pnlDollars, 0) > 0)
  .sort((a, b) => n(b.pnlDollars, 0) - n(a.pnlDollars, 0))
  .slice(0, limit);

const rows = winners.map((trade, index) => {
  const estimated = optionEstimateForTrade(trade, optionConfig);
  return {
    rank: index + 1,
    symbol: trade.symbol,
    side: trade.side,
    optionSide: trade.side === 'short' ? 'put' : 'call',
    date: trade.date,
    entryIso: trade.entryIso || isoTime(trade.entryTime),
    exitIso: trade.exitIso || isoTime(trade.exitTime),
    minutesHeld: trade.minutesHeld ?? minutesHeld(trade),
    entry: trade.entry,
    exit: trade.exit,
    equityPnlOn100k: trade.pnlDollars,
    equityPnlOn10k: n(trade.pnlDollars, 0) * 0.10,
    confidence: trade.confidence,
    mfeR: trade.mfeR,
    maeR: trade.maeR,
    tags: trade.tags || [],
    selectedRouteKey: trade.selectedRouteKey,
    estimatedBestAtSystemExit: estimated.bestAtSystemExit,
    estimatedBestOracle: estimated.bestOracle,
  };
});

const providerResults = await runProviderProbe(rows.map((row) => row.symbol), rows[0]?.date || new Date().toISOString().slice(0, 10), fetchCurrent);
const totals = rows.reduce((sum, row) => {
  sum.equityPnlOn10k += n(row.equityPnlOn10k, 0);
  sum.estimatedSystemExitOptionProfitOn10k += n(row.estimatedBestAtSystemExit?.profitOn10k, 0);
  sum.estimatedOracleOptionProfitOn10k += n(row.estimatedBestOracle?.oracleProfitOn10k, 0);
  return sum;
}, {
  trades: rows.length,
  equityPnlOn10k: 0,
  estimatedSystemExitOptionProfitOn10k: 0,
  estimatedOracleOptionProfitOn10k: 0,
});

const output = {
  updatedAt: new Date().toISOString(),
  phase: 'Options Data Probe',
  safety: {
    paperOnly: true,
    noBrokerOrders: true,
  },
  sourceLedger: {
    selector,
    phase: loaded.phase,
    category: loaded.category,
    id: loaded.id,
    profile: loaded.ledger.profile,
  },
  config: {
    limit,
    fetchCurrent,
    dteCandidates: optionConfig.dteCandidates,
    otmPctCandidates: optionConfig.otmPctCandidates,
  },
  providerResults,
  totals,
  rows,
  dataConfidence: {
    exactHistoricalContracts: providerResults.some((item) => item.provider === 'alpha_vantage_historical_options' && item.status === 'available') ? 'partially_available' : 'not_available_in_this_run',
    currentChains: providerResults.some((item) => item.provider === 'yahoo_current_chain' && item.status === 'available_current_only') ? 'available_current_only' : 'not_available_or_not_requested',
    estimatedBacktest: 'available',
  },
};

writeJson(join(paths.reports, 'options-data-probe-report.json'), output);
writeJson(join(paths.dashboardData, 'options-data-probe.json'), output);
writeJson(join(paths.generatedOptions, 'options_data_probe_export.json'), output);

console.log('Options data probe complete');
console.log(`Ledger=${selector} winners=${rows.length} exactHistorical=${output.dataConfidence.exactHistoricalContracts} currentChains=${output.dataConfidence.currentChains}`);
if (rows[0]) {
  console.log(`Top estimated oracle=${rows[0].symbol} ${rows[0].optionSide} strike=${rows[0].estimatedBestOracle.strike} dte=${rows[0].estimatedBestOracle.dte} profit10k=$${rows[0].estimatedBestOracle.oracleProfitOn10k.toFixed(0)}`);
}
