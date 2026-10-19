// Local live test of the v2 signal engine (S1) and Delta connector (S2).
// Logs every alert v2 WOULD send (CONFIRMED, REALTIME, CANCELLED, NOT-CONFIRMED) to logs/shadow-run-<date>.jsonl.
// It sends nothing to Telegram and stores nothing durable; it is a test tool, not the production runner.
// Run: node scripts/shadow-run.ts --timeframes=5m,15m --margin=0.05 --min-volume=10000000 --minutes=0
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { SYSTEM, TIMEFRAME_MS, isTimeframe, type Timeframe } from '../core/config/settings.ts';
import { closedSeries } from '../core/domain/candles.ts';
import { closeOutcome, evaluateConfirmed, evaluateRealtime, newRealtimeCandle, type RealtimeCandle, type SignalState } from '../core/domain/signal.ts';
import { alertId } from '../core/domain/ids.ts';
import { DeltaClient } from '../core/exchange/delta.ts';
import { parseFeedMessage, subscribeMessage } from '../core/exchange/delta-feed.ts';

const arg = (name: string, fallback: string): string => process.argv.find(a => a.startsWith(`--${name}=`))?.split('=')[1] ?? fallback;
const timeframes = arg('timeframes', '15m').split(',').filter(isTimeframe) as Timeframe[];
const marginPct = Number(arg('margin', '0.05'));
const minVolume = Number(arg('min-volume', '10000000'));
const runMinutes = Number(arg('minutes', '0'));
if (!timeframes.length || !Number.isFinite(marginPct) || !Number.isFinite(minVolume)) throw new Error('bad arguments');

const PAIR = { fast: SYSTEM.signal.emaFast, slow: SYSTEM.signal.emaSlow };
const LOG_DIR = join(import.meta.dirname, '..', 'logs');
mkdirSync(LOG_DIR, { recursive: true });
const LOG = join(LOG_DIR, `shadow-run-${new Date().toISOString().slice(0, 10)}.jsonl`);
const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

const client = new DeltaClient((url, init) => fetch(url, init));
let offsetMs = 0; // Delta server clock minus local clock (the PC clock was ~10 s slow when measured)
const serverNow = (): number => Date.now() + offsetMs;
const iso = (ms: number): string => new Date(ms).toISOString();
const counts = { confirmed: 0, realtime: 0, cancelled: 0, notConfirmed: 0, fetchErrors: 0, rejected: 0, feedOpens: 0, tickers: 0 };

function log(event: Record<string, unknown>): void {
  const line = JSON.stringify({ at: iso(serverNow()), ...event });
  appendFileSync(LOG, line + '\n');
  console.log(line);
}

interface Series {
  symbol: string;
  tf: Timeframe;
  state: SignalState | null;
  rt: RealtimeCandle | null;
}
const series = new Map<string, Series>();

const MAX_ATTEMPTS = 3;

async function refresh(s: Series, requested: number, attempt = 1): Promise<void> {
  const interval = TIMEFRAME_MS[s.tf];
  const count = s.state ? requested : SYSTEM.signal.rebuildHistory; // no prior state: baseline from full history
  const retry = async (waitMs: number): Promise<void> => {
    await sleep(waitMs);
    return refresh(s, requested, attempt + 1);
  };
  const r = await client.candles(s.symbol, s.tf, count, serverNow());
  if (!r.ok) {
    if (attempt < MAX_ATTEMPTS) return retry(r.error.kind === 'rate-limited' ? Math.min(r.error.retryAfterMs, 30_000) : 3000);
    counts.fetchErrors++;
    log({ kind: 'fetch-error', symbol: s.symbol, tf: s.tf, error: r.error, attempts: attempt });
    return;
  }
  if (r.serverClock) offsetMs = r.serverNow - Date.now();
  const check = closedSeries(r.value, interval, r.serverNow, SYSTEM.signal.emaSlow);
  if (!check.ok) {
    if ((check.problem === 'stale' || check.problem === 'empty') && attempt < MAX_ATTEMPTS) return retry(2000);
    counts.rejected++;
    log({ kind: 'series-rejected', symbol: s.symbol, tf: s.tf, problem: check.problem, detail: check.detail });
    return;
  }
  if (check.dropped) log({ kind: 'candles-dropped', symbol: s.symbol, tf: s.tf, dropped: check.dropped });
  const prior = s.state;
  const res = evaluateConfirmed(check.candles, PAIR, marginPct, prior, prior ? prior.lastCloseStart : Number.POSITIVE_INFINITY);
  // A rebuild is only settled on long history; refetch it once, unless the exchange has no more (young listing).
  if (res.status === 'rebuilt' && prior && count < SYSTEM.signal.rebuildHistory && r.value.length >= count) {
    s.state = null;
    return refresh(s, requested, attempt);
  }
  if (!res.state || res.status === 'no-new-candle' || res.status === 'too-short') return;

  for (const c of res.crosses) {
    const rt = s.rt && s.rt.candleStart === c.candleStart ? s.rt : null;
    counts.confirmed++;
    log({
      kind: 'CONFIRMED', id: await alertId({ kind: 'confirmed', symbol: s.symbol, timeframe: s.tf, candleStart: c.candleStart, direction: c.direction }),
      symbol: s.symbol, tf: s.tf, direction: c.direction, candleClose: iso(c.candleStart + interval), close: c.close,
      spreadPct: +c.spreadPct.toFixed(4), outcome: closeOutcome(c.candleStart, rt, c), sentAfterCloseSec: +((serverNow() - c.candleStart - interval) / 1000).toFixed(1)
    });
  }
  const closedRt = s.rt;
  if (closedRt?.alerted && closedRt.candleStart <= res.state.lastCloseStart && !res.crosses.some(c => c.candleStart === closedRt.candleStart)) {
    if (closeOutcome(closedRt.candleStart, closedRt, null) === 'realtime-not-confirmed') {
      counts.notConfirmed++;
      log({ kind: 'NOT-CONFIRMED', symbol: s.symbol, tf: s.tf, direction: closedRt.alerted, candleClose: iso(closedRt.candleStart + interval) });
    }
  }
  if (!prior) log({ kind: 'baseline', symbol: s.symbol, tf: s.tf, side: res.state.side, lastClose: iso(res.state.lastCloseStart + interval), candles: check.candles.length });
  s.state = res.state;
  s.rt = newRealtimeCandle(res.state.lastCloseStart + interval);
}

