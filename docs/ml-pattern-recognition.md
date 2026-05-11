# Machine Learning Pattern Recognition Plan

This lab treats every backtest and forward-paper signal as training evidence, not proof of future profit.

## Data Spine

- Canonical trades live in `data/canonical/` and prevent duplicate ledger rows from inflating results.
- Exact champion ledgers live in `apps/dashboard/public/data/*trade-ledgers.json`.
- Forward-paper signals should be appended through the closed-loop webhook ledger, then scored by `npm run scalp:closed-loop:update`.
- Raw high-volume ledgers stay out of git unless compressed as Actions artifacts.

## Labels

Pattern Lab should learn more than win/loss:

- `win`: modeled target reached before stop.
- `netDollars`: modeled profit after cost assumptions.
- `mfeR`: max favorable excursion in R.
- `maeR`: max adverse excursion in R.
- `timeToProfitBars`: how quickly price moved in favor.
- `optionWorthy`: fast favorable move with low adverse movement.
- `failurePattern`: late chase, fake volume spike, trap breakout, exhaustion, chop, or regime conflict.

## Feature Families

- Structure: liquidity sweep, failed breakdown/reclaim, breakout, opening range, prior-day level.
- VWAP/EMA: reclaim quality, distance penalty, compression around fair value, pullback resume.
- Volume/flow: relative volume, real accumulation score, fake spike penalty, absorption proxy.
- Candle quality: close location, body strength, wick rejection, range expansion.
- Relative strength: symbol versus SPY/QQQ/sector/peer basket.
- Regime: open drive, trend day, reversal day, high-vol chop, low-vol grind, power hour.

## Model Roadmap

- Start with interpretable weighted scoring and route-specific guard mutation.
- Add route-family logistic models for take/skip classification.
- Add calibration tables so “90% confidence” means historically close to 90% on holdout/forward samples.
- Add drift detection when today’s feature distribution no longer resembles training data.
- Promote only through chronological walk-forward, holdout, stress, and forward-paper evidence.

## Promotion Rules

- Main champion must beat the current champion on enough metrics, not just one headline win rate.
- Specialist modules can be saved when they are excellent in a narrow lane but too small to replace the main champion.
- Forward-proven specialists outrank backtest-only specialists.
- No model is allowed to place real trades from this repo.
