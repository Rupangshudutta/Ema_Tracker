// Start and stop messages, the guard against two copies sending, the Docker spare watching Cloudflare, and the
// v1 top lists.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { TelegramUpdate } from '../core/notify/telegram.ts';
import { renderAlert } from '../core/app/messages.ts';
import { openSqlite } from '../runtimes/docker/sqlite.ts';
import { BASE, CHAT, FakeWorld, MIN, envFor, makeEngine, runUntil, settle } from './fake-world.ts';

const START = Date.UTC(2026, 9, 20, 2, 0, 3500); // 07:30 IST
let nextUpdate = 5000;

function world(start = START): FakeWorld {
  const w = new FakeWorld(start);
  w.coins.set('BTCUSD', { turnover: 400e6, price: () => 100 });
  w.coins.set('ETHUSD', { turnover: 200e6, price: () => 50 });
  w.coins.set('PUMPUSD', { turnover: 3e6, price: () => 2 });
  w.coins.set('DEADUSD', { turnover: 0.2e6, price: () => 1 });
  return w;
}

const starts = (w: FakeWorld): string[] => w.sent().filter(t => /EMA Tracker started/.test(t));
const message = (text: string): TelegramUpdate => ({ update_id: nextUpdate++, message: { message_id: 1, chat: { id: Number(CHAT), type: 'private' }, from: { id: Number(CHAT) }, text } });

