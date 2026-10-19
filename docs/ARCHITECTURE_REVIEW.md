# EMA Tracker architecture review

Audited: `main.js` at commit `12314c9`, 19 Oct 2026. Diagrams are Mermaid and can be edited in place.

Legend: **Exists** (blue), **Exists with a finding** (red), **Missing today** (grey dashed), **Proposed** (green dashed), **External** (tan).

## Improvement areas, ranked

### Fix Now

**I1. Two writers share one candle cache** (effort: S, hours)

The REST backup poll (`checkEMACross`, main.js:1707, run at startup on line 3076 and every 5 minutes on line 3125) writes the unfinished candle into the same cache the WebSocket path appends to. `getKlines` (526) keeps Bybit's newest row, which a live API probe confirmed is the open candle. `processClosedCandle` (967) then appends the confirmed candle without checking its start time. In a replay of real candles the WebSocket-only control matched 160 of 160 expected alerts. The as-built pipeline sent 22 to 42 of them, plus 56 to 67 alerts that the bot's own rule does not produce on closed candles.

*Fix:* Drop rows where start + interval is later than now, skip candles whose start is not newer than the last stored one, and make the poll seed-only (no alerts, no state changes).

**I2. The 0.03% margin discards 79% of crossovers** (effort: S, needs your decision)

The margin (`MIN_CROSS_PCT`, line 138, used on lines 1442 and 1455) is tested once, on the crossing candle. If the spread is smaller, the new side is recorded and that crossover can never alert, even when the spread clears the margin on the next candle. Across 8 pairs, 589 of 749 raw crossovers were dropped, and 201 of those were above the margin one candle later. How strict the filter should be is your call. The rule should wait for confirmation instead of discarding.

*Fix:* Hysteresis: persist the last alerted side and alert when the spread passes the margin on the opposite side.

**I3. Alerts can be lost without a trace** (effort: M, 1 to 3 days)

`shouldAlert` saves state and cooldown before the message is sent (764-768). `safeSendAlert` returns silently while its breaker is open (173-176) and its callers still log success (737, 1523). Reproduced: after five failures, calls six and seven return with no Telegram request. The August logs show two "Failed to send even simplified message" errors. There is no retry and no record of what was dropped.

*Fix:* An outbox with an idempotency key (symbol + timeframe + candle close + direction), retry with backoff and Telegram's `retry_after`, and state updated only when Telegram accepts the message.

**I4. Secrets in the public repository history** (effort: S, hours)

github.com/Rupangshudutta/Ema_Tracker is public. Commits d5a7dc1 and 8947c13 contain a Telegram-token-shaped string and a numeric chat ID in `ecosystem.config.js`, `node.js` and `nodejsDump.txt`. They are gone from HEAD and still in history. The token in your local `.env` is a different string, so it was probably rotated. I did not test the old one. If it was never revoked, anyone holding it can send messages as that bot.

*Fix:* Confirm the old token is revoked in @BotFather, add secret scanning (for example gitleaks) to commits, and purge history only if you want it clean once the token is dead.

**I5. A failed stats call breaks the alert formatter** (effort: XS, minutes)

`get24HrStats` returns `quoteVolume` as the string '0' on error (429-431). `formatVolume` (396) then throws `volume.toFixed is not a function`. Reproduced, and the same error is in the August logs twice. The alert degrades to a one-line message and the desktop toast is skipped.

*Fix:* Return numbers, and send the alert before fetching extras.

**I6. The container image is not production-safe** (effort: S, hours)

The Dockerfile uses node:18-alpine (nodejs.org lists Node 18 and 20 as end of life), runs as root, and has a HEALTHCHECK that only prints ok (line 26). There is no `.dockerignore`, so `COPY . .` (line 18) copies a local `.env`, logs and host `node_modules` into the image when built from a dev folder. I did not run a build.

*Fix:* Current LTS base image, `USER node`, a `.dockerignore` (.env, node_modules, logs, state files), and a healthcheck that calls /health and fails when the feed is stale.

### Improve Next

**I7. State lives on disk that may not survive** (effort: S to M)

