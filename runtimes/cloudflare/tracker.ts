// The Tracker Durable Object (the "desk worker"): hosts the engine on Cloudflare.
// It gives the engine its SQLite notebook, outbound fetch, Delta's live feed and an alarm to wake it; the engine in
// core/app does the rest. One instance ("main") exists, so there is exactly one writer.
import { DurableObject } from 'cloudflare:workers';
import { parseRuntimeEnv } from '../../core/config/env.ts';
import { SYSTEM } from '../../core/config/settings.ts';
import { Engine } from '../../core/app/engine.ts';
import type { FeedOpener } from '../../core/app/feed.ts';
import { handleHttp } from '../../core/app/http.ts';
import type { SqlDriver, SqlValue } from '../../core/store/sql.ts';
import { Store } from '../../core/store/store.ts';

export const VERSION = '2.1.0';

/** Cloudflare's free plan allows 50 outbound calls per invocation; keep a margin for the feed and the alarm. */
const CALLS_PER_RUN = 45;
const UPGRADE_TIMEOUT_MS = 10_000;
const WATCHDOG_MAX_ALARM_DELAY_MS = 2 * 60_000;

/** Secrets are set in the Cloudflare dashboard, so `wrangler types` cannot see them; they are optional here. */
type SecretName = 'TELEGRAM_BOT_TOKEN' | 'TELEGRAM_CHAT_ID' | 'TELEGRAM_ADMIN_USER_IDS' | 'TELEGRAM_WEBHOOK_SECRET' | 'HEALTHCHECK_PING_URL';
type TrackerEnv = Env & Partial<Record<SecretName, string>>;

function durableSql(storage: DurableObjectStorage): SqlDriver {
  return {
    all<T>(sql: string, ...params: SqlValue[]): T[] {
      return storage.sql.exec(sql, ...params).toArray() as unknown as T[];
    },
    run(sql: string, ...params: SqlValue[]): boolean {
      const cursor = storage.sql.exec(sql, ...params);
      cursor.toArray();
      return cursor.rowsWritten > 0;
    },
    transaction<T>(fn: () => T): T {
      return storage.transactionSync(fn);
    }
  };
}

/**
 * Opens Delta's feed through a fetch upgrade. The timeout is a race, not an AbortSignal: an abort signal attached
 * to the upgrade request also kills the socket once it fires, which made the S0 probe drop every 10 s.
 */
const openFeed: FeedOpener = async callbacks => {
  const upgrade = fetch(SYSTEM.exchange.wsUrl.replace(/^wss:/, 'https:'), { headers: { Upgrade: 'websocket', 'User-Agent': SYSTEM.exchange.userAgent } });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`no upgrade within ${UPGRADE_TIMEOUT_MS / 1000} s`)), UPGRADE_TIMEOUT_MS);
  });
  let res: Response;
  try {
    res = await Promise.race([upgrade, timeout]);
  } catch (err) {
    upgrade.then(late => late.webSocket?.close(1000, 'too late'), () => undefined);
    throw err;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
  const ws = res.webSocket;
  if (!ws) throw new Error(`upgrade refused: HTTP ${res.status}`);
  ws.accept();
  ws.addEventListener('message', event => callbacks.onMessage(typeof event.data === 'string' ? event.data : ''));
  ws.addEventListener('close', event => callbacks.onClose(event.code, event.reason));
  ws.addEventListener('error', () => callbacks.onClose(1006, 'socket error'));
  return {
    send: data => ws.send(data),
    close: () => {
      try {
        ws.close(1000, 'closing');
      } catch {
        // already closed
      }
    }
  };
};

export class Tracker extends DurableObject<Env> {
  private readonly engine: Engine;
  private alarmAt: number | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const e = env as TrackerEnv;
    const parsed = parseRuntimeEnv(
      {
        TELEGRAM_BOT_TOKEN: e.TELEGRAM_BOT_TOKEN,
        TELEGRAM_CHAT_ID: e.TELEGRAM_CHAT_ID,
        TELEGRAM_ADMIN_USER_IDS: e.TELEGRAM_ADMIN_USER_IDS,
        TELEGRAM_WEBHOOK_SECRET: e.TELEGRAM_WEBHOOK_SECRET,
        HEALTHCHECK_PING_URL: e.HEALTHCHECK_PING_URL,
        RUNTIME_ROLE: e.RUNTIME_ROLE,
        PUBLIC_BASE_URL: e.PUBLIC_BASE_URL
      },
      'active'
    );
    const id = env.CF_VERSION_METADATA?.id;
    this.engine = new Engine(
      new Store(durableSql(ctx.storage)),
      {
        runtime: 'Cloudflare',
        version: id ? `${VERSION} (${id.slice(0, 8)})` : VERSION,
        fetch: (url, init) => fetch(url, init),
        openFeed,
        requestWake: at => this.requestWake(at),
        callBudget: CALLS_PER_RUN,
        trustLocalClock: true
      },
      parsed.ok ? parsed.value : null,
      parsed.ok ? [] : parsed.errors
    );
    ctx.blockConcurrencyWhile(async () => {
      this.engine.init();
      // Pick up within a second after a restart or deploy instead of waiting for the next timer tick. An alarm that
      // is already due is left alone: replacing it cancels the alarm run that may be starting this very object.
      const pending = await ctx.storage.getAlarm();
      if (pending === null || pending > Date.now() + 1000) await this.setAlarm(Date.now() + 1000);
      else this.alarmAt = pending;
    });
  }

  /** Every-minute watchdog from the Worker's cron: makes sure an alarm is set. The engine's own alarm does the work. */
  async tick(): Promise<void> {
    const at = await this.ctx.storage.getAlarm();
    if (at === null || at > Date.now() + WATCHDOG_MAX_ALARM_DELAY_MS) await this.setAlarm(Date.now() + 1000);
  }

  override async alarm(): Promise<void> {
    this.alarmAt = null;
    await this.engine.wake(); // never throws; it schedules the next alarm itself
  }

  override async fetch(request: Request): Promise<Response> {
    return handleHttp(request, this.engine);
  }

  /** setAlarm replaces the current alarm, so only move it earlier (or set one when none is pending). */
  private requestWake(at: number): void {
    const target = Math.max(at, Date.now());
    if (this.alarmAt !== null && this.alarmAt > Date.now() && this.alarmAt <= target) return;
    this.setAlarm(target).catch(err => console.log(`[Cloudflare] setAlarm failed: ${err instanceof Error ? err.message : String(err)}`));
  }

  private async setAlarm(at: number): Promise<void> {
    this.alarmAt = at;
    await this.ctx.storage.setAlarm(at);
  }
}
