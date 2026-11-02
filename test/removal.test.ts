// Settings > Removal (item 3, 2026-11-02): Manual keeps watched coins until the owner removes them; Auto removes a
// coin after 4 h below the volume filter and lets it join again by itself. Also the one-choice new-coin timeframe
// (1m to 1h, 30m included).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { TelegramUpdate } from '../core/notify/telegram.ts';
import { openSqlite } from '../runtimes/docker/sqlite.ts';
import { CHAT, FakeWorld, MIN, makeEngine, envFor, runUntil } from './fake-world.ts';
import type { Engine } from '../core/app/engine.ts';

const START = Date.UTC(2026, 10, 2, 3, 0, 3500);
const H = 60 * MIN;
let nextUpdate = 7000;

const callback = (data: string): TelegramUpdate => ({ update_id: nextUpdate++, callback_query: { id: `cb${nextUpdate}`, from: { id: Number(CHAT) }, data, message: { message_id: 55, chat: { id: Number(CHAT), type: 'private' } } } });

function setup() {
  const w = new FakeWorld(START);
  w.coins.set('BTCUSD', { turnover: 400e6, price: () => 100 });
  w.coins.set('SOLUSD', { turnover: 50e6, price: () => 20 });
  const db = openSqlite(':memory:');
  const engine = makeEngine(w, 'Cloudflare', envFor(), db);
  return { w, db, engine };
}

const toasts = (w: FakeWorld): string[] => w.telegram.filter(c => c.method === 'answerCallbackQuery').map(c => String(c.body.text ?? ''));
const screens = (w: FakeWorld): string[] => w.telegram.filter(c => c.method === 'editMessageText').map(c => String(c.body.text));
const watched = (e: Engine, symbol: string) => e.watchRows().find(r => r.symbol === symbol);

describe('Settings > Removal', () => {
  it('Manual (the default): a coin below the filter stays, for as long as it takes', async () => {
    const { w, engine } = setup();
    await runUntil(w, engine, START + 2 * MIN);
    assert.equal(engine.settings().coins.removal, 'manual');
    w.coins.get('SOLUSD')!.turnover = 2e6;
    await runUntil(w, engine, w.now + 5 * H);
    assert.equal(watched(engine, 'SOLUSD')?.status, 'active');
    assert.ok(!w.sent().some(t => /Removed/.test(t)));
  });

  it('Auto: removes the coin after 4 h below the filter, with a note, and it joins again by itself when back above', async () => {
    const { w, db, engine } = setup();
    await runUntil(w, engine, START + 2 * MIN);
    await engine.handleTelegramUpdate(callback('rm:auto'));
    assert.equal(engine.settings().coins.removal, 'auto');
    assert.match(toasts(w).at(-1)!, /Removal: Auto \(after 4 h below the filter\)/);
    assert.ok(engine.store.seriesAll().some(r => r.symbol === 'SOLUSD'), 'SOL has signal state while watched');

    const dropAt = w.now;
    w.coins.get('SOLUSD')!.turnover = 2e6;
    await runUntil(w, engine, dropAt + 3.5 * H);
    assert.equal(watched(engine, 'SOLUSD')?.status, 'active', 'still watched 3.5 h into the dip');
    const pickerSol = engine.coinList().find(c => c.symbol === 'SOLUSD')!;
    assert.ok(pickerSol.autoRemoveAt !== null && pickerSol.autoRemoveAt > w.now, 'the coin picker says when it goes');

    w.clearTelegram();
    await runUntil(w, engine, dropAt + 4.5 * H);
    assert.equal(watched(engine, 'SOLUSD'), undefined, 'removed and forgotten');
    assert.ok(!engine.store.seriesAll().some(r => r.symbol === 'SOLUSD'), 'its signal state is deleted');
    assert.equal(watched(engine, 'BTCUSD')?.status, 'active', 'coins above the filter are untouched');
    const note = w.sent().find(t => /Removed/.test(t));
    assert.match(note ?? '', /Removed<\/b> \(Removal: Auto\): SOLUSD \(\$2M\)\. 24 h volume below your \$10M filter for 4 h/);
    assert.match(note!, /joins again by itself on 15m/);
    const audit = db.all<{ actor: string; change: string }>("SELECT actor, change FROM settings_audit WHERE actor = 'removal auto'");
    assert.deepEqual(audit, [{ actor: 'removal auto', change: 'SOLUSD removed: below the $10M volume filter for 4 h or more' }]);

    w.clearTelegram();
    w.coins.get('SOLUSD')!.turnover = 30e6;
    await runUntil(w, engine, w.now + 20 * MIN);
    assert.deepEqual([watched(engine, 'SOLUSD')?.status, watched(engine, 'SOLUSD')?.timeframes, watched(engine, 'SOLUSD')?.origin], ['active', ['15m'], 'auto']);
    assert.ok(w.sent().some(t => /Joined the watchlist<\/b> on 15m: SOLUSD/.test(t)), 'with the usual "joined" note');
  });

  it('switching to Auto removes at once the coins already below the filter for 4 h', async () => {
    const { w, engine } = setup();
    await runUntil(w, engine, START + 2 * MIN);
    w.coins.get('SOLUSD')!.turnover = 2e6;
    await runUntil(w, engine, w.now + 4.5 * H); // Manual: noted, kept
    assert.equal(watched(engine, 'SOLUSD')?.status, 'active');
    w.clearTelegram();
    await engine.handleTelegramUpdate(callback('rm:auto'));
    assert.equal(watched(engine, 'SOLUSD'), undefined);
    await runUntil(w, engine, w.now + MIN); // the note goes out with the next delivery
    assert.ok(w.sent().some(t => /Removed<\/b> \(Removal: Auto\): SOLUSD/.test(t)));
    await engine.handleTelegramUpdate(callback('rm:manual'));
    assert.equal(engine.settings().coins.removal, 'manual');
  });

  it('the menu explains both modes and shows the current one', async () => {
    const { w, engine } = setup();
    await runUntil(w, engine, START + MIN);
    w.clearTelegram();
    await engine.handleTelegramUpdate(callback('nav:set'));
    assert.match(screens(w).at(-1)!, /<b>Removal<\/b> Manual: coins already on your watchlist stay until you remove them\./);
    await engine.handleTelegramUpdate(callback('nav:rm'));
    const screen = screens(w).at(-1)!;
    assert.match(screen, /<b>Manual<\/b>: it stays until you remove it/);
    assert.match(screen, /<b>Auto<\/b>: it is removed after 4 h below the filter \(checked every 15 min\)/);
    await engine.handleTelegramUpdate(callback('rm:sometimes'));
    assert.equal(toasts(w).at(-1), 'Unknown removal mode');
    assert.equal(engine.settings().coins.removal, 'manual');
  });
});

