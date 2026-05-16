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
  P22 --> P23["Phase23 Intelligence Specialist"]
  P23 --> P24["Phase24 Self-Improvement Loop"]
  P24 --> CH
  P24 --> OPT["Options Probe"]
  TO --> CH["Champion Registry"]
  CH --> PE["Pine Export"]
  CH --> DB["Dashboard"]
```

## Main Commands

```bash
npm run lab:report
npm run lab:phase21
npm run scalp:phase22
npm run scalp:phase23
npm run lab:self-improve
npm run options:probe
npm run pine:export
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
- Writes exact selected trade ledgers to `apps/dashboard/public/data/phase22-trade-ledgers.json` for the dashboard trade viewer.

## Phase23 Intelligence Specialist

`npm run scalp:phase23` applies the new logic layer to exact Phase22 winner trades:

- Adds liquidity sweep, VWAP reclaim quality, compression breakout, trend pullback, exhaustion reversal, failed-breakout trap, relative strength, volume quality, candle-location, and VWAP-distance engines.
- Mutates feature weights and guard thresholds across thousands of challenger overlays.
- Promotes category winners instead of blindly replacing the main champion: balanced/profit, high-win guarded, and elite precision.
- Writes the Phase23 model to `models/champions/current-phase23-intelligence-specialist.json`.
- Writes Phase23 trade ledgers to `apps/dashboard/public/data/phase23-intelligence-trade-ledgers.json`.
- Exports Pine metadata so TradingView can show `Phase23 Intelligence Specialist` as a selectable/auto-selected specialist mode.

Phase23 is an intelligence overlay, not a live-trading bot. It is paper/backtest analytics until forward evidence promotes it.

## Phase24 Self-Improvement Loop

`npm run lab:self-improve` runs the repeatable improvement pipeline:

- Generates challenger variants from Phase22/Phase23 winners, fused ledgers, family rotations, symbol batches, intraday pools, and overnight pools.
- Scores entries using entry-time features only, then evaluates exits/targets after selection.
- Tests profit-first, high-win, options-burst, intraday-scalp, and overnight-burst profiles.
- Applies train/test/holdout/stress checks, drawdown/loss-streak gates, and promotion/watchlist/rejection reasons.
- Writes the current self-improvement model to `models/self-improvement/current-phase24-self-improvement.json`.
- Writes exact selected ledgers to `apps/dashboard/public/data/phase24-trade-ledgers.json`.
- Updates Pine metadata and dashboard panels.

`npm run options:probe` compares winning equity trades against free/estimated options data. Exact historical option-chain data is only used when a free/keyed provider returns it; otherwise results are clearly marked `Estimated`.

## Phase25 Fresh Symbol Tournament

`npm run lab:phase25` tests the current champion backbone on symbols excluded from the Phase22/Phase23/Phase24 winner ledgers:

- Builds a strict fresh-symbol universe, excluding prior champion symbols and preserving paper-only/no-broker-order safety.
- Runs 30 challenger variants, each with one unique improvement such as options burst shape, volume accumulation, anti-chase guard, compression pop, liquidity sweep reclaim, trend pullback, low-price momentum, and sector/family rotation.
- Applies chronological train/test/holdout, stress-cost, drawdown, loss-streak, unique-symbol/day/week, and promotion/watchlist/rejection gates.
- Writes the model to `models/fresh-symbol/current-phase25-fresh-symbol-tournament.json`.
- Writes exact selected ledgers to `apps/dashboard/public/data/phase25-fresh-symbol-trade-ledgers.json`.
- Adds dashboard panels for the fresh-symbol tournament, challenger leaderboard, fresh-symbol leaderboard, and every selected trade.

## Phase26 Generalization Engine

`npm run lab:phase26` is the overfit-control tournament built after Phase25 showed that known-symbol logic did not transfer well enough:

- Adds fresh-symbol-first scoring, leave-one-symbol-out validation, leave-one-family-out validation, regime routing, setup archetypes, failure-pattern blocking, entry timing, MFE/MAE prediction, time-to-profit filtering, route durability, symbol personality, relative strength, liquidity quality, volume intent, VWAP gravity, candle anatomy, opening-range intelligence, adaptive targets, dynamic stops, after-cost scoring, loss-cluster cooldowns, recent edge decay, specialist voting, meta-classifier fusion, forward-gap penalty, pattern prototypes, counterfactual timing proxy, stress survival, ticker discovery, and champion fusion.
- Uses chronological train/test/holdout plus normal and deep cost stress.
- Promotes only variants that survive unseen-symbol/family diagnostics, holdout, stress, drawdown, loss-streak, and profit gates.
- Writes the model to `models/generalization/current-phase26-generalization-engine.json`.
- Writes exact selected ledgers to `apps/dashboard/public/data/phase26-generalization-trade-ledgers.json`.
- Adds dashboard panels for promoted layers, implementation coverage, discovered tickers, generalization diagnostics, and every selected trade.

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
