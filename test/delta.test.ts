// Contract tests for the Delta connector against replies recorded from the real API (test/fixtures/delta-api).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SYSTEM } from '../core/config/settings.ts';
import { DeltaClient, parseTicker, type FetchFn } from '../core/exchange/delta.ts';
import { diffSubscriptions, parseFeedMessage, subscribeMessage, unsubscribeMessage } from '../core/exchange/delta-feed.ts';
import { closedSeries } from '../core/domain/candles.ts';

interface Recorded { status: number; date: string; body: unknown }
const sample = (name: string): Recorded => JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', 'delta-api', `${name}.json`), 'utf8'));
const feedSamples = JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', 'delta-api', 'feed-messages.json'), 'utf8')) as Record<string, unknown>;

/** Fake fetch that replays responses in order and records each request. */
function replay(responses: (Response | Error)[]): { fetch: FetchFn; calls: { url: string; init?: RequestInit }[] } {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetch: FetchFn = async (url, init) => {
    calls.push({ url, ...(init ? { init } : {}) });
    const next = responses.shift();
    if (!next) throw new Error('unexpected extra request');
    if (next instanceof Error) throw next;
    return next;
  };
  return { fetch, calls };
}
const json = (r: Recorded, status = r.status): Response => new Response(JSON.stringify(r.body), { status, headers: { date: r.date, 'content-type': 'application/json' } });
const noSleep = async (): Promise<void> => {};

describe('DeltaClient (recorded replies)', () => {
  it('parses tickers with mixed number/string fields and sends a User-Agent', async () => {
    const { fetch, calls } = replay([json(sample('tickers'))]);
    const r = await new DeltaClient(fetch, noSleep).tickers();
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.value.rejected, 0);
    const sol = r.value.tickers.find(t => t.symbol === 'SOLUSD')!;
    assert.equal(typeof sol.markPrice, 'number');
    assert.ok(sol.turnoverUsd24h > 0 && sol.lastPrice > 0 && sol.openInterestUsd! > 0);
    assert.equal(sol.change24hPct, 0.8385);
    assert.equal(sol.tradingStatus, 'operational');
    assert.ok(sol.timestampMs > 1.7e12 && sol.timestampMs < 2e12, 'microseconds converted to milliseconds');
    assert.equal(r.serverNow, Date.parse(sample('tickers').date));
    const headers = new Headers(calls[0]!.init?.headers);
    assert.equal(headers.get('user-agent'), SYSTEM.exchange.userAgent);
  });

  it('turns recorded candles into a valid closed series, dropping the forming candle', async () => {
    const rec = sample('candles-btc-5m');
    const { fetch, calls } = replay([json(rec)]);
    const r = await new DeltaClient(fetch, noSleep).candles('BTCUSD', '5m', 4, Date.parse(rec.date));
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.match(calls[0]!.url, /resolution=5m&symbol=BTCUSD&start=\d+&end=\d+$/);
    const checked = closedSeries(r.value, 300_000, r.serverNow);
    assert.equal(checked.ok, true);
    if (checked.ok) assert.equal(checked.candles.length, r.value.length - 1);
  });

  it('treats an unknown symbol (HTTP 200, empty list) as no data, not as success', async () => {
    const rec = sample('candles-unknown-symbol');
    const { fetch } = replay([json(rec)]);
    const r = await new DeltaClient(fetch, noSleep).candles('NOSUCHCOIN', '5m', 4, Date.parse(rec.date));
    assert.equal(r.ok && r.value.length, 0);
    if (r.ok) assert.equal((c => (c.ok ? 'ok' : c.problem))(closedSeries(r.value, 300_000, r.serverNow)), 'empty');
  });

  it('does not retry a 429 and reports the reset wait', async () => {
    const { fetch, calls } = replay([new Response('{}', { status: 429, headers: { 'x-rate-limit-reset': '4200' } })]);
    const r = await new DeltaClient(fetch, noSleep).tickers();
    assert.deepEqual(r, { ok: false, error: { kind: 'rate-limited', retryAfterMs: 4200 }, attempts: 1 });
    assert.equal(calls.length, 1);
  });

  it('retries 5xx and network errors with backoff, then succeeds', async () => {
    const waits: number[] = [];
    const { fetch, calls } = replay([new Response('', { status: 503 }), new TypeError('fetch failed'), json(sample('tickers'))]);
    const r = await new DeltaClient(fetch, async ms => { waits.push(ms); }).tickers();
    assert.equal(r.ok, true);
    assert.equal(calls.length, 3);
    assert.deepEqual(waits, [250, 500]);
  });

  it('gives up after the configured retries with the last error', async () => {
    const timeout = Object.assign(new Error('timed out'), { name: 'TimeoutError' });
    const { fetch, calls } = replay([timeout, timeout, timeout, timeout]);
    const r = await new DeltaClient(fetch, noSleep).tickers();
    assert.deepEqual(r, { ok: false, error: { kind: 'timeout' }, attempts: SYSTEM.exchange.maxRetries + 1 });
    assert.equal(calls.length, SYSTEM.exchange.maxRetries + 1);
  });

  it('rejects malformed replies without retrying', async () => {
    const { fetch } = replay([new Response('<html>blocked</html>', { status: 200 }), new Response('{"success":false}', { status: 200 }), new Response('', { status: 403 })]);
    const client = new DeltaClient(fetch, noSleep);
    assert.equal((await client.tickers()).ok ? 'ok' : 'bad-response', 'bad-response');
    const second = await client.tickers();
    assert.equal(!second.ok && second.error.kind, 'bad-response');
    const third = await client.tickers();
    assert.deepEqual(!third.ok && third.error, { kind: 'http', status: 403 });
  });

  it('drops ticker rows that fail validation', () => {
    assert.equal(parseTicker({ symbol: 'X', close: 0, turnover_usd: 1 }), null);
    assert.equal(parseTicker({ close: 5, turnover_usd: 1 }), null);
    assert.equal(parseTicker(null), null);
    assert.ok(parseTicker({ symbol: 'X', close: '5', turnover_usd: '10' }));
  });
});