`alert_state.json` and `settings.json` are written beside the code (91, 2391), tracked in git, and baked into the image (Dockerfile:18). fly.toml has no volume. Fly's docs describe Machine storage as ephemeral and Render states that free web services have an ephemeral filesystem. Writes happen in place (102-107), so a crash mid-write can leave a truncated file, and the loader then starts empty.

*Fix:* Write to a temp file and rename, keep runtime state out of git, and use a volume or a small external store on cloud hosts.

**I8. WebSocket liveness has gaps** (effort: M, 1 to 3 days)

The heartbeat checks only `readyState` (2741-2775) and there is no pong handler, so a half-open socket goes unnoticed. After five failed reconnects a pool stops (855-865) until a 5-minute timer retries (3090-3104). The 60-second heartbeat and the backoff timer can each create a socket for the same pool index (859-862, 2757-2758), leaving an orphan that still delivers candles (reasoned from the code, not reproduced). Reconnects do not reload history, so missed candles become a gap the EMA treats as contiguous. A duplicate delivery added one duplicate row and about 0.2 bps of EMA drift in my test.

*Fix:* Track pong time and reconnect on silence, close the old socket before replacing it, reseed from REST after every reconnect, and ignore candles that are not newer than the last stored one. Or drop the WebSocket (see Proposed).

**I9. Alert latency and request pattern** (effort: S, hours)

Every alert waits for two 1.2-second limiter slots (703-704, 1487-1488), so bursts queue: 16 simultaneous crossovers (8 pairs x 2 timeframes) means at least 38 s for the last one, and 68 means at least 163 s. Bybit allows 600 requests per 5 s per IP, about 140 times the limiter's rate. `fetchInChunks` (1694) receives promises that are already running, so its batching does nothing: in a test, 40 tasks all started within 1 ms and the function added 471 ms of waiting. Each poll also downloads the full tickers list, 172 KB gzipped (678 KB raw).

*Fix:* Send the alert first and enrich afterwards, cache the tickers response for 30 s, and replace the 1.2 s queue with a token bucket sized to Bybit's real limit.

**I10. Dependencies and runtime** (effort: S to M)

`npm audit` reports 19 findings: 2 critical, 7 high, 10 moderate. Affected direct packages are axios, ws, figlet, chokidar, node-notifier and node-telegram-bot-api (its critical findings come through the deprecated `request` chain). In-range updates exist for axios (1.20.0), ws (8.22.0) and figlet (1.12.0). node-telegram-bot-api 2.1.0 is a major jump to test first. `fs` and `path` in package.json are placeholder npm packages, and brain.js and TensorFlow are imported but not declared.

*Fix:* Update inside ranges, remove `fs`, `path` and `chokidar` from dependencies, and move the ML packages to optional.

**I11. Single-EMA mode starts from too little history** (effort: XS, minutes)

`getKlines` requests period + 100 candles (526-531). For EMA 200 that leaves 37% of the seed error. Against a long-history EMA the median gap was 10.9 bps, the 95th percentile 91.8 bps, and the above/below side differed on 4.8% of samples (EMA 100: 3.4 bps, 29.5 bps, 1.8%). EMA 9/15 mode is not affected.

*Fix:* Request at least 3 x period candles (Bybit allows 1,000).

**I12. Hosting claims in the repo do not hold for $0** (effort: S, hours)

fly.toml says 3 free VMs, but Fly's docs say new organizations have no free tier. render.yaml uses a Background Worker, and Render lists only web services, Postgres and Key Value as free. The README says Railway gives $5 a month, while Railway's docs describe a one-time $5 trial and then $1 a month. The committed settings.json (EMA 100, dual mode on) also overrides the EMA_PERIOD=200 in fly.toml and render.yaml. See the hosting table.

*Fix:* Pick a runner from the hosting table, delete the platform files you will not use, and make the README match.

**I13. Observability and log hygiene** (effort: S, hours)

About 11,600 identical "Telegram polling error ... ENOTFOUND" lines in 8 days of logs, each written synchronously by `log()` (263). `/health` always answers ok (3016) and nothing compares `lastCandleTime` with the clock. Logs rotate only at startup (2995). 45 "Conflict: terminated by other getUpdates" lines show two instances ran on one token, which also means duplicate alerts.

