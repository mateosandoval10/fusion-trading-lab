# TradingView Closed Loop

The live loop connects TradingView signals to the lab without placing trades.

## Local Paper Loop

```bash
npm run scalp:closed-loop:start
```

The command starts:

- local alert receiver
- public tunnel URL
- ledger at `optimization-results/live-alerts/tradingview-alert-ledger.jsonl`

In TradingView:

- Condition: `Any alert() function call`
- Webhook URL: the printed `/tradingview-alert` URL
- Message: leave default, because Pine calls `alert()` with JSON

Score mature signals:

```bash
npm run scalp:closed-loop:update
```

The scorer writes:

- `optimization-results/forward-tests/phase18-forward-outcomes.jsonl`
- `optimization-results/forward-tests/phase18-forward-route-trust.json`
- `optimization-results/forward-tests/latest-phase18-forward-proven-summary.json`

## Cloud Receiver Later

For always-on forward testing, deploy the receiver to Render/Vercel/Supabase. TradingView needs a public HTTPS webhook and your laptop does not need to stay awake.
