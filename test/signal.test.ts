import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { closeOutcome, evaluateConfirmed, evaluateRealtime, newRealtimeCandle, sideAfter, spreadPct, type SignalState } from '../core/domain/signal.ts';
import { candlesFrom } from './helpers.ts';

const PAIR = { fast: 9, slow: 15 };
const MIN5 = 5 * 60_000;
const T0 = Date.UTC(2026, 9, 1);

/** Down-trend (side becomes BELOW), then a slow up-turn so EMA 9 crosses above EMA 15 with a widening gap. */
const TURN = [...Array.from({ length: 60 }, (_, i) => 120 - i * 0.2), ...Array.from({ length: 30 }, (_, i) => 108 + i * 0.12)];
/** Oscillating prices: several crosses in each direction. */
const WAVE = Array.from({ length: 260 }, (_, i) => 100 + 2 * Math.sin(i / 8));

describe('sideAfter (hysteresis)', () => {
  it('flips only beyond the margin and holds inside it', () => {
    assert.equal(sideAfter('below', 0.04, 0.05), 'below');
    assert.equal(sideAfter('below', 0.06, 0.05), 'above');
    assert.equal(sideAfter('above', -0.04, 0.05), 'above');
    assert.equal(sideAfter('above', -0.06, 0.05), 'below');
    assert.equal(sideAfter(null, 0.01, 0.05), null);
  });

  it('with margin 0 behaves like a plain crossover and holds on an exact tie', () => {
    assert.equal(sideAfter('below', 1e-9, 0), 'above');
    assert.equal(sideAfter('above', 0, 0), 'above');
  });
});

describe('evaluateConfirmed', () => {
  it('reports a delayed cross that today\'s one-shot rule would drop (audit I2)', () => {
    // Down-trend so the side is BELOW, then a slow turn: the first candle above has a tiny gap, later ones a wider one.
    const candles = candlesFrom(TURN, T0, MIN5);
    const loose = evaluateConfirmed(candles, PAIR, 0, null, T0);
    const strict = evaluateConfirmed(candles, PAIR, 0.1, null, T0);
    assert.equal(loose.crosses.length, 1);
    assert.equal(strict.crosses.length, 1);
    assert.equal(strict.crosses[0]!.direction, 'up');
    assert.ok(strict.crosses[0]!.candleStart > loose.crosses[0]!.candleStart, 'the margin delays the cross instead of discarding it');
    assert.ok(strict.crosses[0]!.spreadPct > 0.1);
  });

  it('does not report crosses at or before reportAfterStart but keeps the side', () => {
    const candles = candlesFrom(TURN, T0, MIN5);
    const all = evaluateConfirmed(candles, PAIR, 0.05, null, T0);
    const cross = all.crosses[0];
    assert.ok(cross);
    const quiet = evaluateConfirmed(candles, PAIR, 0.05, null, cross.candleStart);
    assert.equal(quiet.crosses.length, 0);
    assert.equal(quiet.state?.side, all.state?.side);
  });

  it('continues from a prior state and only looks at newer candles', () => {
    const candles = candlesFrom(WAVE, T0, MIN5);
    const before = evaluateConfirmed(candles.slice(0, 160), PAIR, 0.05, null, T0);
    // The remembered candle (index 159) sits at index 99 of this window, past the 90-candle EMA run-in.
    const after = evaluateConfirmed(candles.slice(60, 210), PAIR, 0.05, before.state, before.state!.lastCloseStart);
    assert.equal(after.status, 'advanced');
    const full = evaluateConfirmed(candles.slice(0, 210), PAIR, 0.05, null, before.state!.lastCloseStart);
    assert.ok(full.crosses.length >= 1, 'the wave must cross in the evaluated range');
    assert.deepEqual(after.crosses.map(c => [c.candleStart, c.direction]), full.crosses.map(c => [c.candleStart, c.direction]));
  });

  it('returns the prior state unchanged for stale input and rebuilds when the prior candle is outside the window', () => {
    const candles = candlesFrom(WAVE.slice(0, 160), T0, MIN5);
    const r = evaluateConfirmed(candles, PAIR, 0.05, null, T0);
    const prior: SignalState = r.state!;
    const stale = evaluateConfirmed(candles.slice(0, 120), PAIR, 0.05, prior, 0);
    assert.equal(stale.state, prior);
    assert.equal(stale.crosses.length, 0);
    const far: SignalState = { ...prior, lastCloseStart: T0 - 10 * MIN5 };
    assert.equal(evaluateConfirmed(candles, PAIR, 0.05, far, 0).status, 'rebuilt');
    assert.equal(stale.status, 'no-new-candle');
  });

  it('rebuilds instead of trusting a side computed with a different margin (review #3)', () => {
    const candles = candlesFrom(WAVE, T0, MIN5);
    const before = evaluateConfirmed(candles.slice(0, 160), PAIR, 0.01, null, T0);
    const changed = evaluateConfirmed(candles.slice(60, 210), PAIR, 0.1, before.state, before.state!.lastCloseStart);
    assert.equal(changed.status, 'rebuilt');
    assert.equal(changed.state?.marginPct, 0.1);
    // Same margin, no new candle: kept as is. Different margin, no new candle: rebuilt, never silently reused.
    assert.equal(evaluateConfirmed(candles.slice(0, 160), PAIR, 0.01, before.state, 0).status, 'no-new-candle');
    assert.equal(evaluateConfirmed(candles.slice(0, 160), PAIR, 0.1, before.state, Number.POSITIVE_INFINITY).status, 'rebuilt');
  });

  it('needs at least slow-period candles', () => {
    assert.deepEqual(evaluateConfirmed(candlesFrom([1, 2, 3], T0, MIN5), PAIR, 0, null, 0), { crosses: [], state: null, status: 'too-short' });
  });
});

