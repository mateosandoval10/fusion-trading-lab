#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, appendFileSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const tv = process.env.TV_CLI || '/Applications/Codex.app/Contents/Resources/node';
const cli = join(root, 'src/cli/index.js');

const strategyName = 'Sniper v03 Fusion v3.2 Strategy [KhanSaab]';
const outDir = join(root, 'optimization-results');
const runsDir = join(outDir, 'runs');
const summariesDir = join(outDir, 'summaries');
const datasetsDir = join(outDir, 'datasets');
const modelsDir = join(outDir, 'models');
const reportsDir = join(outDir, 'reports');
for (const dir of [outDir, runsDir, summariesDir, datasetsDir, modelsDir, reportsDir]) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

const runId = new Date().toISOString().replace(/[:.]/g, '-');
const jsonlPath = join(runsDir, `fusionv3-${runId}.jsonl`);
const summaryPath = join(summariesDir, `fusionv3-${runId}-summary.json`);
const datasetPath = join(datasetsDir, 'fusionv3-master-results.jsonl');
const bestModelPath = join(modelsDir, 'current-best-model.json');
const modelHistoryPath = join(modelsDir, 'promotion-history.jsonl');
const regimeModelPath = join(modelsDir, 'regime-profiles.json');
const reportPath = join(reportsDir, `fusionv3-${runId}.md`);
const tempStrategyPath = join(outDir, 'current-fusionv3-strategy.pine');
const strategyTemplatePath = join(root, 'fusionv3_strategy.pine');

const args = new Map(process.argv.slice(2).map((arg) => {
  const [key, value = 'true'] = arg.replace(/^--/, '').split('=');
  return [key, value];
}));

const maxRuns = Number(args.get('max-runs') || 72);
const settleMs = Number(args.get('settle-ms') || 3000);
const symbolSettleMs = Number(args.get('symbol-settle-ms') || 8000);
const applyMode = args.get('apply-mode') || 'compile';
const selectionMode = args.get('selection') || 'even';
const promote = args.get('promote') !== 'false';
const minChampionTrades = Number(args.get('min-champion-trades') || 30);
const timeframe = args.get('timeframe') || null;
const strictSymbolCheck = args.get('strict-symbol-check') !== 'false';
const symbols = (args.get('symbols') || 'PEPPERSTONE:CRUDEF,AAPL,NFLX,TSLA,NVDA,MSFT')
  .split(',')
  .map((symbol) => symbol.trim())
  .filter(Boolean);
const minChampionSymbols = Number(args.get('min-champion-symbols') || Math.min(3, symbols.length || 3));

const listArg = (name, fallback, mapper = (value) => value) => (args.get(name) || fallback.join('|'))
  .split('|')
  .map((value) => value.trim())
  .filter(Boolean)
  .map(mapper);

const grid = {
  preset: listArg('preset', ['Balanced', 'Strict', 'Aggressive']),
  minConf: listArg('min-conf', [50, 55, 60, 65, 70], Number),
  density: listArg('density', ['Medium moves', 'Big moves only']),
  entryMode: listArg('entry-mode', ['Cross + pullback reclaim', 'EMA cross only', 'Score regime shifts', 'Options Sniper']),
  target: listArg('target', ['TP1', 'TP2', 'TP3', 'TP4', 'TP5']),
};

const inputIds = {
  preset: 'in_9',
  minConf: 'in_21',
  density: 'in_22',
  entryMode: 'in_23',
  target: 'in_40',
};

function tvJson(commandArgs, options = {}) {
  const stdout = execFileSync(tv, [cli, ...commandArgs], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: options.timeout || 30000,
    maxBuffer: options.maxBuffer || 8 * 1024 * 1024,
  });
  return JSON.parse(stdout);
}

function tvText(commandArgs, options = {}) {
  return execFileSync(tv, [cli, ...commandArgs], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: options.timeout || 60000,
    maxBuffer: options.maxBuffer || 8 * 1024 * 1024,
  });
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function findStrategyEntity() {
  const state = tvJson(['state']);
  const study = (state.studies || []).find((item) => item.name === strategyName || item.name.includes('Fusion v3.2 Strategy'));
  if (!study) throw new Error(`Strategy study not found on chart. Studies: ${JSON.stringify(state.studies || [])}`);
  return study.id;
}

function findStrategyEntities() {
  const state = tvJson(['state']);
  return (state.studies || []).filter((item) => item.name === strategyName || item.name.includes('Fusion v3.2 Strategy'));
}