*Fix:* Collapse repeated errors, report the age of the last good cycle on /health and as a Telegram alert, and take a single-instance lock.

### Future Enhancement

**I14. Split the monolith and add tests** (effort: M to L)

main.js holds config, networking, indicators, alerts, the Telegram UI, ML and desktop toasts in 3,152 lines with no tests. `scripts/data_sync.js` hardcodes a personal Windows path, and SECURITY.md contains pasted notes that still mention Binance.

*Fix:* Extract the signal core and the exchange adapter first, and use the replay data from this review as the first regression suite.

## Architectures

### Current architecture, as built

Two paths write the same candle cache: the REST backup poll (left) and the WebSocket pool. Red nodes carry a finding; the tag (I1, I2…) points to the improvement list.

```mermaid
flowchart LR
  subgraph EXT["External services"]
    direction TB
    BYR["Bybit REST<br/>tickers · kline · open-interest"]:::ext
    BYW["Bybit WebSocket<br/>kline.5 and kline.15 per symbol"]:::ext
    TGA["Telegram Bot API"]:::ext
  end
  subgraph APP["main.js, one process, 3,152 lines"]
    direction TB
    POLL["checkEMACross<br/>startup + every 5 min · I1"]:::defect
    SEED["getKlines<br/>keeps the forming candle · I1"]:::defect
    POOL["WebSocket pool<br/>backoff x5 · heartbeat · I8"]:::defect
    PCC["processClosedCandle<br/>append + EMA step, no dedupe · I1"]:::defect
    CACHE[("klineCache · ema9Cache · ema15Cache<br/>two writers · I1")]:::defect
    DET["checkForDualEmaCrossover<br/>one-shot 0.03% gate · I2"]:::defect
    GATE["shouldAlert<br/>saves state before send · I3"]:::defect
    SND["sendDualEmaAlert + safeSendAlert<br/>breaker drops silently · I3"]:::defect
    RL["enforceRateLimit<br/>1.2 s serial queue · I9"]:::defect
    CMD["Telegram commands<br/>settings · refresh · ML"]:::existing
    HEALTH["/health on :3000<br/>always ok · I13"]:::defect
  end
  subgraph FSYS["Container filesystem"]
    direction TB
    AS[("alert_state.json · I7")]:::defect
    SET[("settings.json · I7")]:::defect
    LOG[("logs/*.log")]:::existing
  end
  POLL --> SEED
  SEED -->|"2 x N kline calls"| BYR
  SEED --> CACHE
  BYW -->|"confirm=true pushes"| POOL
  POOL --> PCC
  PCC --> CACHE
  POLL --> DET
  PCC --> DET
  DET --> GATE
  GATE --> AS
  GATE --> SND
  SND --> RL
  RL -->|"24h stats + OI delta"| BYR
  SND -->|"sendMessage"| TGA
  TGA <-->|"long-poll updates"| CMD
  CMD --> SET
  PCC -.->|"sync append"| LOG
  POOL -.-> HEALTH

  classDef existing fill:#dfe7f1,stroke:#4a6684,color:#14202e;
  classDef defect fill:#fbe3df,stroke:#c0392b,stroke-width:2px,color:#3b0d08;
  classDef missing fill:#f1f1f1,stroke:#7d7d7d,stroke-dasharray:5 4,color:#2c2c2c;
  classDef proposed fill:#dff3e6,stroke:#1e7f4f,stroke-width:2px,stroke-dasharray:6 3,color:#0d2e1c;
  classDef ext fill:#efe9dc,stroke:#8a7a52,color:#2b2412;
  classDef trigger fill:#fff4d6,stroke:#b58105,color:#3a2a00;
```

### Layered architecture, mapped to the repository

Line numbers are in main.js. Grey dashed boxes are layers or capabilities the project does not have yet.

