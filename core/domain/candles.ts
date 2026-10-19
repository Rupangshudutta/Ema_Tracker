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
export type SeriesCheck = { ok: true; candles: Candle[]; dropped: number } | { ok: false; problem: SeriesProblem; detail: string };

/** The signal only uses start and close, so only those decide whether a candle is usable. */
const usable = (c: Candle, intervalMs: number): boolean => c.start % intervalMs === 0 && Number.isFinite(c.close) && c.close > 0;

/** Start of the most recent candle that has closed at `nowMs`. */
export function lastClosedStart(nowMs: number, intervalMs: number): number {
  return Math.floor(nowMs / intervalMs) * intervalMs - intervalMs;
}

/**
 * Keeps candles with start + interval <= nowMs (nowMs must be exchange or trusted server time) and returns the longest
 * run of contiguous, usable candles that ends at the candle that just closed. Anything older than the first gap,
 * off-grid start, bad close or conflicting duplicate (walking back from the newest) is dropped and counted, so one bad
 * old candle cannot mute a coin. Fails if the just-closed candle is not there yet ('stale'), is itself unusable
 * ('invalid'), or the clean run is shorter than `minCandles` ('gap').
 */
export function closedSeries(rows: readonly Candle[], intervalMs: number, nowMs: number, minCandles = 1): SeriesCheck {
  const closed = rows.filter(c => Number.isFinite(c.start) && c.start + intervalMs <= nowMs).sort((a, b) => a.start - b.start);
  if (!closed.length) return { ok: false, problem: 'empty', detail: 'no closed candles in response' };

  const expected = lastClosedStart(nowMs, intervalMs);
  const newest = closed[closed.length - 1]!;
  if (newest.start !== expected) {
    return { ok: false, problem: 'stale', detail: `newest closed candle is ${new Date(newest.start).toISOString()}, expected ${new Date(expected).toISOString()}` };
  }
  if (!usable(newest, intervalMs)) return { ok: false, problem: 'invalid', detail: `the just-closed candle ${new Date(newest.start).toISOString()} has no usable close` };

  const run: Candle[] = [newest];
  for (let i = closed.length - 2; i >= 0; i--) {
    const c = closed[i]!;
    const earliest = run[run.length - 1]!;
    if (c.start === earliest.start) {
      if (c.close === earliest.close) continue; // identical duplicate row
      run.pop(); // conflicting duplicate: trust neither copy, nor anything older
      break;
    }
    if (earliest.start - c.start !== intervalMs || !usable(c, intervalMs)) break;
    run.push(c);
  }
  run.reverse();
  if (run.length < minCandles) {
    return { ok: false, problem: 'gap', detail: `only ${run.length} clean candles up to ${new Date(newest.start).toISOString()} (need ${minCandles})` };
  }
  return { ok: true, candles: run, dropped: closed.length - run.length };
}
