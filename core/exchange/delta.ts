// Delta Exchange India REST client (public market data, no keys).
// Formats verified against recorded replies in test/fixtures/delta-api:
//   - envelope { success, result }, and an unknown symbol returns success with an empty result (not an error)
//   - candles are newest-first, times in seconds, and include the still-forming candle
//   - ticker numbers arrive as numbers or strings; timestamps in microseconds; ltp_change_24h is already a percent
//   - 429 carries X-RATE-LIMIT-RESET in milliseconds (Delta docs); Delta's CDN rejects requests without a User-Agent
import { SYSTEM, TIMEFRAME_MS, type Timeframe } from '../config/settings.ts';
import type { Candle } from '../domain/candles.ts';

export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;
export type Sleep = (ms: number) => Promise<void>;

export interface DeltaTicker {
  symbol: string;
  lastPrice: number;
  markPrice: number;
  turnoverUsd24h: number;
  change24hPct: number;
  openInterestUsd: number | null;
  tradingStatus: string;
  timestampMs: number;
}

export type DeltaFailure =
  | { kind: 'rate-limited'; retryAfterMs: number }
  | { kind: 'http'; status: number }
  | { kind: 'network'; message: string }
  | { kind: 'timeout' }
  | { kind: 'bad-response'; message: string };

/** serverClock is true when serverNow came from Delta's Date header, false when it fell back to the local clock. */
export type DeltaResult<T> = { ok: true; value: T; serverNow: number; serverClock: boolean } | { ok: false; error: DeltaFailure; attempts: number };

export interface DeltaClientOptions {
  restBase: string;
  userAgent: string;
  requestTimeoutMs: number;
  maxRetries: number;
  contractType: string;
  /** Backoff before retry n (0-based); defaults to 250 ms, 500 ms, 1 s. */
  backoffMs?: (attempt: number) => number;
}

const DEFAULT_RATE_LIMIT_WAIT_MS = 60_000;

/** Coerces Delta's number-or-string fields; NaN when absent or not numeric. */
function num(v: unknown): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && v.trim() !== '') return Number(v);
  return Number.NaN;
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function parseTicker(raw: unknown): DeltaTicker | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const t = raw as Record<string, unknown>;
  const symbol = typeof t.symbol === 'string' ? t.symbol : '';
  const lastPrice = num(t.close);
  const markPrice = num(t.mark_price);
  const turnover = num(t.turnover_usd);
  const change = num(t.ltp_change_24h);
  const oi = num(t.oi_value_usd);
  const ts = num(t.timestamp);
  if (!symbol || !(lastPrice > 0) || !Number.isFinite(turnover) || turnover < 0) return null;
  return {
    symbol,
    lastPrice,
    markPrice: markPrice > 0 ? markPrice : lastPrice,
    turnoverUsd24h: turnover,
    change24hPct: Number.isFinite(change) ? change : 0,
    openInterestUsd: Number.isFinite(oi) ? oi : null,
    tradingStatus: typeof t.product_trading_status === 'string' ? t.product_trading_status : 'unknown',
    timestampMs: Number.isFinite(ts) ? Math.floor(ts / 1000) : 0
  };
}

export class DeltaClient {
  private readonly fetchFn: FetchFn;
  private readonly sleep: Sleep;
  private readonly options: DeltaClientOptions;
  private readonly backoff: (attempt: number) => number;

