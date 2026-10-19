import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_USER_SETTINGS } from '../core/config/settings.ts';
import { Store } from '../core/store/store.ts';
import { openSqlite } from '../runtimes/docker/sqlite.ts';

const NOW = Date.UTC(2026, 9, 19, 12, 0, 0);

function fresh(): { store: Store; db: ReturnType<typeof openSqlite> } {
  const db = openSqlite(':memory:');
  const store = new Store(db);
  store.migrate();
  return { store, db };
}

describe('Store schema', () => {
  it('migrates once, is safe to run again, and drops the S0 probe tables', () => {
    const db = openSqlite(':memory:');
    db.run('CREATE TABLE probe_minute (minute_ts INTEGER PRIMARY KEY)');
    const store = new Store(db);
    store.migrate();
    store.migrate();
    assert.equal(store.getMeta('schema_version'), '1');
    assert.equal(db.all<{ n: number }>("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'probe_minute'")[0]!.n, 0);
  });

  it('rolls back everything written inside a failed transaction', () => {
    const { store } = fresh();
    assert.throws(() =>
      store.transaction(() => {
        store.setMeta('a', '1');
        store.enqueue({ id: 'x', kind: 'note', payload: '{}', eventAt: NOW, status: 'pending' }, NOW);
        throw new Error('crash mid-write');
      })
    );
    assert.equal(store.getMeta('a'), null);
    assert.equal(store.hasMessage('x'), false);
  });
});

describe('Store settings', () => {
  it('starts from the defaults and keeps an audit line for every change', () => {
    const { store, db } = fresh();
    assert.deepEqual(store.settings(), DEFAULT_USER_SETTINGS);
    const next = { ...DEFAULT_USER_SETTINGS, signal: { marginPct: 0.03 } };
    assert.deepEqual(store.saveSettings(next, 'user:1', 'margin 0.05 -> 0.03', NOW), { ok: true });
    assert.equal(store.settings().signal.marginPct, 0.03);
    assert.equal(new Store(db).settings().signal.marginPct, 0.03, 'a fresh Store reads it back from the database');
    const audit = db.all<{ actor: string; change: string }>('SELECT actor, change FROM settings_audit');
    assert.deepEqual(audit, [{ actor: 'user:1', change: 'margin 0.05 -> 0.03' }]);
  });

  it('refuses invalid values and reports stored corruption instead of hiding it', () => {
    const { store, db } = fresh();
    const bad = { ...DEFAULT_USER_SETTINGS, signal: { marginPct: 0.5 } };
    const r = store.saveSettings(bad, 'user:1', 'x', NOW);
    assert.equal(r.ok, false);
    db.run("INSERT INTO settings (id, json, updated_at) VALUES (1, '{not json', 0) ON CONFLICT(id) DO UPDATE SET json = excluded.json");
    const reader = new Store(db);
    const reported: string[][] = [];
    reader.onCorruptSettings = errors => reported.push(errors);
    assert.deepEqual(reader.settings(), DEFAULT_USER_SETTINGS);
    assert.equal(reported.length, 1);
  });
});

describe('Store watchlist and signal state', () => {
  it('round-trips watch rows and series records', () => {
    const { store } = fresh();
    store.saveWatch({ symbol: 'BTCUSD', timeframes: ['5m', '15m'], origin: 'user', status: 'active', belowSince: null, updatedAt: NOW });
    store.saveWatch({ symbol: 'XAUTUSD', timeframes: [], origin: 'auto', status: 'removed', belowSince: null, updatedAt: NOW });
    assert.deepEqual(store.watchList().map(w => [w.symbol, w.timeframes, w.status]), [['BTCUSD', ['5m', '15m'], 'active'], ['XAUTUSD', [], 'removed']]);

    const rec = {
      symbol: 'BTCUSD',
      timeframe: '15m' as const,
      state: { side: 'below' as const, marginPct: 0.05, lastCloseStart: NOW - 900_000, emaFast: 100.5, emaSlow: 101.25 },
      rt: { candleStart: NOW, alerted: 'up' as const, cancelled: false },
      rtAlertedAt: NOW + 61_000
    };
    store.saveSeries(rec, NOW);
    assert.deepEqual(store.seriesAll(), [rec]);
    store.saveSeries({ ...rec, rt: null, rtAlertedAt: null }, NOW);
    assert.equal(store.seriesAll()[0]!.rt, null);
    store.deleteSeries('BTCUSD', '15m');
    assert.equal(store.seriesAll().length, 0);
  });

  it('exports and imports the portable state (settings and watchlist)', () => {
    const a = fresh().store;
    a.saveSettings({ ...DEFAULT_USER_SETTINGS, coins: { volumeThresholdUsd: 20e6, defaultTimeframes: ['5m'] } }, 'user:1', 'x', NOW);
    a.saveWatch({ symbol: 'ETHUSD', timeframes: ['1h'], origin: 'user', status: 'active', belowSince: null, updatedAt: NOW });
    const b = fresh().store;
    b.saveWatch({ symbol: 'OLDUSD', timeframes: ['15m'], origin: 'auto', status: 'active', belowSince: null, updatedAt: NOW });
    assert.deepEqual(b.importState(JSON.parse(JSON.stringify(a.exportState())), 'sync', NOW), { ok: true });
    assert.equal(b.settings().coins.volumeThresholdUsd, 20e6);
    assert.deepEqual(b.watchList().map(w => w.symbol), ['ETHUSD']);
    assert.equal(b.importState({ settings: { signal: { marginPct: 9 } } as never, watch: [] }, 'sync', NOW).ok, false);
  });
});

describe('Store outbox, counters and housekeeping', () => {
  it('refuses a second message with the same ID (no duplicate alerts)', () => {
    const { store } = fresh();
    const entry = { id: 'abc', kind: 'alert' as const, payload: '{}', eventAt: NOW, status: 'pending' as const };
    assert.equal(store.enqueue(entry, NOW), true);
    assert.equal(store.enqueue(entry, NOW + 1), false);
    assert.equal(store.pendingSummary().count, 1);
  });

  it('adds counters and resets them when taken', () => {
    const { store } = fresh();
    store.addStats({ sent_confirmed: 2, late: 0 });
    store.addStats({ sent_confirmed: 1, failed: 1 });
    assert.deepEqual(store.takeStats(), { sent_confirmed: 3, failed: 1 });
    assert.deepEqual(store.peekStats(), {});
  });

  it('accepts each Telegram update once and prunes old rows', () => {
    const { store } = fresh();
    assert.equal(store.firstSeenUpdate(7, NOW), true);
    assert.equal(store.firstSeenUpdate(7, NOW), false);
    store.enqueue({ id: 'old', kind: 'note', payload: '{}', eventAt: NOW, status: 'suppressed' }, NOW);
    store.log(NOW, 'warn', 'test', 'x');
    store.prune(NOW + 30 * 24 * 60 * 60_000);
    assert.equal(store.hasMessage('old'), false);
    assert.equal(store.recentLog(5).length, 0);
    assert.equal(store.firstSeenUpdate(7, NOW), true, 'pruned update IDs are forgotten');
  });
});