function removeStrategyEntities() {
  for (const study of findStrategyEntities()) {
    try {
      tvJson(['indicator', 'remove', study.id], { timeout: 30000 });
      sleep(700);
    } catch (error) {
      console.error(`Could not remove stale strategy ${study.id}: ${error.message}`);
    }
  }
}

function waitForStrategyEntity(timeoutMs = 45000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      return findStrategyEntity();
    } catch (error) {
      lastError = error;
      sleep(1500);
    }
  }
  throw lastError || new Error('Strategy study not found before timeout');
}

function setRegularCandles() {
  try {
    tvJson(['type', 'Candles']);
    sleep(700);
  } catch (error) {
    console.error(`Could not set regular candles: ${error.message}`);
  }
}

function setTimeframeIfRequested() {
  if (!timeframe) return;
  try {
    tvJson(['timeframe', timeframe], { timeout: 45000 });
    sleep(5000);
  } catch (error) {
    console.error(`Could not set timeframe ${timeframe}: ${error.message}`);
  }
}

function setSymbol(symbol) {
  tvJson(['symbol', symbol], { timeout: 45000 });
  const requested = symbol.replace(/^.*:/, '').toUpperCase();
  let matched = false;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    sleep(1000);
    const state = tvJson(['state']);
    const actual = String(state.symbol || '').replace(/^.*:/, '').toUpperCase();
    if (actual === requested) {
      matched = true;
      break;
    }
  }
  sleep(symbolSettleMs);
  if (strictSymbolCheck) {
    const state = tvJson(['state']);
    const actual = String(state.symbol || '').replace(/^.*:/, '').toUpperCase();
    if (!matched && actual !== requested) {
      throw new Error(`Symbol did not switch cleanly. Requested ${symbol}, chart reports ${state.symbol}`);
    }
  }
}

function clickUpdateOnChart() {
  try {
    const result = tvJson(['ui', 'eval', `
      (() => {
        const button = Array.from(document.querySelectorAll('button')).find((btn) => btn.getAttribute('title') === 'Update on chart');
        if (!button) return 'no update button';
        button.click();
        return 'clicked update';
      })()
    `]);
    if (result?.result === 'clicked update') sleep(5000);
  } catch {
    // Some chart states do not expose the button; metric polling below is still the source of truth.
  }
}

function clickSaveAndAddConfirmation() {
  try {
    const result = tvJson(['ui', 'eval', `
      (() => {
        const buttons = Array.from(document.querySelectorAll('button'));
        const button = buttons.find((btn) => /Save and add to chart/i.test(btn.textContent || ''));
        if (!button) return 'no save-add confirmation';
        button.click();
        return 'clicked save-add confirmation';
      })()
    `]);
    if (result?.result === 'clicked save-add confirmation') sleep(7000);
  } catch {
    // Confirmation is intermittent; absence is fine.
  }
}

function ema(values, length) {
  if (values.length === 0) return null;
  const alpha = 2 / (length + 1);
  let current = values[0];
  for (let index = 1; index < values.length; index += 1) {
    current = alpha * values[index] + (1 - alpha) * current;
  }
  return current;
}

function sma(values, length) {
  const slice = values.slice(-length);
  if (slice.length === 0) return null;
  return slice.reduce((sum, value) => sum + value, 0) / slice.length;
}

function trueRanges(bars) {
  const ranges = [];
  for (let index = 1; index < bars.length; index += 1) {
    const previousClose = bars[index - 1].close;
    const bar = bars[index];
    ranges.push(Math.max(
      bar.high - bar.low,
      Math.abs(bar.high - previousClose),
      Math.abs(bar.low - previousClose),
    ));
  }
  return ranges;
}

function efficiencyRatio(closes, length) {
  if (closes.length <= length) return 0;
  const end = closes.length - 1;
  const direction = Math.abs(closes[end] - closes[end - length]);
  let volatility = 0;
  for (let index = end - length + 1; index <= end; index += 1) {
    volatility += Math.abs(closes[index] - closes[index - 1]);
  }
  return volatility > 0 ? direction / volatility : 0;
}

