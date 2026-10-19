// Closed-candle guard (fix for audit finding I1). Exchanges return the still-forming candle with the finished ones;
// only candles the exchange has closed may reach the confirmed rule, and the series must be complete and current.

export interface Candle {
  /** Candle open time, epoch milliseconds. */
  start: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export type SeriesProblem = 'empty' | 'invalid' | 'gap' | 'stale';
export type SeriesCheck = { ok: true; candles: Candle[] } | { ok: false; problem: SeriesProblem; detail: string };

const finitePositive = (n: number): boolean => Number.isFinite(n) && n > 0;

/** Start of the most recent candle that has closed at `nowMs`. */
export function lastClosedStart(nowMs: number, intervalMs: number): number {
  return Math.floor(nowMs / intervalMs) * intervalMs - intervalMs;
}

/**
 * Keeps candles with start + interval <= nowMs (nowMs must be exchange or trusted server time), sorts them ascending,
 * and rejects the series if a price is invalid, a start repeats or is off-grid, a candle is missing in between,
 * or the newest closed candle is not the one that just closed (the exchange has not published it yet).
 */
export function closedSeries(rows: readonly Candle[], intervalMs: number, nowMs: number): SeriesCheck {
  const closed = rows.filter(c => c.start + intervalMs <= nowMs).sort((a, b) => a.start - b.start);
  if (!closed.length) return { ok: false, problem: 'empty', detail: 'no closed candles in response' };
  for (const c of closed) {
    if (c.start % intervalMs !== 0) return { ok: false, problem: 'invalid', detail: `candle ${c.start} is not on the ${intervalMs} ms grid` };
    if (![c.open, c.high, c.low, c.close].every(finitePositive) || !(Number.isFinite(c.volume) && c.volume >= 0)) {
      return { ok: false, problem: 'invalid', detail: `candle ${new Date(c.start).toISOString()} has a non-positive or non-numeric value` };
    }
  }
  for (let i = 1; i < closed.length; i++) {
    const step = closed[i]!.start - closed[i - 1]!.start;
    if (step === 0) return { ok: false, problem: 'invalid', detail: `duplicate candle ${new Date(closed[i]!.start).toISOString()}` };
    if (step !== intervalMs) return { ok: false, problem: 'gap', detail: `missing candles after ${new Date(closed[i - 1]!.start).toISOString()}` };
  }
  const expected = lastClosedStart(nowMs, intervalMs);
  const newest = closed[closed.length - 1]!.start;
  if (newest !== expected) {
    return { ok: false, problem: 'stale', detail: `newest closed candle is ${new Date(newest).toISOString()}, expected ${new Date(expected).toISOString()}` };
  }
  return { ok: true, candles: closed };
}
