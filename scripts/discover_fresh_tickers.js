#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const configDir = join(root, 'config');
const outDir = join(root, 'optimization-results', 'ticker-discovery');
if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

const args = new Map(process.argv.slice(2).map((arg) => {
  const [key, value = 'true'] = arg.replace(/^--/, '').split('=');
  return [key, value];
}));

const symbolFile = args.get('symbol-file') || join(configDir, 'scalp-symbols-expanded.txt');
const maxAdd = Number(args.get('max-add') || 50);
const update = args.get('update') === 'true';

const screeners = [
  'day_gainers',
  'day_losers',
  'most_actives',
  'aggressive_small_caps',
  'undervalued_growth_stocks',
];

function normalize(symbol) {
  return String(symbol || '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9.-]/g, '');
}

async function fetchScreener(scrId) {
  const url = `https://query1.finance.yahoo.com/v1/finance/screener/predefined/saved?scrIds=${encodeURIComponent(scrId)}&count=100`;
  const response = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!response.ok) throw new Error(`${scrId} HTTP ${response.status}`);
  const data = await response.json();
  return data.finance?.result?.[0]?.quotes || [];
}

const current = existsSync(symbolFile)
  ? readFileSync(symbolFile, 'utf8').split(',').map(normalize).filter(Boolean)
  : [];
const currentSet = new Set(current);
const found = [];

for (const screener of screeners) {
  try {
    const quotes = await fetchScreener(screener);
    for (const quote of quotes) {
      const symbol = normalize(quote.symbol);
      if (!symbol || currentSet.has(symbol)) continue;
      const price = Number(quote.regularMarketPrice || 0);
      const volume = Number(quote.regularMarketVolume || quote.averageDailyVolume3Month || 0);
      const dollarVolume = price * volume;
      if (price < 1 || dollarVolume < 500000) continue;
      found.push({
        symbol,
        screener,
        price,
        volume,
        dollarVolume,
        changePercent: quote.regularMarketChangePercent,
        marketCap: quote.marketCap,
      });
      currentSet.add(symbol);
    }
  } catch (error) {
    console.error(`${screener}: ${error.message}`);
  }
}

found.sort((a, b) => (b.dollarVolume - a.dollarVolume) || Math.abs(b.changePercent || 0) - Math.abs(a.changePercent || 0));
const additions = found.slice(0, maxAdd);
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const report = join(outDir, `ticker-discovery-${stamp}.json`);
writeFileSync(report, `${JSON.stringify({ generatedAt: new Date().toISOString(), screeners, additions }, null, 2)}\n`);

if (update && additions.length > 0) {
  const merged = [...new Set([...current, ...additions.map((item) => item.symbol)])];
  writeFileSync(symbolFile, `${merged.join(',')}\n`);
}

console.log(`Ticker discovery saved: ${report}`);
console.log(`New candidates: ${additions.length}`);
console.log(additions.slice(0, 25).map((item) => item.symbol).join(','));
if (update) console.log(`Updated symbol file: ${symbolFile}`);