async function refreshAll(list: Series[], count: number): Promise<void> {
  for (let i = 0; i < list.length; i += 6) await Promise.all(list.slice(i, i + 6).map(s => refresh(s, count)));
}

function onTicker(symbol: string, price: number, tickMs: number): void {
  counts.tickers++;
  for (const tf of timeframes) {
    const s = series.get(`${symbol}|${tf}`);
    if (!s?.state || !s.rt) continue;
    const interval = TIMEFRAME_MS[tf];
    if (Math.floor(tickMs / interval) * interval !== s.rt.candleStart) continue; // tick belongs to another candle; wait for the confirmed refresh
    const { action, candle } = evaluateRealtime(s.state, s.rt, interval, price, PAIR, marginPct);
    s.rt = candle;
    if (action.kind === 'alert') {
      counts.realtime++;
      log({ kind: 'REALTIME', symbol, tf, direction: action.direction, price, spreadPct: +action.spreadPct.toFixed(4), candleCloses: iso(candle.candleStart + interval) });
    } else if (action.kind === 'cancel') {
      counts.cancelled++;
      log({ kind: 'CANCELLED', symbol, tf, direction: action.direction, price, spreadPct: +action.spreadPct.toFixed(4), candleCloses: iso(candle.candleStart + interval) });
    }
  }
}

function startFeed(symbols: string[]): void {
  let lastMsg = Date.now();
  let ws: WebSocket | null = null;
  let failures = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  const scheduleReconnect = (): void => {
    if (reconnectTimer) return;
    const delay = Math.min(2000 * 2 ** failures, 60_000);
    failures++;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, delay);
  };
  const connect = (): void => {
    const socket = new WebSocket(SYSTEM.exchange.wsUrl);
    ws = socket;
    lastMsg = Date.now();
    socket.onopen = () => {
      if (ws !== socket) return;
      failures = 0;
      counts.feedOpens++;
      lastMsg = Date.now();
      socket.send(subscribeMessage(symbols));
      log({ kind: 'feed-open', symbols: symbols.length });
    };
    socket.onmessage = e => {
      if (ws !== socket) return;
      lastMsg = Date.now();
      const ev = parseFeedMessage(String(e.data));
      if (ev.type === 'ticker') onTicker(ev.symbol, ev.price, ev.timestampMs);
      else if (ev.type === 'error') log({ kind: 'feed-error', message: ev.message });
    };
    socket.onclose = e => {
      if (ws !== socket) return; // an abandoned socket finally closing
      log({ kind: 'feed-closed', code: e.code });
      ws = null;
      scheduleReconnect();
    };
  };
  connect();
  setInterval(() => {
    if (ws && Date.now() - lastMsg > SYSTEM.realtime.feedStaleSeconds * 1000) {
      log({ kind: 'feed-stale', silentSec: Math.round((Date.now() - lastMsg) / 1000) });
      const dead = ws;
      ws = null; // abandon it now: close() on a dead socket may never fire onclose
      try {
        dead.close();
      } catch {
        // already closing
      }
      scheduleReconnect();
    }
  }, 5000);
}

function summary(): void {
  log({ kind: 'summary', timeframes, marginPct, coins: new Set([...series.values()].map(s => s.symbol)).size, ...counts });
}

// Start: pick coins, record a baseline (no alerts for history), open the live feed, then work at each boundary.
const tk = await client.tickers();
if (!tk.ok) throw new Error(`tickers failed: ${JSON.stringify(tk.error)}`);
offsetMs = tk.serverNow - Date.now();
const coins = tk.value.tickers
  .filter(t => t.turnoverUsd24h > minVolume && t.tradingStatus === 'operational')
  .sort((a, b) => b.turnoverUsd24h - a.turnoverUsd24h)
  .slice(0, SYSTEM.coins.maxWatchlistCoins)
  .map(t => t.symbol);
log({ kind: 'start', coins, timeframes, marginPct, clockOffsetMs: offsetMs, log: LOG });
for (const symbol of coins) for (const tf of timeframes) series.set(`${symbol}|${tf}`, { symbol, tf, state: null, rt: null });
await refreshAll([...series.values()], SYSTEM.signal.rebuildHistory);
startFeed(coins);
process.on('SIGINT', () => { summary(); process.exit(0); });
process.on('SIGTERM', () => { summary(); process.exit(0); });

const stopAt = runMinutes > 0 ? Date.now() + runMinutes * 60_000 : Number.POSITIVE_INFINITY;
let summaryAt = Date.now() + 15 * 60_000;
while (Date.now() < stopAt) {
  const boundary = Math.floor(serverNow() / 60_000) * 60_000 + 60_000;
  await sleep(Math.max(0, boundary + SYSTEM.timing.settleSeconds * 1000 - serverNow()));
  const due = [...series.values()].filter(s => boundary % TIMEFRAME_MS[s.tf] === 0);
  if (due.length) await refreshAll(due, SYSTEM.signal.candleHistory);
  if (Date.now() >= summaryAt) {
    summary();
    summaryAt += 15 * 60_000;
  }
}
summary();
process.exit(0);
