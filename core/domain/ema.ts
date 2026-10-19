// Exponential moving average, the same recurrence as main.js calculateEMA (which matched all 160 expected
// events in the audit's control replay): seeded with the simple average of the first `period` values.

function assertPeriod(period: number): void {
  if (!Number.isInteger(period) || period < 1) throw new RangeError(`EMA period must be a positive integer, got ${period}`);
}

/** EMA of `values`. Element i of the result is the EMA at input index i + period - 1; empty if there are too few values. */
export function emaSeries(values: readonly number[], period: number): number[] {
  assertPeriod(period);
  if (values.length < period) return [];
  const k = 2 / (period + 1);
  let ema = 0;
  for (let i = 0; i < period; i++) ema += values[i]!;
  ema /= period;
  const out = [ema];
  for (let i = period; i < values.length; i++) {
    ema = (values[i]! - ema) * k + ema;
    out.push(ema);
  }
  return out;
}

/** One EMA step: the value after `previous` when `value` arrives. Used for realtime estimates from the live price. */
export function emaStep(previous: number, value: number, period: number): number {
  assertPeriod(period);
  return (value - previous) * (2 / (period + 1)) + previous;
}
