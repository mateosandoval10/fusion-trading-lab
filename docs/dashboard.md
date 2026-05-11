# Dashboard

The dashboard is a static app in `apps/dashboard/public`.

## Local

From the repo root:

```bash
npm run lab:report
python3 -m http.server 8080 --directory apps/dashboard/public
```

Open `http://localhost:8080`.

## GitHub Pages

This repo is public so GitHub Pages can deploy without a paid private-Pages plan.

The `Deploy Dashboard` workflow publishes `apps/dashboard/public` through GitHub Pages whenever dashboard/model/report files change on `main`.

The free fallback is still the `Build Dashboard Artifact` workflow. It uploads the dashboard as an Actions artifact named `fusion-dashboard-static`.

## Phase21 Panels

The dashboard now includes a canonical data panel and specialist factory table:

- `Phase21 Canonical Data` shows raw trades, deduped canonical trades, duplicates removed, route count, symbol count, global metrics, and top route quality.
- `Phase21 Specialist Factory` shows deduped specialist candidates with consistency, outlier, drawdown, feature-boost, and target suggestions.
- `Biggest Stock Hits` now prefers the canonical symbol manifest when available, so repeated ledger rows do not inflate the leaderboard.
- `Phase22 Deep Tournament` shows the newest fused challenger champion, category winners, stress metrics, Monte Carlo risk, and top routes.
- `Phase22 Trade Ledger` shows every exact backtest trade selected by each Phase22 winner category, with entry/exit time, prices, modeled PnL, 10k-scaled PnL, MFE/MAE, confidence, and selected route.
- `Phase23 Intelligence Layer` shows the newest feature-engine overlay, including balanced/profit, high-win guarded, and elite-precision winners plus the feature blueprints used by Pine.

## Specialist Detail Panels

Each specialist panel should answer four questions quickly:

- What is this specialist built to catch?
- How many exact trades did it take?
- Did it survive holdout/stress checks?
- Which symbols created the biggest modeled wins and losses?

The dashboard keeps Phase22 exact ledgers and Phase23 intelligence ledgers separate so a high-win precision overlay does not hide the broader profit champion.
