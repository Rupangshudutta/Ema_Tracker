# Security Policy

## Supported Versions

Use this section to tell people about which versions of your project are
currently being supported with security updates.

| Version | Supported          |
| ------- | ------------------ |
| 5.1.x   | :white_check_mark: |
| 5.0.x   | :x:                |
| 4.0.x   | :white_check_mark: |
| < 4.0   | :x:                |

## Reporting a Vulnerability

Use this section to tell people how to report a vulnerability.

Tell them where to go, how often they can expect to get an update on a
reported vulnerability, what to expect if the vulnerability is accepted or
declined, etc.


# EMA Tracker Project Memory

## Architecture Overview
- **main.js** — monolithic single file (~2750 lines), all logic in one place
- Node.js bot: Binance Futures WebSocket + Telegram alerts + desktop notifications
- Deploys to Fly.io (Singapore region to bypass Binance 451 geo-block)

## Key Modes
- **Single EMA mode**: price vs EMA(50/100/200), configurable via Telegram
- **DUAL_EMA_MODE**: EMA(9) vs EMA(15) crossover — now runs on BOTH 5m AND 15m simultaneously

## Dual-TF 9/15 Crossover Implementation (completed)
All 5 changes are in main.js:

1. **`tfKey(symbol, tf)`** helper at line ~111 — returns `"BTCUSDT_5m"` etc.
2. **`getKlines(symbol, tf=null)`** — `tf` param added; uses `tfKey` when provided
3. **`setupSymbolWebSocket`** — multiplexed WS URL when DUAL_EMA_MODE:
   `wss://fstream.binance.com/stream?streams=sym@kline_5m/sym@kline_15m`
   Seeds history for both TFs at startup. Message handler reads `kline.i` for tf.
4. **`processClosedCandle(symbol, kline, tf=null)`** — `cacheKey = tf ? tfKey(symbol,tf) : symbol`
5. **`updateDualEMA(key, newClose)`** — O(1) incremental EMA9+EMA15 update (replaces full recalc on every candle)
6. **`checkForDualEmaCrossover(..., tf='')`** — passes tf to shouldAlert + sendDualEmaAlert
7. **`shouldAlert(symbol, state, tf='')`** — TF-aware keys, backward compat with single mode
8. **`sendDualEmaAlert(..., tf='')`** — adds `[5M]` or `[15M]` label to all alerts
9. **`checkEMACross`** — in DUAL_EMA_MODE loops over `['5m','15m']` per pair

## State Key Formats
- Single mode: `coinStates.get(symbol)`, `lastAlerts.get("BTCUSDT_above")`
- Dual mode: `coinStates.get("BTCUSDT_5m")`, `lastAlerts.get("BTCUSDT_5m_ema9_above")`
- 4 independent cooldown buckets per symbol in dual mode

## Rate Limits (24/7 safe)
- WebSocket = zero REST weight (live candle data)
- Startup: ~5 REST calls/symbol × 2 TFs = ~10N weight (staggered by enforceRateLimit)
- Binance limit: 1200 weight/min — actual steady-state usage <1%

## User Preferences
- User prefers concise explanations with visuals/tables before code changes
- Code-first approach after confirmation

## Important Files
- `main.js` — entire bot logic
- `src/indicators.js` — RSI, MACD, Bollinger Bands
- `alert_state.json` — persisted cooldown state (survives restarts)
- `settings.json` — persisted user settings
- `fly.toml` — Fly.io deployment config (Singapore region)
