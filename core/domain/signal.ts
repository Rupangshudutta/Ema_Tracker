// The two EMA 9/15 rules (fix for audit finding I2).
// CONFIRMED: on closed candles, the side flips only when the gap passes the margin on the other side
//            (hysteresis), so a cross that starts under the margin is confirmed later instead of discarded.
// REALTIME:  while a candle is open, the live price is treated as its close; one alert per candle, with a
//            cancel when EMA 9 goes back across EMA 15 before the close.
import { emaSeries, emaStep } from './ema.ts';
import type { Candle } from './candles.ts';

export type Side = 'above' | 'below';
export type Direction = 'up' | 'down';

export interface EmaPair {
  fast: number;
  slow: number;
}

/** What is remembered per coin and timeframe after each closed candle. */
export interface SignalState {
  /** Confirmed side, or null until the gap has first left the margin band. */
  side: Side | null;
  /** Margin the side was computed with; a different margin makes the side meaningless (it must be rebuilt). */
  marginPct: number;
  /** Start of the last closed candle this state includes, epoch ms. */
  lastCloseStart: number;
  /** EMA values at that candle's close (the base for realtime estimates). */
  emaFast: number;
  emaSlow: number;
}

export interface ConfirmedCross {
  direction: Direction;
  candleStart: number;
  close: number;
  emaFast: number;
  emaSlow: number;
  spreadPct: number;
}

/** Gap between the EMAs as a percentage of the slow EMA. */
export function spreadPct(fast: number, slow: number): number {
  return ((fast - slow) / slow) * 100;
}

/** Hysteresis: change side only when the gap clears the margin on the other side; otherwise keep the previous side. */
export function sideAfter(previous: Side | null, spread: number, marginPct: number): Side | null {
  if (spread > marginPct) return 'above';
  if (spread < -marginPct) return 'below';
  return previous;
}

/**
 * advanced       the side continued from `prior` over newer candles
 * rebuilt        no usable prior (none, outside the series, before the EMA run-in, or a different margin); the side was
 *                rebuilt from this series alone, so callers should pass SYSTEM.signal.rebuildHistory candles when they can
 * no-new-candle  the series holds nothing newer than `prior`; state returned unchanged
 * too-short      fewer candles than the slow EMA period; state returned unchanged
 */
export type ConfirmedStatus = 'advanced' | 'rebuilt' | 'no-new-candle' | 'too-short';

export interface ConfirmedResult {
  crosses: ConfirmedCross[];
  state: SignalState | null;
  status: ConfirmedStatus;
}

const sameMargin = (a: number, b: number): boolean => Math.abs(a - b) < 1e-9;

/**
 * Runs the confirmed rule over closed, ascending, contiguous candles.
 * If `prior` was computed with the same margin and points at a candle inside the series and past the EMA run-in,
 * the side continues from it and only newer candles are evaluated; otherwise the side is rebuilt (status 'rebuilt').
 * Crosses on candles that started at or before `reportAfterStart` are applied to the state but not reported.
 */
export function evaluateConfirmed(
  candles: readonly Candle[],
  periods: EmaPair,
  marginPct: number,
  prior: SignalState | null,
  reportAfterStart: number
): ConfirmedResult {
  const n = candles.length;
  if (n < periods.slow) return { crosses: [], state: prior, status: 'too-short' };
  const last = candles[n - 1]!;
  const priorUsable = prior !== null && sameMargin(prior.marginPct, marginPct);
  if (priorUsable && prior.lastCloseStart >= last.start) return { crosses: [], state: prior, status: 'no-new-candle' };

  const closes = candles.map(c => c.close);
  const fastSeries = emaSeries(closes, periods.fast);
  const slowSeries = emaSeries(closes, periods.slow);
  const fastAt = (i: number): number => fastSeries[i - (periods.fast - 1)]!;
  const slowAt = (i: number): number => slowSeries[i - (periods.slow - 1)]!;

  const firstIndex = periods.slow - 1;
  // EMAs need a run-in before they are accurate (seed error shrinks by (1 - 2/(period+1)) per candle; 6 x period
  // leaves under 0.04% of it for EMA 15). Continue from the prior state only if its candle is past that run-in.
  const warmupIndex = Math.min(periods.slow * 6, n - 1);
  const priorIndex = priorUsable ? candles.findIndex(c => c.start === prior.lastCloseStart) : -1;
  const rebuilt = priorIndex < warmupIndex;
  let side: Side | null = rebuilt ? null : prior!.side;
  const crosses: ConfirmedCross[] = [];

  for (let i = rebuilt ? firstIndex : priorIndex + 1; i < n; i++) {
    const fast = fastAt(i);
    const slow = slowAt(i);
    const spread = spreadPct(fast, slow);
    const next = sideAfter(side, spread, marginPct);
    if (next !== side && side !== null && next !== null && candles[i]!.start > reportAfterStart) {
      crosses.push({ direction: next === 'above' ? 'up' : 'down', candleStart: candles[i]!.start, close: candles[i]!.close, emaFast: fast, emaSlow: slow, spreadPct: spread });
    }
    side = next;
  }
  return {
    crosses,
    state: { side, marginPct, lastCloseStart: last.start, emaFast: fastAt(n - 1), emaSlow: slowAt(n - 1) },
    status: rebuilt ? 'rebuilt' : 'advanced'
  };
}

