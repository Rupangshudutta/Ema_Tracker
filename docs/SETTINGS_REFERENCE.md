# EMA Tracker v2 settings reference

Every setting the bot uses, what it is for, its default, and where it is changed, grouped by responsibility. The code keeps the same grouping (one settings schema, one section per group). Secrets are listed by name only; their values never go in git.

## Secrets

Keys and private links. Never in git, never in a file the bot publishes. Stored in Cloudflare's secret store, or in a .env file only you can read when running in Docker.

| Name | What it does | Default | Allowed values | Where it is set | Who changes it |
| --- | --- | --- | --- | --- | --- |
| `TELEGRAM_BOT_TOKEN` | Lets the bot send and receive Telegram messages | none | From @BotFather | Cloudflare secrets / Docker .env | You |
| `TELEGRAM_CHAT_ID` | The chat that receives alerts and reports | none | Numeric ID | Cloudflare secrets / Docker .env | You |
| `TELEGRAM_ADMIN_USER_IDS` | Telegram users allowed to change settings and pick coins | your user ID | Comma-separated numeric IDs | Cloudflare secrets / Docker .env | You |
| `TELEGRAM_WEBHOOK_SECRET` | Proves an incoming request really came from Telegram | generated once | 1 to 256 letters, digits, _ or - | Cloudflare secrets | Set up once |
| `HEALTHCHECK_PING_URL` | The Healthchecks.io link the bot calls after every healthy run | none | Your check's ping URL | Cloudflare secrets / Docker .env | You |

## Runtime

Which engine is running and whether it is allowed to send.

| Name | What it does | Default | Allowed values | Where it is set | Who changes it |
| --- | --- | --- | --- | --- | --- |
| `RUNTIME` | Which shell is running the core | cloudflare | cloudflare, docker | Set by the build | Nobody |
| `RUNTIME_ROLE` | Who may send is decided by who holds the Telegram connection (webhook on Cloudflare, polling in Docker). On Cloudflare, active = may claim the webhook, standby = never sends. In Docker, standby = follow the connection, active = take it at start (emergency) | active on Cloudflare, standby in Docker | active, standby | Cloudflare vars / Docker compose (`$env:RUNTIME_ROLE`) | You, in an emergency |
| `PUBLIC_BASE_URL` | Cloudflare's web address: the webhook, mini app and health page live there, and the Docker spare uses it to copy settings and check in | your workers.dev address | https URL | Cloudflare vars / Docker .env.docker | Set up once |
| `DATA_DIR` | Where Docker keeps its SQLite file | /data | A mounted volume path | Docker compose file | Set up once |
| `LOG_LEVEL` | Reserved; not read yet (the engine logs state changes and problems only) | info | debug, info, warn, error | Cloudflare vars | Nobody yet |

## Exchange (Delta India)

How the bot talks to Delta.

| Name | What it does | Default | Allowed values | Where it is set | Who changes it |
| --- | --- | --- | --- | --- | --- |
| `DELTA_API_BASE` | Delta India REST address | https://api.india.delta.exchange | Fixed | Config file in git | Nobody |
| `DELTA_WS_URL` | Delta India live feed address | wss://socket.india.delta.exchange | Fixed | Config file in git | Nobody |
| `HTTP_USER_AGENT` | Name the bot sends with every request (Delta rejects requests without one) | ema-tracker/2.x | Text | Config file in git | Nobody |
| `REQUEST_TIMEOUT_MS` | How long to wait for Delta before retrying | 8000 | 1000 to 20000 | Config file in git | Rarely |
| `MAX_RETRIES` | Retries per request inside one run | 3 | 0 to 5 | Config file in git | Rarely |

## Coins

Which coins the bot watches.

| Name | What it does | Default | Allowed values | Where it is set | Who changes it |
| --- | --- | --- | --- | --- | --- |
| `volumeThresholdUsd` | Minimum 24 h trading volume for a coin to join or stay on the watchlist | $10M | $5M, $10M, $15M, $20M, $30M, $50M, $100M | Telegram menu | You |
| `watchlist` | Each coin's ticked timeframes; a coin with none is removed and gets no alerts or live feed | Every coin above the filter on 15m | Per coin: any of 1m, 3m, 5m, 15m, 1h, 4h, or none | Mini app search | You |
| `removedCoins` | Coins you removed; they stay out even while above the filter | none | Any coins | Mini app search | You |
| `defaultTimeframes` | Timeframes a newly qualifying coin starts with | 15m | Any of 1m, 3m, 5m, 15m, 1h, 4h | Telegram menu | You |
| `maxWatchlistCoins` | Most coins on the watchlist at once; extra coins are listed in a note | 16 | Fixed for the free plan | Config file in git | Nobody |
| `universeRefreshMinutes` | How often the coin list is rebuilt from Delta volumes | 15 | Fixed | Config file in git | Nobody |
| `dropGraceMinutes` | How long a coin must stay below the filter before it is dropped | 60 | Fixed | Config file in git | Nobody |

