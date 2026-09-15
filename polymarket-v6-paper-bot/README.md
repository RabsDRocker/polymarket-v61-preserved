# Polymarket V6 Paper Bot

A paper-only research bot for Polymarket BTC Up/Down 5-minute and 15-minute markets. It uses public market data and simulated fills; it cannot connect a wallet, sign an order, or move money.

## V6 in plain English

V6 combines three live public feeds:

- **Chainlink** supplies the settlement-aligned BTC reference target.
- **Binance** supplies fast BTC trades for momentum and volatility.
- **Polymarket** supplies executable Up/Down order books, spread, depth, and flow.

The adaptive model continuously compares its estimated probability with the executable Polymarket ask after fees and an execution reserve. It can enter BTC 5m or 15m when the signal, liquidity, and risk limits qualify.

The deterministic momentum setup activates near two minutes remaining when BTC has moved at least $70 during the interval and Polymarket order flow supports that direction. It allocates 50% of a $100 per-market research budget. At extreme 95% model skew, V6 can add a $2 opposite-side paper hedge.

All thresholds are centralized in [`lib/v6-strategy.ts`](lib/v6-strategy.ts).

## V6.1 and V7 experiments

- **V6.1 Adaptive Pulse** preserves V6's directional entry, exit, and micro-hedge logic while delaying BTC 15-minute entries until six minutes remain.
- **V7 Balanced Conviction** begins with independent equal-dollar Up and Down paper buys, retries a missing opening leg, then makes probability-scaled additions to the favored side. It never sells, reverses, or hedges.

Each version writes to its own ignored SQLite journal, so running one experiment does not overwrite another version's history.


## Run locally

Requires Node.js 24+ because the project uses Node's built-in SQLite module.

```sh
pnpm install
pnpm test
pnpm build
pnpm paper:continuous:v6
```

To run one of the later experiments instead, use exactly one of:

```sh
pnpm paper:continuous:v61
pnpm paper:continuous:v7
```

In another terminal:

```sh
pnpm start --hostname 127.0.0.1 --port 3210
```

Dashboard routes:

- V6: [http://127.0.0.1:3210/v6](http://127.0.0.1:3210/v6)
- V6.1: [http://127.0.0.1:3210/v61](http://127.0.0.1:3210/v61)
- V7: [http://127.0.0.1:3210/v7](http://127.0.0.1:3210/v7)

## Important files

- `lib/v6-strategy.ts` — thresholds, probability blend, entry rules, and sizing.
- `scripts/v6-stream.ts` — public feeds, simulated execution, settlement, and journal updates.
- `app/v6/`, `app/v61/`, and `app/v7/` — versioned analytics dashboards.
- `lib/v7-strategy.ts` — V7 opening-pair retry and accumulation policy.
- `tests/scoring.test.ts` — deterministic strategy and safety tests.
- `RULE_HISTORY.md` — evidence and rule-change history.
- `SAFETY.md` — operating restrictions.