describe('Removal: Auto, the hard cases (second review, 2026-11-02)', () => {
  it('a candle check in flight never writes state back for a coin removed meanwhile (no stale alerts when it rejoins)', async () => {
    const w = new FakeWorld(START);
    for (const s of ['AAAUSD', 'BBBUSD', 'CCCUSD', 'DDDUSD', 'EEEUSD', 'FFFUSD', 'GGGUSD']) w.coins.set(s, { turnover: 100e6, price: t => 100 + Math.sin(t / (20 * MIN)) * 5 });
    w.coins.set('ZZZUSD', { turnover: 50e6, price: t => 20 + Math.sin(t / (25 * MIN)) * 2 }); // checked in the second batch
    let gate: Promise<void> | null = null;
    let release: () => void = () => {};
    const fetch = w.fetch;
    w.fetch = async (url, init) => {
      if (gate && url.includes('/v2/history/candles') && url.includes('symbol=AAAUSD')) await gate;
      return fetch(url, init);
    };
    const engine = makeEngine(w);
    await runUntil(w, engine, START + 3 * MIN);
    w.coins.get('ZZZUSD')!.turnover = 2e6;
    const close = Math.ceil((w.now + 4.5 * H) / (15 * MIN)) * 15 * MIN;
    await runUntil(w, engine, close - MIN + 3500); // Manual: the dip is noted, the coin kept
    assert.equal(watched(engine, 'ZZZUSD')?.status, 'active');

    gate = new Promise(r => (release = r));
    w.now = close + 3500;
    w.heartbeat();
    const running = engine.wake(); // the 15m close: the first batch waits on Delta
    await new Promise(r => setTimeout(r, 15));
    await engine.handleTelegramUpdate(callback('rm:auto')); // removes ZZZUSD meanwhile
    assert.equal(watched(engine, 'ZZZUSD'), undefined);
    gate = null;
    release();
    await running;
    assert.ok(!engine.store.seriesAll().some(r => r.symbol === 'ZZZUSD'), 'no series row came back for the removed coin');
  });

  it('a settings change while Delta is down tracks dips but removes nothing on the old ticker list', async () => {
    const { w, engine } = setup();
    await runUntil(w, engine, START + 2 * MIN);
    w.coins.get('SOLUSD')!.turnover = 2e6;
    await runUntil(w, engine, w.now + 4.5 * H); // Manual: the dip is noted, the coin kept
    w.deltaDown = true;
    await runUntil(w, engine, w.now + 17 * MIN); // the ticker list in memory is now older than the regular check
    await engine.handleTelegramUpdate(callback('rm:auto'));
    assert.equal(watched(engine, 'SOLUSD')?.status, 'active', 'not on a ticker list from before the outage');
    w.deltaDown = false;
    await runUntil(w, engine, w.now + 16 * MIN);
    assert.equal(watched(engine, 'SOLUSD'), undefined, 'removed at the first check with a fresh list');
  });

  it('the coin picker shows no removal warning once the coin is back above the filter', async () => {
    const { w, engine } = setup();
    await runUntil(w, engine, START + 2 * MIN);
    await engine.handleTelegramUpdate(callback('rm:auto'));
    w.coins.get('SOLUSD')!.turnover = 2e6;
    await runUntil(w, engine, w.now + 20 * MIN);
    assert.notEqual(engine.coinList().find(c => c.symbol === 'SOLUSD')!.autoRemoveAt, null);
    w.coins.get('SOLUSD')!.turnover = 40e6;
    w.now += 2 * MIN;
    await engine.freshTickers(); // the coin picker refreshes prices; the rules run at the next check
    assert.equal(engine.coinList().find(c => c.symbol === 'SOLUSD')!.autoRemoveAt, null);
  });

  it('Manual is stored and synced without the new key, so older code (a rollback, a spare not rebuilt) still reads it', async () => {
    const { w, db, engine } = setup();
    await runUntil(w, engine, START + MIN);
    await engine.handleTelegramUpdate(callback('m:0.08'));
    const stored = () => JSON.parse(db.all<{ json: string }>('SELECT json FROM settings WHERE id = 1')[0]!.json) as { coins: Record<string, unknown> };
    assert.deepEqual(Object.keys(stored().coins), ['volumeThresholdUsd', 'defaultTimeframes'], 'the keys code from before this update knows');
    assert.ok(!('removal' in (engine.exportState().settings as { coins: object }).coins));
    await engine.handleTelegramUpdate(callback('rm:auto'));
    assert.equal(stored().coins.removal, 'auto', 'Auto has to be written');
    assert.equal(engine.settings().coins.removal, 'auto');
  });

  it('a Docker spare that cannot read Cloudflare\'s settings says so once in the chat and in /health', async () => {
    const w = new FakeWorld(START);
    w.coins.set('BTCUSD', { turnover: 400e6, price: () => 100 });
    w.webhookUrl = 'https://example.invalid/telegram/webhook'; // Cloudflare holds Telegram: Docker stays on standby
    w.publicHealth = { instance: 'cf', role: 'active' };
    w.syncState = { settings: { coins: { volumeThresholdUsd: 10e6, defaultTimeframes: ['15m'], fromTheFuture: true } }, watch: [] };
    const docker = makeEngine(w, 'Docker', envFor({ role: 'standby' }));
    await runUntil(w, docker, START + 20 * MIN);
    assert.equal(docker.status().role, 'standby');
    assert.equal(w.sent().filter(t => /Docker spare out of date/.test(t)).length, 1, 'once, not every 5 minutes');
    assert.match(docker.status().problems.join('\n'), /Cloudflare settings rejected \(rebuild the Docker spare\): unknown setting: coins\.fromTheFuture/);
    w.syncState = { settings: { coins: { volumeThresholdUsd: 10e6, defaultTimeframes: ['15m'] } }, watch: [] };
    await runUntil(w, docker, w.now + 6 * MIN);
    assert.ok(!docker.status().problems.some(p => /rejected/.test(p)), 'cleared once a sync works');
  });
});

