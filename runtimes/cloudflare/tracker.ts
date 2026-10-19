// The Tracker Durable Object (the "desk worker").
// Stage S0 probe: measures, from Cloudflare's network, whether the v2 design holds before the full bot is built,
// and reports to Telegram so the Cloudflare -> Telegram path is proven early:
//   - Delta India REST reachability, latency, 429s and clock skew
//   - an always-open Delta live feed (v2/ticker) on the coins above $10M: uptime, reconnects, message volume
//   - how precisely the every-minute timer fires, and how often (and after which deploy) Cloudflare restarts this object
//   - Telegram: one "live" message per deployed version, a status report every 6 h, warnings when Delta fails
//   - Healthchecks.io: a ping every 5 minutes while healthy, a fail ping otherwise
// Probe-specific numbers live here; shared settings come from core/config. Replaced by the full bot in S4.
import { DurableObject } from 'cloudflare:workers';
import { parseRuntimeEnv, type RuntimeEnv } from '../../core/config/env.ts';
import { SYSTEM } from '../../core/config/settings.ts';
import { diffSubscriptions, subscribeMessage, unsubscribeMessage } from '../../core/exchange/delta-feed.ts';
import { TelegramClient, escapeHtml, type TelegramFailure } from '../../core/notify/telegram.ts';

const DELTA_REST = SYSTEM.exchange.restBase;
const DELTA_WS = SYSTEM.exchange.wsUrl.replace(/^wss:/, 'https:'); // fetch() upgrades need the https form
const USER_AGENT = `${SYSTEM.exchange.userAgent} probe`;
const MIN_TURNOVER_USD = 10_000_000;
const MAX_SYMBOLS = SYSTEM.coins.maxWatchlistCoins;
const FEED_STALE_MS = SYSTEM.realtime.feedStaleSeconds * 1000;
const MINUTE_MS = 60_000;
const ALARM_EVERY_MS = MINUTE_MS;
const RECONNECT_DELAY_MS = 2_000;
const SYMBOL_REFRESH_MS = 60 * MINUTE_MS;
const REQUEST_TIMEOUT_MS = SYSTEM.exchange.requestTimeoutMs;
const UPGRADE_TIMEOUT_MS = 10_000;
const RETENTION_EVERY_MS = 60 * MINUTE_MS;
const RETAIN_MS = 7 * 24 * 60 * MINUTE_MS;
const EVENT_REPEAT_WINDOW_MS = MINUTE_MS;
const STATUS_EVERY_MS = 6 * 60 * MINUTE_MS;
const FEED_DOWN_ALERT_MS = 5 * MINUTE_MS;
const REST_FAIL_ALERT_MINUTES = 5;
const HEALTH_PING_EVERY_MINUTES = SYSTEM.monitoring.healthPingMinutes;
const VERSION = '2.0.1-probe';

/** Secrets are set in the Cloudflare dashboard, so `wrangler types` cannot see them; they are optional here. */
type SecretName = 'TELEGRAM_BOT_TOKEN' | 'TELEGRAM_CHAT_ID' | 'TELEGRAM_ADMIN_USER_IDS' | 'TELEGRAM_WEBHOOK_SECRET' | 'HEALTHCHECK_PING_URL';
type TrackerEnv = Env & Partial<Record<SecretName, string>>;

