// The Tracker Durable Object (the "desk worker").
// Stage S0 probe: measures, from Cloudflare's network, whether the v2 design holds before it is built:
//   - Delta India REST reachability, latency, 429s and clock skew
//   - an always-open Delta live feed (v2/ticker) on the coins above $10M: uptime, reconnects, message volume
//   - how precisely the every-minute timer fires, and how often Cloudflare restarts this object
// Constants here are probe-only; the real settings live in core/config from S1 and replace this file in S4.
import { DurableObject } from 'cloudflare:workers';

const DELTA_REST = 'https://api.india.delta.exchange';
const DELTA_WS = 'https://socket.india.delta.exchange'; // fetch() upgrades need the https form of the wss:// address
const USER_AGENT = 'ema-tracker/2.0-probe (+https://github.com/Rupangshudutta/Ema_Tracker)';
const MIN_TURNOVER_USD = 10_000_000;
const MAX_SYMBOLS = 16;
const FEED_STALE_MS = 30_000;
const ALARM_EVERY_MS = 60_000;
const SYMBOL_REFRESH_MS = 60 * 60_000;
const REQUEST_TIMEOUT_MS = 8_000;
const MINUTE_MS = 60_000;

interface MinuteCounts {
  wsMsgs: number;
  restOk: number;
  restFail: number;
  rest429: number;
  restMsSum: number;
  restMsMax: number;
  cronDelayMsMax: number;
  skewMs: number | null;
}

export interface ProbeReport {
  generatedAt: string;
  windowHours: number;
  firstMinute: string | null;
  minutesObserved: number;
  instanceStarts: number;
  feed: {
    connectedNow: boolean;
    symbols: string[];
    minutesConnected: number;
    connectedPct: number;
    tickerMessages: number;
    messagesPerHour: number;
    opens: number;
    closes: number;
    staleReconnects: number;
    errors: number;
    lastMessageAgeSec: number | null;
  };
  rest: { ok: number; failed: number; rateLimited: number; avgLatencyMs: number | null; maxLatencyMs: number; lastSkewMs: number | null };
  timer: { ticks: number; maxDelayMs: number };
  recentEvents: { at: string; kind: string; detail: string }[];
}

const emptyCounts = (): MinuteCounts => ({ wsMsgs: 0, restOk: 0, restFail: 0, rest429: 0, restMsSum: 0, restMsMax: 0, cronDelayMsMax: 0, skewMs: null });