```mermaid
flowchart TB
  subgraph L1["1 Configuration"]
    direction LR
    C1["dotenv + env parsing<br/>main.js 1-45"]:::existing
    C2["settings.json loader + whitelists<br/>main.js 140-142, 2403"]:::existing
    C3["Schema validation of env values"]:::missing
  end
  subgraph L2["2 Data ingestion"]
    direction LR
    I1a["REST client (axios)<br/>getFuturesPairs 435 · getKlines 526<br/>get24HrStats 416 · getOIDelta 673"]:::defect
    I2a["WebSocket pool<br/>setupPoolConnection 801<br/>subscribeSymbolToPool 932"]:::defect
    I3a["Pong watchdog · gap backfill · IP-ban handling"]:::missing
  end
  subgraph L3["3 Processing"]
    direction LR
    P1["calculateEMA 596 · updateDualEMA 650"]:::existing
    P2["klineCache + EMA caches (Maps)"]:::defect
  end
  subgraph L4["4 Business logic"]
    direction LR
    B1["checkForDualEmaCrossover 1434<br/>checkForCrossover 1367"]:::defect
    B2["shouldAlert 754<br/>MIN_CROSS_PCT 138"]:::defect
  end
  subgraph L5["5 State"]
    direction LR
    S1["coinStates + lastAlerts (Maps)<br/>alert_state.json 91-107"]:::defect
    S2["Durable or external store"]:::missing
  end
  subgraph L6["6 Notification"]
    direction LR
    N1["sendDualEmaAlert 1478<br/>safeSendAlert 173"]:::defect
    N2["Telegram command UI 2075-2368"]:::existing
    N3["Desktop toast 329 (dev PC only)"]:::existing
    N4["Alert outbox with retry"]:::missing
  end
  subgraph L7["7 Monitoring"]
    direction LR
    M1["WS heartbeat 2741 · log() 263<br/>/health 3016 · rotateLogs 2995"]:::defect
    M2["Metrics + stale-feed alarm"]:::missing
  end
  subgraph L8["8 Build and deploy"]
    direction LR
    D1a["Dockerfile · fly.toml · render.yaml<br/>railway.json · Procfile · PM2"]:::defect
    D2a["CI, tests, image scan"]:::missing
  end
  L1 --> L2
  L2 --> L3
  L3 --> L4
  L4 --> L6
  L4 <--> L5
  L7 -.-> L2
  L7 -.-> L6
  L8 -.-> L1

  classDef existing fill:#dfe7f1,stroke:#4a6684,color:#14202e;
  classDef defect fill:#fbe3df,stroke:#c0392b,stroke-width:2px,color:#3b0d08;
  classDef missing fill:#f1f1f1,stroke:#7d7d7d,stroke-dasharray:5 4,color:#2c2c2c;
  classDef proposed fill:#dff3e6,stroke:#1e7f4f,stroke-width:2px,stroke-dasharray:6 3,color:#0d2e1c;
  classDef ext fill:#efe9dc,stroke:#8a7a52,color:#2b2412;
  classDef trigger fill:#fff4d6,stroke:#b58105,color:#3a2a00;
```

### Sequence: candle to Telegram, as built

The REST poll lands inside the candle, consumes the crossover with a sub-margin spread, and the later WebSocket step has nothing left to detect. Reproduced on real candles (see Evidence).

```mermaid
sequenceDiagram
  autonumber
  participant BW as Bybit WS
  participant POLL as checkEMACross timer
  participant REST as Bybit REST
  participant C as Candle and EMA cache
  participant PCC as processClosedCandle
  participant G as shouldAlert
  participant TG as Telegram
  Note over POLL,REST: every 5 min, at any point inside the candle
  POLL->>REST: GET kline limit 115
  REST-->>POLL: 115 rows, newest row is the forming candle
  POLL->>C: overwrite caches, forming candle included
  POLL->>G: crossover from last closed to partial value
  Note over G: spread under 0.03 percent, side recorded silently, no alert (I2)
  Note over BW,PCC: candle closes
  BW->>PCC: kline push, confirm true
  PCC->>C: append row with the same start time, EMA stepped a second time (I1)
  PCC->>G: crossover from partial to double-stepped value
  alt straddle still present and spread over 0.03 percent
    G->>G: save state and cooldown BEFORE sending (I3)
    G->>REST: 24h stats, 1.2 s limiter slot (I9)
    G->>REST: OI delta, 1.2 s limiter slot (I9)
    G->>TG: sendMessage
    alt Telegram failed 5 times in a row
      TG--xG: breaker open, later alerts return silently and are lost (I3)
    end
  else poll already consumed the straddle
    Note over G: real signal is never sent (I1, I2)
  end
```