function classifyRegimeFromBars(bars) {
  if (!bars || bars.length < 80) {
    return {
      tag: 'unknown',
      trend: 'unknown',
      direction: 'unknown',
      volatility: 'unknown',
      atrRatio: null,
      efficiencyRatio: null,
      emaSpreadAtr: null,
      bars: bars?.length || 0,
    };
  }
  const closes = bars.map((bar) => bar.close);
  const ranges = trueRanges(bars);
  const atr14 = sma(ranges, 14) || 0;
  const atrSma50 = sma(ranges, 50) || atr14 || 1;
  const atrRatio = atrSma50 > 0 ? atr14 / atrSma50 : 1;
  const er20 = efficiencyRatio(closes, 20);
  const ema20 = ema(closes, 20);
  const ema50 = ema(closes, 50);
  const emaSpreadAtr = atr14 > 0 ? Math.abs(ema20 - ema50) / atr14 : 0;
  const direction = ema20 >= ema50 ? 'bull' : 'bear';
  const volatility = atrRatio >= 1.2 ? 'highVol' : atrRatio <= 0.85 ? 'lowVol' : 'normalVol';
  const trend = er20 >= 0.28 && emaSpreadAtr >= 0.65 ? 'trend' : er20 <= 0.14 || emaSpreadAtr <= 0.25 ? 'chop' : 'mixed';
  return {
    tag: `${volatility}-${trend}-${direction}`,
    trend,
    direction,
    volatility,
    atrRatio,
    efficiencyRatio: er20,
    emaSpreadAtr,
    bars: bars.length,
    sampleFrom: bars[0]?.time ?? null,
    sampleTo: bars[bars.length - 1]?.time ?? null,
  };
}

function getRegimeSnapshot(symbol) {
  try {
    const data = tvJson(['ohlcv', '-n', '400'], { timeout: 30000 });
    return {
      symbol,
      timeframe: tvJson(['timeframe']).resolution,
      ...classifyRegimeFromBars(data.bars || []),
    };
  } catch (error) {
    return {
      symbol,
      tag: 'unknown',
      trend: 'unknown',
      direction: 'unknown',
      volatility: 'unknown',
      error: error.message,
    };
  }
}

function setInputs(entityId, combo) {
  const inputs = {
    [inputIds.preset]: combo.preset,
    [inputIds.minConf]: combo.minConf,
    [inputIds.density]: combo.density,
    [inputIds.entryMode]: combo.entryMode,
    [inputIds.target]: combo.target,
  };
  tvJson(['indicator', 'set', entityId, '-i', JSON.stringify(inputs)]);
  clickUpdateOnChart();
  try {
    tvJson(['ui', 'eval', `
      (() => {
        const activeWidget = window._exposed_chartWidgetCollection?.activeChartWidget;
        const widget = activeWidget?.value?.() || activeWidget?._value || activeWidget;
        const model = widget?.model?.();
        const source = model?.dataSourceForId?.('${entityId}');
        source?.clearData?.();
        source?.restoreData?.();
        return source?.title?.() || 'ok';
      })()
    `]);
  } catch {
    // Best effort only; the follow-up settle gives TradingView time to refresh the strategy report.
  }
  sleep(settleMs);
}

function comboVisibleInTitle(title, combo) {
  return title
    && title.includes(combo.preset)
    && title.includes(String(combo.minConf))
    && title.includes(combo.density)
    && title.includes(combo.entryMode)
    && title.includes(combo.target);
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function replaceOnce(source, pattern, replacement, label) {
  if (!pattern.test(source)) throw new Error(`Could not replace ${label} in strategy template`);
  return source.replace(pattern, replacement);
}

function renderStrategy(combo) {
  let source = readFileSync(strategyTemplatePath, 'utf8');
  source = replaceOnce(
    source,
    /presetMode\s*=\s*input\.string\("([^"]+)"/,
    `presetMode  = input.string("${combo.preset}"`,
    'presetMode',
  );
  source = replaceOnce(
    source,
    /tog_minConf\s*=\s*input\.int\(\d+/,
    `tog_minConf    = input.int(${combo.minConf}`,
    'tog_minConf',
  );
  source = replaceOnce(
    source,
    /signalDensity\s*=\s*input\.string\("([^"]+)"/,
    `signalDensity = input.string("${combo.density}"`,
    'signalDensity',
  );
  source = replaceOnce(
    source,
    /entryMode\s*=\s*input\.string\("([^"]+)"/,
    `entryMode = input.string("${combo.entryMode}"`,
    'entryMode',
  );
  source = replaceOnce(
    source,
    /btTarget\s*=\s*input\.string\("([^"]+)"/,
    `btTarget      = input.string("${combo.target}"`,
    'btTarget',
  );
  source = replaceOnce(
    source,
    /strategy\("Sniper v03 Fusion v3\.[0-9]+ Strategy \[KhanSaab\]"/,
    `strategy("Sniper v03 Fusion v3.2 Strategy [KhanSaab]"`,
    'strategy title',
  );
  return source;
}

