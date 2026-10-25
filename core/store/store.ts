// The notebook: everything the bot must remember across restarts, in SQLite.
// Write budget: Cloudflare's free plan allows 100,000 written rows a day per account, so only state changes are
// written (one series row per candle close, outbox rows per message, warnings and errors in the log) and the coin
// universe is kept in memory and re-fetched after a restart.
import { DEFAULT_USER_SETTINGS, isTimeframe, validateUserSettings, type Timeframe, type UserSettings } from '../config/settings.ts';
import type { Direction, RealtimeCandle, Side, SignalState } from '../domain/signal.ts';
import type { SqlDriver } from './sql.ts';

/** A schema change (SQL statements) or a one-time data change (run inside the same transaction). */
type Migration = readonly string[] | ((store: Store, now: number) => void);

const MIGRATIONS: readonly Migration[] = [
  [
    // 1: v2 engine. Drops the S0 probe tables, which the engine replaces.
    'DROP TABLE IF EXISTS probe_minute',
    'DROP TABLE IF EXISTS probe_event',
    'DROP TABLE IF EXISTS probe_meta',
    'CREATE TABLE settings (id INTEGER PRIMARY KEY CHECK (id = 1), json TEXT NOT NULL, updated_at INTEGER NOT NULL)',
    'CREATE TABLE settings_audit (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, actor TEXT NOT NULL, change TEXT NOT NULL)',
    `CREATE TABLE watch (
       symbol TEXT PRIMARY KEY, timeframes TEXT NOT NULL,
       origin TEXT NOT NULL CHECK (origin IN ('auto', 'user')),
       status TEXT NOT NULL CHECK (status IN ('active', 'paused', 'removed')),
       below_since INTEGER, updated_at INTEGER NOT NULL)`,
    `CREATE TABLE series (
       symbol TEXT NOT NULL, timeframe TEXT NOT NULL,
       side TEXT CHECK (side IN ('above', 'below')), margin_pct REAL NOT NULL, last_close_start INTEGER NOT NULL,
       ema_fast REAL NOT NULL, ema_slow REAL NOT NULL,
       rt_candle_start INTEGER, rt_alerted TEXT CHECK (rt_alerted IN ('up', 'down')), rt_cancelled INTEGER NOT NULL DEFAULT 0,
       rt_alerted_at INTEGER, updated_at INTEGER NOT NULL,
       PRIMARY KEY (symbol, timeframe))`,
    `CREATE TABLE outbox (
       id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('alert', 'note')), payload TEXT NOT NULL,
       event_at INTEGER NOT NULL, created_at INTEGER NOT NULL, status TEXT NOT NULL,
       attempts INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL, sent_at INTEGER, message_id INTEGER, last_error TEXT)`,
    "CREATE INDEX outbox_pending ON outbox (next_at) WHERE status = 'pending'",
    'CREATE INDEX outbox_created ON outbox (created_at)',
    'CREATE TABLE log (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, level TEXT NOT NULL, kind TEXT NOT NULL, detail TEXT NOT NULL)',
    'CREATE INDEX log_at ON log (at)',
    'CREATE TABLE stats (key TEXT PRIMARY KEY, value INTEGER NOT NULL)',
    'CREATE TABLE telegram_update (update_id INTEGER PRIMARY KEY, at INTEGER NOT NULL)'
  ],
  // 2 (2026-10-25): coins that join because of their volume start on 15m again, as the owner asked (the stored
  // choice was 1h). Only this setting changes; coins already on the watchlist keep their timeframes. It stays
  // changeable in Settings > New coins.
  (store, now) => {
    const s = store.settings();
    const tfs = s.coins.defaultTimeframes;
    if (tfs.length === 1 && tfs[0] === '15m') return;
    store.saveSettings({ ...s, coins: { ...s.coins, defaultTimeframes: ['15m'] } }, 'update 2', `new-coin timeframes ${tfs.join(',')} -> 15m (owner request 2026-10-25)`, now);
  }
];

const DAY_MS = 24 * 60 * 60_000;
const RETAIN_MESSAGES_MS = 7 * DAY_MS;
const RETAIN_LOG_MS = 14 * DAY_MS;
const RETAIN_UPDATES_MS = 2 * DAY_MS;

