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

export interface ConfirmedResult {
  crosses: ConfirmedCross[];
  state: SignalState | null;
  /** True when no usable prior state existed and the side was rebuilt from this series alone. */
  rebuilt: boolean;
}

/**
 * Runs the confirmed rule over closed, ascending, contiguous candles.
 * If `prior` points at a candle inside the series and past the EMA run-in, the side continues from it and only newer
 * candles are evaluated; otherwise the side is rebuilt from the start of the series and `rebuilt` is true
 * (callers then pass SYSTEM.signal.rebuildHistory candles so the rebuilt side is settled).
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
  if (n < periods.slow) return { crosses: [], state: prior, rebuilt: false };
  const last = candles[n - 1]!;
  if (prior && prior.lastCloseStart >= last.start) return { crosses: [], state: prior, rebuilt: false };

  const closes = candles.map(c => c.close);
  const fastSeries = emaSeries(closes, periods.fast);
  const slowSeries = emaSeries(closes, periods.slow);
  const fastAt = (i: number): number => fastSeries[i - (periods.fast - 1)]!;
  const slowAt = (i: number): number => slowSeries[i - (periods.slow - 1)]!;

  const firstIndex = periods.slow - 1;
  // EMAs need a run-in before they are accurate (seed error shrinks by (1 - 2/(period+1)) per candle; 6 x period
  // leaves under 0.04% of it for EMA 15). Continue from the prior state only if its candle is past that run-in.
  const warmupIndex = Math.min(periods.slow * 6, n - 1);
  const priorIndex = prior ? candles.findIndex(c => c.start === prior.lastCloseStart) : -1;
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
  return { crosses, state: { side, lastCloseStart: last.start, emaFast: fastAt(n - 1), emaSlow: slowAt(n - 1) }, rebuilt };
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
 * `candle.candleStart`; otherwise the estimate would skip candles and nothing is reported.
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
  if (confirmed.lastCloseStart + intervalMs !== candle.candleStart) return { action: { kind: 'none', reason: 'stale-state' }, candle };

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

export type CloseOutcome = 'confirmed-after-realtime' | 'confirmed' | 'realtime-not-confirmed' | 'realtime-cancelled' | 'nothing';

/** What to tell the user when a candle closes, given its realtime history and the confirmed result. */
export function closeOutcome(realtime: RealtimeCandle | null, cross: ConfirmedCross | null): CloseOutcome {
  if (cross) return realtime?.alerted === cross.direction ? 'confirmed-after-realtime' : 'confirmed';
  if (realtime?.alerted) return realtime.cancelled ? 'realtime-cancelled' : 'realtime-not-confirmed';
  return 'nothing';
}
