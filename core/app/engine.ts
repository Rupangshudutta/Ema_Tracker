// The engine: one place that runs the whole bot, the same code on Cloudflare (inside the Tracker Durable Object) and
// in the Docker spare. The host gives it a clock, outbound fetch, a way to open Delta's live feed and a way to be
// woken up; the engine decides everything else.
//
// Every minute (3 s after the boundary, so Delta has published the candle):
//   1. who sends: the runtime that holds the Telegram connection (webhook on Cloudflare, long polling in Docker)
//   2. coin universe and watchlist (every 15 min, or every minute while the live feed is down, as a price fallback)
//   3. confirmed alerts for every coin-timeframe whose candle just closed (fresh closed candles, hysteresis rule)
//   4. daily report, degraded warnings, Healthchecks ping, then the outbox
// Between minutes, live prices drive the realtime alerts.
import { SYSTEM, TIMEFRAMES, TIMEFRAME_MS, isTimeframe, type Timeframe, type UserSettings } from '../config/settings.ts';
import type { RuntimeEnv } from '../config/env.ts';
import { closedSeries, lastClosedStart, type Candle, type SeriesCheck } from '../domain/candles.ts';
import { emaSeries } from '../domain/ema.ts';
import { alertId } from '../domain/ids.ts';
import { closeOutcome, evaluateConfirmed, evaluateRealtime, newRealtimeCandle, spreadPct, type EmaPair } from '../domain/signal.ts';
import { DeltaClient, type DeltaFailure, type DeltaTicker, type FetchFn } from '../exchange/delta.ts';
import { TelegramClient, describeTelegramFailure, type TelegramFailure, type TelegramUpdate } from '../notify/telegram.ts';
import type { PortableState, SeriesRecord, Store, WatchRow } from '../store/store.ts';
import { syncKey, webhookSecret } from './auth.ts';
import { handleUpdate } from './bot.ts';
import { Feed, type FeedOpener, type FeedStatus } from './feed.ts';
import { notes, renderDailyReport, type AlertPayload, type StartKind, type TickerContext, type TopListKind } from './messages.ts';
import { deliver } from './outbox.ts';
import { applyUniverse, editCoin, qualifies } from './watchlist.ts';

export type RuntimeName = 'Cloudflare' | 'Docker';
export type Role = 'active' | 'standby';

export interface EngineHost {
  runtime: RuntimeName;
  /** Version label shown in messages, for example "2.1.0 (abcd1234)". */
  version: string;
  fetch: FetchFn;
  openFeed: FeedOpener;
  /** Ask the host to call wake() at local time `at` (or sooner). */
  requestWake(at: number): void;
  /** Outbound calls allowed per wake-up: Cloudflare's free plan allows 50 per invocation; Infinity in Docker. */
  callBudget: number;
  /** Local clock; defaults to Date.now. */
  now?: () => number;
  /** True where the local clock is known to be accurate (Cloudflare); Docker follows Delta's clock instead. */
  trustLocalClock?: boolean;
  /** Console logging (Cloudflare observability or Docker logs). */
  print?: (line: string) => void;
}

export interface CoinInfo {
  symbol: string;
  turnoverUsd24h: number | null;
  change24hPct: number | null;
  lastPrice: number | null;
  /** 'available' = above the volume filter but not on the watchlist. */
  status: WatchRow['status'] | 'available';
  timeframes: Timeframe[];
  qualifies: boolean;
}

export interface EngineStatus {
  runtime: RuntimeName;
  version: string;
  role: Role;
  roleReason: string;
  configProblems: string[];
  /** Random, non-secret ID of this engine's notebook. */
  instance: string;
  startedAt: number;
  lastMinuteAt: number | null;
  feed: FeedStatus;
  coins: { active: number; paused: number; removed: number; series: number; universe: number };
  delta: { failingSince: number | null; lastError: string | null; backoffUntil: number | null };
  telegram: { lastError: string | null; lastErrorAt: number | null; blocked: boolean };
  outbox: { pending: number; oldestEventAt: number | null };
  /** Alerts since the last daily report: all found, and those held back (paused, standby or Telegram not set up). */
  alerts: { found: number; heldBack: number };
  /** Local date (YYYY-MM-DD, report time zone) of the last daily report, or null before the first one. */
  lastDailyReport: string | null;
  settings: UserSettings;
  clockOffsetMs: number;
  healthy: boolean;
  problems: string[];
}

const MINUTE_MS = 60_000;
const SETTLE_MS = SYSTEM.timing.settleSeconds * 1000;
const UNIVERSE_EVERY_MS = SYSTEM.coins.universeRefreshMinutes * MINUTE_MS;
const DROP_GRACE_MS = SYSTEM.coins.dropGraceMinutes * MINUTE_MS;
const MAX_ALERT_AGE_MS = SYSTEM.delivery.maxAlertAgeHours * 60 * MINUTE_MS;
const PAIR: EmaPair = { fast: SYSTEM.signal.emaFast, slow: SYSTEM.signal.emaSlow };
/** Candle requests run this many at a time; each may cost 2 calls on Cloudflare (one retry). */
const CONCURRENCY = 6;
const CALLS_PER_SERIES = 2;
/** Calls kept back in every run for delivery, the health ping and the feed. */
const RESERVE_CALLS = 8;
const STALE_RETRY_MS = 5_000;
const STALE_MAX_RETRIES = 6;
const FEED_FALLBACK_AFTER_MS = 20_000;
const WARN_AFTER_MS = 5 * MINUTE_MS;
const DOCKER_SILENCE_MS = 10 * MINUTE_MS;
const COUNTER_FLUSH_MS = 15 * MINUTE_MS;
const PRUNE_EVERY_MS = 60 * MINUTE_MS;
const PAUSE_FOREVER_MS = 30 * 24 * 60 * MINUTE_MS;
/** Restarts with less downtime than this (Cloudflare moving the desk worker) get no start message. */
const START_NOTE_AFTER_DOWN_MS = 2 * MINUTE_MS;
/** Bump to redo setWebhook, the command list and the menu button on the next start (2: /top added). */
const SETUP_VERSION = '2';

const seriesKey = (symbol: string, tf: Timeframe): string => `${symbol}|${tf}`;
const describeDelta = (e: DeltaFailure): string =>
  e.kind === 'rate-limited' ? `rate limited for ${Math.round(e.retryAfterMs / 1000)} s` : e.kind === 'http' ? `HTTP ${e.status}` : e.kind === 'timeout' ? 'timeout' : `${e.kind}: ${e.message}`;
const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

class Budget {
  readonly max: number;
  used = 0;
  constructor(max: number) {
    this.max = max;
  }
  remaining(): number {
    return this.max - this.used;
  }
  wrap(fetchFn: FetchFn): FetchFn {
    return (url, init) => {
      if (this.used >= this.max) return Promise.reject(new Error('outbound call budget for this run is used up'));
      this.used++;
      return fetchFn(url, init);
    };
  }
}

interface RetryState {
  attempts: number;
  notBefore: number;
  warned: boolean;
}

export class Engine {
  readonly store: Store;
  readonly host: EngineHost;
  readonly env: RuntimeEnv | null;
  readonly configProblems: string[];
  private readonly feed: Feed;
  private readonly localNow: () => number;
  private readonly startedAt: number;

  private universe = new Map<string, DeltaTicker>();
  private universeAt = 0;
  private watch: WatchRow[] = [];
  private watchBySymbol = new Map<string, WatchRow>();
  private series = new Map<string, SeriesRecord>();
  private retries = new Map<string, RetryState>();
  private clockOffsetMs = 0;

  private role: Role = 'standby';
  private roleReason = 'starting';
  private roleKnown = false;
  private bootTakeoverDone = false;

  private nextMinuteAt = 0;
  private followUpAt: number | null = null;
  private deliverAt: number | null = null;
  private waking = false;
  private wakeAgain = false;
  private delivering = false;
  private lastMinuteAt: number | null = null;

