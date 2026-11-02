// The coin picker always lists every coin above the volume filter (item 2, 2026-11-02): before, the list was empty
// after a restart until the next minute run, so "Not watched" showed nothing.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { signInitData } from '../core/app/auth.ts';
import { handleHttp } from '../core/app/http.ts';
import { MINI_APP_JS } from '../core/app/miniapp.ts';
import { openSqlite } from '../runtimes/docker/sqlite.ts';
import { BASE, CHAT, FakeWorld, MIN, TOKEN, envFor, makeEngine, runUntil } from './fake-world.ts';
import type { Engine } from '../core/app/engine.ts';

const START = Date.UTC(2026, 10, 2, 3, 0, 3500);

interface Coin { symbol: string; status: string; turnoverUsd24h: number | null }
interface CoinsBody { coins: Coin[]; pricesFresh: boolean }

function world(): { w: FakeWorld; tickerCalls: () => number } {
  const w = new FakeWorld(START);
  w.coins.set('BTCUSD', { turnover: 400e6, price: () => 100 });
  w.coins.set('ETHUSD', { turnover: 200e6, price: () => 50 });
  w.coins.set('SOLUSD', { turnover: 50e6, price: () => 20 });
  w.coins.set('LOWUSD', { turnover: 1e6, price: () => 1 });
  let calls = 0;
  const fetch = w.fetch;
  w.fetch = async (url, init) => {
    if (url.includes('/v2/tickers')) calls++;
    return fetch(url, init);
  };
  return { w, tickerCalls: () => calls };
}

async function headers(w: FakeWorld): Promise<Record<string, string>> {
  const initData = await signInitData({ auth_date: String(Math.floor(w.now / 1000)), user: JSON.stringify({ id: Number(CHAT) }) }, TOKEN);
  return { 'x-telegram-init-data': initData, 'content-type': 'application/json' };
}

async function list(w: FakeWorld, engine: Engine): Promise<CoinsBody> {
  const res = await handleHttp(new Request(`${BASE}/api/coins`, { headers: await headers(w) }), engine);
  assert.equal(res.status, 200);
  return (await res.json()) as CoinsBody;
}

/** A bot that watched BTC, ETH and SOL, then had ETH removed by the owner, restarted on the same database. */
async function restarted(): Promise<{ w: FakeWorld; engine: Engine; tickerCalls: () => number }> {
  const { w, tickerCalls } = world();
  const db = openSqlite(':memory:');
  const first = makeEngine(w, 'Cloudflare', envFor(), db);
  await runUntil(w, first, START + 2 * MIN);
  assert.ok(first.setCoinTimeframes('ETHUSD', [], 'test').ok);
  w.now += 10_000;
  return { w, engine: makeEngine(w, 'Cloudflare', envFor(), db), tickerCalls };
}

