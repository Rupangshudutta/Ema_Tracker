import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { alertLine, fmtDuration, fmtPct, fmtPrice, fmtTime, fmtUsd, renderAlert, tzLabel, type AlertPayload } from '../core/app/messages.ts';

const START = Date.UTC(2026, 9, 19, 4, 30, 0); // 10:00 IST
const TZ = 'Asia/Kolkata';
const on = { timeZone: TZ, lateMs: 4000 };

describe('number and time formatting', () => {
  it('formats prices, signed percentages, volumes and durations for people', () => {
    assert.equal(fmtPrice(67321.456), '67,321.5');
    assert.equal(fmtPrice(0.044581234), '0.0445812');
    assert.equal(fmtPct(0.0812, 3), '+0.081%');
    assert.equal(fmtPct(-0.06), '−0.06%');
    assert.equal(fmtPct(0.0001), '0.00%');
    assert.equal(fmtUsd(412_345_678), '$412M');
    assert.equal(fmtUsd(10_000_000), '$10M');
    assert.equal(fmtUsd(1_234_000_000), '$1.2B');
    assert.equal(fmtDuration(83_000), '1 min 23 s');
    assert.equal(fmtDuration(12 * 60_000), '12 min');
    assert.equal(fmtDuration(125 * 60_000), '2 h 5 min');
    assert.equal(fmtTime(START, TZ), '10:00');
    assert.equal(tzLabel(TZ), 'IST');
  });
});

describe('alert texts', () => {
  const base = { symbol: 'BTCUSD', timeframe: '15m' as const, candleStart: START };

  it('labels realtime and confirmed alerts as the user asked', () => {
    const rt: AlertPayload = { ...base, type: 'realtime', direction: 'up', price: 67321.5, spreadPct: 0.061, marginPct: 0.05, ctx: { change24hPct: 2.31, turnoverUsd24h: 412e6 } };
    const text = renderAlert('abc123', rt, on);
    assert.match(text, /REALTIME<\/b> · candle still open/);
    assert.match(text, /BTCUSD 15m<\/b> bullish cross/);
    assert.match(text, /24h \+2\.31% · vol \$412M/);
    assert.match(text, /Candle closes 10:15 IST/);

    const cf: AlertPayload = { ...base, type: 'confirmed', direction: 'up', close: 67350, spreadPct: 0.081, marginPct: 0.05, realtimeAt: START + 15 * 60_000 - 83_000, realtimeCancelled: false, ctx: null };
    const done = renderAlert('abc124', cf, on);
    assert.match(done, /CONFIRMED<\/b> · candle closed/);
    assert.match(done, /realtime alert came 1 min 23 s before the close/);
    assert.match(done, /Candle 10:00–10:15 IST · <code>abc124<\/code>/);
  });

  it('writes the cancel and not-confirmed notes and the LATE line', () => {
    const cancel = renderAlert('x', { ...base, type: 'realtime-cancel', direction: 'down', price: 1, spreadPct: 0.01 }, on);
    assert.match(cancel, /REALTIME CANCELLED/);
    assert.match(cancel, /bearish cross reversed/);
    const nc = renderAlert('y', { ...base, type: 'not-confirmed', direction: 'up', spreadPct: 0.02, marginPct: 0.05 }, { timeZone: TZ, lateMs: 12 * 60_000 });
    assert.match(nc, /^⏰ <b>LATE<\/b> by 12 min/);
    assert.match(nc, /NOT CONFIRMED/);
  });

  it('escapes symbols so Telegram never rejects the HTML', () => {
    const line = alertLine({ ...base, symbol: 'A<B&C', type: 'not-confirmed', direction: 'up', spreadPct: 0, marginPct: 0 });
    assert.match(line, /A&lt;B&amp;C/);
  });
});
