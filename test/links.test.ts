import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { deltaAppUrl, deltaUrl, tradingViewUrl } from '../core/app/links.ts';
import { handleHttp } from '../core/app/http.ts';
import { BASE, FakeWorld, makeEngine } from './fake-world.ts';
import { renderAlert } from '../core/app/messages.ts';
import { parseTicker } from '../core/exchange/delta.ts';

describe('chart links', () => {
  it('opens TradingView on 15m by default and on the given timeframe otherwise', () => {
    assert.equal(tradingViewUrl('BTCUSD'), 'https://www.tradingview.com/chart/?symbol=DELTAIN%3ABTCUSD.P&interval=15');
    assert.equal(tradingViewUrl('ETHUSD', '1m'), 'https://www.tradingview.com/chart/?symbol=DELTAIN%3AETHUSD.P&interval=1');
    assert.equal(tradingViewUrl('ETHUSD', '30m'), 'https://www.tradingview.com/chart/?symbol=DELTAIN%3AETHUSD.P&interval=30');
    assert.equal(tradingViewUrl('ETHUSD', '1h'), 'https://www.tradingview.com/chart/?symbol=DELTAIN%3AETHUSD.P&interval=60');
    assert.equal(tradingViewUrl('ETHUSD', '4h'), 'https://www.tradingview.com/chart/?symbol=DELTAIN%3AETHUSD.P&interval=240');
  });

  it("opens the coin's Delta Exchange India trade page", () => {
    assert.equal(deltaUrl('BTCUSD', 'BTC'), 'https://www.delta.exchange/app/futures/trade/BTC/BTCUSD');
    assert.equal(deltaUrl('XAUTUSD'), 'https://www.delta.exchange/app/futures/trade/XAUT/XAUTUSD', 'falls back to the symbol without USD');
  });

  it("opens the Delta app through Delta's own app link, with the trade page for computers", () => {
    const url = new URL(deltaAppUrl('BTCUSD', 'BTC'));
    assert.equal(`${url.origin}${url.pathname}`, 'https://deltaexchange.onelink.me/DIpL');
    assert.deepEqual([...url.searchParams.keys()], ['af_web_dp'], 'no attribution parameters of our own');
    assert.equal(url.searchParams.get('af_web_dp'), 'https://www.delta.exchange/app/futures/trade/BTC/BTCUSD');
  });

  it('sends links to the old open-in-app page on to the app link; anything else is 404', async () => {
    const engine = makeEngine(new FakeWorld(Date.UTC(2026, 10, 3)));
    const r = await handleHttp(new Request(`${BASE}/open/delta/SOLUSD`), engine);
    assert.equal(r.status, 302);
    assert.equal(r.headers.get('location'), deltaAppUrl('SOLUSD'));
    for (const bad of ['', 'btcusd', 'BTC%3Cx%3E', '%E0%A4%A', 'BTC/USD']) {
      assert.equal((await handleHttp(new Request(`${BASE}/open/delta/${bad}`), engine)).status, 404, bad);
    }
    assert.equal((await handleHttp(new Request(`${BASE}/open.js`), engine)).status, 404);
  });

  it('reads the underlying coin from Delta tickers, with the same fallback', () => {
    assert.equal(parseTicker({ symbol: 'BTCUSD', underlying_asset_symbol: 'BTC', close: '1', turnover_usd: 1 })?.underlying, 'BTC');
    assert.equal(parseTicker({ symbol: 'ZECUSD', close: '1', turnover_usd: 1 })?.underlying, 'ZEC');
  });

  it('alerts link the chart on their own timeframe, plus the Delta app', () => {
    const text = renderAlert('id1', { type: 'confirmed', symbol: 'SOLUSD', timeframe: '5m', direction: 'up', candleStart: Date.UTC(2026, 9, 23), close: 1, spreadPct: 0.1, marginPct: 0.05, realtimeAt: null, realtimeCancelled: false, ctx: null }, { timeZone: 'Asia/Kolkata', lateMs: 0 });
    assert.match(text, /<a href="https:\/\/www\.tradingview\.com\/chart\/\?symbol=DELTAIN%3ASOLUSD\.P&amp;interval=5">chart 5m<\/a> · <a href="https:\/\/deltaexchange\.onelink\.me\/DIpL\?af_web_dp=https%3A%2F%2Fwww\.delta\.exchange%2Fapp%2Ffutures%2Ftrade%2FSOL%2FSOLUSD">Delta app<\/a>/);
  });
});
