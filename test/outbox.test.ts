import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deliver, type Sender } from '../core/app/outbox.ts';
import type { AlertPayload, MessagePayload } from '../core/app/messages.ts';
import type { TelegramFailure, TelegramResult } from '../core/notify/telegram.ts';
import { Store } from '../core/store/store.ts';
import { openSqlite } from '../runtimes/docker/sqlite.ts';

const MIN = 60_000;
const CLOSE = Date.UTC(2026, 9, 19, 10, 15, 0); // a 15m candle close
const TZ = 'Asia/Kolkata';

class FakeSender implements Sender {
  texts: string[] = [];
  failures: TelegramFailure[] = [];
  private nextId = 100;
  async sendMessage(_chatId: string, html: string): Promise<TelegramResult> {
    const failure = this.failures.shift();
    if (failure) return { ok: false, error: failure };
    this.texts.push(html);
    return { ok: true, messageId: this.nextId++ };
  }
}

function confirmed(symbol: string, candleStart = CLOSE - 15 * MIN): AlertPayload {
  return { type: 'confirmed', symbol, timeframe: '15m', direction: 'up', candleStart, close: 101.5, spreadPct: 0.081, marginPct: 0.05, realtimeAt: null, realtimeCancelled: false, ctx: null };
}

function setup(): Store {
  const store = new Store(openSqlite(':memory:'));
  store.migrate();
  return store;
}

function add(store: Store, id: string, payload: MessagePayload, eventAt: number, now = eventAt): void {
  store.enqueue({ id, kind: payload.type === 'note' ? 'note' : 'alert', payload: JSON.stringify(payload), eventAt, status: 'pending' }, now);
}

const run = (store: Store, sender: Sender, now: number, maxSends = 40) => deliver({ store, sender, chatId: '1', now, timeZone: TZ, maxSends });
const statusOf = (store: Store, id: string): string | undefined => store.recentMessages(100).find(m => m.id === id)?.status;