interface MinuteCounts {
  wsMsgs: number;
  wsDownMs: number;
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
  version: string;
  windowHours: number;
  firstMinute: string | null;
  minutesObserved: number;
  instanceStarts: number;
  config: { telegram: boolean; healthcheck: boolean; role: string | null; problems: string[] };
  feed: {
    connectedNow: boolean;
    symbols: string[];
    minutesConnected: number;
    connectedPct: number;
    downSeconds: number;
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
  telegram: { sent: number; errors: number };
  recentEvents: { at: string; kind: string; detail: string }[];
}

const emptyCounts = (): MinuteCounts => ({ wsMsgs: 0, wsDownMs: 0, restOk: 0, restFail: 0, rest429: 0, restMsSum: 0, restMsMax: 0, cronDelayMsMax: 0, skewMs: null });

function describeTelegramFailure(e: TelegramFailure): string {
  switch (e.kind) {
    case 'rate-limited': return `rate limited, retry after ${Math.round(e.retryAfterMs / 1000)} s`;
    case 'rejected': return `rejected (HTTP ${e.status}): ${e.description}`;
    case 'server': return `Telegram server error HTTP ${e.status}`;
    case 'network': return `network: ${e.message}`;
    case 'timeout': return 'timeout';
  }
}

export class Tracker extends DurableObject<Env> {
  private readonly sql: SqlStorage;
  private ws: WebSocket | null = null;
  private connecting = false;
  private lastMsgAt = 0;
  private downSince: number | null = null;
  private symbols: string[] = [];
  private subscribed = new Set<string>();
  private symbolsRefreshedAt = 0;
  private counts: MinuteCounts = emptyCounts();
  private countsMinute = 0;
  private lastRestOk = false;
  private restFailStreak = 0;
  private lastEventKey = '';
  private lastEventAt = 0;
  private runtimeEnv: { value: RuntimeEnv | null; problems: string[] } | null = null;

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
      this.sql.exec('CREATE INDEX IF NOT EXISTS probe_event_ts ON probe_event (ts)');
      this.sql.exec('CREATE TABLE IF NOT EXISTS probe_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
      const columns = this.sql.exec<{ name: string }>('PRAGMA table_info(probe_minute)').toArray().map(c => c.name);
      if (!columns.includes('ws_down_ms')) this.sql.exec('ALTER TABLE probe_minute ADD COLUMN ws_down_ms INTEGER NOT NULL DEFAULT 0');

      const saved = this.meta('symbols');
      this.symbols = saved ? saved.split(',').filter(Boolean) : [];
      this.event('instance_start', `version ${this.versionLabel()}`);
      // Reconnect within seconds after a restart instead of waiting for the next timer tick.
      await ctx.storage.setAlarm(Date.now() + 1000);
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
    await this.notify();
    await this.healthPing(scheduledTime);
    this.flush();
    this.retentionIfDue();
  }

  /** Keeps the feed alive between timer ticks and reconnects quickly after a drop or restart. */
  override async alarm(): Promise<void> {
    await this.ctx.storage.setAlarm(Date.now() + ALARM_EVERY_MS);
    if (!this.symbols.length) await this.refreshSymbolsIfDue();
    await this.ensureFeed();
    this.flush();
  }

