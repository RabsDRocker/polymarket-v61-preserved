# Polymarket live execution sidecar

This service is isolated from the V6.1 paper bot. It uses the official Polymarket TypeScript SDK and is installed with two independent locks engaged: the `LIVE_TRADING_ENABLED` environment guard and a persistent `KILL_SWITCH` file/database setting.

The service records idempotent intents before submission, checks signal age, expiry, market ownership, minimum order size, balance, position balance, geographic eligibility, price protection, exposure, and daily loss. It reconciles open exchange orders before processing. A network or SDK exception after submission begins is treated as an unknown outcome: the service records `unknown`, creates the kill-switch file, and stops without retrying.

The V6.1 bridge maps `adaptive_value` and `deterministic_momentum` to entries, `micro_hedge` to hedge buys, and `adaptive_exit` to a sale of the actual wallet inventory for that outcome. Paper dollar sizing is multiplied by `LIVE_SIZE_SCALE` (default `0.025`) with a `MIN_LIVE_BUY_USD` floor (default `$1`). The exchange minimum may raise an order only within `MAX_ORDER_USD`. Entry and hedge buys obey the collateral, daily-loss, and exposure limits; exits remain available after a loss stop so the bot can reduce risk. A hedge is suppressed unless its corresponding live entry was accepted.

`MAX_ACCEPTED_ORDERS` defaults to `1` for a deployment trial. Set it to `0` only after review to allow the full continuous lifecycle. Continuous mode still halts on an unknown submission outcome, a kill-switch request, or a configured risk limit. Accepted fills are recorded in a live position ledger, while wallet balances and portfolio value are reconciled from Polymarket for exposure and daily equity P&L.

No credential values should appear in commands, logs, source files, or the paper repository. When a later step is authorized, credentials belong in a root-owned environment file read only by the system service.
