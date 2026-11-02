import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_USER_SETTINGS, SYSTEM, type UserSettings } from '../core/config/settings.ts';
import type { DeltaTicker } from '../core/exchange/delta.ts';
import { Feed, type FeedCallbacks } from '../core/app/feed.ts';
import { applyUniverse, editCoin } from '../core/app/watchlist.ts';
import type { WatchRow } from '../core/store/store.ts';

describe('live feed connection handling', () => {
  function harness() {
    const h = { now: Date.UTC(2026, 9, 20), sent: [] as string[], opens: 0, wakes: [] as number[], cb: null as FeedCallbacks | null, ticks: [] as string[] };
    const feed = new Feed(
      async callbacks => {
        h.opens++;
        h.cb = callbacks;
        return { send: d => h.sent.push(d), close: () => { h.cb = null; } };
      },
      symbol => h.ticks.push(symbol),
      () => h.now,
      () => {},
      at => h.wakes.push(at)
    );
    return { h, feed };
  }
  const drop = (h: ReturnType<typeof harness>['h']): void => {
    const cb = h.cb;
    h.cb = null;
    cb?.onClose(1006, 'gone');
  };

  it('opens with the heartbeat on, subscribes the watchlist and passes tickers on', async () => {
    const { h, feed } = harness();
    feed.setWanted(['BTCUSD', 'ETHUSD']);
    await feed.check();
    assert.equal(h.opens, 1);
    assert.equal(h.sent[0], '{"type":"enable_heartbeat"}');
    assert.match(h.sent[1]!, /"subscribe".*"BTCUSD","ETHUSD"/);
    h.cb!.onMessage(JSON.stringify({ type: 'v2/ticker', symbol: 'BTCUSD', close: '100', timestamp: h.now * 1000 }));
    assert.deepEqual(h.ticks, ['BTCUSD']);
    feed.setWanted(['BTCUSD']);
    assert.match(h.sent.at(-1)!, /"unsubscribe".*"ETHUSD"/);
  });

  it('backs off 2 s, 5 s, 15 s, 1 min, 5 min, 10 min after quick drops, and resets after a healthy minute', async () => {
    const { h, feed } = harness();
    feed.setWanted(['BTCUSD']);
    await feed.check();
    const waits: number[] = [];
    for (let i = 0; i < 7; i++) {
      h.now += 3000;
      drop(h);
      const next = feed.status().nextConnectAt!;
      waits.push((next - h.now) / 1000);
      h.now = next;
      await feed.check();
    }
    assert.deepEqual(waits, [5, 15, 60, 300, 600, 600, 600]);
    h.now += SYSTEM.realtime.healthyAfterSeconds * 1000 + 1000;
    h.cb!.onMessage('{"type":"heartbeat"}');
    assert.equal(feed.status().quickDrops, 0);
    h.now += 1000;
    drop(h);
    assert.equal((feed.status().nextConnectAt! - h.now) / 1000, 2);
  });

  it('drops a connection that has been silent for 35 s and closes it when no coins are wanted', async () => {
    const { h, feed } = harness();
    feed.setWanted(['BTCUSD']);
    await feed.check();
    h.now += 36_000;
    await feed.check();
    assert.equal(feed.status().connected, false);
    h.now = feed.status().nextConnectAt!;
    await feed.check();
    assert.equal(feed.status().connected, true);
    feed.setWanted([]);
    assert.equal(feed.status().connected, false);
    assert.equal(feed.status().downSince, null, 'no coins is idle, not down');
    assert.equal(feed.nextWakeAt(), null);
  });
});

