# Preserved V6.1 deployment — 2026-09-17

This source snapshot includes the deployed paper worker, dashboard, and accompanying live-execution source. The executor is unchanged from the preceding preserved commit. Real-money execution and its bridge are stopped; committing this source does not activate trading.

## Changes since the original preserved snapshot
- Use the official 60-second TWAP feed for current price and the exact opening TWAP for the target. Require a fresh feed and a verified opening anchor before entry.
- Disable the V6.1 paper $200 daily-loss stop. Keep the original strategy and entry windows (up to 210 seconds remaining for BTC 5m, 360 seconds for BTC 15m).
- Show the stopped live-account panel, paper-to-live signal history, recent live wins, and 5m/15m contribution on the dashboard.
- Preserve realized P&L when reopening a token; accumulate existing open inventory; atomically record purchases and exits.
- Allocate sale cost proportionally and retain unsold inventory after a partial exit. Give successive exits distinct event keys.

## Accounting repair
The one-time repair was applied to the active paper database after backing it up. It restored a missing $26.874507159533067 loss and adjusted subsequent equity/cash/realized-P&L snapshots. It does not reset capital or remove trade history.

The repair script replays recorded actions, verifies them against the legacy accounting, and refuses unexpected partial/overlapping historical transactions. It writes an accounting_repairs marker and refuses repeat application. It is specifically for the pre-fix ledger, not a routine maintenance command. Back up the database and stop its writer before using it.

Regression checks: from polymarket-v6-paper-bot, run `node --experimental-strip-types tests/paper-accounting.test.mjs`. The deployed project also passed `tsc --noEmit`.

## Existing VPS wiring
Active source: `/opt/polybot/preserved-twap-reset-20260917/`.
Paper database: `polymarket-v6-paper-bot/data/v61-adaptive.db`.
Dashboard: `127.0.0.1:3210/v61` on the server.
Live state: `/var/lib/polymarket-preserved-fresh/` with KILL_SWITCH engaged. Both live units are inactive and have a condition blocking start while that file exists.
The dashboard uses POLYMARKET_LIVE_DB and POLYMARKET_LIVE_KILL; mirror-status.ts also references the preserved live state path. Systemd overrides and credentials remain on the VPS, outside this repository.

No credentials, private keys, wallet databases, or runtime state are included. A fresh checkout alone does not recreate systemd configuration or activate either trading service. Paper results are simulations, not wallet balances.