### Deployment view, as configured

The logs show the bot actually ran on a Windows PC under PM2. The container and platform files exist in the repo; whether any platform is live was not verified.

```mermaid
flowchart LR
  subgraph PC["Developer PC, Windows (source of the Aug 2026 logs)"]
    direction TB
    PM2["PM2 · ecosystem.config.js<br/>23 starts in 8 days"]:::existing
    TOAST["SnoreToast desktop alerts"]:::existing
  end
  subgraph IMG["Container image (Dockerfile)"]
    direction TB
    NODE["node:18-alpine (end of life), root user<br/>COPY . . and no .dockerignore · I6"]:::defect
    BAKED["alert_state.json + settings.json<br/>baked in from git · I7"]:::defect
    HC["HEALTHCHECK prints ok · I6"]:::defect
  end
  subgraph TARGETS["Platform files in the repo"]
    direction TB
    FLY["fly.toml · Singapore · 256 MB<br/>no volume, no checks · I12"]:::defect
    REN["render.yaml · background worker · I12"]:::defect
    RAIL["railway.json · Procfile"]:::existing
  end
  ENV["Environment variables<br/>bot token + chat id; other defaults<br/>are overridden by settings.json"]:::existing
  VOL[("Persistent volume or external store")]:::missing
  CI["CI: tests, npm audit, image scan"]:::missing
  BYB["Bybit REST + WebSocket"]:::ext
  TGA["Telegram Bot API"]:::ext
  PM2 -->|"outbound only"| BYB
  PM2 -->|"long-poll + send"| TGA
  PM2 --> TOAST
  IMG --> FLY
  IMG --> REN
  IMG --> RAIL
  ENV --> IMG
  FLY -->|"outbound only"| BYB
  FLY -->|"long-poll + send"| TGA
  FLY -.->|"state lost on restart"| BAKED
  VOL -.-> BAKED
  CI -.-> IMG

  classDef existing fill:#dfe7f1,stroke:#4a6684,color:#14202e;
  classDef defect fill:#fbe3df,stroke:#c0392b,stroke-width:2px,color:#3b0d08;
  classDef missing fill:#f1f1f1,stroke:#7d7d7d,stroke-dasharray:5 4,color:#2c2c2c;
  classDef proposed fill:#dff3e6,stroke:#1e7f4f,stroke-width:2px,stroke-dasharray:6 3,color:#0d2e1c;
  classDef ext fill:#efe9dc,stroke:#8a7a52,color:#2b2412;
  classDef trigger fill:#fff4d6,stroke:#b58105,color:#3a2a00;
```

### Failure handling: what exists and what is missing

Blue boxes are handled today, red boxes are handled in a way that loses data, grey dashed boxes are missing.

```mermaid
flowchart LR
  F1(["WebSocket drops or stalls"]):::trigger
  F2(["REST error, 429 or 403"]):::trigger
  F3(["Telegram send fails"]):::trigger
  F4(["Process restarts or redeploys"]):::trigger
  F5(["Second instance, same bot token"]):::trigger

  F1 --> A1["close and error handlers<br/>backoff 5 s x 2^n, 5 tries"]:::existing
  A1 --> A2["heartbeat every 60 s<br/>reconnects a CLOSED socket"]:::existing
  A2 --> A3["5-min timer retries<br/>pools that gave up"]:::existing
  A2 -->|"timers can overlap"| X1["two sockets for one pool<br/>duplicate candles · I8"]:::defect
  F1 -.-> M1["pong watchdog for silent stalls"]:::missing
  A3 -.-> M2["backfill candles missed while down"]:::missing

  F2 --> B1["try/catch, log, return empty list"]:::existing
  B1 --> B2["429: sleep 2 min inside getFuturesPairs"]:::existing
  F2 -.-> M3["403 IP ban: stop all calls for 10+ min"]:::missing

  F3 --> C1["retry once as plain text"]:::existing
  C1 --> C2["5 failures: breaker mutes sends for 5 min"]:::defect
  C2 --> C3["alerts in that window are lost · I3"]:::defect
  F3 -.-> M4["outbox with retry and retry_after"]:::missing

  F4 --> D1["SIGTERM: flush state, post shutdown note"]:::existing
  D1 --> D2["state restored only if the disk survived · I7"]:::defect
  F4 -.-> M5["durable store + catch-up scan of missed closes"]:::missing

  F5 --> E1["409 logged, nothing else<br/>both instances send alerts · I13"]:::defect
  F5 -.-> M6["single-instance lock"]:::missing

  classDef existing fill:#dfe7f1,stroke:#4a6684,color:#14202e;
  classDef defect fill:#fbe3df,stroke:#c0392b,stroke-width:2px,color:#3b0d08;
  classDef missing fill:#f1f1f1,stroke:#7d7d7d,stroke-dasharray:5 4,color:#2c2c2c;
  classDef proposed fill:#dff3e6,stroke:#1e7f4f,stroke-width:2px,stroke-dasharray:6 3,color:#0d2e1c;
  classDef ext fill:#efe9dc,stroke:#8a7a52,color:#2b2412;
  classDef trigger fill:#fff4d6,stroke:#b58105,color:#3a2a00;
```

