import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { deltaUrl, tradingViewUrl } from '../core/app/links.ts';
import { renderAlert } from '../core/app/messages.ts';
import { parseTicker } from '../core/exchange/delta.ts';

describe('chart links', () => {
  it('opens TradingView on 15m by default and on the given timeframe otherwise', () => {
    assert.equal(tradingViewUrl('BTCUSD'), 'https://www.tradingview.com/chart/?symbol=DELTAIN%3ABTCUSD.P&interval=15');
    assert.equal(tradingViewUrl('ETHUSD', '1m'), 'https://www.tradingview.com/chart/?symbol=DELTAIN%3AETHUSD.P&interval=1');
    assert.equal(tradingViewUrl('ETHUSD', '1h'), 'https://www.tradingview.com/chart/?symbol=DELTAIN%3AETHUSD.P&interval=60');
    assert.equal(tradingViewUrl('ETHUSD', '4h'), 'https://www.tradingview.com/chart/?symbol=DELTAIN%3AETHUSD.P&interval=240');
  });

  it("opens the coin's Delta Exchange India trade page", () => {
    assert.equal(deltaUrl('BTCUSD', 'BTC'), 'https://www.delta.exchange/app/futures/trade/BTC/BTCUSD');
    assert.equal(deltaUrl('XAUTUSD'), 'https://www.delta.exchange/app/futures/trade/XAUT/XAUTUSD', 'falls back to the symbol without USD');
  });

  it('reads the underlying coin from Delta tickers, with the same fallback', () => {
    assert.equal(parseTicker({ symbol: 'BTCUSD', underlying_asset_symbol: 'BTC', close: '1', turnover_usd: 1 })?.underlying, 'BTC');
    assert.equal(parseTicker({ symbol: 'ZECUSD', close: '1', turnover_usd: 1 })?.underlying, 'ZEC');
  });

  it('alerts link the chart on their own timeframe, plus Delta', () => {
    const text = renderAlert('id1', { type: 'confirmed', symbol: 'SOLUSD', timeframe: '5m', direction: 'up', candleStart: Date.UTC(2026, 9, 23), close: 1, spreadPct: 0.1, marginPct: 0.05, realtimeAt: null, realtimeCancelled: false, ctx: null }, { timeZone: 'Asia/Kolkata', lateMs: 0 });
    assert.match(text, /<a href="https:\/\/www\.tradingview\.com\/chart\/\?symbol=DELTAIN%3ASOLUSD\.P&amp;interval=5">chart 5m<\/a> · <a href="https:\/\/www\.delta\.exchange\/app\/futures\/trade\/SOL\/SOLUSD">Delta<\/a>/);
  });
});