describe('start message', () => {
  it('says "back online" with the downtime after an outage, and nothing after a quick restart', async () => {
    const w = world();
    const db = openSqlite(':memory:');
    const first = makeEngine(w, 'Cloudflare', envFor(), db);
    await runUntil(w, first, START + 3 * MIN);
    assert.equal(starts(w).length, 1);

    w.clearTelegram();
    w.now += 30_000; // Cloudflare moves the desk worker: back within seconds
    const quick = makeEngine(w, 'Cloudflare', envFor(), db);
    await runUntil(w, quick, w.now + 2 * MIN);
    assert.equal(starts(w).length, 0, 'no message for a restart without downtime');

    w.clearTelegram();
    w.now += 12 * MIN; // an outage
    const back = makeEngine(w, 'Cloudflare', envFor(), db);
    await runUntil(w, back, w.now + 2 * MIN);
    const texts = starts(w);
    assert.equal(texts.length, 1);
    assert.match(texts[0]!, /Back online after 1[23] min away \(last seen/);
    assert.match(texts[0]!, /Watching 2 coins:\n15m: BTCUSD, ETHUSD/);
  });

  it('announces a new version after a deploy', async () => {
    const w = world();
    const db = openSqlite(':memory:');
    await runUntil(w, makeEngine(w, 'Cloudflare', envFor(), db, '2.1.0'), START + 2 * MIN);
    w.clearTelegram();
    w.now += 20_000;
    await runUntil(w, makeEngine(w, 'Cloudflare', envFor(), db, '2.2.0'), w.now + 2 * MIN);
    assert.match(starts(w)[0] ?? '', /New version 2\.2\.0 is live/);
  });
});

describe('stop message (Docker spare)', () => {
  it('hands alerts back to Cloudflare and says goodbye when stopped while sending', async () => {
    const w = world();
    w.webhookUrl = '';
    const docker = makeEngine(w, 'Docker', envFor({ role: 'standby' }));
    await runUntil(w, docker, START + 2 * MIN);
    assert.equal(docker.status().role, 'active');
    w.clearTelegram();
    await docker.shutdown('the Docker container is stopping');
    assert.ok(w.syncCalls.includes('PUT /api/sync/state'), 'settings copied back first');
    assert.equal(w.webhookUrl, `${BASE}/telegram/webhook`, 'Telegram connection handed back');
    const bye = w.sent().find(t => /EMA Tracker stopping/.test(t));
    assert.match(bye ?? '', /The Docker container is stopping\. Alerts were handed back to Cloudflare/);
  });

  it('says nothing when stopped on standby', async () => {
    const w = world();
    w.webhookUrl = `${BASE}/telegram/webhook`;
    const docker = makeEngine(w, 'Docker', envFor({ role: 'standby' }));
    await runUntil(w, docker, START + 2 * MIN);
    w.clearTelegram();
    await docker.shutdown('the Docker container is stopping');
    assert.equal(w.sent().length, 0);
  });

  it('warns once from standby when Cloudflare stops answering, and says when it is back', async () => {
    const w = world();
    w.webhookUrl = `${BASE}/telegram/webhook`;
    const docker = makeEngine(w, 'Docker', envFor({ role: 'standby' }));
    await runUntil(w, docker, START + 2 * MIN);
    w.clearTelegram();
    w.cloudflareUp = false;
    await runUntil(w, docker, START + 10 * MIN);
    assert.equal(w.sent().filter(t => /Cloudflare engine not answering/.test(t)).length, 1);
    w.cloudflareUp = true;
    await runUntil(w, docker, START + 12 * MIN);
    assert.equal(w.sent().filter(t => /Cloudflare engine answering again/.test(t)).length, 1);
    assert.equal(docker.status().role, 'standby', 'the warning never makes Docker take over by itself');
  });
});

describe('two Cloudflare copies with the same secrets', () => {
  it('a copy that finds another active engine at the public address stays silent', async () => {
    const w = world();
    w.publicHealth = { instance: 'production-notebook', role: 'active' };
    const local = makeEngine(w);
    await runUntil(w, local, START + 3 * MIN);
    assert.equal(local.status().role, 'standby');
    assert.match(local.status().roleReason, /another copy of the bot is active/);
    assert.equal(w.webhookUrl, '', 'it did not take the Telegram connection');
    assert.equal(w.sent().length, 0);
  });

  it('goes ahead when the public engine is on standby or does not answer, and never blocks itself', async () => {
    const w = world();
    w.publicHealth = { instance: 'production-notebook', role: 'standby' };
    const engine = makeEngine(w);
    await runUntil(w, engine, START + 2 * MIN);
    assert.equal(engine.status().role, 'active');
    w.publicHealth = { instance: engine.id(), role: 'active' };
    await runUntil(w, engine, START + 4 * MIN);
    assert.equal(engine.status().role, 'active', 'its own ID at the public address is fine');
  });
});

describe('top lists (v1 options)', () => {
  it('/top shows gainers above $1M volume; the buttons switch to losers and highest volume', async () => {
    const w = world();
    w.coins.set('PUMPUSD', { turnover: 3e6, price: () => 2 });
    const engine = makeEngine(w);
    await runUntil(w, engine, START + 2 * MIN);
    w.clearTelegram();
    await engine.handleTelegramUpdate(message('/top'));
    const text = String(w.telegram.find(c => c.method === 'sendMessage')?.body.text);
    assert.match(text, /Top gainers<\/b> \(24h\)/);
    assert.match(text, /Coins with at least \$1M volume/);
    assert.match(text, /1\. <b>BTCUSD<\/b>.*👁/);
    assert.doesNotMatch(text, /DEADUSD/, 'near-dead coins are left out of gainers');
    w.clearTelegram();
    await engine.handleTelegramUpdate({ update_id: nextUpdate++, callback_query: { id: 'q1', from: { id: Number(CHAT) }, data: 'top:volume', message: { message_id: 9, chat: { id: Number(CHAT), type: 'private' } } } });
    const edit = String(w.telegram.find(c => c.method === 'editMessageText')?.body.text);
    assert.match(edit, /Highest volume<\/b>/);
    assert.match(edit, /4\. <b>DEADUSD<\/b>/, 'the volume list covers every coin');
  });
});

describe('daily report on a first start', () => {
  it('does not send a report right after a first start past the report time; it comes the next day', async () => {
    const w = world(Date.UTC(2026, 9, 20, 6, 0, 3500)); // 11:30 IST, after 09:00
    const engine = makeEngine(w);
    await runUntil(w, engine, w.now + 3 * MIN);
    assert.equal(w.sent().filter(t => /Daily report/.test(t)).length, 0);
    w.now = Date.UTC(2026, 9, 21, 3, 25, 3500); // jump to 08:55 IST next day
    await runUntil(w, engine, Date.UTC(2026, 9, 21, 3, 32, 0)); // 09:02 IST
    await settle();
    assert.equal(w.sent().filter(t => /Daily report/.test(t)).length, 1);
  });
});

describe('alert text', () => {
  it('links the TradingView chart for the Delta India perpetual', () => {
    const text = renderAlert('id1', { type: 'realtime', symbol: 'BTCUSD', timeframe: '15m', direction: 'up', candleStart: START, price: 1, spreadPct: 0.1, marginPct: 0.05, ctx: null }, { timeZone: 'Asia/Kolkata', lateMs: 0 });
    assert.match(text, /<a href="https:\/\/www\.tradingview\.com\/chart\/\?symbol=DELTAIN%3ABTCUSD\.P">chart<\/a>/);
  });
});