function compileCombo(combo) {
  const source = renderStrategy(combo);
  writeFileSync(tempStrategyPath, source);
  tvText(['pine', 'set', '--file', tempStrategyPath], { timeout: 60000 });
  const output = tvText(['pine', 'compile'], { timeout: 90000 });
  let compileResult = null;
  try {
    compileResult = JSON.parse(output);
  } catch {
    compileResult = null;
  }
  if (compileResult?.success === false || compileResult?.has_errors === true) {
    throw new Error(`Pine compile failed for ${JSON.stringify(combo)}:\n${output}`);
  }
  sleep(settleMs);
}

function readdCombo(combo) {
  removeStrategyEntities();
  const source = renderStrategy(combo);
  writeFileSync(tempStrategyPath, source);
  tvText(['pine', 'set', '--file', tempStrategyPath], { timeout: 60000 });
  const output = tvText(['pine', 'raw-compile'], { timeout: 90000 });
  let result = null;
  try {
    result = JSON.parse(output);
  } catch {
    result = null;
  }
  if (result?.success === false) {
    throw new Error(`Pine raw compile failed for ${JSON.stringify(combo)}:\n${output}`);
  }
  sleep(Math.max(settleMs, 7000));
  try {
    return waitForStrategyEntity(30000);
  } catch {
    clickSaveAndAddConfirmation();
    return waitForStrategyEntity(45000);
  }
}

function getMetrics() {
  const script = String.raw`
    (() => {
      const activeWidget = window._exposed_chartWidgetCollection?.activeChartWidget;
      const widget = activeWidget?.value?.() || activeWidget?._value || activeWidget;
      const model = widget?.model?.();
      const sources = model?.dataSources?.() || [];
      const strategy = sources.find((source) => {
        const title = source.title?.() || source.name?.() || '';
        return source.id?.() !== '_seriesId' && title.includes('Sniper v03 Fusion v3.2 Strategy');
      });
      const report = typeof strategy?.reportData === 'function' ? strategy.reportData() : strategy?.reportData;
      const perf = report?.performance;
      const all = perf?.all;
      if (all) {
        return {
          totalPLText: String(all.netProfit ?? ''),
          maxDDText: String(perf.maxStrategyDrawDown ?? ''),
          totalTrades: all.totalTrades ?? null,
          profitableText: String((all.percentProfitable ?? 0) * 100),
          winRate: all.percentProfitable == null ? null : all.percentProfitable * 100,
          profitFactor: all.profitFactor ?? null,
          netPLText: String(all.netProfit ?? ''),
          netPL: all.netProfit ?? null,
          maxDD: perf.maxStrategyDrawDown ?? null,
          sharpe: perf.sharpeRatio ?? null,
          sortino: perf.sortinoRatio ?? null,
          longTrades: perf.long?.totalTrades ?? null,
          shortTrades: perf.short?.totalTrades ?? null,
          longWinRate: perf.long?.percentProfitable == null ? null : perf.long.percentProfitable * 100,
          shortWinRate: perf.short?.percentProfitable == null ? null : perf.short.percentProfitable * 100,
          buyHoldReturn: perf.buyHoldReturn ?? null,
          strategyTitle: strategy.title?.() || null,
        };
      }
      const text = document.body.innerText;
      const pick = (re) => {
        const match = text.match(re);
        return match ? match[1].trim() : null;
      };
      const toNumber = (value) => {
        if (value == null) return null;
        const normalized = String(value).replace(/\u2212/g, '-');
        const cleaned = normalized.replace(/[^\d.+-]/g, '');
        const parsed = Number(cleaned);
        return Number.isFinite(parsed) ? parsed : null;
      };
      return {
        totalPLText: pick(/Total P&L\s*([^\n]+)/),
        maxDDText: pick(/Max equity drawdown\s*([^\n]+)/),
        totalTrades: toNumber(pick(/Total trades\s*(\d+)/)),
        profitableText: pick(/Profitable trades\s*([^\n]+)/),
        winRate: toNumber(pick(/Profitable trades\s*([0-9.]+)%/)),
        profitFactor: toNumber(pick(/Profit factor\s*([0-9.]+)/)),
        netPLText: pick(/Net P&L\s*([^\n]+)/),
        netPL: toNumber(pick(/Net P&L\s*([+\-\u2212]?[0-9,.]+)/)) ?? toNumber(pick(/Total P&L\s*([+\-\u2212]?[0-9,.]+)/)),
        maxDD: toNumber(pick(/Max equity drawdown\s*([0-9,.]+)/)),
        sharpe: toNumber(pick(/Sharpe ratio\s*([0-9.-]+)/)),
        sortino: toNumber(pick(/Sortino ratio\s*([0-9.-]+)/)),
        strategyTitle: strategy?.title?.() || null,
      };
    })()
  `;
  return tvJson(['ui', 'eval', script]).result;
}

