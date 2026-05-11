# Fusion Trading Lab

Research lab for the Fusion/Sniper TradingView system.

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
  PL --> CD["Canonical Data Spine"]
  CD --> SF["Phase21 Specialist Factory"]
  PL --> SP["Specialist Candidates"]
  SF --> SP
  SP --> TO["Tournaments"]
  TO --> P22["Phase22 Deep Specialist Tournament"]
  P22 --> CH
  TO --> CH["Champion Registry"]
  CH --> PE["Pine Export"]
  CH --> DB["Dashboard"]
```

## Main Commands

```bash
npm run lab:report
npm run lab:phase21
npm run scalp:phase22
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

GitHub stores code, models, reports, Pine exports, canonical summaries, specialist factory output, and compressed ledgers. Raw `.jsonl` ledgers stay ignored or get uploaded as Actions artifacts. If this grows, move raw data to Supabase/Postgres/S3/R2 and keep GitHub as the control plane.

## Phase21 Canonical Data

`npm run lab:phase21` runs Pattern Lab with the new canonical spine:

- Dedupes repeated trade rows across backtest ledgers.
- Assigns `canonicalId` and `routeId` values to trades.
- Writes route, symbol, and factory summaries into `data/canonical/`.
- Writes deduped specialist candidates into `models/specialists/phase21-specialist-factory.json`.
- Updates the dashboard with raw-vs-canonical trade counts, biggest symbol hits, route quality, and consistency checks.

## Phase22 Deep Tournament

`npm run scalp:phase22` fuses Phase21 factory routes into portfolio challengers:

- Tests balanced, high-win, profit-max, low-drawdown, options-worthy, and high-trade-count profiles.
- Splits results into train/test/holdout/stress and odd/even-day validation.
- Resolves route conflicts so overlapping routes do not double-count the same underlying trade.
- Runs Monte Carlo drawdown checks on top variants.
- Writes the current Phase22 champion to `models/champions/current-phase22-deep-specialist-tournament.json`.

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

For GitHub, the public repo deploys the static dashboard through the `Deploy Dashboard` workflow. The `Build Dashboard Artifact` workflow remains as a backup artifact export.
