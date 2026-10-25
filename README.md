# EMA Tracker v2

Telegram alerts when EMA 9 crosses EMA 15 on **Delta Exchange India** perpetual futures.

## What you get

| Alert | When |
| --- | --- |
| ⚡ **REALTIME** | The live price pushes EMA 9 past EMA 15 by more than your margin while the candle is still open (at most one per coin, timeframe and candle) |
| ↩️ **REALTIME CANCELLED** | That cross reversed before the candle closed |
| ✅ **CONFIRMED** | The closed candle confirms the cross (hysteresis rule: the side flips only when the gap clears the margin) |
| ❌ **NOT CONFIRMED** | The realtime cross did not hold at the close |
| ⏰ **LATE** | Held up by an outage; after 30 min alerts come in one "missed" list, after 6 h they are dropped and counted |

Plus a daily "I'm alive" report, start and stop messages, warnings when Delta or the live feed fails, Healthchecks.io pings,
and the menu: status, settings, top gainers / losers / highest volume, pause, and a coin-picker mini app with per-coin
timeframes (1m, 3m, 5m, 15m, 1h, 4h).

Coins above your volume filter (default $10M, 24 h) join the watchlist automatically on 15m, up to 16 coins, and stay
until you remove them: a volume drop never pauses or removes a coin. One margin
(0.00 to 0.10%, default 0.05%) applies to every coin, timeframe and alert type.

## How it runs

| Part | Where |
| --- | --- |
| Main engine | Cloudflare Workers: one Worker plus one Durable Object with SQLite (`runtimes/cloudflare`), deployed by Workers Builds from `main` after `npm run check` passes |
| Spare engine | Docker on your PC (`runtimes/docker`), on standby until you switch |
| Who sends | Whichever engine holds the bot's Telegram connection (webhook on Cloudflare, long polling in Docker), so alerts are never doubled |

Both engines run the same code in `core/`. There are no runtime npm packages.

Setup, everyday use, switching engines and troubleshooting: **[docs/RUNBOOK.md](docs/RUNBOOK.md)**.

## Development

Needs Node 24.

```bash
npm ci
npm run check        # secret scan, type checks, all tests
npm run cf:dev       # local Worker (reads .dev.vars; standby without secrets)
npm run top          # top gainers, losers and volume from live Delta data
npm run crosses -- --hours=8 --timeframes=15m   # confirmed crosses the bot would have sent
```

| Folder | What |
| --- | --- |
| `core/config` | Settings (fixed and user) and environment parsing |
| `core/domain` | EMA, closed-candle guard, confirmed and realtime rules, alert IDs |
| `core/exchange` | Delta India REST client and live-feed messages |
| `core/store` | SQLite notebook: settings, watchlist, signal state, outbox, counters |
| `core/app` | Engine, live feed, watchlist rules, outbox, messages, Telegram menus, mini app, HTTP routes |
| `runtimes/cloudflare` | Worker and Tracker Durable Object |
| `runtimes/docker` | Node host, Dockerfile, compose file |
| `test` | Unit, golden (recorded Delta candles) and end-to-end tests against a simulated Delta and Telegram |
| `docs` | Runbook, settings reference, system design, architecture review |

The v1 bot (Bybit, `main.js`) is retired; its last state is the git tag `v1-final`.

## Security

Secrets live only in Cloudflare secrets or a git-ignored `.env.docker`; see [SECURITY.md](SECURITY.md).