## Signal

The EMA 9/15 rules.

| Name | What it does | Default | Allowed values | Where it is set | Who changes it |
| --- | --- | --- | --- | --- | --- |
| `marginPct` | How far EMA 9 must pass EMA 15 before any alert; one value for every coin, timeframe and alert type | 0.05% | 0.00, 0.01, 0.02 ... 0.10% | Telegram menu | You |
| `availableTimeframes` | Candle sizes the mini app offers | 1m, 3m, 5m, 15m, 1h, 4h | Fixed | Config file in git | Nobody |
| `candleHistory` | Candles fetched per check (enough for exact EMAs) | 150 | Fixed | Config file in git | Nobody |
| `rebuildHistory` | Candles fetched once if the remembered side is ever lost | 1000 | Fixed | Config file in git | Nobody |

## Realtime

Live alerts while a candle is still open. They run on every watchlist coin and ticked timeframe.

| Name | What it does | Default | Allowed values | Where it is set | Who changes it |
| --- | --- | --- | --- | --- | --- |
| `realtimeCancelNotes` | Send a short note when a realtime cross undoes itself before the close | on | on, off | Telegram menu | You |
| `feedStaleSeconds` | Silence on the live feed before the bot reconnects (Delta heartbeat is every 30 s) | 35 | Fixed | Config file in git | Nobody |
| `reconnectDelaysSeconds` | Wait before reconnecting after 0, 1, 2... quick drops in a row (Delta allows 150 connections per IP per 5 min) | 2, 5, 15, 60, 300, 600 | Fixed | Config file in git | Nobody |
| `healthyAfterSeconds` | A connection that dies sooner than this counts as a quick drop | 60 | Fixed | Config file in git | Nobody |

## Timing

When work happens.

| Name | What it does | Default | Allowed values | Where it is set | Who changes it |
| --- | --- | --- | --- | --- | --- |
| `timerSchedule` | How often Cloudflare wakes the bot | every minute | Fixed | wrangler.jsonc | Nobody |
| `settleSeconds` | Wait after a candle closes before reading it | 3 | Fixed | Config file in git | Nobody |

## Market lists

The v1 bot's Top gainers, Top losers and Highest volume lists (`/top` and the menu).

| Name | What it does | Default | Allowed values | Where it is set | Who changes it |
| --- | --- | --- | --- | --- | --- |
| `topListSize` | Coins per list | 10 | Fixed | Config file in git | Nobody |
| `topListMinVolumeUsd` | Gainers and losers skip coins with less 24 h volume (Delta lists many near-dead coins) | $1M | Fixed | Config file in git | Nobody |

## Delivery

How alerts reach you.

| Name | What it does | Default | Allowed values | Where it is set | Who changes it |
| --- | --- | --- | --- | --- | --- |
| `digestThreshold` | From this many alerts in one run, send one combined message | 4 | Fixed | Config file in git | Nobody |
| `lateWindowMinutes` | Missed alerts up to this age are sent marked LATE; older ones go in a summary | 30 | Fixed | Config file in git | Nobody |
| `maxAlertAgeHours` | Undelivered alerts older than this are given up and listed in the report | 6 | Fixed | Config file in git | Nobody |
| `pause` | Stop all alerts for a while | off | 1 h, 4 h, until resumed | Telegram menu | You |

## Monitoring

How you know the bot is healthy.

| Name | What it does | Default | Allowed values | Where it is set | Who changes it |
| --- | --- | --- | --- | --- | --- |
| `dailyReportTime` | When the daily I'm-alive report arrives | 09:00 India time | Any time | Telegram menu | You |
| `healthPingMinutes` | How often the bot calls Healthchecks.io when healthy | 5 | Fixed (set the check to period 5 min, grace 10 min) | Config file in git | Nobody |
| `degradedAlert` | Instant warning when Delta keeps failing, the feed is stale or alerts are stuck | on | Fixed | Config file in git | Nobody |