describe('outbox delivery', () => {
  it('sends a recorded alert once and never again', async () => {
    const store = setup();
    const sender = new FakeSender();
    add(store, 'a1', confirmed('BTCUSD'), CLOSE);
    const r = await run(store, sender, CLOSE + 4000);
    assert.equal(r.sent, 1);
    assert.match(sender.texts[0]!, /CONFIRMED/);
    assert.doesNotMatch(sender.texts[0]!, /LATE/);
    assert.equal((await run(store, sender, CLOSE + 9000)).sent, 0);
    assert.equal(sender.texts.length, 1);
    assert.deepEqual(store.peekStats(), { sent_confirmed: 1 });
  });

  it('survives a crash between recording and sending: sent once after restart, the replayed alert is refused', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ema-outbox-'));
    try {
      const file = join(dir, 'notebook.db');
      const before = openSqlite(file);
      const s1 = new Store(before);
      s1.migrate();
      add(s1, 'a1', confirmed('BTCUSD'), CLOSE);
      before.close(); // crash: nothing was sent

      const after = openSqlite(file);
      const s2 = new Store(after);
      s2.migrate();
      add(s2, 'a1', confirmed('BTCUSD'), CLOSE); // the restarted engine recomputes the same candle
      const sender = new FakeSender();
      await run(s2, sender, CLOSE + 20_000);
      await run(s2, sender, CLOSE + 30_000);
      assert.equal(sender.texts.length, 1);
      after.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('retries after a network failure and marks the alert LATE when it finally goes out', async () => {
    const store = setup();
    const sender = new FakeSender();
    sender.failures.push({ kind: 'network', message: 'reset' });
    add(store, 'a1', confirmed('BTCUSD'), CLOSE);
    const first = await run(store, sender, CLOSE + 3000);
    assert.equal(first.error?.kind, 'network');
    assert.equal(statusOf(store, 'a1'), 'pending');
    assert.equal((await run(store, sender, CLOSE + 5000)).sent, 0, 'waits for the backoff');
    const later = await run(store, sender, CLOSE + 4 * MIN);
    assert.equal(later.sent, 1);
    assert.match(sender.texts[0]!, /LATE<\/b> by 4 min/);
  });

  it('obeys a Telegram 429 for every pending message', async () => {
    const store = setup();
    const sender = new FakeSender();
    sender.failures.push({ kind: 'rate-limited', retryAfterMs: 30_000 });
    add(store, 'a1', confirmed('BTCUSD'), CLOSE);
    add(store, 'a2', confirmed('ETHUSD'), CLOSE);
    await run(store, sender, CLOSE + 1000);
    assert.equal((await run(store, sender, CLOSE + 20_000)).sent, 0);
    assert.equal((await run(store, sender, CLOSE + 31_000)).sent, 2);
  });

  it('marks text Telegram refuses as failed and carries on with the rest', async () => {
    const store = setup();
    const sender = new FakeSender();
    sender.failures.push({ kind: 'rejected', status: 400, description: "can't parse entities" });
    add(store, 'a1', confirmed('BTCUSD'), CLOSE);
    add(store, 'a2', confirmed('ETHUSD'), CLOSE + 1);
    const r = await run(store, sender, CLOSE + 2000);
    assert.equal(r.failed, 1);
    assert.equal(r.sent, 1);
    assert.equal(statusOf(store, 'a1'), 'failed');
  });

  it('keeps messages pending for 10 min when Telegram refuses the bot (revoked token, blocked)', async () => {
    const store = setup();
    const sender = new FakeSender();
    sender.failures.push({ kind: 'rejected', status: 401, description: 'Unauthorized' });
    add(store, 'a1', confirmed('BTCUSD'), CLOSE);
    const r = await run(store, sender, CLOSE + 1000);
    assert.equal(r.error?.kind, 'rejected');
    assert.equal(statusOf(store, 'a1'), 'pending');
    assert.equal(store.pendingSummary().nextAt, CLOSE + 1000 + 10 * MIN);
  });

  it('bundles four or more due alerts into one digest', async () => {
    const store = setup();
    const sender = new FakeSender();
    for (const s of ['AUSD', 'BUSD', 'CUSD', 'DUSD']) add(store, s, confirmed(s), CLOSE);
    const r = await run(store, sender, CLOSE + 5000);
    assert.equal(r.calls, 1);
    assert.equal(r.sent, 4);
    assert.match(sender.texts[0]!, /4 alerts/);
  });

  it('lists alerts over 30 min late in one summary and drops those over 6 h', async () => {
    const store = setup();
    const sender = new FakeSender();
    add(store, 'old', confirmed('OLDUSD', CLOSE - 7 * 60 * MIN), CLOSE - 7 * 60 * MIN + 15 * MIN);
    add(store, 'mid', confirmed('MIDUSD', CLOSE - 60 * MIN), CLOSE - 45 * MIN);
    add(store, 'new', confirmed('NEWUSD'), CLOSE);
    const r = await run(store, sender, CLOSE + 10_000);
    assert.equal(r.expired, 1);
    assert.equal(r.missed, 1);
    assert.equal(r.sent, 1);
    assert.match(sender.texts[0]!, /Missed while offline.*\n.*MIDUSD[\s\S]*1 more was older than 6 h/);
    assert.match(sender.texts[1]!, /NEWUSD/);
    assert.equal(statusOf(store, 'old'), 'expired');
    assert.equal(statusOf(store, 'mid'), 'missed');
  });

  it('drops a realtime alert whose candle has already closed (the close result replaces it)', async () => {
    const store = setup();
    const sender = new FakeSender();
    const rt: AlertPayload = { type: 'realtime', symbol: 'BTCUSD', timeframe: '5m', direction: 'down', candleStart: CLOSE - 5 * MIN, price: 99, spreadPct: -0.06, marginPct: 0.05, ctx: null };
    add(store, 'rt1', rt, CLOSE - 2 * MIN);
    const r = await run(store, sender, CLOSE + 1000);
    assert.equal(r.superseded, 1);
    assert.equal(sender.texts.length, 0);
  });

  it('stops at the call budget and reports more work', async () => {
    const store = setup();
    const sender = new FakeSender();
    add(store, 'a1', confirmed('AUSD'), CLOSE);
    add(store, 'a2', confirmed('BUSD'), CLOSE + 1);
    const r = await run(store, sender, CLOSE + 1000, 1);
    assert.equal(r.sent, 1);
    assert.equal(r.more, true);
    assert.equal((await run(store, sender, CLOSE + 2000, 1)).sent, 1);
  });
});