export type WatchStatus = 'active' | 'paused' | 'removed';
export type WatchOrigin = 'auto' | 'user';

export interface WatchRow {
  symbol: string;
  /** Ticked timeframes, shortest first; empty only when status is 'removed'. */
  timeframes: Timeframe[];
  origin: WatchOrigin;
  status: WatchStatus;
  /** First time the coin was seen below the volume filter in the current dip, or null. */
  belowSince: number | null;
  updatedAt: number;
}

export interface SeriesRecord {
  symbol: string;
  timeframe: Timeframe;
  state: SignalState;
  /** Realtime bookkeeping for the open candle, or null before the first one. */
  rt: RealtimeCandle | null;
  /** When the realtime alert for `rt` was raised, so the confirmed alert can say how much earlier it came. */
  rtAlertedAt: number | null;
}

export type OutboxKind = 'alert' | 'note';
/**
 * pending     waiting to be sent (next_at says when)
 * sent        delivered (alone or inside a digest or summary)
 * suppressed  recorded while paused or while this runtime is on standby; never sent
 * superseded  a realtime message whose candle closed before it could go out (the close result replaces it)
 * missed      too late to send alone; listed in a "missed while offline" summary
 * expired     older than the maximum age; dropped and counted
 * failed      Telegram refused it (for example malformed text); logged and counted
 */
export type OutboxStatus = 'pending' | 'sent' | 'suppressed' | 'superseded' | 'missed' | 'expired' | 'failed';

export interface OutboxRow {
  id: string;
  kind: OutboxKind;
  payload: string;
  eventAt: number;
  createdAt: number;
  status: OutboxStatus;
  attempts: number;
  nextAt: number;
}

export interface LogRow {
  at: number;
  level: 'warn' | 'error';
  kind: string;
  detail: string;
}

/** What the Docker spare copies from (and back to) Cloudflare when the engines switch. */
export interface PortableState {
  settings: UserSettings;
  watch: WatchRow[];
}

interface SeriesDbRow {
  symbol: string;
  timeframe: string;
  side: string | null;
  margin_pct: number;
  last_close_start: number;
  ema_fast: number;
  ema_slow: number;
  rt_candle_start: number | null;
  rt_alerted: string | null;
  rt_cancelled: number;
  rt_alerted_at: number | null;
}

interface WatchDbRow {
  symbol: string;
  timeframes: string;
  origin: string;
  status: string;
  below_since: number | null;
  updated_at: number;
}

const toTimeframes = (csv: string): Timeframe[] => csv.split(',').filter(isTimeframe);

function toWatch(r: WatchDbRow): WatchRow {
  return {
    symbol: r.symbol,
    timeframes: toTimeframes(r.timeframes),
    origin: r.origin === 'user' ? 'user' : 'auto',
    status: r.status === 'paused' || r.status === 'removed' ? r.status : 'active',
    belowSince: r.below_since,
    updatedAt: r.updated_at
  };
}

export class Store {
  private readonly db: SqlDriver;
  private txDepth = 0;
  private settingsCache: UserSettings | null = null;
  /** Called when stored settings fail validation (they are replaced by defaults in memory, never silently in the database). */
  onCorruptSettings: (errors: string[]) => void = () => {};

  constructor(db: SqlDriver) {
    this.db = db;
  }

