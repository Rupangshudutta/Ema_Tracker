// End-to-end tests of the engine against a simulated Delta, Telegram and clock (test/fake-world.ts).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SYSTEM, TIMEFRAME_MS } from '../core/config/settings.ts';
import { closedSeries } from '../core/domain/candles.ts';
import { evaluateConfirmed } from '../core/domain/signal.ts';
import { BASE, FakeWorld, MIN, envFor, makeEngine, runUntil, settle } from './fake-world.ts';

const TF = TIMEFRAME_MS['15m'];
const PIVOT = Date.UTC(2026, 9, 20, 3, 0, 0); // 08:30 IST, a 15m boundary
const PAIR = { fast: SYSTEM.signal.emaFast, slow: SYSTEM.signal.emaSlow };

/** Falls 0.05% per 15 min until the pivot, then rises 0.6% per 15 min: EMA 9 crosses above EMA 15 a few candles later. */
const turnUp = (pivot: number) => (t: number): number => (t < pivot ? 100 + ((pivot - t) / TF) * 0.05 : 100 + ((t - pivot) / TF) * 0.6);
/** A steady fall: the confirmed side stays BELOW. */
const falling = (t: number): number => 100 - ((t - PIVOT) / TF) * 0.05 + 50;
const flat = (): number => 2000;

/** The candle whose close confirms the bullish cross, computed with the domain rule itself. */
function expectedCross(price: (t: number) => number, from: number, to: number): number {
  const rows = [];
  for (let s = from; s < to; s += TF) rows.push({ start: s, open: 0, high: 0, low: 0, close: price(s + TF - 1), volume: 1 });
  const check = closedSeries(rows, TF, to, 15);
  assert.ok(check.ok);
  const res = evaluateConfirmed(check.candles, PAIR, 0.05, null, PIVOT);
  assert.equal(res.crosses.length, 1);
  return res.crosses[0]!.candleStart;
}

function world(start: number): FakeWorld {
  const w = new FakeWorld(start);
  w.coins.set('BTCUSD', { turnover: 400e6, price: turnUp(PIVOT) });
  w.coins.set('ETHUSD', { turnover: 200e6, price: flat });
  w.coins.set('LOWUSD', { turnover: 2e6, price: flat });
  return w;
}

const count = (texts: string[], re: RegExp): number => texts.filter(t => re.test(t)).length;
// Alert headers only (the help and start-up texts also mention these words).
const REALTIME = /⚡ <b>REALTIME<\/b>/;
const CONFIRMED = /✅ <b>CONFIRMED<\/b>/;
const NOT_CONFIRMED = /❌ <b>NOT CONFIRMED<\/b>/;
const CANCELLED = /REALTIME CANCELLED<\/b>/;

describe('engine on Cloudflare: start-up', () => {
  it('claims the webhook, announces itself, adds coins above the filter on 15m and sends no alerts from history', async () => {
    const w = world(PIVOT - 60 * MIN + 3500);
    const engine = makeEngine(w);
    await engine.wake();
    await settle();
    await engine.wake();
    assert.equal(w.webhookUrl, `${BASE}/telegram/webhook`);
    assert.ok(w.telegram.some(c => c.method === 'setMyCommands'));
    assert.ok(w.telegram.some(c => c.method === 'setChatMenuButton'));
    const texts = w.sent();
    assert.equal(count(texts, /EMA Tracker started<\/b> · Cloudflare\nFirst start/), 1);
    assert.match(texts.find(t => /Joined the watchlist/.test(t))!, /on 15m: BTCUSD \(\$400M, 24h \+1\.50%\), ETHUSD \(\$200M, 24h \+1\.50%\)/);
    assert.equal(count(texts, /LOWUSD/), 0);
    assert.equal(count(texts, REALTIME) + count(texts, CONFIRMED), 0);
    const st = engine.status();
    assert.equal(st.role, 'active');
    assert.equal(st.coins.active, 2);
    assert.equal(st.coins.series, 2);
    await settle();
    await engine.wake();
    assert.ok(w.feedConnected, 'the live feed opens for the watchlist');
    assert.ok(w.feedSent.some(m => m.includes('enable_heartbeat')));
    assert.ok(w.feedSent.some(m => m.includes('"subscribe"') && m.includes('BTCUSD') && m.includes('ETHUSD')));
  });
});