  /** Read-only summary of the last 24 h (unflushed counters of the current minute are not included). */
  async report(): Promise<ProbeReport> {
    const now = Date.now();
    const since = now - 24 * 60 * MINUTE_MS;
    const agg = this.sql.exec<{ minutes: number; first: number | null; msgs: number; connected: number; down: number; ok: number; fail: number; rl: number; mssum: number; msmax: number; ticks: number; delaymax: number }>(
      `SELECT COUNT(*) AS minutes, MIN(minute_ts) AS first, COALESCE(SUM(ws_msgs),0) AS msgs, COALESCE(SUM(ws_connected),0) AS connected,
              COALESCE(SUM(ws_down_ms),0) AS down, COALESCE(SUM(rest_ok),0) AS ok, COALESCE(SUM(rest_fail),0) AS fail,
              COALESCE(SUM(rest_429),0) AS rl, COALESCE(SUM(rest_ms_sum),0) AS mssum, COALESCE(MAX(rest_ms_max),0) AS msmax,
              COALESCE(SUM(ticks),0) AS ticks, COALESCE(MAX(cron_delay_ms_max),0) AS delaymax
       FROM probe_minute WHERE minute_ts >= ?`, since).one();
    const kinds = new Map<string, number>();
    for (const row of this.sql.exec<{ kind: string; n: number }>('SELECT kind, COUNT(*) AS n FROM probe_event WHERE ts >= ? GROUP BY kind', since)) {
      kinds.set(row.kind, row.n);
    }
    const lastSkew = this.sql.exec<{ skew_ms: number | null }>('SELECT skew_ms FROM probe_minute WHERE skew_ms IS NOT NULL ORDER BY minute_ts DESC LIMIT 1').toArray()[0];
    const recent = this.sql.exec<{ ts: number; kind: string; detail: string }>('SELECT ts, kind, detail FROM probe_event ORDER BY id DESC LIMIT 25').toArray();
    const hours = Math.max(agg.minutes, 1) / 60;
    const rt = this.runtime();
    return {
      generatedAt: new Date(now).toISOString(),
      version: this.versionLabel(),
      windowHours: 24,
      firstMinute: agg.first === null ? null : new Date(agg.first).toISOString(),
      minutesObserved: agg.minutes,
      instanceStarts: kinds.get('instance_start') ?? 0,
      config: { telegram: rt.value !== null, healthcheck: !!rt.value?.healthcheckPingUrl, role: rt.value?.role ?? null, problems: rt.problems },
      feed: {
        connectedNow: this.ws !== null,
        symbols: this.symbols,
        minutesConnected: agg.connected,
        connectedPct: agg.minutes ? Math.round((1000 * agg.connected) / agg.minutes) / 10 : 0,
        downSeconds: Math.round(agg.down / 1000),
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
      telegram: { sent: kinds.get('telegram_sent') ?? 0, errors: kinds.get('telegram_error') ?? 0 },
      recentEvents: recent.map(e => ({ at: new Date(e.ts).toISOString(), kind: e.kind, detail: e.detail }))
    };
  }

  // ---------------------------------------------------------------- configuration

  private versionLabel(): string {
    const id = this.env.CF_VERSION_METADATA?.id;
    return id ? `${VERSION} (${id.slice(0, 8)})` : VERSION;
  }

  /** Parsed secrets and runtime switches, cached per instance. Problems name the variable, never its value. */
  private runtime(): { value: RuntimeEnv | null; problems: string[] } {
    if (!this.runtimeEnv) {
      const e = this.env as TrackerEnv;
      const parsed = parseRuntimeEnv({
        TELEGRAM_BOT_TOKEN: e.TELEGRAM_BOT_TOKEN,
        TELEGRAM_CHAT_ID: e.TELEGRAM_CHAT_ID,
        TELEGRAM_ADMIN_USER_IDS: e.TELEGRAM_ADMIN_USER_IDS,
        TELEGRAM_WEBHOOK_SECRET: e.TELEGRAM_WEBHOOK_SECRET,
        HEALTHCHECK_PING_URL: e.HEALTHCHECK_PING_URL,
        RUNTIME_ROLE: e.RUNTIME_ROLE,
        PUBLIC_BASE_URL: e.PUBLIC_BASE_URL
      }, 'active');
      this.runtimeEnv = parsed.ok ? { value: parsed.value, problems: [] } : { value: null, problems: parsed.errors };
      if (!parsed.ok) this.event('config_problem', parsed.errors.join('; '));
    }
    return this.runtimeEnv;
  }

  private meta(key: string): string | null {
    return this.sql.exec<{ value: string }>('SELECT value FROM probe_meta WHERE key = ?', key).toArray()[0]?.value ?? null;
  }

  private setMeta(key: string, value: string): void {
    this.sql.exec('INSERT INTO probe_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, value);
  }

  // ---------------------------------------------------------------- Delta

  private async ensureAlarm(): Promise<void> {
    if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(Date.now() + ALARM_EVERY_MS);
  }

  private async refreshSymbolsIfDue(): Promise<void> {
    if (this.symbols.length && this.symbolsRefreshedAt && Date.now() - this.symbolsRefreshedAt < SYMBOL_REFRESH_MS) return;
    const res = await this.timedFetch(`${DELTA_REST}/v2/tickers?contract_types=${SYSTEM.exchange.contractType}`);
    if (!res) return;
    let rows: { symbol?: unknown; turnover_usd?: unknown }[];
    try {
      const body = (await res.json()) as { result?: unknown };
      if (!Array.isArray(body.result)) throw new Error('no result list');
      rows = body.result as { symbol?: unknown; turnover_usd?: unknown }[];
    } catch (err) {
      this.event('rest_error', `tickers body: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    const next = rows
      .map(t => ({ symbol: typeof t.symbol === 'string' ? t.symbol : '', turnover: Number(t.turnover_usd) }))
      .filter(t => t.symbol && Number.isFinite(t.turnover) && t.turnover > MIN_TURNOVER_USD)
      .sort((a, b) => b.turnover - a.turnover)
      .slice(0, MAX_SYMBOLS)
      .map(t => t.symbol);
    this.symbolsRefreshedAt = Date.now();
    const wanted = new Set(next);
    const changed = wanted.size !== this.symbols.length || this.symbols.some(s => !wanted.has(s));
    if (!changed) return;
    this.event('symbols', [...wanted].sort().join(','));
    this.symbols = next;
    this.setMeta('symbols', next.join(','));
    if (this.ws) {
      // Adjust the live subscription in place instead of dropping the connection.
      const diff = diffSubscriptions(this.subscribed, wanted);
      try {
        if (diff.unsubscribe.length) this.ws.send(unsubscribeMessage(diff.unsubscribe));
        if (diff.subscribe.length) this.ws.send(subscribeMessage(diff.subscribe));
        this.subscribed = wanted;
      } catch (err) {
        this.event('ws_error', `resubscribe failed: ${err instanceof Error ? err.message : String(err)}`);
        this.dropFeed('resubscribe failed');
      }
    }
  }

  private async ensureFeed(): Promise<void> {
    if (this.ws && Date.now() - this.lastMsgAt > FEED_STALE_MS) {
      this.event('ws_stale', `no message for ${Math.round((Date.now() - this.lastMsgAt) / 1000)} s`);
      this.dropFeed('stale');
    }
    if (this.ws || this.connecting || !this.symbols.length) return;
    this.connecting = true;
    let ws: WebSocket | null = null;
    try {
      const res = await fetch(DELTA_WS, { headers: { Upgrade: 'websocket', 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(UPGRADE_TIMEOUT_MS) });
      ws = res.webSocket;
      if (!ws) {
        this.markDown();
        this.event('ws_error', `upgrade refused: HTTP ${res.status}`);
        return;
      }
      ws.accept();
      const socket = ws;
      socket.addEventListener('message', event => {
        this.lastMsgAt = Date.now();
        if (typeof event.data === 'string' && event.data.includes('"v2/ticker"')) {
          this.bump();
          this.counts.wsMsgs++;
        }
      });
      socket.addEventListener('close', event => this.onSocketGone(socket, 'ws_close', `code ${event.code} ${event.reason}`.trim()));
      socket.addEventListener('error', () => this.onSocketGone(socket, 'ws_error', 'socket error'));
      socket.send(subscribeMessage(this.symbols));
      this.subscribed = new Set(this.symbols);
      this.ws = socket;
      this.lastMsgAt = Date.now();
      if (this.downSince !== null) {
        this.bump();
        this.counts.wsDownMs += Date.now() - this.downSince;
        this.downSince = null;
      }
      this.event('ws_open', `${this.symbols.length} symbols`);
    } catch (err) {
      if (ws) {
        try {
          ws.close(1011, 'subscribe failed');
        } catch {
          // already closed
        }
      }
      this.markDown();
      this.event('ws_error', err instanceof Error ? err.message : String(err));
    } finally {
      this.connecting = false;
    }
  }

  private onSocketGone(socket: WebSocket, kind: string, detail: string): void {
    if (this.ws !== socket) return; // an older socket we already replaced or dropped
    this.ws = null;
    this.markDown();
    this.event(kind, detail);
    // Reconnect in a couple of seconds rather than at the next minute tick.
    this.ctx.storage.setAlarm(Date.now() + RECONNECT_DELAY_MS).catch(err => this.event('alarm_error', err instanceof Error ? err.message : String(err)));
  }

  private markDown(): void {
    if (this.downSince === null) this.downSince = Date.now();
  }

  private dropFeed(reason: string): void {
    const ws = this.ws;
    this.ws = null;
    this.markDown();
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
    const ticker = await this.timedFetch(`${DELTA_REST}/v2/tickers/BTCUSD`);
    const candles = await this.timedFetch(`${DELTA_REST}/v2/history/candles?resolution=5m&symbol=BTCUSD&start=${end - 900}&end=${end}`);
    const date = candles?.headers.get('date');
    if (date) this.counts.skewMs = Date.now() - Date.parse(date);
    this.lastRestOk = ticker !== null && candles !== null;
    this.restFailStreak = this.lastRestOk ? 0 : this.restFailStreak + 1;
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

  // ---------------------------------------------------------------- Telegram and Healthchecks

  private async notify(): Promise<void> {
    const rt = this.runtime().value;
    if (!rt || rt.role !== 'active') return;
    const tg = new TelegramClient((url, init) => fetch(url, init), rt.telegramBotToken);
    const send = async (html: string): Promise<boolean> => {
      const r = await tg.sendMessage(rt.telegramChatId, html);
      if (r.ok) this.event('telegram_sent', html.replace(/<[^>]+>/g, '').slice(0, 80));
      else this.event('telegram_error', describeTelegramFailure(r.error));
      return r.ok;
    };
    const now = Date.now();
    const version = this.versionLabel();

    if (this.meta('announced_version') !== version) {
      const text = [
        '🟢 <b>EMA Tracker v2 is live on Cloudflare</b> (probe stage)',
        `Version ${escapeHtml(version)}`,
        `Watching ${this.symbols.length} Delta India coins above $10M. Live feed: ${this.ws ? 'connected' : 'connecting'}.`,
        '',
        'No trading alerts yet: this stage checks that Cloudflare, Delta and Telegram work together. You will get a status report every 6 hours, and a warning if the Delta feed or the Delta API stops working.'
      ].join('\n');
      if (await send(text)) {
        this.setMeta('announced_version', version);
        this.setMeta('last_status_at', String(now));
      }
    }

    const feedAlert = this.meta('feed_alert');
    if (this.downSince !== null && now - this.downSince >= FEED_DOWN_ALERT_MS && feedAlert !== 'down') {
      if (await send(`⚠️ <b>Delta live feed down</b> for ${Math.round((now - this.downSince) / MINUTE_MS)} min. Reconnecting automatically.`)) this.setMeta('feed_alert', 'down');
    } else if (this.downSince === null && feedAlert === 'down') {
      if (await send('✅ <b>Delta live feed back</b>.')) this.setMeta('feed_alert', 'ok');
    }

    const restAlert = this.meta('rest_alert');
    if (this.restFailStreak >= REST_FAIL_ALERT_MINUTES && restAlert !== 'down') {
      if (await send(`⚠️ <b>Delta API failing</b> for ${this.restFailStreak} min in a row (see /probe for details).`)) this.setMeta('rest_alert', 'down');
    } else if (this.restFailStreak === 0 && restAlert === 'down') {
      if (await send('✅ <b>Delta API answering again</b>.')) this.setMeta('rest_alert', 'ok');
    }

    if (now - Number(this.meta('last_status_at') ?? 0) >= STATUS_EVERY_MS) {
      const r = await this.report();
      const text = [
        '📊 <b>EMA Tracker status</b> (last 24 h, probe stage)',
        `Coins: ${r.feed.symbols.length} · feed ${r.feed.connectedNow ? 'connected' : 'DOWN'} · ${r.feed.connectedPct}% of minutes, ${r.feed.downSeconds} s down`,
        `Live updates: ${r.feed.messagesPerHour}/h · reconnects ${r.feed.opens}`,
        `Delta API: ${r.rest.ok} ok, ${r.rest.failed} failed, ${r.rest.rateLimited} rate-limited, avg ${r.rest.avgLatencyMs ?? '-'} ms`,
        `Timer: ${r.timer.ticks} ticks, worst delay ${(r.timer.maxDelayMs / 1000).toFixed(1)} s · restarts ${r.instanceStarts}`,
        `Version ${escapeHtml(r.version)}`
      ].join('\n');
      if (await send(text)) this.setMeta('last_status_at', String(now));
    }
  }

  private async healthPing(scheduledTime: number): Promise<void> {
    const rt = this.runtime().value;
    if (!rt?.healthcheckPingUrl || rt.role !== 'active') return;
    if (Math.floor(scheduledTime / MINUTE_MS) % HEALTH_PING_EVERY_MINUTES !== 0) return;
    const healthy = this.ws !== null && Date.now() - this.lastMsgAt < 2 * FEED_STALE_MS && this.lastRestOk;
    const url = healthy ? rt.healthcheckPingUrl : `${rt.healthcheckPingUrl.replace(/\/$/, '')}/fail`;
    try {
      const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      if (!res.ok) this.event('health_error', `HTTP ${res.status}`);
    } catch (err) {
      // Never log the URL: it is a secret.
      this.event('health_error', err instanceof Error ? err.name : 'unknown error');
    }
  }

  // ---------------------------------------------------------------- bookkeeping

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
      `INSERT INTO probe_minute (minute_ts, ws_msgs, ws_connected, ws_down_ms, rest_ok, rest_fail, rest_429, rest_ms_sum, rest_ms_max, cron_delay_ms_max, skew_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(minute_ts) DO UPDATE SET
         ws_msgs = ws_msgs + excluded.ws_msgs, ws_connected = MAX(ws_connected, excluded.ws_connected), ws_down_ms = ws_down_ms + excluded.ws_down_ms,
         rest_ok = rest_ok + excluded.rest_ok, rest_fail = rest_fail + excluded.rest_fail, rest_429 = rest_429 + excluded.rest_429,
         rest_ms_sum = rest_ms_sum + excluded.rest_ms_sum, rest_ms_max = MAX(rest_ms_max, excluded.rest_ms_max),
         cron_delay_ms_max = MAX(cron_delay_ms_max, excluded.cron_delay_ms_max), skew_ms = COALESCE(excluded.skew_ms, skew_ms)`,
      this.countsMinute, c.wsMsgs, this.ws ? 1 : 0, c.wsDownMs, c.restOk, c.restFail, c.rest429, c.restMsSum, c.restMsMax, c.cronDelayMsMax, c.skewMs
    );
    this.counts = emptyCounts();
  }

  /** Deletes rows older than the retention window, at most once an hour (ts is indexed, so this is cheap). */
  private retentionIfDue(): void {
    const now = Date.now();
    if (now - Number(this.meta('last_retention_at') ?? 0) < RETENTION_EVERY_MS) return;
    this.sql.exec('DELETE FROM probe_minute WHERE minute_ts < ?', now - RETAIN_MS);
    this.sql.exec('DELETE FROM probe_event WHERE ts < ?', now - RETAIN_MS);
    this.setMeta('last_retention_at', String(now));
  }

  /** Records an event; an identical event within a minute of the previous one is skipped, so error storms stay cheap. */
  private event(kind: string, detail: string): void {
    const key = `${kind}|${detail}`;
    const now = Date.now();
    if (key === this.lastEventKey && now - this.lastEventAt < EVENT_REPEAT_WINDOW_MS) return;
    this.lastEventKey = key;
    this.lastEventAt = now;
    this.sql.exec('INSERT INTO probe_event (ts, kind, detail) VALUES (?, ?, ?)', now, kind, detail.slice(0, 500));
  }
}