  /** Creates or upgrades the schema. Safe to call on every start. */
  migrate(now: number = Date.now()): void {
    this.db.run('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    const current = Number(this.getMeta('schema_version') ?? 0);
    for (let v = current; v < MIGRATIONS.length; v++) {
      this.transaction(() => {
        const step = MIGRATIONS[v]!;
        if (typeof step === 'function') step(this, now);
        else for (const statement of step) this.db.run(statement);
        this.setMeta('schema_version', String(v + 1));
      });
    }
  }

  /** Atomic block; nested calls join the outer transaction. */
  transaction<T>(fn: () => T): T {
    if (this.txDepth > 0) return fn();
    this.txDepth++;
    try {
      return this.db.transaction(fn);
    } catch (err) {
      this.settingsCache = null; // a rolled-back settings write must not survive in the cache
      throw err;
    } finally {
      this.txDepth--;
    }
  }

  // ---------------------------------------------------------------- meta

  getMeta(key: string): string | null {
    return this.db.all<{ value: string }>('SELECT value FROM meta WHERE key = ?', key)[0]?.value ?? null;
  }

  setMeta(key: string, value: string): void {
    this.db.run('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, value);
  }

  deleteMeta(key: string): void {
    this.db.run('DELETE FROM meta WHERE key = ?', key);
  }

  // ---------------------------------------------------------------- settings

  settings(): UserSettings {
    if (this.settingsCache) return this.settingsCache;
    const row = this.db.all<{ json: string }>('SELECT json FROM settings WHERE id = 1')[0];
    let value = DEFAULT_USER_SETTINGS;
    if (row) {
      let parsed: unknown = null;
      try {
        parsed = JSON.parse(row.json);
      } catch {
        // reported below as invalid
      }
      const v = validateUserSettings(parsed);
      if (v.ok) value = v.value;
      else this.onCorruptSettings(v.errors);
    }
    this.settingsCache = value;
    return value;
  }

  /** Validates and stores settings, with an audit line saying who changed what. */
  saveSettings(next: UserSettings, actor: string, change: string, now: number): { ok: true } | { ok: false; errors: string[] } {
    const v = validateUserSettings(next);
    if (!v.ok) return v;
    this.transaction(() => {
      this.db.run(
        'INSERT INTO settings (id, json, updated_at) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at',
        JSON.stringify(v.value),
        now
      );
      this.db.run('INSERT INTO settings_audit (at, actor, change) VALUES (?, ?, ?)', now, actor, change.slice(0, 500));
    });
    this.settingsCache = v.value;
    return { ok: true };
  }

  // ---------------------------------------------------------------- watchlist

  watchList(): WatchRow[] {
    return this.db.all<WatchDbRow>('SELECT symbol, timeframes, origin, status, below_since, updated_at FROM watch ORDER BY symbol').map(toWatch);
  }

  saveWatch(row: WatchRow): void {
    this.db.run(
      `INSERT INTO watch (symbol, timeframes, origin, status, below_since, updated_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(symbol) DO UPDATE SET timeframes = excluded.timeframes, origin = excluded.origin, status = excluded.status,
         below_since = excluded.below_since, updated_at = excluded.updated_at`,
      row.symbol, row.timeframes.join(','), row.origin, row.status, row.belowSince, row.updatedAt
    );
  }

  // ---------------------------------------------------------------- signal state

  seriesAll(): SeriesRecord[] {
    const rows = this.db.all<SeriesDbRow>(
      `SELECT symbol, timeframe, side, margin_pct, last_close_start, ema_fast, ema_slow, rt_candle_start, rt_alerted, rt_cancelled, rt_alerted_at FROM series`
    );
    const out: SeriesRecord[] = [];
    for (const r of rows) {
      if (!isTimeframe(r.timeframe)) continue;
      const side: Side | null = r.side === 'above' || r.side === 'below' ? r.side : null;
      const alerted: Direction | null = r.rt_alerted === 'up' || r.rt_alerted === 'down' ? r.rt_alerted : null;
      out.push({
        symbol: r.symbol,
        timeframe: r.timeframe,
        state: { side, marginPct: r.margin_pct, lastCloseStart: r.last_close_start, emaFast: r.ema_fast, emaSlow: r.ema_slow },
        rt: r.rt_candle_start === null ? null : { candleStart: r.rt_candle_start, alerted, cancelled: r.rt_cancelled === 1 },
        rtAlertedAt: r.rt_alerted_at
      });
    }
    return out;
  }

  saveSeries(rec: SeriesRecord, now: number): void {
    const s = rec.state;
    this.db.run(
      `INSERT INTO series (symbol, timeframe, side, margin_pct, last_close_start, ema_fast, ema_slow, rt_candle_start, rt_alerted, rt_cancelled, rt_alerted_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(symbol, timeframe) DO UPDATE SET side = excluded.side, margin_pct = excluded.margin_pct,
         last_close_start = excluded.last_close_start, ema_fast = excluded.ema_fast, ema_slow = excluded.ema_slow,
         rt_candle_start = excluded.rt_candle_start, rt_alerted = excluded.rt_alerted, rt_cancelled = excluded.rt_cancelled,
         rt_alerted_at = excluded.rt_alerted_at, updated_at = excluded.updated_at`,
      rec.symbol, rec.timeframe, s.side, s.marginPct, s.lastCloseStart, s.emaFast, s.emaSlow,
      rec.rt?.candleStart ?? null, rec.rt?.alerted ?? null, rec.rt?.cancelled ? 1 : 0, rec.rtAlertedAt, now
    );
  }

  deleteSeries(symbol: string, timeframe?: Timeframe): void {
    if (timeframe) this.db.run('DELETE FROM series WHERE symbol = ? AND timeframe = ?', symbol, timeframe);
    else this.db.run('DELETE FROM series WHERE symbol = ?', symbol);
  }

  deleteAllSeries(): void {
    this.db.run('DELETE FROM series');
  }

  // ---------------------------------------------------------------- outbox

  /** Records a message. Returns false when a message with the same ID already exists (duplicates are refused). */
  enqueue(entry: { id: string; kind: OutboxKind; payload: string; eventAt: number; status: 'pending' | 'suppressed' }, now: number): boolean {
    return this.db.run(
      'INSERT OR IGNORE INTO outbox (id, kind, payload, event_at, created_at, status, next_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      entry.id, entry.kind, entry.payload, entry.eventAt, now, entry.status, now
    );
  }

  hasMessage(id: string): boolean {
    return this.db.all<{ n: number }>('SELECT COUNT(*) AS n FROM outbox WHERE id = ?', id)[0]!.n > 0;
  }

  duePending(now: number, limit: number): OutboxRow[] {
    return this.db
      .all<{ id: string; kind: string; payload: string; event_at: number; created_at: number; status: string; attempts: number; next_at: number }>(
        `SELECT id, kind, payload, event_at, created_at, status, attempts, next_at FROM outbox
         WHERE status = 'pending' AND next_at <= ? ORDER BY event_at, created_at, id LIMIT ?`,
        now, limit
      )
      .map(r => ({ id: r.id, kind: r.kind === 'note' ? 'note' : 'alert', payload: r.payload, eventAt: r.event_at, createdAt: r.created_at, status: 'pending', attempts: r.attempts, nextAt: r.next_at }));
  }

  pendingSummary(): { count: number; oldestEventAt: number | null; nextAt: number | null } {
    const r = this.db.all<{ n: number; oldest: number | null; next: number | null }>(
      "SELECT COUNT(*) AS n, MIN(event_at) AS oldest, MIN(next_at) AS next FROM outbox WHERE status = 'pending'"
    )[0]!;
    return { count: r.n, oldestEventAt: r.oldest, nextAt: r.next };
  }

  markOutbox(ids: readonly string[], status: Exclude<OutboxStatus, 'pending'>, now: number, messageId: number | null = null, error: string | null = null): void {
    if (!ids.length) return;
    this.transaction(() => {
      for (const id of ids) {
        this.db.run(
          'UPDATE outbox SET status = ?, sent_at = ?, message_id = ?, last_error = COALESCE(?, last_error) WHERE id = ?',
          status, status === 'sent' ? now : null, messageId, error, id
        );
      }
    });
  }

  retryLater(ids: readonly string[], nextAt: number, error: string): void {
    this.transaction(() => {
      for (const id of ids) this.db.run('UPDATE outbox SET attempts = attempts + 1, next_at = ?, last_error = ? WHERE id = ?', nextAt, error.slice(0, 300), id);
    });
  }

  /** Marks every pending message suppressed (this runtime went to standby; the other one sends from now on). */
  suppressPending(): void {
    this.db.run("UPDATE outbox SET status = 'suppressed' WHERE status = 'pending'");
  }

  /** Pushes every pending message to `nextAt` or later (after a Telegram 429 or while Telegram refuses the bot). */
  delayPending(nextAt: number): void {
    this.db.run("UPDATE outbox SET next_at = MAX(next_at, ?) WHERE status = 'pending'", nextAt);
  }

  /** Recently delivered or dropped messages, newest first (for the status screen and tests). */
  recentMessages(limit: number): { id: string; kind: OutboxKind; status: OutboxStatus; eventAt: number; payload: string }[] {
    return this.db
      .all<{ id: string; kind: string; status: string; event_at: number; payload: string }>(
        'SELECT id, kind, status, event_at, payload FROM outbox ORDER BY created_at DESC, id DESC LIMIT ?',
        limit
      )
      .map(r => ({ id: r.id, kind: r.kind === 'note' ? 'note' : 'alert', status: r.status as OutboxStatus, eventAt: r.event_at, payload: r.payload }));
  }

  // ---------------------------------------------------------------- log and counters

  /** Records who changed what (settings, watchlist, engine switches). */
  audit(at: number, actor: string, change: string): void {
    this.db.run('INSERT INTO settings_audit (at, actor, change) VALUES (?, ?, ?)', at, actor, change.slice(0, 500));
  }

  log(at: number, level: LogRow['level'], kind: string, detail: string): void {
    this.db.run('INSERT INTO log (at, level, kind, detail) VALUES (?, ?, ?, ?)', at, level, kind, detail.slice(0, 500));
  }

  recentLog(limit: number): LogRow[] {
    return this.db.all<LogRow>('SELECT at, level, kind, detail FROM log ORDER BY id DESC LIMIT ?', limit);
  }

  addStats(deltas: Readonly<Record<string, number>>): void {
    const entries = Object.entries(deltas).filter(([, v]) => v !== 0);
    if (!entries.length) return;
    this.transaction(() => {
      for (const [key, value] of entries) {
        this.db.run('INSERT INTO stats (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = value + excluded.value', key, Math.round(value));
      }
    });
  }

  peekStats(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const r of this.db.all<{ key: string; value: number }>('SELECT key, value FROM stats')) out[r.key] = r.value;
    return out;
  }

  /** Reads the counters and resets them (used by the daily report). */
  takeStats(): Record<string, number> {
    return this.transaction(() => {
      const out = this.peekStats();
      this.db.run('DELETE FROM stats');
      return out;
    });
  }

  // ---------------------------------------------------------------- Telegram updates

  /** True the first time an update ID is seen; Telegram may deliver the same update twice. */
  firstSeenUpdate(updateId: number, now: number): boolean {
    return this.db.run('INSERT OR IGNORE INTO telegram_update (update_id, at) VALUES (?, ?)', updateId, now);
  }

  // ---------------------------------------------------------------- portability and housekeeping

  exportState(): PortableState {
    return { settings: this.settings(), watch: this.watchList() };
  }

  /** Replaces settings and the watchlist with a copy from the other runtime. Signal state is kept (it is recomputed anyway). */
  importState(state: PortableState, actor: string, now: number): { ok: true } | { ok: false; errors: string[] } {
    const v = validateUserSettings(state.settings);
    if (!v.ok) return v;
    if (!Array.isArray(state.watch)) return { ok: false, errors: ['watch must be a list'] };
    this.transaction(() => {
      this.saveSettings(v.value, actor, 'imported from the other runtime', now);
      this.db.run('DELETE FROM watch');
      for (const w of state.watch) {
        if (typeof w?.symbol !== 'string' || !/^[A-Z0-9_.-]{1,40}$/.test(w.symbol)) continue;
        const tfs = Array.isArray(w.timeframes) ? w.timeframes.filter(isTimeframe) : [];
        const status: WatchStatus = w.status === 'paused' || w.status === 'removed' ? w.status : 'active';
        this.saveWatch({ symbol: w.symbol, timeframes: status === 'removed' ? [] : tfs, origin: w.origin === 'user' ? 'user' : 'auto', status: tfs.length || status === 'removed' ? status : 'removed', belowSince: typeof w.belowSince === 'number' ? w.belowSince : null, updatedAt: now });
      }
    });
    return { ok: true };
  }

  /** Deletes old delivered messages, log lines and update IDs. */
  prune(now: number): void {
    this.transaction(() => {
      this.db.run("DELETE FROM outbox WHERE status <> 'pending' AND created_at < ?", now - RETAIN_MESSAGES_MS);
      this.db.run('DELETE FROM log WHERE at < ?', now - RETAIN_LOG_MS);
      this.db.run('DELETE FROM telegram_update WHERE at < ?', now - RETAIN_UPDATES_MS);
      this.db.run('DELETE FROM settings_audit WHERE at < ?', now - 90 * DAY_MS);
    });
  }
}