  private restFailingSince: number | null = null;
  private restLastError: string | null = null;
  private restBackoffUntil = 0;
  private telegramLastError: string | null = null;
  private telegramLastErrorAt: number | null = null;
  private telegramBlocked = false;

  private counters: Record<string, number> = {};
  private countersFlushedAt = 0;
  private prunedAt = 0;
  private peerSyncAt = 0;
  private peerFailingSince: number | null = null;
  private peerWarned = false;

  /** Random ID of this notebook, so two Cloudflare copies (production and a local test) can tell each other apart. */
  private instanceId = '';
  /** When the previous run of this notebook was last alive (engine time), read at start-up. */
  private previousAliveAt: number | null = null;
  private startAnnounced = false;
  private publicCheckAt = 0;
  private otherEngineAtPublicUrl = false;
  private tickersAt = 0;

  constructor(store: Store, host: EngineHost, env: RuntimeEnv | null, configProblems: string[]) {
    this.store = store;
    this.host = host;
    this.env = env;
    this.configProblems = configProblems;
    this.localNow = host.now ?? Date.now;
    this.startedAt = this.localNow();
    this.feed = new Feed(
      host.openFeed,
      (symbol, price, ts) => {
        this.onPrice(symbol, price, ts).catch(err => this.fault('realtime', err));
      },
      () => this.now(),
      (kind, detail) => this.print(`${kind}: ${detail}`),
      at => this.requestWake(at)
    );
    store.onCorruptSettings = errors => this.warn('settings_corrupt', `stored settings are invalid, using defaults: ${errors.join('; ')}`);
  }

  /** Loads the notebook into memory and starts the feed for the stored watchlist. Call once after construction. */
  init(): void {
    this.store.migrate();
    this.instanceId = this.store.getMeta('instance_id') ?? crypto.randomUUID();
    this.store.setMeta('instance_id', this.instanceId);
    const alive = Number(this.store.getMeta('alive_at') ?? 0);
    this.previousAliveAt = alive > 0 ? alive : null;
    this.store.addStats({ instance_starts: 1 });
    for (const rec of this.store.seriesAll()) this.series.set(seriesKey(rec.symbol, rec.timeframe), rec);
    this.reloadWatch();
    this.print(`engine start: ${this.host.runtime} ${this.host.version}, ${this.watch.length} watch rows, ${this.series.size} series${this.configProblems.length ? `; config problems: ${this.configProblems.join('; ')}` : ''}`);
  }

  currentRole(): Role {
    return this.role;
  }

  /** Public, non-secret ID of this notebook (shown on /health). */
  id(): string {
    return this.instanceId;
  }

  /**
   * Planned stop (Docker: docker compose down, Ctrl+C). If this engine is sending, it first hands alerts back to
   * Cloudflare when it can, then says goodbye in the chat. Cloudflare gives no warning before it stops a Durable
   * Object, so there the next start says how long the bot was away instead.
   */
  async shutdown(reason: string): Promise<void> {
    this.feed.close();
    const env = this.env;
    if (!env || this.role !== 'active') return;
    const now = this.now();
    this.store.setMeta('clean_stop_at', String(now));
    let detail = `${reason[0]!.toUpperCase()}${reason.slice(1)}.`;
    if (this.host.runtime === 'Docker' && env.publicBaseUrl) {
      const r = await this.handBackToCloudflare(`shutdown (${reason})`);
      detail += r.ok ? ' Alerts were handed back to Cloudflare, which carries on.' : ` Could not hand alerts back to Cloudflare (${r.message}). If Cloudflare is running it takes over by itself within 10 minutes.`;
    } else {
      detail += ' Alerts stop until the bot runs again.';
    }
    const sent = await this.telegram(new Budget(4)).sendMessage(env.telegramChatId, notes.stopping(this.host.runtime, detail));
    if (!sent.ok) this.print(`shutdown message failed: ${describeTelegramFailure(sent.error)}`);
  }

  /** Engine time: the local clock corrected by Delta's clock (the PC clock was ~10 s slow; Cloudflare's is accurate). */
  now(): number {
    return this.localNow() + this.clockOffsetMs;
  }

  // ================================================================ wake-ups

  /** Runs whatever is due. Hosts call this from their timer (Cloudflare alarm, Docker setTimeout). */
  async wake(): Promise<void> {
    if (this.waking) {
      this.wakeAgain = true;
      return;
    }
    this.waking = true;
    try {
      do {
        this.wakeAgain = false;
        await this.wakeOnce(new Budget(this.host.callBudget));
      } while (this.wakeAgain && this.host.callBudget === Number.POSITIVE_INFINITY);
    } catch (err) {
      this.fault('wake', err);
    } finally {
      this.waking = false;
      this.host.requestWake(this.wakeAgain ? this.localNow() : this.nextWakeLocal());
    }
  }

  /** Local time of the next thing that needs doing. */
  nextWakeLocal(): number {
    const times = [this.nextMinuteAt || this.now(), this.followUpAt, this.deliverAt, this.feed.nextWakeAt()].filter((t): t is number => t !== null);
    return Math.min(...times) - this.clockOffsetMs;
  }

  private async wakeOnce(budget: Budget): Promise<void> {
    await this.feed.check();
    const now = this.now();
    if (now >= this.nextMinuteAt) {
      this.nextMinuteAt = Math.floor(now / MINUTE_MS) * MINUTE_MS + MINUTE_MS + SETTLE_MS;
      await this.minute(now, budget);
    } else if (this.followUpAt !== null && now >= this.followUpAt) {
      this.followUpAt = null;
      await this.confirmedCycle(now, budget);
    }
    if (this.deliverAt !== null && this.now() >= this.deliverAt) await this.deliverNow(budget);
  }

  private requestWake(at: number): void {
    this.host.requestWake(at - this.clockOffsetMs);
  }

  private followUp(at: number): void {
    if (this.followUpAt === null || at < this.followUpAt) this.followUpAt = at;
    this.requestWake(at);
  }

  private scheduleDelivery(at: number): void {
    if (this.deliverAt === null || at < this.deliverAt) this.deliverAt = at;
    this.requestWake(at);
  }

  private async minute(now: number, budget: Budget): Promise<void> {
    this.count('minute_runs');
    await this.checkLease(now, budget);

    const feed = this.feed.status();
    const feedDown = feed.wanted > 0 && !feed.connected && feed.downSince !== null && now - feed.downSince > FEED_FALLBACK_AFTER_MS;
    if (!this.universe.size || now - this.universeAt >= UNIVERSE_EVERY_MS || feedDown) {
      if (await this.refreshUniverse(now, budget)) {
        this.applyWatchlist(now, DROP_GRACE_MS);
        if (feedDown) await this.priceFallback();
      }
    }
    this.announceStart(now);
    await this.confirmedCycle(now, budget);
    this.lastMinuteAt = now;
    this.store.setMeta('alive_at', String(now));

    this.pauseEnded(now);
    this.dailyReportIfDue(now);
    this.warnings(now);
    if (this.host.runtime === 'Docker') await this.syncWithCloudflare(now, budget);
    await this.deliverNow(budget);
    await this.healthPing(now, budget);
    this.housekeeping(now);
  }

  // ================================================================ who sends (the Telegram connection is the lease)

  /** The Cloudflare Worker's webhook URL (PUBLIC_BASE_URL is always Cloudflare's address, in both runtimes). */
  webhookUrl(): string | null {
    const base = this.env?.publicBaseUrl;
    return base ? `${base.replace(/\/$/, '')}/telegram/webhook` : null;
  }