### Proposed architecture

Same Telegram UI, same EMA function, one candle writer. The runner is a thin shell, so the same core runs as an always-on process or as a scheduled job. Green dashed boxes are proposed, blue boxes are reused from today.

```mermaid
flowchart LR
  subgraph RUN["Runner, pick one"]
    direction TB
    R1["Always-on Node process<br/>timer aligned to candle close"]:::proposed
    R2["Scheduled job<br/>GitHub Actions or Cloudflare Cron"]:::proposed
  end
  CFG["Config schema + validation<br/>fails fast on bad env"]:::proposed
  MD["Market data adapter<br/>REST klines, closed candles only"]:::proposed
  CORE["Signal core, pure functions<br/>calculateEMA reused<br/>hysteresis side machine"]:::proposed
  ST[("State store<br/>atomic JSON file, or KV, or git branch")]:::proposed
  OB["Alert outbox<br/>idempotent key, retry, retry_after"]:::proposed
  SND["Telegram sender"]:::existing
  CMD["Telegram command UI<br/>existing code, optional in job mode"]:::existing
  WD["Watchdog<br/>age of last good cycle<br/>on /health and as an alert"]:::proposed
  BY["Bybit REST"]:::ext
  TGA["Telegram Bot API"]:::ext
  WS["WebSocket feed<br/>optional later, only for sub-minute latency"]:::missing
  CFG --> RUN
  RUN --> MD
  MD -->|"GET kline"| BY
  MD --> CORE
  CORE <--> ST
  CORE --> OB
  OB <--> ST
  OB --> SND
  SND --> TGA
  TGA <--> CMD
  CMD --> CFG
  RUN --> WD
  WD -.->|"stale feed alert"| OB
  WS -.-> MD

  classDef existing fill:#dfe7f1,stroke:#4a6684,color:#14202e;
  classDef defect fill:#fbe3df,stroke:#c0392b,stroke-width:2px,color:#3b0d08;
  classDef missing fill:#f1f1f1,stroke:#7d7d7d,stroke-dasharray:5 4,color:#2c2c2c;
  classDef proposed fill:#dff3e6,stroke:#1e7f4f,stroke-width:2px,stroke-dasharray:6 3,color:#0d2e1c;
  classDef ext fill:#efe9dc,stroke:#8a7a52,color:#2b2412;
  classDef trigger fill:#fff4d6,stroke:#b58105,color:#3a2a00;
```

### Sequence: candle to Telegram, proposed

One writer, closed candles only, stateless EMA recompute, and an idempotent outbox. Nothing is marked as sent until Telegram accepts it.

```mermaid
sequenceDiagram
  autonumber
  participant CLK as Candle clock
  participant MD as Market data adapter
  participant CORE as Signal core
  participant ST as State store
  participant OB as Alert outbox
  participant TG as Telegram
  CLK->>MD: 2 s after each 5m and 15m boundary, fetch last 200 candles per symbol
  MD-->>CORE: closed candles only, drop rows where start + interval is after now
  CORE->>CORE: recompute EMA 9 and 15 from the series
  CORE->>ST: read last confirmed side per symbol and timeframe
  CORE->>CORE: hysteresis rule decides flip or hold
  CORE->>OB: enqueue alert, key = symbol + tf + closeTs + direction
  OB->>ST: insert atomically, duplicate keys are ignored
  OB->>TG: send with backoff, honor retry_after
  TG-->>OB: accepted
  OB->>ST: mark delivered and store new side
  Note over CLK,TG: a missed cycle is repaired on the next one because EMAs are recomputed from history
```