describe('engine on Cloudflare: alerts', () => {
  it('sends one REALTIME alert while the cross candle is open, then one CONFIRMED alert at its close', async () => {
    const cross = expectedCross(turnUp(PIVOT), PIVOT - 300 * TF, PIVOT + 20 * TF);
    const w = world(PIVOT - 60 * MIN + 3500);
    const engine = makeEngine(w);
    await runUntil(w, engine, cross - 30 * MIN);
    w.clearTelegram();

    for (let m = 1; m < 15; m++) {
      await runUntil(w, engine, cross + m * MIN + 10_000);
      w.tick('BTCUSD');
      await settle();
      await engine.wake();
    }
    const during = w.sent();
    assert.equal(count(during, REALTIME), 1, during.join('\n---\n'));
    assert.match(during.find(t => REALTIME.test(t))!, /BTCUSD 15m<\/b> bullish cross/);
    assert.equal(count(during, CONFIRMED), 0);

    await runUntil(w, engine, cross + TF + 10_000);
    const confirmed = w.sent().filter(t => CONFIRMED.test(t));
    assert.equal(confirmed.length, 1);
    assert.match(confirmed[0]!, /realtime alert came \d+ min( \d+ s)? before the close/);
    assert.doesNotMatch(confirmed[0]!, /LATE/);

    await runUntil(w, engine, cross + 4 * TF);
    assert.equal(count(w.sent(), CONFIRMED), 1, 'no repeat while the side stays the same');
    assert.equal(count(w.sent(), REALTIME), 1);
  });

  it('cancels a realtime cross that reverses, and says NOT CONFIRMED when the close disagrees', async () => {
    const w = new FakeWorld(PIVOT + 3500);
    w.coins.set('DOWNUSD', { turnover: 50e6, price: falling });
    const engine = makeEngine(w);
    await runUntil(w, engine, PIVOT + TF + 2 * MIN);
    w.clearTelegram();
    const base = falling(w.now);
    w.tick('DOWNUSD', base * 1.05);
    await settle();
    await engine.wake();
    w.tick('DOWNUSD', base * 1.06);
    await settle();
    await engine.wake();
    assert.equal(count(w.sent(), REALTIME), 1, 'one realtime alert per candle');
    w.now += MIN;
    w.tick('DOWNUSD', base * 0.98);
    await settle();
    await engine.wake();
    assert.equal(count(w.sent(), CANCELLED), 1);
    await runUntil(w, engine, PIVOT + 2 * TF + 10_000);
    assert.equal(count(w.sent(), NOT_CONFIRMED) + count(w.sent(), CONFIRMED), 0, 'the cancel note already told the story');

    w.clearTelegram();
    await runUntil(w, engine, PIVOT + 2 * TF + 3 * MIN);
    w.tick('DOWNUSD', falling(w.now) * 1.05);
    await settle();
    await engine.wake();
    await runUntil(w, engine, PIVOT + 3 * TF + 10_000);
    const texts = w.sent();
    assert.equal(count(texts, REALTIME), 1);
    assert.equal(count(texts, NOT_CONFIRMED), 1);
  });

  it('catches up after an outage: the missed cross arrives marked LATE', async () => {
    const cross = expectedCross(turnUp(PIVOT), PIVOT - 300 * TF, PIVOT + 20 * TF);
    const w = world(PIVOT - 60 * MIN + 3500);
    const engine = makeEngine(w);
    await runUntil(w, engine, cross - 20 * MIN);
    w.clearTelegram();
    w.now = cross + TF + 20 * MIN + 3500; // the engine was down for 40 min across the close
    await engine.wake();
    await settle();
    await engine.wake();
    const confirmed = w.sent().filter(t => CONFIRMED.test(t));
    assert.equal(confirmed.length, 1);
    assert.match(confirmed[0]!, /^⏰ <b>LATE<\/b> by 20 min/);
  });
});

