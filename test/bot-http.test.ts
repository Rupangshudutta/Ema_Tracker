// Telegram menus and commands, the mini app's sign-in check and the HTTP routes.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { signInitData, syncKey, validateInitData, webhookSecret } from '../core/app/auth.ts';
import { handleHttp } from '../core/app/http.ts';
import type { TelegramUpdate } from '../core/notify/telegram.ts';
import { BASE, CHAT, FakeWorld, MIN, TOKEN, makeEngine, runUntil } from './fake-world.ts';

const START = Date.UTC(2026, 9, 20, 3, 0, 3500);
let nextUpdate = 1;

function setup() {
  const w = new FakeWorld(START);
  w.coins.set('BTCUSD', { turnover: 400e6, price: () => 100 });
  w.coins.set('ETHUSD', { turnover: 200e6, price: () => 50 });
  w.coins.set('LOWUSD', { turnover: 1e6, price: () => 1 });
  const engine = makeEngine(w);
  return { w, engine };
}

const message = (text: string, from = Number(CHAT)): TelegramUpdate => ({ update_id: nextUpdate++, message: { message_id: 1, chat: { id: Number(CHAT), type: 'private' }, from: { id: from }, text } });
const callback = (data: string, from = Number(CHAT)): TelegramUpdate => ({ update_id: nextUpdate++, callback_query: { id: `cb${nextUpdate}`, from: { id: from }, data, message: { message_id: 55, chat: { id: Number(CHAT), type: 'private' } } } });
const calls = (w: FakeWorld, method: string) => w.telegram.filter(c => c.method === method);

describe('Telegram menu and commands', () => {
  it('/start shows the menu with the Coins mini app button; strangers get nothing', async () => {
    const { w, engine } = setup();
    await runUntil(w, engine, START + MIN);
    w.clearTelegram();
    await engine.handleTelegramUpdate(message('/start'));
    const sent = calls(w, 'sendMessage');
    assert.equal(sent.length, 1);
    assert.match(String(sent[0]!.body.text), /EMA Tracker/);
    const keyboard = JSON.stringify(sent[0]!.body.reply_markup);
    assert.ok(keyboard.includes(`"web_app":{"url":"${BASE}/app"}`));
    assert.ok(keyboard.includes('"callback_data":"nav:set"'));
    w.clearTelegram();
    await engine.handleTelegramUpdate(message('/start', 999));
    assert.equal(w.telegram.length, 0);
  });

  it('changes the margin from the buttons, edits the menu in place and audits the change', async () => {
    const { w, engine } = setup();
    await runUntil(w, engine, START + MIN);
    w.clearTelegram();
    await engine.handleTelegramUpdate(callback('m:0.03'));
    assert.equal(engine.settings().signal.marginPct, 0.03);
    assert.equal(calls(w, 'editMessageText').length, 1);
    assert.match(String(calls(w, 'answerCallbackQuery')[0]!.body.text), /Margin set to 0\.03%/);
    await engine.handleTelegramUpdate(callback('m:0.5'));
    assert.equal(engine.settings().signal.marginPct, 0.03, 'values outside the menu are refused');
    await engine.handleTelegramUpdate(callback('v:20000000', 999));
    assert.equal(engine.settings().coins.volumeThresholdUsd, 10e6, 'strangers cannot press buttons');
    assert.match(String(calls(w, 'answerCallbackQuery').at(-1)!.body.text), /Not allowed/);
  });

  it('handles each update once, even if Telegram delivers it twice', async () => {
    const { w, engine } = setup();
    await runUntil(w, engine, START + MIN);
    w.clearTelegram();
    const u = message('/status');
    await engine.handleTelegramUpdate(u);
    await engine.handleTelegramUpdate(u);
    assert.equal(calls(w, 'sendMessage').length, 1);
  });

  it('/watch, /unwatch, /pause and /resume work from the chat', async () => {
    const { w, engine } = setup();
    await runUntil(w, engine, START + MIN);
    w.clearTelegram();
    await engine.handleTelegramUpdate(message('/watch ETHUSD 5m 1h'));
    await engine.handleTelegramUpdate(message('/watch LOWUSD 5m'));
    await engine.handleTelegramUpdate(message('/unwatch BTCUSD'));
    await engine.handleTelegramUpdate(message('/pause 2h'));
    const texts = calls(w, 'sendMessage').map(c => String(c.body.text));
    assert.match(texts[0]!, /ETHUSD: 5m, 1h/);
    assert.match(texts[1]!, /not above your volume filter/);
    assert.match(texts[2]!, /BTCUSD removed/);
    assert.match(texts[3]!, /Alerts paused until/);
    assert.ok(engine.settings().delivery.pausedUntil! > w.now + 119 * MIN);
    await engine.handleTelegramUpdate(message('/resume'));
    assert.equal(engine.settings().delivery.pausedUntil, null);
  });
});

describe('mini app sign-in (initData)', () => {
  const fields = (userId: number, authDate: number): Record<string, string> => ({ auth_date: String(authDate), query_id: 'AAH', user: JSON.stringify({ id: userId, first_name: 'R' }) });

  it('accepts data signed with the bot token and rejects tampering, other tokens and stale data', async () => {
    const now = Date.UTC(2026, 9, 20);
    const good = await signInitData(fields(777, now / 1000 - 60), TOKEN);
    assert.deepEqual(await validateInitData(good, TOKEN, now), { ok: true, userId: 777 });
    const tampered = good.replace('777', '778');
    assert.equal((await validateInitData(tampered, TOKEN, now)).ok, false);
    const otherBot = await signInitData(fields(777, now / 1000 - 60), ['1', 'q'.repeat(35)].join(':'));
    assert.equal((await validateInitData(otherBot, TOKEN, now)).ok, false);
    const old = await signInitData(fields(777, now / 1000 - 2 * 24 * 3600), TOKEN);
    assert.match(JSON.stringify(await validateInitData(old, TOKEN, now)), /expired/);
  });
});