describe('watchlist rules', () => {
  const NOW = 10_000_000;
  const s: UserSettings = DEFAULT_USER_SETTINGS;
  const t = (symbol: string, turnoverUsd24h: number, tradingStatus = 'operational'): DeltaTicker => ({ symbol, underlying: symbol.replace(/USD$/, ''), lastPrice: 1, markPrice: 1, turnoverUsd24h, change24hPct: 0, openInterestUsd: null, tradingStatus, timestampMs: NOW });
  const universe = (...list: DeltaTicker[]) => new Map(list.map(x => [x.symbol, x]));
  const row = (symbol: string, over: Partial<WatchRow> = {}): WatchRow => ({ symbol, timeframes: ['15m'], origin: 'auto', status: 'active', belowSince: null, lowVolumeSince: null, updatedAt: 0, ...over });

  it('adds coins above the filter on the default timeframes, biggest first, up to the cap', () => {
    const u = universe(t('A', 50e6), t('B', 20e6), t('C', 5e6), t('D', 30e6, 'halted'));
    const ch = applyUniverse([], u, s, NOW, 0, 1);
    assert.deepEqual(ch.joined.map(j => j.symbol), ['A']);
    assert.equal(ch.overCap, 1);
    assert.deepEqual(ch.rows[0]!.timeframes, ['15m']);
  });

  it('never re-adds a coin the user removed', () => {
    const ch = applyUniverse([row('A', { status: 'removed', timeframes: [] })], universe(t('A', 50e6)), s, NOW, 0);
    assert.equal(ch.rows.length, 0);
  });

  it('Removal: Manual keeps a watched coin whose volume drops, for days: only the owner removes coins', () => {
    const lowVolume = universe(t('A', 2e6));
    let rows = [row('A', { timeframes: ['3m', '15m'] })];
    for (const after of [0, 61 * 60_000, 3 * 24 * 60 * 60_000]) {
      const ch = applyUniverse(rows, lowVolume, s, NOW + after, 60 * 60_000);
      assert.equal(ch.removed.length, 0);
      assert.equal(ch.paused.length, 0);
      if (after === 0) assert.deepEqual(ch.rows.map(r => [r.status, r.timeframes, r.lowVolumeSince]), [['active', ['3m', '15m'], NOW]], 'only the start of the dip is noted');
      else assert.equal(ch.rows.length, 0, 'nothing about the coin changes');
      rows = rows.map(r => ch.rows.find(c => c.symbol === r.symbol) ?? r);
    }
  });

  it('a raised volume filter never pauses coins already watched; it only limits new ones', () => {
    const higher = { ...s, coins: { ...s.coins, volumeThresholdUsd: 20e6 } };
    const ch = applyUniverse([row('A')], universe(t('A', 15e6), t('NEW', 15e6)), higher, NOW, 60 * 60_000);
    assert.deepEqual(ch.rows.map(r => [r.symbol, r.status]), [['A', 'active']]);
    assert.equal(ch.removed.length, 0);
    assert.equal(ch.joined.length, 0, '15M is below the new 20M filter, so NEW does not join');
  });

  describe('Removal: Auto', () => {
    const auto: UserSettings = { ...s, coins: { ...s.coins, removal: 'auto' } };
    const H = 60 * 60_000;
    const run = (rows: WatchRow[], u: ReturnType<typeof universe>, at: number, settings = auto) => applyUniverse(rows, u, settings, at, H, 16, 4 * H);
    const next = (rows: WatchRow[], ch: ReturnType<typeof run>) => rows.filter(r => !ch.removed.some(x => x.symbol === r.symbol)).map(r => ch.rows.find(c => c.symbol === r.symbol) ?? r).concat(ch.rows.filter(c => !rows.some(r => r.symbol === c.symbol)));

    it('removes a coin after 4 h in a row below the filter, not before', () => {
      const low = universe(t('A', 2e6));
      let rows = [row('A', { timeframes: ['5m', '15m'], origin: 'user' })];
      for (const at of [0, H, 3 * H, 4 * H - 1]) {
        const ch = run(rows, low, NOW + at);
        assert.equal(ch.removed.length, 0, `still watched ${at / H} h into the dip`);
        rows = next(rows, ch);
      }
      assert.equal(rows[0]!.lowVolumeSince, NOW);
      const ch = run(rows, low, NOW + 4 * H);
      assert.deepEqual(ch.removed, [{ symbol: 'A', timeframes: ['5m', '15m'], turnoverUsd24h: 2e6 }], 'user-added coins too (the owner chose this)');
      assert.equal(ch.rows.length, 0, 'the row is deleted, not written');
    });

    it('a recovery above the filter restarts the 4 h count', () => {
      let rows = [row('A')];
      rows = next(rows, run(rows, universe(t('A', 2e6)), NOW));
      rows = next(rows, run(rows, universe(t('A', 50e6)), NOW + 3 * H));
      assert.equal(rows[0]!.lowVolumeSince, null);
      rows = next(rows, run(rows, universe(t('A', 2e6)), NOW + 3.5 * H));
      assert.equal(run(rows, universe(t('A', 2e6)), NOW + 7 * H).removed.length, 0, 'only 3.5 h into the new dip');
      assert.equal(run(rows, universe(t('A', 2e6)), NOW + 7.5 * H).removed.length, 1);
    });

    it('a removed coin joins again by itself on the new-coin timeframe once it is back above the filter', () => {
      let rows = [row('A', { timeframes: ['1h'], origin: 'user', lowVolumeSince: NOW - 4 * H })];
      const gone = run(rows, universe(t('A', 2e6)), NOW);
      assert.equal(gone.removed.length, 1);
      rows = next(rows, gone);
      assert.equal(rows.length, 0);
      const back = run(rows, universe(t('A', 30e6)), NOW + 15 * 60_000);
      assert.deepEqual(back.joined.map(j => j.symbol), ['A']);
      assert.deepEqual(back.rows.map(r => [r.symbol, r.timeframes, r.origin]), [['A', ['15m'], 'auto']]);
    });

    it('switching from Manual to Auto removes coins already low for 4 h; the cap slot goes to the next coin', () => {
      let rows = [row('A')];
      rows = next(rows, run(rows, universe(t('A', 2e6)), NOW, s));
      const ch = applyUniverse(rows, universe(t('A', 2e6), t('B', 40e6)), auto, NOW + 5 * H, H, 1, 4 * H);
      assert.deepEqual(ch.removed.map(r => r.symbol), ['A']);
      assert.deepEqual(ch.joined.map(j => j.symbol), ['B'], 'the freed slot is used at once');
    });

    it('never removes a coin Delta stops trading (that pauses it) or one the owner removed', () => {
      const rows = [row('H', { lowVolumeSince: NOW - 10 * H }), row('R', { status: 'removed', timeframes: [] })];
      const ch = run(rows, universe(t('H', 1e6, 'halted'), t('R', 1e6)), NOW);
      assert.equal(ch.removed.length, 0);
      const resumed = run([row('H', { status: 'paused', lowVolumeSince: NOW - 10 * H })], universe(t('H', 1e6)), NOW);
      assert.deepEqual(resumed.rows.map(r => [r.status, r.lowVolumeSince]), [['active', null]], 'a resumed coin starts a fresh count');
    });
  });

  it('pauses only when Delta stops trading the coin (after the grace), and resumes it when trading restarts', () => {
    const halted = universe(t('A', 50e6, 'halted'));
    const first = applyUniverse([row('A', { timeframes: ['5m', '1h'] })], halted, s, NOW, 60 * 60_000);
    assert.equal(first.rows[0]!.belowSince, NOW);
    assert.equal(first.paused.length, 0);
    const later = applyUniverse([first.rows[0]!], halted, s, NOW + 61 * 60_000, 60 * 60_000);
    assert.equal(later.rows[0]!.status, 'paused');
    const delisted = applyUniverse([first.rows[0]!], universe(), s, NOW + 61 * 60_000, 60 * 60_000);
    assert.deepEqual(delisted.paused, [{ symbol: 'A', turnoverUsd24h: null }]);
    const back = applyUniverse([later.rows[0]!], universe(t('A', 1e6)), s, NOW + 2 * 60 * 60_000, 60 * 60_000);
    assert.deepEqual(back.resumed, ['A'], 'trading again: back, even with low volume');
    assert.deepEqual(back.rows[0]!.timeframes, ['5m', '1h']);
  });

  it('brings back coins an older version paused for low volume', () => {
    const ch = applyUniverse([row('IRYSUSD', { status: 'paused', timeframes: ['3m', '15m'], belowSince: NOW - 60 * 60_000 })], universe(t('IRYSUSD', 4e6)), s, NOW, 60 * 60_000);
    assert.deepEqual(ch.resumed, ['IRYSUSD']);
    assert.equal(ch.rows[0]!.status, 'active');
  });

  it('lets the user tick timeframes, remove coins and re-add them, within the filter and the cap', () => {
    const u = universe(t('A', 50e6), t('LOW', 1e6));
    const edit = editCoin([row('A')], u, s, 'A', ['1h', '5m', '5m'], NOW);
    assert.ok(edit.ok && edit.row.timeframes.join() === '5m,1h' && edit.droppedTimeframes.join() === '15m');
    const removed = editCoin([row('A')], u, s, 'A', [], NOW);
    assert.ok(removed.ok && removed.row.status === 'removed');
    assert.equal(editCoin([], u, s, 'LOW', ['5m'], NOW).ok, false);
    const full = Array.from({ length: SYSTEM.coins.maxWatchlistCoins }, (_, i) => row(`C${i}`));
    const r = editCoin(full, u, s, 'A', ['5m'], NOW);
    assert.ok(!r.ok && /full/.test(r.reason));
  });
});
