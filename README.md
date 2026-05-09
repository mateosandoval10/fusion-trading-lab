# Fusion Trading Lab

Private research lab for the Fusion/Sniper TradingView system.

This repo is designed to be the source of truth for:

- Pine exports used in TradingView.
- Current champion and specialist model metadata.
- Backtest and forward-paper reports.
- Pattern recognition output.
- Dashboard data for local viewing, GitHub Actions artifacts, or GitHub Pages if available.
- Nightly GitHub Actions backtest/pattern-lab runs.

## Current Flow

```mermaid
flowchart LR
  TV["TradingView Pine"] -->|alert() JSON webhook| WH["Webhook Receiver"]
  WH --> FL["Forward Ledger"]
  BT["Backtest Engine"] --> TL["Trade Ledgers"]
  TL --> PL["Pattern Lab"]
  FL --> PL
  PL --> SP["Specialist Candidates"]
  SP --> TO["Tournaments"]
  TO --> CH["Champion Registry"]
  CH --> PE["Pine Export"]
  CH --> DB["Dashboard"]
```

## Main Commands

```bash
npm run lab:report
npm run lab:nightly
npm run scalp:phase19 -- --fresh-data=false
npm run scalp:closed-loop:start
npm run scalp:closed-loop:update
```

To learn from historical ledgers without copying them into this repo:

```bash
FUSION_EXTERNAL_LEDGER_DIRS="/path/to/old/local-runs,/path/to/old/trade-ledger" npm run lab:report
```

## Important Storage Rule

GitHub stores code, models, reports, Pine exports, and compressed ledgers. It should not become the permanent raw tick/bar database. If this grows, move raw data to Supabase/Postgres/S3/R2 and keep GitHub as the control plane.

## TradingView Connection

1. Add `generated/fusionv3_codex_clean_tradingview.pine` to TradingView.
2. Create an alert with condition `Any alert() function call`.
3. Use the webhook URL printed by `npm run scalp:closed-loop:start`.
4. Run `npm run scalp:closed-loop:update` to score mature forward signals.
5. Run `npm run lab:report` to update dashboard data.

This is paper/analytics only. It does not place trades.

## Dashboard

Local dashboard:

```bash
npm run lab:report
python3 -m http.server 8080 --directory apps/dashboard/public
```

Open `http://localhost:8080`.

For GitHub, the `Build Dashboard Artifact` workflow uploads the static dashboard. GitHub Pages is included as a manual workflow, but private Pages is not available on every GitHub plan.