describe('HTTP routes', () => {
  it('serves health without secrets', async () => {
    const { w, engine } = setup();
    await runUntil(w, engine, START + MIN);
    const res = await handleHttp(new Request(`${BASE}/health`), engine);
    const body = (await res.json()) as Record<string, unknown>;
    assert.equal(res.status, 200);
    assert.equal(body.role, 'active');
    assert.ok(!JSON.stringify(body).includes(TOKEN));
  });

  it('accepts webhook updates only with the secret header', async () => {
    const { w, engine } = setup();
    await runUntil(w, engine, START + MIN);
    const update = JSON.stringify(message('/status'));
    const bad = await handleHttp(new Request(`${BASE}/telegram/webhook`, { method: 'POST', body: update, headers: { 'x-telegram-bot-api-secret-token': 'nope' } }), engine);
    assert.equal(bad.status, 403);
    w.clearTelegram();
    const secret = await webhookSecret(TOKEN, null);
    const ok = await handleHttp(new Request(`${BASE}/telegram/webhook`, { method: 'POST', body: update, headers: { 'x-telegram-bot-api-secret-token': secret } }), engine);
    assert.equal(ok.status, 200);
    assert.equal(calls(w, 'sendMessage').length, 1);
  });

  it('mini app API: lists coins and saves ticks for the admin only', async () => {
    const { w, engine } = setup();
    await runUntil(w, engine, START + MIN);
    const initData = await signInitData({ auth_date: String(Math.floor(w.now / 1000)), user: JSON.stringify({ id: Number(CHAT) }) }, TOKEN);
    const headers = { 'x-telegram-init-data': initData, 'content-type': 'application/json' };
    const list = await handleHttp(new Request(`${BASE}/api/coins`, { headers }), engine);
    assert.equal(list.status, 200);
    const body = (await list.json()) as { coins: { symbol: string; status: string }[]; cap: number };
    assert.deepEqual(body.coins.map(c => c.symbol), ['BTCUSD', 'ETHUSD']);
    assert.equal(body.cap, 16);
    const save = await handleHttp(new Request(`${BASE}/api/coins`, { method: 'POST', headers, body: JSON.stringify({ symbol: 'BTCUSD', timeframes: ['5m', '15m'] }) }), engine);
    assert.equal(save.status, 200);
    assert.deepEqual(engine.watchRows().find(r => r.symbol === 'BTCUSD')?.timeframes, ['5m', '15m']);
    const stranger = await signInitData({ auth_date: String(Math.floor(w.now / 1000)), user: JSON.stringify({ id: 999 }) }, TOKEN);
    assert.equal((await handleHttp(new Request(`${BASE}/api/coins`, { headers: { 'x-telegram-init-data': stranger } }), engine)).status, 403);
    assert.equal((await handleHttp(new Request(`${BASE}/api/coins`), engine)).status, 401);
    const page = await handleHttp(new Request(`${BASE}/app`), engine);
    assert.match(page.headers.get('content-security-policy') ?? '', /script-src 'self' https:\/\/telegram\.org/);
    const script = await (await handleHttp(new Request(`${BASE}/app.js`), engine)).text();
    assert.ok(script.includes('var TFS = ["1m","3m","5m","15m","1h","4h"];'), 'the coin picker offers all six timeframes');
    assert.ok(script.includes('tg.openLink(url)'), 'chart buttons open outside Telegram');
    const btc = (body.coins as unknown as { symbol: string; chartUrl: string; deltaUrl: string }[]).find(c => c.symbol === 'BTCUSD')!;
    assert.equal(btc.chartUrl, 'https://www.tradingview.com/chart/?symbol=DELTAIN%3ABTCUSD.P&interval=15');
    assert.equal(btc.deltaUrl, 'https://www.delta.exchange/app/futures/trade/BTC/BTCUSD');
    const fast = await handleHttp(new Request(`${BASE}/api/coins`, { method: 'POST', headers, body: JSON.stringify({ symbol: 'ETHUSD', timeframes: ['1m', '3m'] }) }), engine);
    assert.equal(fast.status, 200);
  });

  it('runtime sync needs the key derived from the bot token', async () => {
    const { w, engine } = setup();
    await runUntil(w, engine, START + MIN);
    assert.equal((await handleHttp(new Request(`${BASE}/api/sync/state`), engine)).status, 403);
    const res = await handleHttp(new Request(`${BASE}/api/sync/state`, { headers: { authorization: `Bearer ${await syncKey(TOKEN)}` } }), engine);
    assert.equal(res.status, 200);
    const state = (await res.json()) as { settings: unknown; watch: unknown[] };
    assert.equal(state.watch.length, 2);
    const hb = await handleHttp(new Request(`${BASE}/api/sync/heartbeat`, { method: 'POST', body: '{"role":"standby"}', headers: { authorization: `Bearer ${await syncKey(TOKEN)}` } }), engine);
    assert.deepEqual(await hb.json(), { role: 'active' });
    const put = await handleHttp(new Request(`${BASE}/api/sync/state`, { method: 'PUT', body: JSON.stringify(state), headers: { authorization: `Bearer ${await syncKey(TOKEN)}` } }), engine);
    assert.equal(put.status, 409, 'an active Cloudflare keeps its own settings');
  });
});