describe('Settings > New coins: one timeframe, 1m to 1h', () => {
  it('sets a single timeframe, 30m included; 4h is not offered for new coins', async () => {
    const { w, engine } = setup();
    await runUntil(w, engine, START + MIN);
    w.clearTelegram();
    await engine.handleTelegramUpdate(callback('nav:tf'));
    const keyboard = JSON.stringify(w.telegram.filter(c => c.method === 'editMessageText').at(-1)!.body.reply_markup);
    for (const tf of ['1m', '3m', '5m', '15m', '30m', '1h']) assert.ok(keyboard.includes(`"callback_data":"tf:${tf}"`), tf);
    assert.ok(!keyboard.includes('tf:4h'));
    await engine.handleTelegramUpdate(callback('tf:30m'));
    assert.deepEqual(engine.settings().coins.defaultTimeframes, ['30m']);
    assert.equal(toasts(w).at(-1), 'New coins start on 30m');
    await engine.handleTelegramUpdate(callback('tf:5m'));
    assert.deepEqual(engine.settings().coins.defaultTimeframes, ['5m'], 'replaces, never adds');
    await engine.handleTelegramUpdate(callback('tf:4h'));
    assert.deepEqual(engine.settings().coins.defaultTimeframes, ['5m']);
    assert.equal(toasts(w).at(-1), 'Unknown timeframe');

    w.coins.set('NEWUSD', { turnover: 30e6, price: () => 3 });
    await runUntil(w, engine, w.now + 16 * MIN);
    assert.deepEqual(watched(engine, 'NEWUSD')?.timeframes, ['5m'], 'a coin that joins starts on the chosen timeframe');
  });

  it('30m works as a coin timeframe end to end (candles, baseline, chart link)', async () => {
    const { w, engine } = setup();
    await runUntil(w, engine, START + MIN);
    assert.deepEqual(engine.setCoinTimeframes('BTCUSD', ['30m'], 'test'), { ok: true, message: 'BTCUSD: 30m' });
    await runUntil(w, engine, w.now + 2 * MIN);
    assert.ok(engine.store.seriesAll().some(r => r.symbol === 'BTCUSD' && r.timeframe === '30m'), 'the 30m series has its baseline');
  });
});