  private async checkLease(now: number, budget: Budget): Promise<void> {
    const env = this.env;
    if (!env) {
      this.setRole('standby', `configuration problem: ${this.configProblems.join('; ')}`, now);
      return;
    }
    const tg = this.telegram(budget);
    const info = await tg.getWebhookInfo();
    if (!info.ok) {
      this.telegramFailure(info.error, now);
      return;
    }
    const url = info.result.url ?? '';
    const ours = this.webhookUrl();

    if (this.host.runtime === 'Docker') {
      if (env.role === 'active' && !this.bootTakeoverDone) {
        if (url) {
          const r = await tg.deleteWebhook();
          if (!r.ok) {
            this.telegramFailure(r.error, now);
            return;
          }
          this.store.audit(now, 'docker', 'took over the Telegram connection at start (RUNTIME_ROLE=active)');
        }
        this.bootTakeoverDone = true;
        this.setRole('active', 'took over at start (RUNTIME_ROLE=active)', now);
        return;
      }
      if (!url) this.setRole('active', 'the Telegram connection is free (Cloudflare handed over)', now);
      else this.setRole('standby', 'Cloudflare holds the Telegram webhook', now);
      return;
    }

    if (!ours) {
      this.setRole('standby', 'PUBLIC_BASE_URL is not set', now);
      return;
    }
    if ((url === ours || url === '') && (await this.otherEngineServesPublicUrl(now, budget))) {
      this.setRole('standby', 'another copy of the bot is active at PUBLIC_BASE_URL (this one is probably a local test), so it stays silent to avoid double alerts', now);
      return;
    }
    if (url === ours) {
      await this.ensureTelegramSetup(tg, ours, now);
      this.setRole('active', 'holds the Telegram webhook', now);
      return;
    }
    if (url === '') {
      const claimed = this.store.getMeta('webhook_claimed') === '1';
      const dockerQuiet = now - Number(this.store.getMeta('docker_active_seen_at') ?? 0) > DOCKER_SILENCE_MS;
      if (env.role === 'active' && (!claimed || dockerQuiet)) {
        const r = await tg.setWebhook(ours, await webhookSecret(env.telegramBotToken, env.telegramWebhookSecret));
        if (!r.ok) {
          this.telegramFailure(r.error, now);
          return;
        }
        this.store.setMeta('webhook_claimed', '1');
        this.store.setMeta('telegram_setup', '');
        this.store.audit(now, 'cloudflare', claimed ? 'took the Telegram webhook back: the Docker spare went quiet' : 'claimed the Telegram webhook');
        await this.ensureTelegramSetup(tg, ours, now);
        this.setRole('active', claimed ? 'took the webhook back because the Docker spare went quiet for 10 min' : 'claimed the Telegram webhook', now);
        return;
      }
      this.setRole('standby', 'the Docker spare holds the Telegram connection', now);
      return;
    }
    let host = 'another address';
    try {
      host = new URL(url).host;
    } catch {
      // keep the generic text
    }
    this.setRole('standby', `the Telegram webhook points to ${host}`, now);
  }

  /**
   * Two Cloudflare copies with the same secrets (production and a local `wrangler dev` test) would both see the
   * webhook as theirs and both send. Each notebook has a random ID that /health shows, so a copy that finds a
   * different active engine at PUBLIC_BASE_URL knows it is not the public one. When the check cannot tell (no reply,
   * an older version, or Cloudflare refusing a Worker's call to itself) it does not block: production never stops
   * itself.
   */
  private async otherEngineServesPublicUrl(now: number, budget: Budget): Promise<boolean> {
    const base = this.env?.publicBaseUrl?.replace(/\/$/, '');
    if (!base) return false;
    const every = this.role === 'active' ? MINUTE_MS - 5_000 : 5 * MINUTE_MS;
    if (now - this.publicCheckAt < every) return this.otherEngineAtPublicUrl;
    this.publicCheckAt = now;
    try {
      const res = await budget.wrap(this.host.fetch)(`${base}/health`, { headers: { 'user-agent': SYSTEM.exchange.userAgent, 'cache-control': 'no-cache' }, signal: AbortSignal.timeout(5_000) });
      const body = (await res.json()) as { instance?: unknown; role?: unknown };
      const other = typeof body.instance === 'string' && body.instance !== this.instanceId && body.role === 'active';
      if (other !== this.otherEngineAtPublicUrl) this.print(other ? 'another active engine answers at PUBLIC_BASE_URL; staying silent' : 'this engine is the one at PUBLIC_BASE_URL');
      this.otherEngineAtPublicUrl = other;
    } catch {
      this.otherEngineAtPublicUrl = false;
    }
    return this.otherEngineAtPublicUrl;
  }