describe('live feed messages (recorded)', () => {
  it('parses ticker, subscribe and unsubscribe messages', () => {
    const t = parseFeedMessage(JSON.stringify(feedSamples['v2/ticker']));
    assert.equal(t.type, 'ticker');
    if (t.type === 'ticker') {
      assert.equal(t.symbol, 'BTCUSD');
      assert.ok(t.price > 0 && t.timestampMs > 1.7e12 && t.timestampMs < 2e12);
    }
    assert.deepEqual(parseFeedMessage(JSON.stringify(feedSamples.subscriptions)), { type: 'subscribed', symbols: ['BTCUSD'] });
    assert.deepEqual(parseFeedMessage(JSON.stringify(feedSamples.unsubscribed)), { type: 'unsubscribed', symbols: ['BTCUSD'] });
  });

  it('ignores junk and reports errors', () => {
    assert.equal(parseFeedMessage('not json').type, 'ignored');
    assert.equal(parseFeedMessage('{"type":"v2/ticker","symbol":"X"}').type, 'ignored');
    assert.deepEqual(parseFeedMessage('{"type":"error","message":"bad symbol"}'), { type: 'error', message: 'bad symbol' });
  });

  it('builds the frames Delta accepted in the live test and diffs the watchlist', () => {
    assert.equal(subscribeMessage(['BTCUSD']), '{"type":"subscribe","payload":{"channels":[{"name":"v2/ticker","symbols":["BTCUSD"]}]}}');
    assert.equal(unsubscribeMessage(['ETHUSD']), '{"type":"unsubscribe","payload":{"channels":[{"name":"v2/ticker","symbols":["ETHUSD"]}]}}');
    assert.deepEqual(diffSubscriptions(new Set(['BTCUSD', 'XAUTUSD']), new Set(['BTCUSD', 'SOLUSD'])), { subscribe: ['SOLUSD'], unsubscribe: ['XAUTUSD'] });
    assert.deepEqual(diffSubscriptions(new Set(['A']), new Set(['A'])), { subscribe: [], unsubscribe: [] });
  });
});