  constructor(fetchFn: FetchFn, sleep: Sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), options: DeltaClientOptions = SYSTEM.exchange) {
    this.fetchFn = fetchFn;
    this.sleep = sleep;
    this.options = options;
    this.backoff = options.backoffMs ?? (attempt => 250 * 2 ** attempt);
  }

  /** All perpetual tickers (one call, about 290 KB). Rows that fail validation are dropped and counted. */
  async tickers(): Promise<DeltaResult<{ tickers: DeltaTicker[]; rejected: number }>> {
    const r = await this.request(`/v2/tickers?contract_types=${encodeURIComponent(this.options.contractType)}`);
    if (!r.ok) return r;
    const tickers: DeltaTicker[] = [];
    let rejected = 0;
    for (const row of r.value) {
      const t = parseTicker(row);
      if (t) tickers.push(t);
      else rejected++;
    }
    return { ok: true, value: { tickers, rejected }, serverNow: r.serverNow, serverClock: r.serverClock };
  }

  /** Raw candles for one symbol (forming candle included, any order). Apply closedSeries() with `serverNow`. */
  async candles(symbol: string, timeframe: Timeframe, count: number, nowMs: number): Promise<DeltaResult<Candle[]>> {
    const interval = TIMEFRAME_MS[timeframe];
    const end = Math.floor(nowMs / 1000);
    const start = end - Math.ceil(((count + 2) * interval) / 1000);
    const path = `/v2/history/candles?resolution=${timeframe}&symbol=${encodeURIComponent(symbol)}&start=${start}&end=${end}`;
    const r = await this.request(path);
    if (!r.ok) return r;
    const candles: Candle[] = [];
    for (const row of r.value) {
      if (typeof row !== 'object' || row === null) return { ok: false, error: { kind: 'bad-response', message: 'candle row is not an object' }, attempts: 1 };
      const c = row as Record<string, unknown>;
      candles.push({ start: num(c.time) * 1000, open: num(c.open), high: num(c.high), low: num(c.low), close: num(c.close), volume: num(c.volume) });
    }
    return { ok: true, value: candles, serverNow: r.serverNow, serverClock: r.serverClock };
  }

  private async request(path: string): Promise<DeltaResult<unknown[]>> {
    let attempt = 0;
    let lastError: DeltaFailure = { kind: 'network', message: 'no attempt made' };
    while (attempt <= this.options.maxRetries) {
      if (attempt > 0) await this.sleep(this.backoff(attempt - 1));
      attempt++;
      let res: Response;
      try {
        res = await this.fetchFn(this.options.restBase + path, {
          headers: { 'User-Agent': this.options.userAgent, Accept: 'application/json' },
          signal: AbortSignal.timeout(this.options.requestTimeoutMs)
        });
      } catch (err) {
        const name = err instanceof Error ? err.name : '';
        lastError = name === 'TimeoutError' || name === 'AbortError' ? { kind: 'timeout' } : { kind: 'network', message: describe(err) };
        continue;
      }
      if (res.status === 429) {
        const reset = num(res.headers.get('x-rate-limit-reset'));
        return { ok: false, error: { kind: 'rate-limited', retryAfterMs: reset > 0 ? reset : DEFAULT_RATE_LIMIT_WAIT_MS }, attempts: attempt };
      }
      if (res.status >= 500) {
        lastError = { kind: 'http', status: res.status };
        continue;
      }
      if (!res.ok) return { ok: false, error: { kind: 'http', status: res.status }, attempts: attempt };
      // Read the body as text first: a stalled or reset download is a transient network fault (retry), while text
      // that is not JSON, or JSON of the wrong shape, is a real bad response (do not retry).
      let text: string;
      try {
        text = await res.text();
      } catch (err) {
        const name = err instanceof Error ? err.name : '';
        lastError = name === 'TimeoutError' || name === 'AbortError' ? { kind: 'timeout' } : { kind: 'network', message: `body: ${describe(err)}` };
        continue;
      }
      let body: unknown;
      try {
        body = JSON.parse(text);
      } catch {
        return { ok: false, error: { kind: 'bad-response', message: 'reply is not JSON' }, attempts: attempt };
      }
      const envelope = body as { success?: unknown; result?: unknown };
      if (envelope?.success !== true || !Array.isArray(envelope.result)) {
        return { ok: false, error: { kind: 'bad-response', message: 'missing success flag or result list' }, attempts: attempt };
      }
      const date = Date.parse(res.headers.get('date') ?? '');
      const serverClock = Number.isFinite(date);
      return { ok: true, value: envelope.result, serverNow: serverClock ? date : Date.now(), serverClock };
    }
    return { ok: false, error: lastError, attempts: attempt };
  }
}