function getFreshMetrics(combo) {
  let latest = null;
  for (let attempt = 0; attempt < 15; attempt += 1) {
    try {
      latest = getMetrics();
    } catch (error) {
      latest = {
        totalTrades: null,
        winRate: null,
        profitFactor: null,
        netPL: null,
        maxDD: null,
        error: error.message,
      };
    }
    if (latest?.totalTrades != null && comboVisibleInTitle(latest.strategyTitle, combo)) return latest;
    if (attempt === 3 || attempt === 8) clickUpdateOnChart();
    sleep(1000);
  }
  return latest;
}

function getFreshMetricsAfterReadd(combo) {
  let latest = null;
  for (let attempt = 0; attempt < 24; attempt += 1) {
    try {
      latest = getMetrics();
    } catch (error) {
      latest = {
        totalTrades: null,
        winRate: null,
        profitFactor: null,
        netPL: null,
        maxDD: null,
        error: error.message,
      };
    }
    if (latest?.totalTrades != null && comboVisibleInTitle(latest.strategyTitle, combo)) return latest;
    if (attempt === 4 || attempt === 10 || attempt === 16) {
      tvJson(['ui', 'panel', 'strategy-tester', 'open']);
      clickUpdateOnChart();
    }
    sleep(1500);
  }
  return latest;
}

function score(result) {
  if (!result.metrics || !result.metrics.totalTrades) return -1e9;
  const trades = result.metrics.totalTrades;
  const winRate = result.metrics.winRate ?? 0;
  const profitFactor = result.metrics.profitFactor ?? 0;
  const netPL = result.metrics.netPL ?? 0;
  const maxDD = result.metrics.maxDD ?? 0;
  const samplePenalty = trades < 8 ? (8 - trades) * 20 : 0;
  return winRate * 0.8 + profitFactor * 18 + netPL * 0.35 - maxDD * 1.2 - samplePenalty;
}

function hasValidMetrics(result) {
  return Number.isFinite(Number(result?.metrics?.totalTrades));
}