describe('coin picker list (Not watched)', () => {
  it('right after a restart lists every coin above the filter, removed ones included', async () => {
    const { w, engine } = await restarted();
    const body = await list(w, engine);
    assert.equal(body.pricesFresh, true);
    const bySymbol = new Map(body.coins.map(c => [c.symbol, c]));
    assert.deepEqual([...bySymbol.keys()], ['BTCUSD', 'ETHUSD', 'SOLUSD'], 'LOWUSD stays out: it is under the filter');
    assert.equal(bySymbol.get('ETHUSD')!.status, 'removed', 'the removed coin is offered again ("Not watched")');
    assert.equal(bySymbol.get('ETHUSD')!.turnoverUsd24h, 200e6);
  });

  it('shows a coin that has just risen above the filter, with a snapshot at most a minute old', async () => {
    const { w, engine, tickerCalls } = await restarted();
    await list(w, engine);
    const before = tickerCalls();
    w.coins.set('NEWUSD', { turnover: 30e6, price: () => 3 });
    w.now += 30_000;
    assert.ok(!(await list(w, engine)).coins.some(c => c.symbol === 'NEWUSD'), 'within a minute the snapshot is reused');
    assert.equal(tickerCalls(), before, 'no extra Delta call within a minute');
    w.now += 31_000;
    const fresh = await list(w, engine);
    assert.equal(fresh.coins.find(c => c.symbol === 'NEWUSD')?.status, 'available');
    assert.equal(tickerCalls(), before + 1);
  });

  it('can add a coin right after a restart (its volume is checked against a fresh snapshot)', async () => {
    const { w, engine } = await restarted();
    const early = await handleHttp(new Request(`${BASE}/api/coins`, { method: 'POST', headers: await headers(w), body: JSON.stringify({ symbol: 'ETHUSD', timeframes: ['15m'] }) }), engine);
    assert.equal(early.status, 409);
    assert.match(await early.text(), /starting: try again in a few seconds/, 'not "on standby" while the first run has not decided the role');
    w.deltaDown = true;
    await engine.wake(); // decides the role; Delta does not answer, so the snapshot stays empty
    w.deltaDown = false;
    assert.equal(engine.status().role, 'active');
    assert.equal(engine.status().coins.universe, 0);
    const res = await handleHttp(new Request(`${BASE}/api/coins`, { method: 'POST', headers: await headers(w), body: JSON.stringify({ symbol: 'ETHUSD', timeframes: ['15m'] }) }), engine);
    assert.equal(res.status, 200, await res.clone().text());
    assert.deepEqual(engine.watchRows().find(r => r.symbol === 'ETHUSD')?.timeframes, ['15m']);
  });

  it('when Delta does not answer, still answers with the watched coins and says the list may be incomplete', async () => {
    const { w, engine } = await restarted();
    w.deltaDown = true;
    const body = await list(w, engine);
    assert.equal(body.pricesFresh, false);
    assert.deepEqual(body.coins.map(c => [c.symbol, c.status]).sort(), [['BTCUSD', 'active'], ['SOLUSD', 'active']]);
    assert.ok(MINI_APP_JS.includes('pricesFresh === false'), 'the mini app shows a note in that case');
  });

  it('filling the list on demand does not stop the next minute run from applying the watchlist rules', async () => {
    const { w, engine } = await restarted();
    w.coins.set('NEWUSD', { turnover: 30e6, price: () => 3 });
    assert.equal((await list(w, engine)).coins.find(c => c.symbol === 'NEWUSD')?.status, 'available');
    await runUntil(w, engine, w.now + MIN);
    const row = engine.watchRows().find(r => r.symbol === 'NEWUSD');
    assert.equal(row?.status, 'active', 'the new coin above the filter joins by itself as before');
    assert.equal(row?.origin, 'auto');
  });

  it('after a failed try, screens skip Delta for 30 s so taps stay quick', async () => {
    const { w, engine, tickerCalls } = await restarted();
    w.deltaDown = true;
    await list(w, engine);
    const after = tickerCalls();
    w.now += 10_000;
    assert.equal((await list(w, engine)).pricesFresh, false);
    assert.equal(tickerCalls(), after, 'no new Delta call within 30 s of a failure');
    w.deltaDown = false;
    w.now += 21_000;
    assert.equal((await list(w, engine)).pricesFresh, true);
  });

  it('a tap a while after opening the picker does not claim Delta failed (the snapshot is just older than a minute)', async () => {
    const { w, engine, tickerCalls } = await restarted();
    assert.equal((await list(w, engine)).pricesFresh, true);
    await runUntil(w, engine, w.now + MIN); // the first run decides the role
    const before = tickerCalls();
    w.now += 70_000;
    const tap = await handleHttp(new Request(`${BASE}/api/coins`, { method: 'POST', headers: await headers(w), body: JSON.stringify({ symbol: 'BTCUSD', timeframes: ['5m', '15m'] }) }), engine);
    assert.equal(tap.status, 200);
    assert.equal(((await tap.json()) as { pricesFresh: boolean }).pricesFresh, true);
    assert.equal(tickerCalls(), before, 'a coin already watched needs no Delta call');
  });

  it('a failed fetch for a screen never raises the "Delta API not answering" warning', async () => {
    const { w, engine } = await restarted();
    await runUntil(w, engine, w.now + 2 * MIN); // the snapshot is now over a minute old
    w.deltaDown = true;
    assert.equal((await list(w, engine)).pricesFresh, false);
    w.deltaDown = false;
    assert.equal(engine.status().delta.failingSince, null, 'only the minute run decides that Delta is down');
    w.clearTelegram();
    await runUntil(w, engine, w.now + 8 * MIN);
    assert.ok(!w.sent().some(t => /Delta API not answering/.test(t)), w.sent().join('\n'));
  });

  it('/watch in the chat can add a coin right after a restart', async () => {
    const { w, engine } = await restarted();
    w.deltaDown = true;
    await engine.wake(); // decides the role; the snapshot stays empty
    w.deltaDown = false;
    w.clearTelegram();
    await engine.handleTelegramUpdate({ update_id: 9101, message: { message_id: 1, chat: { id: Number(CHAT), type: 'private' }, from: { id: Number(CHAT) }, text: '/watch ETHUSD 15m' } });
    assert.match(w.sent()[0]!, /ETHUSD added: 15m/);
  });

  it('the chat Coins screen shows volumes right after a restart too', async () => {
    const { w, engine } = await restarted();
    w.clearTelegram();
    await engine.handleTelegramUpdate({ update_id: 9100, message: { message_id: 1, chat: { id: Number(CHAT), type: 'private' }, from: { id: Number(CHAT) }, text: '/coins' } });
    assert.match(w.sent()[0]!, /BTCUSD · 15m · \$400/);
  });
});
