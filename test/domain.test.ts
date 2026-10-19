import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { emaSeries, emaStep } from '../core/domain/ema.ts';
import { closedSeries, lastClosedStart } from '../core/domain/candles.ts';
import { alertId } from '../core/domain/ids.ts';
import { candlesFrom } from './helpers.ts';

const MIN5 = 5 * 60_000;

describe('ema', () => {
  it('matches the original main.js calculateEMA on a known series', () => {
    // main.js calculateEMA([1..10], 3) ends at 9 (checked against the extracted original during the audit).
    const out = emaSeries([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 3);
    assert.equal(out.length, 8);
    assert.equal(out[0], 2);
    assert.equal(out.at(-1), 9);
  });

  it('emaStep continues a series exactly', () => {
    const values = Array.from({ length: 60 }, (_, i) => 100 + Math.sin(i / 3) * 5);
    const series = emaSeries(values, 15);
    const extended = emaSeries([...values, 107.25], 15);
    assert.ok(Math.abs(emaStep(series.at(-1)!, 107.25, 15) - extended.at(-1)!) < 1e-9);
  });

  it('returns nothing for short input and rejects bad periods', () => {
    assert.deepEqual(emaSeries([1, 2], 3), []);
    assert.throws(() => emaSeries([1, 2, 3], 0), RangeError);
    assert.throws(() => emaStep(1, 2, 1.5), RangeError);
  });
});

describe('closedSeries (audit fix I1)', () => {
  const now = Date.UTC(2026, 9, 19, 10, 5, 3); // 3 s after the 10:05 boundary
  const first = Date.UTC(2026, 9, 19, 9, 0);

  it('drops the forming candle and keeps the one that just closed', () => {
    const rows = candlesFrom(Array.from({ length: 14 }, (_, i) => 100 + i), first, MIN5); // 09:00 .. 10:05 (10:05 is forming)
    const r = closedSeries(rows, MIN5, now);
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.candles.length, 13);
      assert.equal(r.candles.at(-1)!.start, Date.UTC(2026, 9, 19, 10, 0));
    }
  });

  it('sorts newest-first input', () => {
    const rows = candlesFrom(Array.from({ length: 13 }, (_, i) => 100 + i), first, MIN5).reverse();
    const r = closedSeries(rows, MIN5, now);
    assert.equal(r.ok && r.candles[0]!.start, first);
  });

  it('reports stale when the just-closed candle is not published yet', () => {
    const rows = candlesFrom(Array.from({ length: 12 }, (_, i) => 100 + i), first, MIN5); // ends 09:55
    const r = closedSeries(rows, MIN5, now);
    assert.equal(r.ok ? 'ok' : r.problem, 'stale');
  });

  it('keeps the clean recent run after a gap, bad close, off-grid start or conflicting duplicate (review #4)', () => {
    const base = candlesFrom(Array.from({ length: 13 }, (_, i) => 100 + i), first, MIN5); // 09:00 .. 10:00
    const lengthOf = (rows: typeof base, min = 1): number | string => (r => (r.ok ? r.candles.length : r.problem))(closedSeries(rows, MIN5, now, min));
    assert.equal(lengthOf(base.filter((_, i) => i !== 5)), 7); // gap after index 4: keep 6..12
    assert.equal(lengthOf(base.filter((_, i) => i !== 5), 13), 'gap'); // too short for the caller's minimum
    assert.equal(lengthOf(base.map((c, i) => (i === 4 ? { ...c, close: Number.NaN } : c))), 8);
    assert.equal(lengthOf(base.map((c, i) => (i === 2 ? { ...c, start: c.start + 1000 } : c))), 10);
    assert.equal(lengthOf([...base, { ...base[3]!, close: 1 }]), 9); // conflicting duplicate of index 3
    assert.equal(lengthOf([...base, { ...base[3]! }]), 13); // identical duplicate is ignored
  });

  it('ignores bad open, high, low or volume because the signal only uses the close', () => {
    const base = candlesFrom(Array.from({ length: 13 }, (_, i) => 100 + i), first, MIN5);
    const r = closedSeries(base.map((c, i) => (i === 0 ? { ...c, open: Number.NaN, volume: -1 } : c)), MIN5, now);
    assert.equal(r.ok && r.candles.length, 13);
    assert.equal(r.ok && r.dropped, 0);
  });

  it('rejects an empty response and an unusable just-closed candle', () => {
    const base = candlesFrom(Array.from({ length: 13 }, (_, i) => 100 + i), first, MIN5);
    assert.equal((r => (r.ok ? 'ok' : r.problem))(closedSeries([], MIN5, now)), 'empty');
    assert.equal((r => (r.ok ? 'ok' : r.problem))(closedSeries(base.map((c, i) => (i === 12 ? { ...c, close: 0 } : c)), MIN5, now)), 'invalid');
  });

  it('computes the last closed candle for every timeframe on the UTC grid', () => {
    const t = Date.UTC(2026, 9, 19, 9, 0, 3);
    assert.equal(lastClosedStart(t, 4 * 3_600_000), Date.UTC(2026, 9, 19, 4, 0));
    assert.equal(lastClosedStart(t, 3_600_000), Date.UTC(2026, 9, 19, 8, 0));
  });
});

describe('alert ids', () => {
  it('is stable, 16 hex characters, and changes with any field', async () => {
    const key = { kind: 'confirmed', symbol: 'BTCUSD', timeframe: '15m', candleStart: 1_792_400_000_000, direction: 'up' } as const;
    const a = await alertId(key);
    assert.match(a, /^[0-9a-f]{16}$/);
    assert.equal(await alertId({ ...key }), a);
    assert.notEqual(await alertId({ ...key, direction: 'down' }), a);
    assert.notEqual(await alertId({ ...key, kind: 'realtime' }), a);
    assert.notEqual(await alertId({ ...key, timeframe: '5m' }), a);
  });
});
