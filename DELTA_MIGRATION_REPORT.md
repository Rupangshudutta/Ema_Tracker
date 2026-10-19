# Delta-Only Migration Report

## What Was Changed
- Migrated market-data REST calls from Bybit to Delta India:
  - `GET /v2/tickers`
  - `GET /v2/tickers/{symbol}`
  - `GET /v2/history/candles`
- Migrated WebSocket from legacy Bybit stream to Delta public socket:
  - `wss://public-socket.india.delta.exchange`
  - `type: subscribe` + `payload.channels` with `candlestick_<resolution>` + symbols
- Updated top-performer calculations to Delta fields:
  - Change: `ltp_change_24h`
  - Volume: `turnover_usd` fallback `turnover`
  - Price: `close`
- Reworked pair discovery to Delta perpetual futures (`contract_types=perpetual_futures`).
- Reworked OI delta:
  - Uses ticker OI snapshot cache (`oi_value_usd` / fallback fields) to compute delta.
- Updated help/startup text to Delta Exchange wording.
- Updated WS heartbeat app-level ping from `{ op: 'ping' }` to `{ type: 'ping' }`.

## Stability Hardening Included
- Added response-shape guard in top-performer path.
- Added duplicate WS candle guard (`lastWsCandleTs`) per `symbol + timeframe`.
- Preserved existing EMA/crossover/alert engine logic; only data provider side changed.

## Validation Run (Live)
- Syntax check: `node --check main.js` -> PASS
- Delta top data path probe:
  - tickers count: `188` perpetual futures
  - gainers sample: `IOUSD`, `LABUSD`, `SKYAIUSD`
  - losers sample: `TSTUSD`, `DOGSUSD`, `HIVEUSD`
  - volume sample: `BTCUSD`, `ETHUSD`, `PAXGUSD`
- Delta WebSocket probe:
  - ticker feed: PASS
  - candlestick feed: PASS

## Buttons/Functions Covered
- `Top Gainers` -> data source and sorting validated
- `Top Losers` -> data source and sorting validated
- `Top Volume` -> data source and sorting validated

## Notes Before Production Push
- Your current volume threshold value should match Delta turnover units (USD turnover fields).
- Existing alerts now rely on Delta candles + periodic backup checks.
- If you want stricter reliability, next step is adding a `/diag` command to post:
  - active WS channels
  - last candle timestamp by timeframe
  - latest top data fetch health