export class Tracker extends DurableObject<Env> {
  private readonly sql: SqlStorage;
  private ws: WebSocket | null = null;
  private connecting = false;
  private lastMsgAt = 0;
  private symbols: string[] = [];
  private symbolsRefreshedAt = 0;
  private counts: MinuteCounts = emptyCounts();
  private countsMinute = 0;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    ctx.blockConcurrencyWhile(async () => {
      this.sql.exec(`CREATE TABLE IF NOT EXISTS probe_minute (
        minute_ts INTEGER PRIMARY KEY, ws_msgs INTEGER NOT NULL DEFAULT 0, ws_connected INTEGER NOT NULL DEFAULT 0,
        rest_ok INTEGER NOT NULL DEFAULT 0, rest_fail INTEGER NOT NULL DEFAULT 0, rest_429 INTEGER NOT NULL DEFAULT 0,
        rest_ms_sum INTEGER NOT NULL DEFAULT 0, rest_ms_max INTEGER NOT NULL DEFAULT 0,
        cron_delay_ms_max INTEGER NOT NULL DEFAULT 0, ticks INTEGER NOT NULL DEFAULT 0, skew_ms INTEGER)`);
      this.sql.exec(`CREATE TABLE IF NOT EXISTS probe_event (
        id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, kind TEXT NOT NULL, detail TEXT NOT NULL)`);
      this.event('instance_start', 'Durable Object created or restarted');
    });
  }

  /** Called by the Worker's every-minute timer. */
  async tick(scheduledTime: number): Promise<void> {
    this.bump();
    this.counts.cronDelayMsMax = Math.max(this.counts.cronDelayMsMax, Date.now() - scheduledTime);
    this.sql.exec('INSERT INTO probe_minute (minute_ts, ticks) VALUES (?, 1) ON CONFLICT(minute_ts) DO UPDATE SET ticks = ticks + 1', this.countsMinute);
    await this.ensureAlarm();
    await this.refreshSymbolsIfDue();
    await this.ensureFeed();
    await this.restProbe();
    this.flush();
  }

  /** Backup heartbeat that keeps the object (and its feed) alive even if a timer tick is missed. */
  override async alarm(): Promise<void> {
    await this.ctx.storage.setAlarm(Date.now() + ALARM_EVERY_MS);
    await this.ensureFeed();
    this.flush();
  }

  async report(): Promise<ProbeReport> {
    this.flush();
    const now = Date.now();
    const since = now - 24 * 60 * MINUTE_MS;
    const agg = this.sql.exec<{ minutes: number; first: number | null; msgs: number; connected: number; ok: number; fail: number; rl: number; mssum: number; msmax: number; ticks: number; delaymax: number }>(
      `SELECT COUNT(*) AS minutes, MIN(minute_ts) AS first, COALESCE(SUM(ws_msgs),0) AS msgs, COALESCE(SUM(ws_connected),0) AS connected,
              COALESCE(SUM(rest_ok),0) AS ok, COALESCE(SUM(rest_fail),0) AS fail, COALESCE(SUM(rest_429),0) AS rl,
              COALESCE(SUM(rest_ms_sum),0) AS mssum, COALESCE(MAX(rest_ms_max),0) AS msmax,
              COALESCE(SUM(ticks),0) AS ticks, COALESCE(MAX(cron_delay_ms_max),0) AS delaymax
       FROM probe_minute WHERE minute_ts >= ?`, since).one();
    const kinds = new Map<string, number>();
    for (const row of this.sql.exec<{ kind: string; n: number }>('SELECT kind, COUNT(*) AS n FROM probe_event WHERE ts >= ? GROUP BY kind', since)) {
      kinds.set(row.kind, row.n);
    }
    const lastSkew = this.sql.exec<{ skew_ms: number | null }>('SELECT skew_ms FROM probe_minute WHERE skew_ms IS NOT NULL ORDER BY minute_ts DESC LIMIT 1').toArray()[0];
    const recent = this.sql.exec<{ ts: number; kind: string; detail: string }>('SELECT ts, kind, detail FROM probe_event ORDER BY id DESC LIMIT 25').toArray();
    const hours = Math.max(agg.minutes, 1) / 60;
    return {
      generatedAt: new Date(now).toISOString(),
      windowHours: 24,
      firstMinute: agg.first === null ? null : new Date(agg.first).toISOString(),
      minutesObserved: agg.minutes,
      instanceStarts: kinds.get('instance_start') ?? 0,
      feed: {
        connectedNow: this.ws !== null,
        symbols: this.symbols,
        minutesConnected: agg.connected,
        connectedPct: agg.minutes ? Math.round((1000 * agg.connected) / agg.minutes) / 10 : 0,
        tickerMessages: agg.msgs,
        messagesPerHour: Math.round(agg.msgs / hours),
        opens: kinds.get('ws_open') ?? 0,
        closes: kinds.get('ws_close') ?? 0,
        staleReconnects: kinds.get('ws_stale') ?? 0,
        errors: kinds.get('ws_error') ?? 0,
        lastMessageAgeSec: this.lastMsgAt ? Math.round((now - this.lastMsgAt) / 1000) : null
      },
      rest: {
        ok: agg.ok,
        failed: agg.fail,
        rateLimited: agg.rl,
        avgLatencyMs: agg.ok + agg.fail ? Math.round(agg.mssum / (agg.ok + agg.fail)) : null,
        maxLatencyMs: agg.msmax,
        lastSkewMs: lastSkew?.skew_ms ?? null
      },
      timer: { ticks: agg.ticks, maxDelayMs: agg.delaymax },
      recentEvents: recent.map(e => ({ at: new Date(e.ts).toISOString(), kind: e.kind, detail: e.detail }))
    };
  }

  private async ensureAlarm(): Promise<void> {
    if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(Date.now() + ALARM_EVERY_MS);
  }

  private async refreshSymbolsIfDue(): Promise<void> {
    if (this.symbols.length && Date.now() - this.symbolsRefreshedAt < SYMBOL_REFRESH_MS) return;
    const res = await this.timedFetch(`${DELTA_REST}/v2/tickers?contract_types=perpetual_futures`);
    if (!res) return;
    const body = (await res.json()) as { result?: { symbol?: string; turnover_usd?: string | number }[] };
    const next = (body.result ?? [])
      .map(t => ({ symbol: String(t.symbol ?? ''), turnover: Number(t.turnover_usd) }))
      .filter(t => t.symbol && Number.isFinite(t.turnover) && t.turnover > MIN_TURNOVER_USD)
      .sort((a, b) => b.turnover - a.turnover)
      .slice(0, MAX_SYMBOLS)
      .map(t => t.symbol);
    this.symbolsRefreshedAt = Date.now();
    if (next.join(',') !== this.symbols.join(',')) {
      this.symbols = next;
      this.event('symbols', next.join(','));
      this.dropFeed('symbol list changed');
    }
  }

  private async ensureFeed(): Promise<void> {
    if (this.ws && Date.now() - this.lastMsgAt > FEED_STALE_MS) {
      this.event('ws_stale', `no message for ${Math.round((Date.now() - this.lastMsgAt) / 1000)} s`);
      this.dropFeed('stale');
    }
    if (this.ws || this.connecting || !this.symbols.length) return;
    this.connecting = true;
    try {
      const res = await fetch(DELTA_WS, { headers: { Upgrade: 'websocket', 'User-Agent': USER_AGENT } });
      const ws = res.webSocket;
      if (!ws) {
        this.event('ws_error', `upgrade refused: HTTP ${res.status}`);
        return;
      }
      ws.accept();
      ws.addEventListener('message', event => {
        this.lastMsgAt = Date.now();
        if (typeof event.data === 'string' && event.data.includes('"v2/ticker"')) {
          this.bump();
          this.counts.wsMsgs++;
        }
      });
      ws.addEventListener('close', event => {
        if (this.ws === ws) this.ws = null;
        this.event('ws_close', `code ${event.code} ${event.reason}`.trim());
      });
      ws.addEventListener('error', () => {
        if (this.ws === ws) this.ws = null;
        this.event('ws_error', 'socket error');
      });
      ws.send(JSON.stringify({ type: 'subscribe', payload: { channels: [{ name: 'v2/ticker', symbols: this.symbols }] } }));
      this.ws = ws;
      this.lastMsgAt = Date.now();
      this.event('ws_open', `${this.symbols.length} symbols`);
    } catch (err) {
      this.event('ws_error', err instanceof Error ? err.message : String(err));
    } finally {
      this.connecting = false;
    }
  }

  private dropFeed(reason: string): void {
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      try {
        ws.close(1000, reason);
      } catch {
        // The socket may already be closed; the close event records it either way.
      }
    }
  }

  private async restProbe(): Promise<void> {
    const end = Math.floor(Date.now() / 1000);
    await this.timedFetch(`${DELTA_REST}/v2/tickers/BTCUSD`);
    const res = await this.timedFetch(`${DELTA_REST}/v2/history/candles?resolution=5m&symbol=BTCUSD&start=${end - 900}&end=${end}`);
    const date = res?.headers.get('date');
    if (date) this.counts.skewMs = Date.now() - Date.parse(date);
  }

  /** fetch with timeout and accounting; returns null (and records why) when the call failed. */
  private async timedFetch(url: string): Promise<Response | null> {
    const started = Date.now();
    try {
      const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' }, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      const ms = Date.now() - started;
      this.bump();
      this.counts.restMsSum += ms;
      this.counts.restMsMax = Math.max(this.counts.restMsMax, ms);
      if (res.ok) {
        this.counts.restOk++;
        return res;
      }
      if (res.status === 429) this.counts.rest429++;
      this.counts.restFail++;
      this.event('rest_error', `HTTP ${res.status} ${new URL(url).pathname} reset=${res.headers.get('x-rate-limit-reset') ?? '-'}`);
      return null;
    } catch (err) {
      this.bump();
      this.counts.restFail++;
      this.event('rest_error', `${new URL(url).pathname}: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  /** Moves to a new minute bucket, flushing the previous one first. */
  private bump(): void {
    const minute = Math.floor(Date.now() / MINUTE_MS) * MINUTE_MS;
    if (minute !== this.countsMinute) {
      this.flush();
      this.countsMinute = minute;
    }
  }

  private flush(): void {
    if (!this.countsMinute) return;
    const c = this.counts;
    this.sql.exec(
      `INSERT INTO probe_minute (minute_ts, ws_msgs, ws_connected, rest_ok, rest_fail, rest_429, rest_ms_sum, rest_ms_max, cron_delay_ms_max, skew_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(minute_ts) DO UPDATE SET
         ws_msgs = ws_msgs + excluded.ws_msgs, ws_connected = MAX(ws_connected, excluded.ws_connected),
         rest_ok = rest_ok + excluded.rest_ok, rest_fail = rest_fail + excluded.rest_fail, rest_429 = rest_429 + excluded.rest_429,
         rest_ms_sum = rest_ms_sum + excluded.rest_ms_sum, rest_ms_max = MAX(rest_ms_max, excluded.rest_ms_max),
         cron_delay_ms_max = MAX(cron_delay_ms_max, excluded.cron_delay_ms_max), skew_ms = COALESCE(excluded.skew_ms, skew_ms)`,
      this.countsMinute, c.wsMsgs, this.ws ? 1 : 0, c.restOk, c.restFail, c.rest429, c.restMsSum, c.restMsMax, c.cronDelayMsMax, c.skewMs
    );
    this.counts = emptyCounts();
    const retainSince = Date.now() - 7 * 24 * 60 * MINUTE_MS;
    this.sql.exec('DELETE FROM probe_minute WHERE minute_ts < ?', retainSince);
    this.sql.exec('DELETE FROM probe_event WHERE ts < ?', retainSince);
  }

  private event(kind: string, detail: string): void {
    this.sql.exec('INSERT INTO probe_event (ts, kind, detail) VALUES (?, ?, ?)', Date.now(), kind, detail.slice(0, 500));
  }
}
