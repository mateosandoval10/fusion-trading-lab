# Platform Plan

## Phase A: Private GitHub Lab

- Keep source code, Pine, specialists, reports, and champion registry in GitHub.
- Run nightly GitHub Actions backtests and Pattern Lab.
- Publish a GitHub Pages dashboard from static JSON.
- Upload compressed ledgers as Actions artifacts.
- Keep raw `.jsonl` ledgers ignored by git; Pattern Lab can read external ledger directories locally or artifacts in CI.

## Phase B: Pattern Lab

- Read historical trade ledgers and forward-paper outcomes.
- Extract feature vectors from every signal/trade.
- Deduplicate repeated ledger rows into the Phase21 canonical trade spine.
- Build winner and loser prototypes.
- Cluster trades into repeatable pattern families.
- Generate specialist candidates from durable patterns.
- Promote only candidates passing train/test/holdout/stress.

## Phase B2: Canonical Data + Specialist Factory

- Store compact canonical summaries in `data/canonical/`.
- Keep full raw trade ledgers out of git; use GitHub Actions artifacts or external storage.
- Score routes by trades, unique days, unique weeks, win rate, profit factor, drawdown, loss streak, outlier dependence, and feature edges.
- Generate `phase21-specialist-factory` candidates for tournament promotion.
- Use the dashboard to show which routes are durable versus merely lucky backtest spikes.

## Phase C: Live Closed Loop

- TradingView Pine emits JSON signals.
- Webhook receiver stores forward paper signals.
- Forward scorer measures MFE/MAE/outcome after the signal.
- Route trust is updated daily.
- Dashboard displays forward-vs-backtest gap.

## Phase D: Serious Data Layer

When GitHub artifacts are not enough:

- Supabase/Postgres for normalized signals/trades/features.
- S3/R2 for raw bars and compressed ledgers.
- GitHub remains the control plane and dashboard host.