## Current versus proposed

| Area | Current | Proposed | Benefit | Trade-off | Effort | Priority |
| --- | --- | --- | --- | --- | --- | --- |
| Candle intake | REST poll and WebSocket both write the cache, forming candle included | One writer, closed candles only, dedupe by start time | Alerts match the closed-candle rule (160 of 160 in replay) | Small patch now, cleaner rewrite later | S | Fix Now |
| Crossover rule | One-shot margin gate on the crossing candle | Hysteresis on a persisted side | Valid crossovers are delayed one candle instead of discarded | You choose how strict the margin is | S | Fix Now |
| Alert delivery | State saved before send, breaker drops silently | Outbox with idempotent key and retry | No silent loss and no duplicates | One more component, needs durable state | M | Fix Now |
| Runtime and image | Node 18, root, no .dockerignore, no-op healthcheck | LTS Node, non-root, .dockerignore, real healthcheck | Closes known security and hygiene gaps | None of note | S | Fix Now |
| Data source | WebSocket pool, heartbeat and REST backup | REST klines after each candle close, EMAs recomputed from the series; WebSocket optional later | Removes the reconnect, gap and duplicate-socket classes and runs as a scheduled job too | Alerts arrive seconds after the close, not sub-second. 16 to 68 requests per 5 minutes against a 600 per 5 s limit | M | Improve Next |
| State | JSON beside the code, tracked in git, in-place writes | Atomic write, outside git, volume or KV on cloud | Survives restarts and redeploys | An extra service on some hosts | S to M | Improve Next |
| Liveness | readyState check, /health always ok | Age of the last good cycle on /health and as an alert | Silent stalls become visible | Small | S | Improve Next |
| Latency | Two serialized 1.2 s calls before every alert | Send first, enrich after, cache tickers, token bucket | Removes the 2.4 s floor per alert | Alert text may arrive without 24h stats | S | Improve Next |
| Configuration | Env parsed with \|\| defaults, settings.json overrides silently | Schema validated at startup, one documented precedence | Fewer surprises across hosts | Small | S | Improve Next |
| Code structure | One 3,152-line file with ML and toasts | Modules: config, exchange, signal, notify, state | Testable core | Needs a few days of refactoring | M to L | Future Enhancement |

## Hosting under $0 and no card

| Option | $0 | No card | Continuous worker | Durable state | What the docs say |
| --- | --- | --- | --- | --- | --- |
| Fly.io | No | Trial only | Yes | Volumes, $0.15 per GB-month | "New organizations don't have a free tier." The trial lasts up to 2 hours of Machine runtime or 7 days and needs no card to start; a card is required after. shared-cpu-1x 256 MB costs $2.19 a month (iad). |
| Render | Web services only | Not stated | Not for workers. Free web services spin down after 15 minutes without inbound traffic | No, filesystem is ephemeral | Background Workers are not a free instance type. 750 free hours per month per workspace. |
| Railway | Trial, then $1 a month credit | Not stated | Only while credit lasts | Trial volumes deleted 30 days after credits expire | One-time $5 for 30 days; limited trial accounts have restricted outbound network access. RAM is $10 per GB-month, so a process holding 100 MB (assumed, not measured) uses the whole $1 credit on RAM alone. |
| GitHub Actions, scheduled | Yes, public repo | A GitHub account (no card mentioned in the pages read) | No | Via repo, cache or artifact | Shortest interval 5 minutes; "can be delayed during periods of high loads" and queued jobs may be dropped. Disabled after 60 days without repository activity in a public repo. 6 hours per job. |
| Cloudflare Workers Cron + KV | Yes, Free plan | Not stated on the limits page | No, cron-driven | KV: 1,000 writes and 100,000 reads per day | Free plan: 10 ms CPU per cron invocation, 50 subrequests per invocation, 5 cron triggers. The larger pair universe (68 kline calls) must be split across invocations. |
| Oracle Cloud Always Free | Reported yes | No, per your README | Yes | Yes | Oracle's page returned HTTP 403, so this is unverified. Your README says a card is needed for verification. |
| A machine you control | Yes | Yes | While powered and online | Local disk | Your August logs show Telegram DNS failures lasting up to 2 h 38 min (13 Aug) and 23 starts in 8 days. |

