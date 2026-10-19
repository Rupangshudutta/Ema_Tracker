# EMA Tracker v2 runbook

How to run, check and switch the bot. Written for the owner, not for developers.

## What runs where

| Part | Where | What it does |
| --- | --- | --- |
| Main engine | Cloudflare: Worker `ema-tracker` and its Tracker desk worker (Durable Object) | Checks Delta India every minute, keeps the live price feed open, sends alerts, answers Telegram |
| Spare engine (optional) | Docker on your PC | The same code. Waits on standby and copies your settings; takes over when you switch |
| Telegram bot | @SuperNana_bot | Only the engine holding the bot's Telegram connection sends alerts, so the two engines never double up |
| Watchdog | Healthchecks.io | Emails you if the active engine stops pinging for 15 minutes |

Address: https://ema-tracker.rupangshudutta.workers.dev (health page: `/health`).

## First-time setup on Cloudflare

1. In the Cloudflare dashboard open **Workers & Pages → ema-tracker → Settings → Variables and Secrets**. Add each of these with type **Secret**, never Text:

   | Name | Value |
   | --- | --- |
   | `TELEGRAM_BOT_TOKEN` | The token from @BotFather (revoke the old one that sits in the public git history first) |
   | `TELEGRAM_CHAT_ID` | Your private chat ID with the bot |
   | `HEALTHCHECK_PING_URL` | The ping URL from your Healthchecks.io check |

   Only add `TELEGRAM_ADMIN_USER_IDS` if alerts go to a group chat (then list the user IDs allowed to change settings).
2. Deploys happen automatically when code reaches GitHub `main` and the checks pass. Within a minute of the first deploy with secrets you get **"EMA Tracker v2 is running"** and **"Joined the watchlist"**.
3. In Healthchecks.io set the check to **Period 5 minutes, Grace 10 minutes**.
4. In Telegram send `/start`. The **Coins** button (bottom-left menu button and in the menu) opens the coin picker.

## Everyday use

| You want to | Do this |
| --- | --- |
| See if everything is fine | `/status`, or wait for the daily report (09:00 IST by default) |
| Change margin, volume filter, report time | `/start` → Settings |
| Pick coins and timeframes | `/start` → Coins, search, tick 5m / 15m / 1h / 4h. Untick everything to remove a coin |
| Do it by typing | `/watch BTCUSD 5m 15m`, `/unwatch BTCUSD`, `/coins` |
| Mute alerts for a while | `/pause 2h` or `/start` → Pause; `/resume` to undo |
| See the market | `/start` → 📈 Top gainers, 📉 Top losers, 💰 Highest volume (24 h, top 10), or `/top`. Gainers and losers skip coins under $1M volume; 👁 marks coins on your watchlist |

Every alert has a **chart** link to the coin on TradingView (Delta India perpetual, for example `DELTAIN:BTCUSD.P`).

## Start and stop messages

| Message | When |
| --- | --- |
| 🟢 **EMA Tracker started**, first start | The very first run, with the coins and settings it starts with |
| 🟢 **EMA Tracker started**, new version is live | After a deploy |
| 🟢 **EMA Tracker started**, back online after N min | After an outage of 2 minutes or more, with when it was last seen. Missed alerts follow, marked LATE or in one list |
| 🟢 **EMA Tracker started**, back after a planned stop | The Docker spare started again after you stopped it |
| 🔴 **EMA Tracker stopping** | The Docker spare is stopped while it is sending. It first hands alerts back to Cloudflare when Cloudflare answers |
| 🔴 **Cloudflare engine not answering** | Sent by the Docker spare on standby when Cloudflare has not answered for 5 minutes (only while the spare runs) |

Cloudflare gives no warning before it stops a bot, so Cloudflare itself cannot send a stop message. You learn about a Cloudflare stop from the "back online after N min" message, from the Docker spare's warning, and from Healthchecks' email. Cloudflare also moves the bot between its machines now and then without downtime; those restarts send no message and are counted in the daily report as engine starts.

Alert labels: ⚡ **REALTIME** (candle still open), ↩️ **REALTIME CANCELLED**, ✅ **CONFIRMED** (candle closed), ❌ **NOT CONFIRMED**, ⏰ **LATE** (held up by an outage). After 30 minutes late, alerts come in one "Missed while offline" list; after 6 hours they are dropped and counted in the daily report.

