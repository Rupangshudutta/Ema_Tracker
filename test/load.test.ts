// The heaviest moment: a 4-hour close with 16 coins on all six timeframes (96 coin-timeframes close together).
// Cloudflare's free plan allows 50 outbound calls per invocation; the engine budgets 45 per wake-up and finishes the
// rest in follow-up wake-ups a second apart.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SYSTEM, TIMEFRAMES, TIMEFRAME_MS } from '../core/config/settings.ts';
import { lastClosedStart } from '../core/domain/candles.ts';
import { FakeWorld, MIN, makeEngine, runUntil, settle } from './fake-world.ts';

const CLOSE = Date.UTC(2026, 9, 20, 4, 0, 0); // a 4h, 1h, 15m, 5m, 3m and 1m close at once
const BUDGET = 45;

describe('load: the busiest candle close', () => {
  it('16 coins x 6 timeframes: every series confirmed within seconds, never over 45 calls per wake-up, nothing doubled', async ctx => {
    const w = new FakeWorld(CLOSE - 20 * MIN + 3500);
    const coins = Array.from({ length: SYSTEM.coins.maxWatchlistCoins }, (_, i) => `C${String(i).padStart(2, '0')}USD`);
    // Every coin crosses EMA 15 again and again on the short timeframes, so alerts flow throughout.
    coins.forEach((symbol, i) => w.coins.set(symbol, { turnover: 50e6 + i * 1e6, price: t => 100 + Math.sin(t / (7 * MIN) + i) * 2 }));

    let calls = 0;
    const realFetch = w.fetch;
    w.fetch = (url, init) => {
      calls++;
      return realFetch(url, init);
    };
    const engine = makeEngine(w);
    await runUntil(w, engine, CLOSE - 18 * MIN);
    for (const symbol of coins) assert.equal(engine.setCoinTimeframes(symbol, [...TIMEFRAMES], 'user:777').ok, true);
    await runUntil(w, engine, CLOSE - 2 * MIN); // baselines for all 96 series (1,000 candles each) under the same budget

    // From the close, wake every second as the alarm would, and count outbound calls per wake-up.
    let maxCalls = 0;
    let doneAt: number | null = null;
    for (let t = CLOSE + 3500; t <= CLOSE + 30_000; t += 1000) {
      w.now = t;
      w.heartbeat();
      calls = 0;
      await engine.wake();
      await settle();
      maxCalls = Math.max(maxCalls, calls);
      const series = engine.store.seriesAll();
      const current = series.filter(r => r.state.lastCloseStart === lastClosedStart(t, TIMEFRAME_MS[r.timeframe])).length;
      if (doneAt === null && series.length === 96 && current === 96) doneAt = t;
    }

    assert.ok(maxCalls <= BUDGET, `a wake-up made ${maxCalls} outbound calls (budget ${BUDGET})`);
    assert.notEqual(doneAt, null, 'all 96 series got their confirmed result');
    assert.ok(doneAt! - CLOSE <= 15_000, `all 96 series done ${(doneAt! - CLOSE) / 1000} s after the close`);
    ctx.diagnostic(`max ${maxCalls} outbound calls in one wake-up; all 96 series done ${(doneAt! - CLOSE) / 1000} s after the close`);
    const texts = w.sent();
    assert.equal(new Set(texts).size, texts.length, 'no message was sent twice');
    assert.ok(texts.some(t => /CONFIRMED|alerts<\/b> at/.test(t)), 'alerts were delivered during the run');
  });
});
