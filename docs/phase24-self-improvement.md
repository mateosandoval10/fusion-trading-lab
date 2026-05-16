# Phase24 Self-Improvement Loop

Phase24 is the first repeatable loop for improving the Fusion/Sniper system.

## What It Does

- Builds challenger pools from current champions, specialist fusions, ticker families, symbol batches, intraday trades, and overnight trades.
- Generates profile-specific challenger variants for profit, high win rate, options bursts, intraday scalps, and overnight bursts.
- Selects trades using entry-time features only.
- Evaluates exits and targets after selection using modeled R outcomes.
- Splits performance into train, test, holdout, and stress.
- Assigns every challenger a decision: promote, watchlist, or reject/quarantine.
- Exports exact trade ledgers so results can be inspected instead of only summarized.

## Commands

```bash
npm run lab:phase24
npm run options:probe
npm run lab:self-improve
```

## Important Constraints

- This is paper/backtest analytics only.
- It never places broker orders.
- Phase24 can mark a route `Backtest Promoted`, but TradingView auto-selection only uses it automatically after it is marked `Forward Proven`.
- Historical options results are marked `Estimated` unless a free/keyed provider returns exact contract-chain data.
- TradingView MCP currently verifies read-only quote/OHLCV chart access; it is not treated as an options-chain historical backtester.

## Outputs

- `models/self-improvement/current-phase24-self-improvement.json`
- `models/self-improvement/phase24-run-registry.json`
- `reports/self-improvement/phase24-self-improvement-report.json`
- `reports/self-improvement/phase24-exact-trade-ledgers.json`
- `apps/dashboard/public/data/phase24-self-improvement.json`
- `apps/dashboard/public/data/phase24-trade-ledgers.json`
- `reports/options-data-probe-report.json`
- `apps/dashboard/public/data/options-data-probe.json`
- `reports/tradingview-mcp-snapshot.json`
- `apps/dashboard/public/data/tradingview-mcp-snapshot.json`