describe('evaluateRealtime', () => {
  const below: SignalState = { side: 'below', marginPct: 0.05, lastCloseStart: T0, emaFast: 99.9, emaSlow: 100 };
  const open = (): ReturnType<typeof newRealtimeCandle> => newRealtimeCandle(T0 + MIN5);

  it('alerts once per candle when the live gap passes the margin', () => {
    let candle = open();
    const tooSmall = evaluateRealtime(below, candle, MIN5, 101.5, PAIR, 0.05);
    assert.deepEqual(tooSmall.action, { kind: 'none', reason: 'inside-margin' });
    const fired = evaluateRealtime(below, tooSmall.candle, MIN5, 103, PAIR, 0.05);
    assert.equal(fired.action.kind, 'alert');
    assert.equal(fired.action.kind === 'alert' && fired.action.direction, 'up');
    candle = fired.candle;
    const again = evaluateRealtime(below, candle, MIN5, 102, PAIR, 0.05);
    assert.deepEqual(again.action, { kind: 'none', reason: 'already-alerted' });
  });

  it('cancels when EMA 9 goes back below EMA 15, once, and never re-alerts in that candle', () => {
    const fired = evaluateRealtime(below, open(), MIN5, 103, PAIR, 0.05);
    const back = evaluateRealtime(below, fired.candle, MIN5, 99.0, PAIR, 0.05);
    assert.equal(back.action.kind, 'cancel');
    const again = evaluateRealtime(below, back.candle, MIN5, 98.0, PAIR, 0.05);
    assert.equal(again.action.kind, 'none');
    const reup = evaluateRealtime(below, again.candle, MIN5, 103, PAIR, 0.05);
    assert.equal(reup.action.kind, 'none');
  });

  it('stays quiet without a confirmed side or with a state that is not the previous candle', () => {
    assert.deepEqual(evaluateRealtime({ ...below, side: null }, open(), MIN5, 120, PAIR, 0).action, { kind: 'none', reason: 'no-side' });
    assert.deepEqual(evaluateRealtime(below, newRealtimeCandle(T0 + 2 * MIN5), MIN5, 120, PAIR, 0.05).action, { kind: 'none', reason: 'stale-state' });
  });

  it('stays quiet when the margin changed since the confirmed side was computed, and on a bad price', () => {
    assert.deepEqual(evaluateRealtime(below, open(), MIN5, 120, PAIR, 0.1).action, { kind: 'none', reason: 'stale-state' });
    assert.equal(evaluateRealtime(below, open(), MIN5, Number.NaN, PAIR, 0.05).action.kind, 'none');
    assert.equal(evaluateRealtime(below, open(), MIN5, Number.POSITIVE_INFINITY, PAIR, 0.05).action.kind, 'none');
  });

  it('uses the same EMA step as the confirmed rule', () => {
    const r = evaluateRealtime({ ...below, marginPct: 0 }, open(), MIN5, 101.5, PAIR, 0);
    if (r.action.kind !== 'alert') throw new Error('expected an alert');
    assert.ok(Math.abs(r.action.spreadPct - spreadPct(r.action.emaFast, r.action.emaSlow)) < 1e-12);
  });
});

describe('closeOutcome', () => {
  const cross = { direction: 'up', candleStart: T0, close: 1, emaFast: 1, emaSlow: 1, spreadPct: 0.2 } as const;
  it('covers every combination', () => {
    assert.equal(closeOutcome(T0, { candleStart: T0, alerted: 'up', cancelled: false }, cross), 'confirmed-after-realtime');
    assert.equal(closeOutcome(T0, { candleStart: T0, alerted: 'up', cancelled: true }, cross), 'confirmed-after-cancel');
    assert.equal(closeOutcome(T0, null, cross), 'confirmed');
    assert.equal(closeOutcome(T0, { candleStart: T0, alerted: 'up', cancelled: false }, null), 'realtime-not-confirmed');
    assert.equal(closeOutcome(T0, { candleStart: T0, alerted: 'up', cancelled: true }, null), 'realtime-cancelled');
    assert.equal(closeOutcome(T0, { candleStart: T0, alerted: null, cancelled: false }, null), 'nothing');
  });

  it('ignores realtime records and crosses from other candles (review #9)', () => {
    const earlier = { candleStart: T0 - 3 * MIN5, alerted: 'up', cancelled: false } as const;
    assert.equal(closeOutcome(T0, earlier, cross), 'confirmed');
    assert.equal(closeOutcome(T0, earlier, null), 'nothing');
    assert.equal(closeOutcome(T0 + MIN5, null, cross), 'nothing');
  });
});