## Evidence

Replay of real Bybit candles (8 pairs, 999 closed candles each, fetched 18 Oct 2026) through the bot's own functions with mocked I/O.

| Run | Setup | Expected | Correct | Missed | Extra |
| --- | --- | --- | --- | --- | --- |
| A | WebSocket only (control, closed candles) | 160 | 160 | 0 | 0 |
| B | As built, poll at 50% of a 5m candle and 20/53/87% of a 15m candle | 160 | 22 | 138 | 64 |
| C | As built, poll near candle open (5%) | 160 | 42 | 118 | 67 |
| D | As built, poll near candle close (95%) | 160 | 38 | 122 | 56 |
| F | WebSocket only with the 15-minute cooldown from fly.toml | 160 | 159 | 1 | 0 |

| Test | Result |
| --- | --- |
| Margin gate | 749 raw EMA 9/15 crossovers on closed candles, 160 pass the 0.03% margin, 589 dropped (78.6%), 201 of the dropped were above the margin one candle later |
| formatVolume after a failed stats call | TypeError: volume.toFixed is not a function (also in the August logs) |
| Circuit breaker | Calls 1 to 5 throw, calls 6 and 7 return undefined, no Telegram request is made |
| fetchInChunks with 40 running promises | All 40 started within 1 ms; 471 ms of artificial waiting |
| Same candle delivered twice | 1 duplicate row, EMA 9 +0.18 bps, EMA 15 +0.21 bps (BTCUSDT 5m) |
| Cooldown | 0 cooldown skips at the 60 s default, 1 skip at 900 s across 160 expected alerts |

| Mode | Candles fetched | Seed error left | Median gap bps | 95th pct bps | Max bps | Side differs |
| --- | --- | --- | --- | --- | --- | --- |
| EMA 50 | 150 | 1.8% | 0.29 | 2.52 | 8.83 | 0.13% |
| EMA 100 | 200 | 13.5% | 3.4 | 29.45 | 70.91 | 1.81% |
| EMA 200 | 300 | 36.8% | 10.92 | 91.76 | 216.09 | 4.84% |

## Not verified

- Whether any cloud deployment is live. Only the platform files exist in the repo.
- Whether the old token is still valid. I deliberately did not test it.
- Single-EMA mode under replay. It has the same structure, but only EMA 9/15 mode was replayed.
- Real intrabar prices. The replay assumes the partial close sits on a straight line from open to close.
- The double-socket race in I8. It is reasoned from the code, not reproduced.
- A Docker build, and CPU or memory use. No benchmark was run.
- Oracle's terms (page blocked) and real-world cron delays on GitHub Actions or Cloudflare.

## Sources

- [Bybit WebSocket connect](https://bybit-exchange.github.io/docs/v5/ws/connect)
- [Bybit rate limits](https://bybit-exchange.github.io/docs/v5/rate-limit)
- [Fly.io pricing](https://docs.fly.io/about/pricing)
- [Render free instances](https://render.com/docs/free)
- [Railway free trial](https://docs.railway.com/reference/pricing/free-trial)
- [Railway plans and usage pricing](https://docs.railway.com/reference/pricing/plans)
- [GitHub Actions schedule event](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows)
- [GitHub Actions limits](https://docs.github.com/en/actions/reference/limits)
- [GitHub Actions billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions)
- [Cloudflare Workers limits](https://developers.cloudflare.com/workers/platform/limits/)
- [Cloudflare KV limits](https://developers.cloudflare.com/kv/platform/limits/)
- [Telegram Bot FAQ](https://core.telegram.org/bots/faq)
- [Node.js releases](https://nodejs.org/en/about/previous-releases)