function readJson(path) {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

function* combos() {
  for (const preset of grid.preset) {
    for (const minConf of grid.minConf) {
      for (const density of grid.density) {
        for (const entryMode of grid.entryMode) {
          for (const target of grid.target) {
            yield { preset, minConf, density, entryMode, target };
          }
        }
      }
    }
  }
}

const allCombos = [...combos()];
const combosPerSymbol = Math.max(1, Math.floor(maxRuns / symbols.length));
const selectedCombos = selectionMode === 'all'
  ? allCombos.slice(0, combosPerSymbol)
  : Array.from({ length: combosPerSymbol }, (_, index) => {
    const comboIndex = Math.floor(index * allCombos.length / combosPerSymbol);
    return allCombos[Math.min(comboIndex, allCombos.length - 1)];
  });
const results = [];

console.log(`Writing results to ${jsonlPath}`);
console.log(`Testing ${symbols.length} symbols x ${selectedCombos.length} settings = ${symbols.length * selectedCombos.length} runs`);
console.log(`Apply mode: ${applyMode}`);

setRegularCandles();
setTimeframeIfRequested();

for (const symbol of symbols) {
  console.log(`\nSymbol ${symbol}`);
  setSymbol(symbol);
  const regime = getRegimeSnapshot(symbol);
  console.log(`Regime ${symbol}: ${regime.tag} ER=${regime.efficiencyRatio?.toFixed?.(2) ?? 'n/a'} ATRx=${regime.atrRatio?.toFixed?.(2) ?? 'n/a'} spread=${regime.emaSpreadAtr?.toFixed?.(2) ?? 'n/a'}`);
  let entityId = null;
  for (const combo of selectedCombos) {
    if (applyMode === 'readd') {
      entityId = readdCombo(combo);
    } else if (applyMode === 'compile') {
      compileCombo(combo);
      entityId = findStrategyEntity();
    } else {
      entityId = findStrategyEntity();
      setInputs(entityId, combo);
    }
    const metrics = applyMode === 'readd' ? getFreshMetricsAfterReadd(combo) : getFreshMetrics(combo);
    const result = {
      runId,
      timestamp: new Date().toISOString(),
      symbol,
      regime,
      combo,
      metrics,
    };
    result.score = score(result);
    results.push(result);
    appendFileSync(jsonlPath, `${JSON.stringify(result)}\n`);
    if (metrics?.totalTrades != null) appendFileSync(datasetPath, `${JSON.stringify(result)}\n`);
    console.log(`${symbol} ${combo.preset} ${combo.minConf}% ${combo.density} ${combo.entryMode} ${combo.target} -> trades=${metrics.totalTrades} win=${metrics.winRate}% pf=${metrics.profitFactor} net=${metrics.netPL} score=${result.score.toFixed(2)}`);
  }
}

const byCombo = new Map();
const byRegimeCombo = new Map();
for (const result of results) {
  if (!hasValidMetrics(result)) continue;
  const key = JSON.stringify(result.combo);
  const item = byCombo.get(key) || { combo: result.combo, count: 0, score: 0, winRate: 0, profitFactor: 0, netPL: 0, maxDD: 0, trades: 0 };
  item.count += 1;
  item.score += result.score;
  item.winRate += result.metrics.winRate || 0;
  item.profitFactor += result.metrics.profitFactor || 0;
  item.netPL += result.metrics.netPL || 0;
  item.maxDD += result.metrics.maxDD || 0;
  item.trades += result.metrics.totalTrades || 0;
  byCombo.set(key, item);

  const regimeKey = JSON.stringify({ tag: result.regime?.tag || 'unknown', combo: result.combo });
  const regimeItem = byRegimeCombo.get(regimeKey) || {
    tag: result.regime?.tag || 'unknown',
    combo: result.combo,
    count: 0,
    score: 0,
    winRate: 0,
    profitFactor: 0,
    netPL: 0,
    maxDD: 0,
    trades: 0,
    symbols: [],
  };
  regimeItem.count += 1;
  regimeItem.score += result.score;
  regimeItem.winRate += result.metrics.winRate || 0;
  regimeItem.profitFactor += result.metrics.profitFactor || 0;
  regimeItem.netPL += result.metrics.netPL || 0;
  regimeItem.maxDD += result.metrics.maxDD || 0;
  regimeItem.trades += result.metrics.totalTrades || 0;
  regimeItem.symbols.push(result.symbol);
  byRegimeCombo.set(regimeKey, regimeItem);
}

const summary = [...byCombo.values()].map((item) => ({
  combo: item.combo,
  symbols: item.count,
  avgScore: item.score / item.count,
  avgWinRate: item.winRate / item.count,
  avgProfitFactor: item.profitFactor / item.count,
  totalNetPL: item.netPL,
  avgMaxDD: item.maxDD / item.count,
  totalTrades: item.trades,
})).sort((a, b) => b.avgScore - a.avgScore);

const regimeSummary = [...byRegimeCombo.values()].map((item) => ({
  tag: item.tag,
  combo: item.combo,
  symbols: item.count,
  symbolList: item.symbols,
  avgScore: item.score / item.count,
  avgWinRate: item.winRate / item.count,
  avgProfitFactor: item.profitFactor / item.count,
  totalNetPL: item.netPL,
  avgMaxDD: item.maxDD / item.count,
  totalTrades: item.trades,
})).sort((a, b) => b.avgScore - a.avgScore);

const regimeProfiles = {};
for (const row of regimeSummary) {
  if (row.symbols < 2 && row.totalTrades < 12) continue;
  if (row.avgProfitFactor < 1 || row.totalNetPL <= 0) continue;
  if (!regimeProfiles[row.tag] || row.avgScore > regimeProfiles[row.tag].avgScore) {
    regimeProfiles[row.tag] = row;
  }
}

const championCandidate = summary.find((row) => (
  row.symbols >= minChampionSymbols
  && row.totalTrades >= minChampionTrades
  && row.avgProfitFactor >= 1
  && row.totalNetPL > 0
)) || summary[0] || null;

const previousChampion = readJson(bestModelPath);
const previousScore = previousChampion?.avgScore ?? -Infinity;
const promoted = Boolean(promote && championCandidate && championCandidate.avgScore > previousScore);
const championRecord = championCandidate ? {
  promotedAt: new Date().toISOString(),
  runId,
  sourceSummary: summaryPath,
  sourceRuns: jsonlPath,
  symbols,
  criteria: {
    minChampionSymbols,
    minChampionTrades,
    requiresPositiveNetPL: true,
    requiresProfitFactorAtLeast: 1,
  },
  ...championCandidate,
} : null;

if (promoted) {
  writeFileSync(bestModelPath, `${JSON.stringify(championRecord, null, 2)}\n`);
  appendFileSync(modelHistoryPath, `${JSON.stringify({ event: 'promoted', previous: previousChampion, champion: championRecord })}\n`);
} else if (championCandidate) {
  appendFileSync(modelHistoryPath, `${JSON.stringify({ event: 'not_promoted', runId, candidate: championCandidate, previousScore })}\n`);
}

const output = {
  runId,
  symbols,
  maxRuns,
  selectionMode,
  applyMode,
  paths: {
    results: jsonlPath,
    summary: summaryPath,
    dataset: datasetPath,
    bestModel: bestModelPath,
    regimeProfiles: regimeModelPath,
    report: reportPath,
  },
  promotion: {
    promoted,
    candidate: championCandidate,
    previousChampion,
  },
  summary,
  regimeSummary,
};

writeFileSync(summaryPath, `${JSON.stringify(output, null, 2)}\n`);
if (Object.keys(regimeProfiles).length > 0) {
  writeFileSync(regimeModelPath, `${JSON.stringify({
    updatedAt: new Date().toISOString(),
    runId,
    sourceSummary: summaryPath,
    profiles: regimeProfiles,
  }, null, 2)}\n`);
}

const reportLines = [
  `# Fusion v3.2 Optimization Run ${runId}`,
  '',
  `- Symbols: ${symbols.join(', ')}`,
  `- Runs: ${results.length}`,
  `- Apply mode: ${applyMode}`,
  `- Selection: ${selectionMode}`,
  `- Promoted champion: ${promoted ? 'yes' : 'no'}`,
  championCandidate ? `- Candidate: ${JSON.stringify(championCandidate.combo)} | win ${championCandidate.avgWinRate.toFixed(2)}% | PF ${championCandidate.avgProfitFactor.toFixed(2)} | net ${championCandidate.totalNetPL.toFixed(2)} | trades ${championCandidate.totalTrades}` : '- Candidate: none',
  '',
  '## Regime Profiles',
  ...Object.entries(regimeProfiles).map(([tag, row]) => `- ${tag}: ${JSON.stringify(row.combo)} — win ${row.avgWinRate.toFixed(2)}%, PF ${row.avgProfitFactor.toFixed(2)}, net ${row.totalNetPL.toFixed(2)}, trades ${row.totalTrades}`),
  Object.keys(regimeProfiles).length === 0 ? '- No regime profile met promotion quality filters.' : '',
  '',
  '## Top 10',
  ...summary.slice(0, 10).map((row, index) => `${index + 1}. ${JSON.stringify(row.combo)} — win ${row.avgWinRate.toFixed(2)}%, PF ${row.avgProfitFactor.toFixed(2)}, net ${row.totalNetPL.toFixed(2)}, trades ${row.totalTrades}, score ${row.avgScore.toFixed(2)}`),
  '',
];
writeFileSync(reportPath, `${reportLines.join('\n')}\n`);

console.log(`\nTop 10 settings:`);
for (const row of summary.slice(0, 10)) {
  console.log(`${JSON.stringify(row.combo)} avgWin=${row.avgWinRate.toFixed(2)} avgPF=${row.avgProfitFactor.toFixed(2)} net=${row.totalNetPL.toFixed(2)} trades=${row.totalTrades} avgScore=${row.avgScore.toFixed(2)}`);
}
console.log(`\nSummary written to ${summaryPath}`);
console.log(`Dataset appended to ${datasetPath}`);
console.log(`Report written to ${reportPath}`);
console.log(`Regime profiles written to ${regimeModelPath}`);
console.log(promoted ? `Promoted new best model at ${bestModelPath}` : `Best model unchanged at ${bestModelPath}`);