  /** Webhook secret, command list and the Coins menu button; redone when the version of this setup changes. */
  private async ensureTelegramSetup(tg: TelegramClient, ours: string, now: number): Promise<void> {
    const env = this.env!;
    const secret = await webhookSecret(env.telegramBotToken, env.telegramWebhookSecret);
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret)));
    const key = `${SETUP_VERSION}|${ours}|${Array.from(digest.slice(0, 4), b => b.toString(16).padStart(2, '0')).join('')}`;
    if (this.store.getMeta('telegram_setup') === key) return;
    const steps = [
      await tg.setWebhook(ours, secret),
      await tg.call('setMyCommands', {
        commands: [
          { command: 'start', description: 'Menu: status, settings, coins, top lists, pause' },
          { command: 'status', description: 'Is the bot healthy right now?' },
          { command: 'top', description: 'Top gainers, top losers and highest volume (24 h)' },
          { command: 'coins', description: 'Watchlist and timeframes' },
          { command: 'settings', description: 'Margin, volume filter, report time' },
          { command: 'pause', description: 'Pause alerts for a while' },
          { command: 'resume', description: 'Resume alerts' },
          { command: 'help', description: 'What the alerts mean' }
        ]
      })
    ];
    if (!env.telegramChatId.startsWith('-') && env.publicBaseUrl) {
      steps.push(await tg.call('setChatMenuButton', { chat_id: Number(env.telegramChatId), menu_button: { type: 'web_app', text: 'Coins', web_app: { url: `${env.publicBaseUrl.replace(/\/$/, '')}/app` } } }));
    }
    const failed = steps.find(s => !s.ok);
    if (failed && !failed.ok) {
      this.telegramFailure(failed.error, now);
      return;
    }
    this.store.setMeta('telegram_setup', key);
  }

  private setRole(role: Role, reason: string, now: number): void {
    const changed = role !== this.role || !this.roleKnown;
    const wasKnown = this.roleKnown;
    this.role = role;
    this.roleReason = reason;
    this.roleKnown = true;
    if (!changed) return;
    this.print(`role: ${role} (${reason})`);
    if (role === 'standby') {
      this.store.suppressPending();
      this.deliverAt = null;
      return;
    }
    if (wasKnown) {
      // A switch between engines: this note is the start message for the engine taking over.
      this.startAnnounced = true;
      this.store.setMeta('announced', `${this.host.runtime}|${this.host.version}`);
      this.enqueueNote(`role:${now}`, notes.recovered(`${this.host.runtime} is sending alerts now`, reason), now);
    }
  }

  /**
   * The start message, once per start of this engine, when it is the one sending: first start, back after an
   * outage (with how long it was away), after a planned stop, or a new version. A restart with no real downtime
   * (Cloudflare moving the desk worker between machines) is only counted in the daily report.
   */
  private announceStart(now: number): void {
    if (this.role !== 'active' || this.startAnnounced) return;
    this.startAnnounced = true;
    const key = `${this.host.runtime}|${this.host.version}`;
    const newVersion = this.store.getMeta('announced') !== key;
    const lastSeenAt = this.previousAliveAt;
    const downMs = lastSeenAt === null ? null : Math.max(0, now - lastSeenAt);
    const planned = this.store.getMeta('clean_stop_at') !== null;
    const kind: StartKind | null =
      lastSeenAt === null ? 'first'
      : downMs !== null && downMs >= START_NOTE_AFTER_DOWN_MS ? (planned ? 'restart' : 'outage')
      : newVersion ? 'deploy'
      : null;
    this.store.transaction(() => {
      this.store.setMeta('announced', key);
      this.store.deleteMeta('clean_stop_at');
      if (kind) {
        this.enqueueNote(`start:${now}`, notes.started({ kind, newVersion, runtime: this.host.runtime, version: this.host.version, downMs, lastSeenAt, watch: this.watch, settings: this.store.settings() }), now);
      }
    });
    if (!kind) this.print(`restarted after ${Math.round((downMs ?? 0) / 1000)} s; too short for a start message`);
  }

  /** Cloudflare: switch to the Docker spare (Telegram command /use_docker). */
  async handOverToDocker(actor: string): Promise<string> {
    const now = this.now();
    if (this.host.runtime !== 'Cloudflare' || !this.env) return 'Only the Cloudflare engine can hand over to Docker.';
    if (this.role !== 'active') return 'Cloudflare is not the active engine right now.';
    const seen = Number(this.store.getMeta('docker_standby_seen_at') ?? 0);
    if (now - seen > DOCKER_SILENCE_MS) return 'The Docker spare has not checked in during the last 10 minutes, so I am staying on Cloudflare. Start it first (see docs/RUNBOOK.md).';
    const r = await this.telegram(new Budget(4)).deleteWebhook();
    if (!r.ok) return `Telegram refused the switch: ${describeTelegramFailure(r.error)}`;
    this.store.setMeta('docker_active_seen_at', String(now)); // give Docker the full quiet window before any take-back
    this.store.audit(now, actor, 'handed over to the Docker spare');
    this.setRole('standby', `handed over to Docker by ${actor}`, now);
    return 'Switching to the Docker spare: it takes over within a minute and says so here. Send /use_cloudflare to switch back.';
  }

  /** Docker: give alerts back to Cloudflare (Telegram command /use_cloudflare, or a planned stop). Copies settings and watchlist first. */
  async handBackToCloudflare(actor: string): Promise<{ ok: boolean; message: string }> {
    const now = this.now();
    const env = this.env;
    const fail = (message: string): { ok: false; message: string } => ({ ok: false, message });
    if (this.host.runtime !== 'Docker' || !env) return fail('Only the Docker spare can hand back to Cloudflare.');
    if (this.role !== 'active') return fail('The Docker spare is not the active engine right now.');
    const base = env.publicBaseUrl?.replace(/\/$/, '');
    const hook = this.webhookUrl();
    if (!base || !hook) return fail('PUBLIC_BASE_URL is not set in .env.docker, so I do not know where Cloudflare is.');
    const key = await syncKey(env.telegramBotToken);
    try {
      const res = await this.host.fetch(`${base}/api/sync/state`, {
        method: 'PUT',
        headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        body: JSON.stringify(this.store.exportState()),
        signal: AbortSignal.timeout(10_000)
      });
      if (!res.ok) return fail(`Cloudflare did not accept the settings copy (HTTP ${res.status}); staying on Docker.`);
    } catch (err) {
      return fail(`Cloudflare is not reachable (${errText(err)}); staying on Docker.`);
    }
    const r = await this.telegram(new Budget(4)).setWebhook(hook, await webhookSecret(env.telegramBotToken, env.telegramWebhookSecret));
    if (!r.ok) return fail(`Telegram refused the switch: ${describeTelegramFailure(r.error)}`);
    this.store.audit(now, actor, 'handed back to Cloudflare');
    this.setRole('standby', `handed back to Cloudflare by ${actor}`, now);
    return { ok: true, message: 'Handed back to Cloudflare: it takes over within a minute and says so here. The Docker spare keeps running on standby.' };
  }

  /** Docker: tell Cloudflare we are alive, and on standby copy its settings and watchlist every 5 minutes. */
  private async syncWithCloudflare(now: number, budget: Budget): Promise<void> {
    const env = this.env;
    const base = env?.publicBaseUrl?.replace(/\/$/, '');
    if (!env || !base) return;
    const key = await syncKey(env.telegramBotToken);
    const fetchFn = budget.wrap(this.host.fetch);
    let reached = false;
    try {
      const hb = await fetchFn(`${base}/api/sync/heartbeat`, {
        method: 'POST',
        headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        body: JSON.stringify({ role: this.role }),
        signal: AbortSignal.timeout(8_000)
      });
      reached = hb.ok;
    } catch (err) {
      this.print(`check-in with Cloudflare failed: ${errText(err)}`);
    }
    await this.watchCloudflare(reached, now, budget);
    if (!reached) return;
    try {
      if (this.role !== 'standby' || now - this.peerSyncAt < 5 * MINUTE_MS) return;
      const res = await fetchFn(`${base}/api/sync/state`, { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(8_000) });
      if (!res.ok) return;
      const state = (await res.json()) as PortableState;
      const r = this.importState(state, 'sync from Cloudflare');
      if (r.ok) this.peerSyncAt = now;
      else this.warn('sync', `Cloudflare state rejected: ${r.errors.join('; ')}`);
    } catch (err) {
      this.print(`sync with Cloudflare failed: ${errText(err)}`);
    }
  }

  /**
   * Docker on standby is the only one that can notice Cloudflare stopping (Cloudflare cannot say goodbye). After
   * 5 minutes without an answer it says so in the chat, once, even on standby (a status note, not an alert, so
   * nothing is doubled), and again when Cloudflare answers.
   */
  private async watchCloudflare(reached: boolean, now: number, budget: Budget): Promise<void> {
    const env = this.env;
    if (!env) return;
    if (reached) {
      if (this.peerWarned) await this.sendDirect(notes.peerBack(), budget);
      this.peerFailingSince = null;
      this.peerWarned = false;
      return;
    }
    this.peerFailingSince ??= now;
    if (this.peerWarned || this.role !== 'standby' || now - this.peerFailingSince < WARN_AFTER_MS) return;
    this.peerWarned = true;
    this.warn('cloudflare', 'Cloudflare engine not answering');
    await this.sendDirect(notes.peerDown(now - this.peerFailingSince), budget);
  }

  /** Sends a status note right away, outside the outbox (used where the outbox is on standby). */
  private async sendDirect(html: string, budget: Budget): Promise<void> {
    if (!this.env) return;
    const r = await this.telegram(budget).sendMessage(this.env.telegramChatId, html);
    if (!r.ok) this.telegramFailure(r.error, this.now());
  }

  /** Cloudflare: the Docker spare checked in. */
  peerHeartbeat(role: unknown): { role: Role } {
    const now = this.now();
    if (role === 'active') this.store.setMeta('docker_active_seen_at', String(now));
    if (role === 'standby') this.store.setMeta('docker_standby_seen_at', String(now));
    return { role: this.role };
  }

  exportState(): PortableState {
    return this.store.exportState();
  }

  importState(state: PortableState, actor: string): { ok: true } | { ok: false; errors: string[] } {
    const before = this.store.settings();
    const r = this.store.importState(state, actor, this.now());
    if (!r.ok) return r;
    this.afterSettingsChange(before, this.store.settings());
    this.reloadWatch();
    return r;
  }

  // ================================================================ coins and watchlist

  private async refreshUniverse(now: number, budget: Budget): Promise<boolean> {
    if (now < this.restBackoffUntil) return false;
    const r = await this.delta(budget).tickers();
    if (!r.ok) {
      this.restFailed(r.error, 'tickers', now);
      return false;
    }
    this.restSucceeded(r.serverNow, false); // the ticker list may come from Delta's cache, with an old Date header
    this.universe = new Map(r.value.tickers.map(t => [t.symbol, t]));
    this.universeAt = now;
    this.tickersAt = now;
    return true;
  }

  /**
   * Top gainers, top losers or highest volume over 24 h (the v1 bot's lists), from a fresh ticker snapshot when the
   * cached one is over a minute old. Gainers and losers skip coins under the list's minimum volume, because Delta
   * lists many near-dead coins whose percentages mean little.
   */
  async topList(kind: TopListKind): Promise<{ items: DeltaTicker[]; at: number; minVolumeUsd: number }> {
    const now = this.now();
    if (now - this.tickersAt > MINUTE_MS && now >= this.restBackoffUntil) {
      const r = await this.delta(new Budget(4)).tickers();
      if (r.ok) {
        this.universe = new Map(r.value.tickers.map(t => [t.symbol, t]));
        this.tickersAt = now;
      } else {
        this.restFailed(r.error, 'tickers', now);
      }
    }
    const minVolumeUsd = SYSTEM.market.topListMinVolumeUsd;
    const live = [...this.universe.values()].filter(t => t.tradingStatus === 'operational');
    const items =
      kind === 'volume' ? live.sort((a, b) => b.turnoverUsd24h - a.turnoverUsd24h)
      : live
          // at least 0.01% in the list's direction, so the list never shows "0.00%"
          .filter(t => t.turnoverUsd24h >= minVolumeUsd && (kind === 'gainers' ? t.change24hPct >= 0.005 : t.change24hPct <= -0.005))
          .sort((a, b) => (kind === 'gainers' ? b.change24hPct - a.change24hPct : a.change24hPct - b.change24hPct));
    return { items: items.slice(0, SYSTEM.market.topListSize), at: this.tickersAt, minVolumeUsd };
  }

  private applyWatchlist(now: number, graceMs: number): void {
    if (!this.universe.size) return;
    const s = this.store.settings();
    const ch = applyUniverse(this.store.watchList(), this.universe, s, now, graceMs);
    const capNoted = Number(this.store.getMeta('cap_noted') ?? 0);
    this.store.transaction(() => {
      for (const row of ch.rows) this.store.saveWatch(row);
      if (ch.joined.length) this.enqueueNote(`joined:${now}`, notes.joined(ch.joined, s.coins.defaultTimeframes), now);
      if (ch.paused.length) this.enqueueNote(`paused:${now}`, notes.paused(ch.paused, s.coins.volumeThresholdUsd), now);
      if (ch.resumed.length) this.enqueueNote(`resumed:${now}`, notes.resumed(ch.resumed), now);
      if (ch.overCap > capNoted) this.enqueueNote(`cap:${now}`, notes.capReached(ch.overCap, SYSTEM.coins.maxWatchlistCoins), now);
      if (ch.overCap !== capNoted) this.store.setMeta('cap_noted', String(ch.overCap));
    });
    if (ch.rows.length) this.reloadWatch();
  }

  private reloadWatch(): void {
    this.watch = this.store.watchList();
    this.watchBySymbol = new Map(this.watch.map(w => [w.symbol, w]));
    this.feed.setWanted(this.watch.filter(w => w.status === 'active' && w.timeframes.length).map(w => w.symbol));
  }

  /** The user ticks timeframes for a coin (mini app, /watch, /unwatch). */
  setCoinTimeframes(symbol: string, timeframes: readonly string[], actor: string): { ok: true; message: string } | { ok: false; reason: string } {
    const tfs = timeframes.filter(isTimeframe);
    if (tfs.length !== timeframes.length) return { ok: false, reason: `Unknown timeframe; use ${TIMEFRAMES.join(', ')}.` };
    const now = this.now();
    const res = editCoin(this.store.watchList(), this.universe, this.store.settings(), symbol, tfs, now);
    if (!res.ok) return res;
    this.store.transaction(() => {
      this.store.saveWatch(res.row);
      for (const tf of res.droppedTimeframes) this.store.deleteSeries(symbol, tf);
      this.store.audit(now, actor, res.message);
    });
    for (const tf of res.droppedTimeframes) this.series.delete(seriesKey(symbol, tf));
    this.reloadWatch();
    this.followUp(now); // new timeframes get their baseline within seconds
    return { ok: true, message: res.message };
  }

  /** Coins for the mini app: everything above the volume filter plus every coin on the watchlist. */
  coinList(): CoinInfo[] {
    const s = this.store.settings();
    const out = new Map<string, CoinInfo>();
    for (const t of this.universe.values()) {
      if (!qualifies(t, s)) continue;
      out.set(t.symbol, { symbol: t.symbol, turnoverUsd24h: t.turnoverUsd24h, change24hPct: t.change24hPct, lastPrice: t.lastPrice, status: 'available', timeframes: [], qualifies: true });
    }
    for (const w of this.watch) {
      const t = this.universe.get(w.symbol);
      const ok = qualifies(t, s);
      if (w.status === 'removed' && !ok) continue;
      out.set(w.symbol, {
        symbol: w.symbol,
        turnoverUsd24h: t?.turnoverUsd24h ?? null,
        change24hPct: t?.change24hPct ?? null,
        lastPrice: t?.lastPrice ?? null,
        status: w.status,
        timeframes: w.status === 'removed' ? [] : w.timeframes,
        qualifies: ok
      });
    }
    return [...out.values()].sort((a, b) => (b.turnoverUsd24h ?? 0) - (a.turnoverUsd24h ?? 0));
  }

  watchRows(): readonly WatchRow[] {
    return this.watch;
  }

  // ================================================================ settings

  settings(): UserSettings {
    return this.store.settings();
  }

  /** Applies a settings change from Telegram, with an audit line. */
  updateSettings(change: string, actor: string, mutate: (s: UserSettings) => UserSettings): { ok: true } | { ok: false; errors: string[] } {
    const before = this.store.settings();
    const r = this.store.saveSettings(mutate(structuredClone(before)), actor, change, this.now());
    if (r.ok) this.afterSettingsChange(before, this.store.settings());
    return r;
  }

  private afterSettingsChange(before: UserSettings, after: UserSettings): void {
    const now = this.now();
    if (Math.abs(before.signal.marginPct - after.signal.marginPct) > 1e-9) {
      // Sides computed with the old margin mean nothing under the new one: rebuild every series quietly (no alerts
      // from history), which takes a few seconds.
      this.store.deleteAllSeries();
      this.series.clear();
      this.followUp(now);
    }
    if (before.coins.volumeThresholdUsd !== after.coins.volumeThresholdUsd) this.applyWatchlist(now, 0);
    if (after.delivery.pausedUntil !== null && after.delivery.pausedUntil > now) this.store.setMeta('pause_noted', '1');
  }

  pause(minutes: number | null, actor: string): { ok: true; until: number } | { ok: false; errors: string[] } {
    const until = this.now() + (minutes === null ? PAUSE_FOREVER_MS : minutes * MINUTE_MS);
    const r = this.updateSettings(`pause ${minutes === null ? 'until resumed' : `${minutes} min`}`, actor, s => ({ ...s, delivery: { pausedUntil: until } }));
    return r.ok ? { ok: true, until } : r;
  }

  resume(actor: string): { ok: true } | { ok: false; errors: string[] } {
    this.store.deleteMeta('pause_noted');
    return this.updateSettings('resume', actor, s => ({ ...s, delivery: { pausedUntil: null } }));
  }

  private pauseEnded(now: number): void {
    const until = this.store.settings().delivery.pausedUntil;
    if (until === null || until > now || this.store.getMeta('pause_noted') !== '1') return;
    this.store.transaction(() => {
      this.store.deleteMeta('pause_noted');
      this.enqueueNote(`unpaused:${now}`, '▶️ <b>Alerts are back on</b> (the pause ended).', now);
    });
  }

  // ================================================================ confirmed alerts (candle close)

  private dueSeries(now: number): { symbol: string; tf: Timeframe; key: string }[] {
    const out: { symbol: string; tf: Timeframe; key: string }[] = [];
    for (const w of this.watch) {
      if (w.status !== 'active') continue;
      for (const tf of w.timeframes) {
        const key = seriesKey(w.symbol, tf);
        const rec = this.series.get(key);
        if (rec && rec.state.lastCloseStart >= lastClosedStart(now, TIMEFRAME_MS[tf])) continue;
        const retry = this.retries.get(key);
        if (retry && retry.notBefore > now) continue;
        out.push({ symbol: w.symbol, tf, key });
      }
    }
    return out.sort((a, b) => TIMEFRAME_MS[a.tf] - TIMEFRAME_MS[b.tf] || a.symbol.localeCompare(b.symbol));
  }

  private async confirmedCycle(now: number, budget: Budget): Promise<void> {
    if (now < this.restBackoffUntil) {
      this.followUp(this.restBackoffUntil);
      return;
    }
    const due = this.dueSeries(now);
    const s = this.store.settings();
    for (let i = 0; i < due.length; i += CONCURRENCY) {
      if (budget.remaining() - RESERVE_CALLS < CONCURRENCY * CALLS_PER_SERIES) {
        this.followUp(this.now() + 1000); // the rest go in a follow-up run with a fresh call budget
        return;
      }
      await Promise.all(due.slice(i, i + CONCURRENCY).map(d => this.processSeries(d.symbol, d.tf, s, budget, false)));
      if (this.now() < this.restBackoffUntil) return;
    }
  }

  private async processSeries(symbol: string, tf: Timeframe, s: UserSettings, budget: Budget, longHistory: boolean): Promise<void> {
    const key = seriesKey(symbol, tf);
    const interval = TIMEFRAME_MS[tf];
    const margin = s.signal.marginPct;
    const rec = this.series.get(key);
    const prior = rec && Math.abs(rec.state.marginPct - margin) < 1e-9 ? rec.state : null;
    const count = prior && !longHistory ? SYSTEM.signal.candleHistory : SYSTEM.signal.rebuildHistory;

    const r = await this.delta(budget).candles(symbol, tf, count, this.now());
    if (!r.ok) {
      this.restFailed(r.error, `${symbol} ${tf} candles`, this.now());
      this.retryLater(key);
      return;
    }
    this.restSucceeded(r.serverNow, r.serverClock);
    const serverNow = r.serverClock ? r.serverNow : this.now();
    const check = closedSeries(r.value, interval, serverNow, SYSTEM.signal.emaSlow);
    if (!check.ok) {
      this.seriesProblem(key, symbol, tf, check);
      return;
    }
    if (this.retries.get(key)?.warned) this.print(`${symbol} ${tf}: candles available again`);
    this.retries.delete(key);

    const reportAfter = prior ? Math.max(prior.lastCloseStart, this.now() - MAX_ALERT_AGE_MS) : Number.POSITIVE_INFINITY;
    const res = evaluateConfirmed(check.candles, PAIR, margin, prior, reportAfter);
    if (res.status === 'rebuilt' && prior && !longHistory && r.value.length >= count) {
      // The remembered candle is older than this window (after an outage): fetch the long history once so the side
      // continues from memory instead of being rebuilt without it.
      return this.processSeries(symbol, tf, s, budget, true);
    }
    if (!res.state || res.status === 'too-short' || res.status === 'no-new-candle') {
      if (res.status === 'too-short') this.warnOnce(key, `${symbol} ${tf}: only ${check.candles.length} candles (new listing); waiting for more`);
      return;
    }

    // Live prices only touch the realtime part of a record while candles are fetched; take the newest one, and give
    // up only if the confirmed part itself changed meanwhile (then the newer result already stands).
    const latest = this.series.get(key);
    if (latest?.state !== rec?.state) return;
    const messages: { id: string; payload: AlertPayload; eventAt: number }[] = [];
    const ctx = this.tickerContext(symbol);
    const rt = prior ? (latest?.rt ?? null) : null;
    for (const c of res.crosses) {
      const outcome = closeOutcome(c.candleStart, rt, c);
      const earlier = rt !== null && rt.candleStart === c.candleStart && rt.alerted === c.direction;
      messages.push({
        id: await alertId({ kind: 'confirmed', symbol, timeframe: tf, candleStart: c.candleStart, direction: c.direction }),
        payload: { type: 'confirmed', symbol, timeframe: tf, direction: c.direction, candleStart: c.candleStart, close: c.close, spreadPct: c.spreadPct, marginPct: margin, realtimeAt: earlier ? (latest?.rtAlertedAt ?? null) : null, realtimeCancelled: outcome === 'confirmed-after-cancel', ctx },
        eventAt: c.candleStart + interval
      });
    }
    if (rt?.alerted && rt.candleStart <= res.state.lastCloseStart && !res.crosses.some(c => c.candleStart === rt.candleStart)) {
      const outcome = closeOutcome(rt.candleStart, rt, null);
      if (outcome === 'realtime-not-confirmed' || (outcome === 'realtime-cancelled' && !s.realtime.cancelNotes)) {
        messages.push({
          id: await alertId({ kind: 'not-confirmed', symbol, timeframe: tf, candleStart: rt.candleStart, direction: rt.alerted }),
          payload: { type: 'not-confirmed', symbol, timeframe: tf, direction: rt.alerted, candleStart: rt.candleStart, spreadPct: spreadAt(check.candles, rt.candleStart) ?? spreadPct(res.state.emaFast, res.state.emaSlow), marginPct: margin },
          eventAt: rt.candleStart + interval
        });
      }
    }

    if (this.series.get(key)?.state !== rec?.state) return;
    const next: SeriesRecord = { symbol, timeframe: tf, state: res.state, rt: newRealtimeCandle(res.state.lastCloseStart + interval), rtAlertedAt: null };
    const now = this.now();
    this.store.transaction(() => {
      this.store.saveSeries(next, now);
      for (const m of messages) this.enqueueAlert(m.id, m.payload, m.eventAt, now);
    });
    this.series.set(key, next);
    if (!prior) this.print(`${symbol} ${tf}: baseline ${res.state.side ?? 'no side yet'} from ${check.candles.length} candles`);
  }

  private seriesProblem(key: string, symbol: string, tf: Timeframe, check: Extract<SeriesCheck, { ok: false }>): void {
    const now = this.now();
    const r = this.retries.get(key) ?? { attempts: 0, notBefore: 0, warned: false };
    r.attempts++;
    this.count('series_problems');
    if ((check.problem === 'stale' || check.problem === 'empty') && r.attempts <= STALE_MAX_RETRIES) {
      r.notBefore = now + STALE_RETRY_MS;
      this.followUp(r.notBefore);
    } else {
      // Not published after ~30 s, or broken data: try again at the next minute (stale) or the next candle (other).
      r.notBefore = check.problem === 'stale' || check.problem === 'empty' ? now + 50_000 : lastClosedStart(now, TIMEFRAME_MS[tf]) + 2 * TIMEFRAME_MS[tf] + SETTLE_MS;
      if (!r.warned) {
        r.warned = true;
        this.warn('candles', `${symbol} ${tf}: ${check.problem} (${check.detail})`);
      }
    }
    this.retries.set(key, r);
  }

  /** After a failed candle request: retry in 10 s, 20 s, 40 s... up to 2 min, so a Delta outage is not hammered. */
  private retryLater(key: string): void {
    const r = this.retries.get(key) ?? { attempts: 0, notBefore: 0, warned: false };
    r.attempts++;
    r.notBefore = this.now() + Math.min(10_000 * 2 ** (r.attempts - 1), 2 * MINUTE_MS);
    this.retries.set(key, r);
    this.followUp(r.notBefore);
  }

  private warnOnce(key: string, detail: string): void {
    const r = this.retries.get(key) ?? { attempts: 0, notBefore: 0, warned: false };
    if (!r.warned) this.warn('candles', detail);
    r.warned = true;
    this.retries.set(key, r);
  }

  // ================================================================ realtime alerts (live price)

  private async onPrice(symbol: string, price: number, timestampMs: number): Promise<void> {
    const w = this.watchBySymbol.get(symbol);
    if (!w || w.status !== 'active') return;
    const s = this.store.settings();
    const margin = s.signal.marginPct;
    for (const tf of w.timeframes) {
      const key = seriesKey(symbol, tf);
      const rec = this.series.get(key);
      if (!rec?.rt) continue;
      const interval = TIMEFRAME_MS[tf];
      const at = timestampMs > 0 ? timestampMs : this.now();
      if (Math.floor(at / interval) * interval !== rec.rt.candleStart) continue; // belongs to another candle
      const { action, candle } = evaluateRealtime(rec.state, rec.rt, interval, price, PAIR, margin);
      if (action.kind === 'none') continue;
      const now = this.now();
      let message: { id: string; payload: AlertPayload } | null = null;
      if (action.kind === 'alert') {
        message = {
          id: await alertId({ kind: 'realtime', symbol, timeframe: tf, candleStart: candle.candleStart, direction: action.direction }),
          payload: { type: 'realtime', symbol, timeframe: tf, direction: action.direction, candleStart: candle.candleStart, price, spreadPct: action.spreadPct, marginPct: margin, ctx: this.tickerContext(symbol) }
        };
      } else if (s.realtime.cancelNotes) {
        message = {
          id: await alertId({ kind: 'realtime-cancel', symbol, timeframe: tf, candleStart: candle.candleStart, direction: action.direction }),
          payload: { type: 'realtime-cancel', symbol, timeframe: tf, direction: action.direction, candleStart: candle.candleStart, price, spreadPct: action.spreadPct }
        };
      }
      if (this.series.get(key) !== rec) continue; // the candle closed while the ID was computed
      const next: SeriesRecord = { ...rec, rt: candle, rtAlertedAt: action.kind === 'alert' ? now : rec.rtAlertedAt };
      this.store.transaction(() => {
        this.store.saveSeries(next, now);
        if (message) this.enqueueAlert(message.id, message.payload, now, now);
      });
      this.series.set(key, next);
    }
  }

  /** While the live feed is down, the minute's ticker snapshot stands in for live prices. */
  private async priceFallback(): Promise<void> {
    this.count('fallback_minutes');
    for (const w of this.watch) {
      if (w.status !== 'active') continue;
      const t = this.universe.get(w.symbol);
      if (t) await this.onPrice(w.symbol, t.lastPrice, t.timestampMs);
    }
  }

  private tickerContext(symbol: string): TickerContext | null {
    const t = this.universe.get(symbol);
    return t ? { change24hPct: t.change24hPct, turnoverUsd24h: t.turnoverUsd24h } : null;
  }

  // ================================================================ messages

  private alertStatus(now: number): 'pending' | 'suppressed' {
    const paused = this.store.settings().delivery.pausedUntil;
    return this.role === 'active' && this.env && !(paused !== null && paused > now) ? 'pending' : 'suppressed';
  }

  private enqueueAlert(id: string, payload: AlertPayload, eventAt: number, now: number): void {
    const status = this.alertStatus(now);
    if (!this.store.enqueue({ id, kind: 'alert', payload: JSON.stringify(payload), eventAt, status }, now)) return;
    this.count(status === 'pending' ? `alerts_${payload.type.replace('-', '_')}` : 'alerts_suppressed');
    if (status === 'pending') this.scheduleDelivery(now);
  }

  private enqueueNote(key: string, html: string, now: number): void {
    const status = this.role === 'active' && this.env ? 'pending' : 'suppressed';
    if (this.store.enqueue({ id: `note:${key}`, kind: 'note', payload: JSON.stringify({ type: 'note', html }), eventAt: now, status }, now) && status === 'pending') {
      this.scheduleDelivery(now);
    }
  }

  private async deliverNow(budget: Budget): Promise<void> {
    this.deliverAt = null;
    if (!this.env || this.role !== 'active') return;
    if (this.delivering) {
      this.scheduleDelivery(this.now() + 1000);
      return;
    }
    this.delivering = true;
    try {
      const now = this.now();
      const r = await deliver({
        store: this.store,
        sender: this.telegram(budget),
        chatId: this.env.telegramChatId,
        now,
        timeZone: this.store.settings().monitoring.timeZone,
        maxSends: Math.max(0, budget.remaining() - 2)
      });
      if (r.error) this.telegramFailure(r.error, now);
      else if (r.sent) this.telegramBlocked = false;
      const pending = this.store.pendingSummary();
      if (pending.nextAt !== null) this.scheduleDelivery(Math.max(pending.nextAt, r.more ? now + 1000 : pending.nextAt));
    } finally {
      this.delivering = false;
    }
  }

  // ================================================================ Telegram commands and the mini app

  /** One Telegram update (webhook on Cloudflare, long polling in Docker). */
  async handleTelegramUpdate(update: TelegramUpdate): Promise<void> {
    if (!this.env) return;
    if (!this.store.firstSeenUpdate(update.update_id, this.now())) return;
    try {
      await handleUpdate(this, this.telegram(new Budget(this.host.callBudget === Number.POSITIVE_INFINITY ? Number.POSITIVE_INFINITY : 40)), update);
    } catch (err) {
      this.fault('telegram update', err);
    }
  }

  // ================================================================ status, reports, warnings, health

  status(): EngineStatus {
    const now = this.now();
    const pending = this.store.pendingSummary();
    const problems: string[] = [];
    if (!this.env) problems.push(...this.configProblems);
    if (now - (this.lastMinuteAt ?? this.startedAt) > 3 * MINUTE_MS) problems.push('the minute timer has not run for 3 min');
    if (this.restFailingSince !== null && now - this.restFailingSince >= WARN_AFTER_MS) problems.push(`Delta API failing for ${Math.round((now - this.restFailingSince) / MINUTE_MS)} min`);
    if (this.telegramBlocked) problems.push(`Telegram refuses the bot: ${this.telegramLastError ?? 'unknown'}`);
    if (pending.oldestEventAt !== null && now - pending.oldestEventAt > 10 * MINUTE_MS) problems.push('messages waiting more than 10 min');
    let active = 0;
    let paused = 0;
    let removed = 0;
    for (const w of this.watch) {
      if (w.status === 'active') active++;
      else if (w.status === 'paused') paused++;
      else removed++;
    }
    return {
      runtime: this.host.runtime,
      version: this.host.version,
      role: this.role,
      roleReason: this.roleReason,
      configProblems: this.configProblems,
      instance: this.instanceId,
      startedAt: this.startedAt,
      lastMinuteAt: this.lastMinuteAt,
      feed: this.feed.status(),
      coins: { active, paused, removed, series: this.series.size, universe: this.universe.size },
      delta: { failingSince: this.restFailingSince, lastError: this.restLastError, backoffUntil: this.restBackoffUntil > now ? this.restBackoffUntil : null },
      telegram: { lastError: this.telegramLastError, lastErrorAt: this.telegramLastErrorAt, blocked: this.telegramBlocked },
      outbox: { pending: pending.count, oldestEventAt: pending.oldestEventAt },
      alerts: this.alertCounts(),
      lastDailyReport: this.store.getMeta('daily_report_date'),
      settings: this.store.settings(),
      clockOffsetMs: this.clockOffsetMs,
      healthy: this.role === 'active' && problems.length === 0,
      problems
    };
  }

  /** Stored counters plus the ones not yet flushed. */
  private alertCounts(): { found: number; heldBack: number } {
    const stored = this.store.peekStats();
    const get = (key: string): number => (stored[key] ?? 0) + (this.counters[key] ?? 0);
    const heldBack = get('alerts_suppressed');
    const sent = get('alerts_confirmed') + get('alerts_realtime') + get('alerts_realtime_cancel') + get('alerts_not_confirmed');
    return { found: sent + heldBack, heldBack };
  }

  private dailyReportIfDue(now: number): void {
    if (this.role !== 'active') return;
    const s = this.store.settings();
    const local = localClock(now, s.monitoring.timeZone);
    const [h, m] = s.monitoring.dailyReportTime.split(':').map(Number) as [number, number];
    const last = this.store.getMeta('daily_report_date');
    if (local.minutes < h * 60 + m || last === local.date) return;
    const started = localClock(this.startedAt + this.clockOffsetMs, s.monitoring.timeZone);
    if (last === null && started.date === local.date && started.minutes >= h * 60 + m) {
      // First start after today's report time: the start message has just gone out, so the first report is tomorrow.
      this.store.setMeta('daily_report_date', local.date);
      return;
    }
    this.flushCounters(now);
    const since = Number(this.store.getMeta('stats_since') ?? this.startedAt);
    this.store.transaction(() => {
      const stats = this.store.takeStats();
      this.enqueueNote(`daily:${local.date}`, renderDailyReport(this.status(), stats, now - since, now), now);
      this.store.setMeta('daily_report_date', local.date);
      this.store.setMeta('stats_since', String(now));
    });
  }

  /** Instant warnings when something degrades, and a note when it recovers (one of each per incident). */
  private warnings(now: number): void {
    const feed = this.feed.status();
    const feedDown = feed.wanted > 0 && feed.downSince !== null && now - feed.downSince >= WARN_AFTER_MS;
    this.incident('feed', feedDown, now, () =>
      notes.warning('Live price feed down', `No live Delta prices for ${Math.round((now - feed.downSince!) / MINUTE_MS)} min. Realtime alerts use a once-a-minute price check until it is back; confirmed alerts are not affected.`)
    , () => notes.recovered('Live price feed back', 'Realtime alerts are on live prices again.'));

    const restDown = this.restFailingSince !== null && now - this.restFailingSince >= WARN_AFTER_MS;
    this.incident('delta', restDown, now, () =>
      notes.warning('Delta API not answering', `For ${Math.round((now - this.restFailingSince!) / MINUTE_MS)} min (${this.restLastError ?? 'unknown error'}). Confirmed alerts catch up, marked LATE, when it is back.`)
    , () => notes.recovered('Delta API answering again', 'Confirmed alerts are catching up.'));
  }

  private incident(name: string, down: boolean, now: number, warning: () => string, recovery: () => string): void {
    const open = this.store.getMeta(`incident_${name}`) === '1';
    if (down === open || this.role !== 'active') return;
    this.store.transaction(() => {
      this.store.setMeta(`incident_${name}`, down ? '1' : '0');
      this.enqueueNote(`${name}:${down ? 'down' : 'up'}:${now}`, down ? warning() : recovery(), now);
    });
    if (down) this.warn(name, 'degraded');
  }

  private async healthPing(now: number, budget: Budget): Promise<void> {
    const url = this.env?.healthcheckPingUrl;
    if (!url || this.role !== 'active') return;
    if (Math.floor(now / MINUTE_MS) % SYSTEM.monitoring.healthPingMinutes !== 0) return;
    const st = this.status();
    const target = st.healthy ? url : `${url.replace(/\/$/, '')}/fail`;
    try {
      const res = await budget.wrap(this.host.fetch)(target, {
        method: 'POST',
        headers: { 'content-type': 'text/plain', 'user-agent': SYSTEM.exchange.userAgent },
        body: st.healthy ? `ok ${this.host.runtime} ${this.host.version}` : st.problems.join('; '),
        signal: AbortSignal.timeout(SYSTEM.exchange.requestTimeoutMs)
      });
      if (!res.ok) this.print(`health ping: HTTP ${res.status}`);
    } catch (err) {
      this.print(`health ping failed: ${err instanceof Error ? err.name : 'error'}`); // never print the URL: it is a secret
    }
  }

  private housekeeping(now: number): void {
    if (now - this.countersFlushedAt >= COUNTER_FLUSH_MS) this.flushCounters(now);
    if (now - this.prunedAt >= PRUNE_EVERY_MS) {
      this.store.prune(now);
      this.prunedAt = now;
    }
  }

  private flushCounters(now: number): void {
    const feed = this.feed.takeCounters();
    this.count('feed_opens', feed.opens);
    this.count('feed_drops', feed.drops);
    this.count('feed_messages', feed.messages);
    this.count('feed_down_ms', feed.downMs);
    this.store.addStats(this.counters);
    this.counters = {};
    this.countersFlushedAt = now;
  }

  // ================================================================ plumbing

  private delta(budget: Budget): DeltaClient {
    const retries = this.host.callBudget === Number.POSITIVE_INFINITY ? SYSTEM.exchange.maxRetries : 1;
    return new DeltaClient(budget.wrap(this.host.fetch), undefined, { ...SYSTEM.exchange, maxRetries: retries });
  }

  private telegram(budget: Budget): TelegramClient {
    return new TelegramClient(budget.wrap(this.host.fetch), this.env?.telegramBotToken ?? '');
  }

  private restSucceeded(serverNow: number, serverClock: boolean): void {
    this.count('rest_ok');
    if (this.restFailingSince !== null) this.print('Delta API answering again');
    this.restFailingSince = null;
    if (serverClock && !this.host.trustLocalClock) {
      // Delta's Date header has 1 s resolution: only correct the clock when it is off by more than 1.5 s.
      const measured = serverNow - this.localNow();
      if (Math.abs(measured - this.clockOffsetMs) > 1500) {
        this.clockOffsetMs = Math.abs(measured) > 1500 ? measured : 0;
        this.print(`clock offset to Delta: ${this.clockOffsetMs} ms`);
      }
    }
  }

  private restFailed(error: DeltaFailure, what: string, now: number): void {
    this.count(error.kind === 'rate-limited' ? 'rest_429' : 'rest_fail');
    this.restLastError = `${what}: ${describeDelta(error)}`;
    this.restFailingSince ??= now;
    if (error.kind === 'rate-limited') this.restBackoffUntil = Math.max(this.restBackoffUntil, now + error.retryAfterMs);
    this.print(`Delta ${this.restLastError}`);
  }

  private telegramFailure(error: TelegramFailure, now: number): void {
    this.telegramLastError = describeTelegramFailure(error);
    this.telegramLastErrorAt = now;
    this.telegramBlocked = error.kind === 'rejected' && error.status !== 400;
    this.print(`Telegram ${this.telegramLastError}`);
  }

  private count(key: string, n = 1): void {
    if (n) this.counters[key] = (this.counters[key] ?? 0) + n;
  }

  private warn(kind: string, detail: string): void {
    this.print(`WARN ${kind}: ${detail}`);
    try {
      this.store.log(this.now(), 'warn', kind, detail);
    } catch {
      // logging must never break the engine
    }
  }

  private fault(where: string, err: unknown): void {
    const detail = err instanceof Error ? `${err.message}${err.stack ? `\n${err.stack.split('\n').slice(1, 4).join('\n')}` : ''}` : String(err);
    this.print(`ERROR ${where}: ${detail}`);
    try {
      this.store.log(this.now(), 'error', where, detail);
    } catch {
      // logging must never break the engine
    }
  }

  private print(line: string): void {
    (this.host.print ?? console.log)(`[${this.host.runtime}] ${line}`);
  }
}

/** EMA 9/15 gap at one candle of a closed series (for the NOT CONFIRMED message after a catch-up). */
function spreadAt(candles: readonly Candle[], start: number): number | null {
  const i = candles.findIndex(c => c.start === start);
  if (i < PAIR.slow - 1) return null;
  const closes = candles.map(c => c.close);
  const fast = emaSeries(closes, PAIR.fast)[i - (PAIR.fast - 1)];
  const slow = emaSeries(closes, PAIR.slow)[i - (PAIR.slow - 1)];
  return fast === undefined || slow === undefined ? null : spreadPct(fast, slow);
}

/** Local date (YYYY-MM-DD) and minutes since local midnight in a time zone. */
export function localClock(ms: number, timeZone: string): { date: string; minutes: number } {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(ms);
  const get = (type: string): string => parts.find(p => p.type === type)?.value ?? '00';
  return { date: `${get('year')}-${get('month')}-${get('day')}`, minutes: Number(get('hour')) * 60 + Number(get('minute')) };
}