## Warnings you may see

| Message | Meaning | Action |
| --- | --- | --- |
| ⚠️ Live price feed down | Delta's live prices stopped for 5+ min. Realtime alerts fall back to a once-a-minute price check; confirmed alerts are unaffected | None; it reconnects by itself (waiting longer between tries if Delta refuses) |
| ⚠️ Delta API not answering | Candle checks fail for 5+ min | None; confirmed alerts catch up marked LATE |
| ⏸ Paused: COIN fell below your volume filter | 24 h volume under the filter for an hour | None; it resumes on the same timeframes |
| Healthchecks email "down" | The active engine stopped pinging, or reports a problem | Open `/health` and read `problems`; if Cloudflare is down, start the Docker spare (below) |
| Nothing at all, no daily report | Secrets missing, or no engine holds the Telegram connection | Open `/health`; `roleReason` says why |

## Docker spare

### One-time setup

1. Install Docker Desktop.
2. Copy `.env.docker.example` to `.env.docker` in the project folder and fill in the values. `.env.docker` is git-ignored; never commit it.
3. Start it (PowerShell, in the project folder):

   ```bash
   docker compose -f runtimes/docker/compose.yaml up -d --build
   ```

4. Check it: `docker compose -f runtimes/docker/compose.yaml logs -f` should show `role: standby (Cloudflare holds the Telegram webhook)`. It copies your settings and watchlist from Cloudflare every 5 minutes and checks in every minute. Health page: http://127.0.0.1:8787/health

### Planned switch to Docker (Cloudflare still works)

Send `/use_docker` in Telegram. Cloudflare refuses if the spare has not checked in during the last 10 minutes. Docker takes over within a minute and says so in the chat.

### Emergency: Cloudflare is down

```bash
$env:RUNTIME_ROLE='active'; docker compose -f runtimes/docker/compose.yaml up -d
```

Docker takes the Telegram connection at start and sends alerts. The coin picker needs Cloudflare; use `/watch` and `/unwatch` meanwhile.

### Switch back to Cloudflare

Send `/use_cloudflare` in Telegram. Docker first copies your settings and watchlist back, then hands over. If you started it with `RUNTIME_ROLE=active`, restart it on standby afterwards:

```bash
$env:RUNTIME_ROLE='standby'; docker compose -f runtimes/docker/compose.yaml up -d
```

If Docker holds the connection but stops checking in for 10 minutes (for example the PC is off), Cloudflare takes the connection back by itself and tells you. Settings changed in Docker since its last check-in are not copied in that case.

### Stop or update the spare

```bash
docker compose -f runtimes/docker/compose.yaml down
```

`down` keeps the data volume (`ema-tracker_ema-data`). To update after pulling new code, run the `up -d --build` command again.

## Testing on your PC (`npm run cf:dev`)

- `wrangler dev` reads `.dev.vars`, not `.env`. The old `.env` belongs to the v1 bot; v2 ignores its settings.
- With an empty `.dev.vars` the local copy runs on standby: it computes everything and sends nothing.
- With real secrets in `.dev.vars` it sends real messages, but only while no other engine is active: before it takes the Telegram connection it reads `PUBLIC_BASE_URL/health`, and if the deployed Cloudflare engine is active it stays silent. Stop it before you deploy anyway, and never commit `.dev.vars`.
- Telegram cannot reach your PC, so buttons and commands only work on the deployed Cloudflare engine.
- On Windows the local runtime sometimes prints "The Workers runtime crashed unexpectedly and is being restarted" right after start or after a reload. It restarts by itself; tests show it happens before the bot's code runs, and it does not affect Cloudflare.

## Free-plan limits (Cloudflare Workers Free)

| Limit | Our use |
| --- | --- |
| 50 outbound calls per run | Each run uses at most 45; bigger candle closes continue in a follow-up run a second later |
| 100,000 Durable Object requests a day | About 3,000 to 4,000 (one alarm and one timer call a minute, plus Telegram) |
| 100,000 SQLite rows written a day | About 1,500 with 12 coins on 15m; under 10,000 with 16 coins on all four timeframes |
| 13,000 GB-seconds of Durable Object time a day | The always-open live feed keeps the desk worker awake: about 10,800 |

Not verified: whether Cloudflare counts incoming live-feed messages against the free plan. Check **Workers & Pages → ema-tracker → Metrics** after the first full day.