/** Realtime bookkeeping for the candle that is currently open (one per coin and timeframe). */
export interface RealtimeCandle {
  candleStart: number;
  alerted: Direction | null;
  cancelled: boolean;
}

export type RealtimeAction =
  | { kind: 'none'; reason: 'no-side' | 'stale-state' | 'inside-margin' | 'already-alerted' }
  | { kind: 'alert'; direction: Direction; spreadPct: number; emaFast: number; emaSlow: number }
  | { kind: 'cancel'; direction: Direction; spreadPct: number };

export function newRealtimeCandle(candleStart: number): RealtimeCandle {
  return { candleStart, alerted: null, cancelled: false };
}

/**
 * Evaluates one live price for the open candle. `confirmed` must describe the candle that closed right before
 * `candle.candleStart` and use the current margin; otherwise the estimate would be wrong and nothing is reported.
 */
export function evaluateRealtime(
  confirmed: SignalState,
  candle: RealtimeCandle,
  intervalMs: number,
  price: number,
  periods: EmaPair,
  marginPct: number
): { action: RealtimeAction; candle: RealtimeCandle } {
  if (confirmed.side === null) return { action: { kind: 'none', reason: 'no-side' }, candle };
  if (confirmed.lastCloseStart + intervalMs !== candle.candleStart || !sameMargin(confirmed.marginPct, marginPct)) {
    return { action: { kind: 'none', reason: 'stale-state' }, candle };
  }
  if (!(Number.isFinite(price) && price > 0)) return { action: { kind: 'none', reason: 'inside-margin' }, candle };

  const fast = emaStep(confirmed.emaFast, price, periods.fast);
  const slow = emaStep(confirmed.emaSlow, price, periods.slow);
  const spread = spreadPct(fast, slow);

  if (candle.alerted === null) {
    const direction: Direction | null = confirmed.side === 'below' && spread > marginPct ? 'up' : confirmed.side === 'above' && spread < -marginPct ? 'down' : null;
    if (!direction) return { action: { kind: 'none', reason: 'inside-margin' }, candle };
    return { action: { kind: 'alert', direction, spreadPct: spread, emaFast: fast, emaSlow: slow }, candle: { ...candle, alerted: direction } };
  }
  const reversed = (candle.alerted === 'up' && spread < 0) || (candle.alerted === 'down' && spread > 0);
  if (!candle.cancelled && reversed) {
    return { action: { kind: 'cancel', direction: candle.alerted, spreadPct: spread }, candle: { ...candle, cancelled: true } };
  }
  return { action: { kind: 'none', reason: 'already-alerted' }, candle };
}

export type CloseOutcome = 'confirmed-after-realtime' | 'confirmed-after-cancel' | 'confirmed' | 'realtime-not-confirmed' | 'realtime-cancelled' | 'nothing';

/**
 * What to tell the user when the candle starting at `closedCandleStart` closes, given that candle's realtime history
 * and the confirmed result. Realtime records from any other candle are ignored.
 */
export function closeOutcome(closedCandleStart: number, realtime: RealtimeCandle | null, cross: ConfirmedCross | null): CloseOutcome {
  const rt = realtime && realtime.candleStart === closedCandleStart ? realtime : null;
  const cr = cross && cross.candleStart === closedCandleStart ? cross : null;
  if (cr) {
    if (rt?.alerted !== cr.direction) return 'confirmed';
    return rt.cancelled ? 'confirmed-after-cancel' : 'confirmed-after-realtime';
  }
  if (rt?.alerted) return rt.cancelled ? 'realtime-cancelled' : 'realtime-not-confirmed';
  return 'nothing';
}