describe('engine on Cloudflare: watchlist, standby and reports', () => {
  it('removing a coin closes its live feed and keeps it out even while it is above the filter', async () => {
    const w = world(PIVOT - 60 * MIN + 3500);
    const engine = makeEngine(w);
    await runUntil(w, engine, PIVOT - 50 * MIN);
    const r = engine.setCoinTimeframes('ETHUSD', [], 'user:777');
    assert.equal(r.ok, true);
    assert.ok(w.feedSent.some(m => m.includes('"unsubscribe"') && m.includes('ETHUSD')));
    await runUntil(w, engine, PIVOT - 50 * MIN + SYSTEM.coins.universeRefreshMinutes * MIN + 2 * MIN);
    const eth = engine.watchRows().find(row => row.symbol === 'ETHUSD');
    assert.equal(eth?.status, 'removed');
    assert.equal(engine.status().coins.active, 1);
    assert.deepEqual(engine.setCoinTimeframes('ETHUSD', ['5m', '1h'], 'user:777'), { ok: true, message: 'ETHUSD added: 5m, 1h' });
    assert.equal(engine.setCoinTimeframes('LOWUSD', ['5m'], 'user:777').ok, false, 'coins below the filter cannot be added');
  });

  it('goes to standby when the webhook points elsewhere and then sends nothing', async () => {
    const w = world(PIVOT - 60 * MIN + 3500);
    const engine = makeEngine(w);
    await runUntil(w, engine, PIVOT - 55 * MIN);
    w.webhookUrl = 'https://elsewhere.example/hook';
    await runUntil(w, engine, PIVOT - 53 * MIN);
    assert.equal(engine.status().role, 'standby');
    w.clearTelegram();
    const cross = expectedCross(turnUp(PIVOT), PIVOT - 300 * TF, PIVOT + 20 * TF);
    await runUntil(w, engine, cross + TF + 10_000);
    assert.equal(w.sent().length, 0);
    const alerts = engine.status().alerts;
    assert.ok(alerts.found >= 1 && alerts.heldBack === alerts.found, `found ${alerts.found}, held back ${alerts.heldBack}`);
  });

  it('sends the daily report at 09:00 India time once, and pings Healthchecks every 5 minutes', async () => {
    const w = world(PIVOT - 10 * MIN + 3500); // 08:20 IST
    const engine = makeEngine(w);
    await runUntil(w, engine, PIVOT + 45 * MIN); // past 09:00 IST
    const reports = w.sent().filter(t => /Daily report/.test(t));
    assert.equal(reports.length, 1);
    assert.match(reports[0]!, /I'm alive: Cloudflare is sending alerts/);
    assert.ok(w.health.length >= 10, `pings: ${w.health.length}`);
    assert.ok(w.health.every(h => h === 'ok'));
  });

  it('warns once when Delta stops answering, and says when it is back', async () => {
    const w = world(PIVOT - 60 * MIN + 3500);
    const engine = makeEngine(w);
    await runUntil(w, engine, PIVOT - 50 * MIN);
    w.clearTelegram();
    w.deltaDown = true;
    await runUntil(w, engine, PIVOT - 38 * MIN);
    assert.equal(count(w.sent(), /Delta API not answering/), 1);
    assert.ok(w.health.includes('/fail'));
    w.deltaDown = false;
    await runUntil(w, engine, PIVOT - 25 * MIN);
    assert.equal(count(w.sent(), /Delta API answering again/), 1);
  });

  it('runs on standby without Telegram secrets and reports the problem', async () => {
    const w = world(PIVOT - 60 * MIN + 3500);
    const engine = makeEngine(w, 'Cloudflare', null);
    await runUntil(w, engine, PIVOT - 55 * MIN);
    const st = engine.status();
    assert.equal(st.role, 'standby');
    assert.match(st.roleReason, /TELEGRAM_BOT_TOKEN/);
    assert.equal(w.telegram.length, 0);
  });
});

describe('engine in Docker: who sends', () => {
  it('stays on standby while Cloudflare holds the webhook and takes over when it is released', async () => {
    const w = world(PIVOT - 60 * MIN + 3500);
    w.webhookUrl = `${BASE}/telegram/webhook`;
    const docker = makeEngine(w, 'Docker', envFor({ role: 'standby' }));
    await runUntil(w, docker, PIVOT - 58 * MIN);
    assert.equal(docker.status().role, 'standby');
    w.webhookUrl = '';
    await runUntil(w, docker, PIVOT - 56 * MIN);
    assert.equal(docker.status().role, 'active');
  });

  it('with RUNTIME_ROLE=active takes the Telegram connection at start', async () => {
    const w = world(PIVOT - 60 * MIN + 3500);
    w.webhookUrl = `${BASE}/telegram/webhook`;
    const docker = makeEngine(w, 'Docker', envFor({ role: 'active' }));
    await runUntil(w, docker, PIVOT - 58 * MIN);
    assert.equal(w.webhookUrl, '');
    assert.equal(docker.status().role, 'active');
    assert.ok(w.telegram.some(c => c.method === 'deleteWebhook'));
  });
});
