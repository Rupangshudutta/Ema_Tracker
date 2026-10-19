// A simulated world for engine tests: Delta REST and live feed, Telegram, Healthchecks and a controllable clock.
// Prices come from per-coin functions of time, so candles and live ticks always agree.
import { TIMEFRAMES, TIMEFRAME_MS, type Timeframe } from '../core/config/settings.ts';
import type { RuntimeEnv } from '../core/config/env.ts';
import { Engine, type RuntimeName } from '../core/app/engine.ts';
import type { FeedCallbacks, FeedOpener } from '../core/app/feed.ts';
import { Store } from '../core/store/store.ts';
import { openSqlite } from '../runtimes/docker/sqlite.ts';

export const MIN = 60_000;
export const TOKEN = ['4242', 'z'.repeat(35)].join(':'); // built at runtime: no token-shaped string in git
export const CHAT = '777';
export const BASE = 'https://ema.example.workers.dev';
export const HEALTH_URL = 'https://hc.example/ping/abc';

export type PriceFn = (t: number) => number;

export interface CoinSpec {
  turnover: number;
  price: PriceFn;
  status?: string;
}

export interface TelegramCall {
  method: string;
  body: Record<string, unknown>;
}

export class FakeWorld {
  now: number;
  coins = new Map<string, CoinSpec>();
  telegram: TelegramCall[] = [];
  webhookUrl = '';
  deltaDown = false;
  telegramDown = false;
  health: string[] = [];
  feedSent: string[] = [];
  feedOpens = 0;
  /** What Cloudflare's public /health answers (null: no answer). */
  publicHealth: { instance: string; role: string } | null = null;
  /** False simulates the Cloudflare Worker being down (for the Docker spare's checks). */
  cloudflareUp = true;
  /** Calls the Docker spare made to Cloudflare's sync API ("POST /api/sync/heartbeat"). */
  syncCalls: string[] = [];
  private feedCallbacks: FeedCallbacks | null = null;
  private messageId = 1000;
  wakes: number[] = [];

  constructor(now: number) {
    this.now = now;
  }

  fetch = async (url: string, init?: RequestInit): Promise<Response> => {
    const date = new Date(this.now).toUTCString();
    const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', date } });
    if (url.startsWith('https://api.india.delta.exchange')) {
      if (this.deltaDown) throw new TypeError('connect ECONNREFUSED');
      const u = new URL(url);
      if (u.pathname === '/v2/tickers') {
        return json({
          success: true,
          result: [...this.coins].map(([symbol, c]) => ({
            symbol,
            close: String(c.price(this.now)),
            mark_price: String(c.price(this.now)),
            turnover_usd: c.turnover,
            ltp_change_24h: '1.5',
            oi_value_usd: '1000',
            timestamp: this.now * 1000,
            product_trading_status: c.status ?? 'operational'
          }))
        });
      }
      if (u.pathname === '/v2/history/candles') {
        const symbol = u.searchParams.get('symbol')!;
        const tf = u.searchParams.get('resolution') as Timeframe;
        const coin = this.coins.get(symbol);
        if (!coin || !TIMEFRAMES.includes(tf)) return json({ success: true, result: [] });
        const interval = TIMEFRAME_MS[tf];
        const start = Number(u.searchParams.get('start')) * 1000;
        const result = [];
        for (let s = Math.ceil(start / interval) * interval; s <= this.now; s += interval) {
          const closeAt = Math.min(s + interval - 1, this.now);
          const close = coin.price(closeAt);
          result.push({ time: s / 1000, open: close, high: close, low: close, close, volume: 10 });
        }
        return json({ success: true, result: result.reverse() });
      }
      return json({ success: false }, 404);
    }
    if (url.startsWith('https://api.telegram.org/')) {
      if (this.telegramDown) throw new TypeError('network down');
      const method = url.split('/').pop()!;
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
      this.telegram.push({ method, body });
      switch (method) {
        case 'getWebhookInfo': return json({ ok: true, result: { url: this.webhookUrl } });
        case 'setWebhook': this.webhookUrl = String(body.url); return json({ ok: true, result: true });
        case 'deleteWebhook': this.webhookUrl = ''; return json({ ok: true, result: true });
        case 'sendMessage': return json({ ok: true, result: { message_id: this.messageId++ } });
        default: return json({ ok: true, result: true });
      }
    }
    if (url.startsWith(BASE)) {
      if (!this.cloudflareUp) throw new TypeError('Cloudflare unreachable');
      const path = new URL(url).pathname;
      if (path === '/health') {
        if (!this.publicHealth) throw new TypeError('no answer');
        return json(this.publicHealth);
      }
      if (path.startsWith('/api/sync/')) {
        this.syncCalls.push(`${init?.method ?? 'GET'} ${path}`);
        return path === '/api/sync/heartbeat' || init?.method === 'PUT' ? json({ ok: true, role: 'standby' }) : json({ error: 'not in this test' }, 404);
      }
      return json({ error: 'not found' }, 404);
    }
    if (url.startsWith(HEALTH_URL)) {
      this.health.push(url.slice(HEALTH_URL.length) || 'ok');
      return new Response('OK');
    }
    throw new TypeError(`unexpected URL in test: ${url}`);
  };

  openFeed: FeedOpener = async callbacks => {
    this.feedOpens++;
    this.feedCallbacks = callbacks;
    return {
      send: data => this.feedSent.push(data),
      close: () => {
        if (this.feedCallbacks === callbacks) this.feedCallbacks = null;
      }
    };
  };

  get feedConnected(): boolean {
    return this.feedCallbacks !== null;
  }

  /** A live v2/ticker message at the current time. */
  tick(symbol: string, price = this.coins.get(symbol)!.price(this.now)): void {
    this.feedCallbacks?.onMessage(JSON.stringify({ type: 'v2/ticker', symbol, close: String(price), timestamp: this.now * 1000 }));
  }

  /** Delta sends {"type":"heartbeat"} every 30 s once enabled. */
  heartbeat(): void {
    this.feedCallbacks?.onMessage(JSON.stringify({ type: 'heartbeat' }));
  }

  dropFeed(): void {
    const cb = this.feedCallbacks;
    this.feedCallbacks = null;
    cb?.onClose(1006, 'test drop');
  }

  sent(): string[] {
    return this.telegram.filter(c => c.method === 'sendMessage').map(c => String(c.body.text));
  }

  clearTelegram(): void {
    this.telegram = [];
  }
}

export function envFor(overrides: Partial<RuntimeEnv> = {}): RuntimeEnv {
  return { telegramBotToken: TOKEN, telegramChatId: CHAT, adminUserIds: [CHAT], telegramWebhookSecret: null, healthcheckPingUrl: HEALTH_URL, role: 'active', publicBaseUrl: BASE, ...overrides };
}

export function makeEngine(world: FakeWorld, runtime: RuntimeName = 'Cloudflare', env: RuntimeEnv | null = envFor(), db = openSqlite(':memory:'), version = 'test'): Engine {
  const engine = new Engine(new Store(db), {
    runtime,
    version,
    fetch: world.fetch,
    openFeed: world.openFeed,
    requestWake: at => world.wakes.push(at),
    callBudget: runtime === 'Cloudflare' ? 45 : Number.POSITIVE_INFINITY,
    now: () => world.now,
    print: () => {}
  }, env, env ? [] : ['TELEGRAM_BOT_TOKEN is missing']);
  engine.init();
  return engine;
}

/** Lets pending promise chains (alert ID hashing, feed callbacks) finish. */
export const settle = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 15));

/** Moves the clock to `at` and wakes the engine at every minute boundary (+3.5 s) on the way, like the alarm does. */
export async function runUntil(world: FakeWorld, engine: Engine, at: number): Promise<void> {
  let next = Math.floor(world.now / MIN) * MIN + MIN + 3500;
  while (next <= at) {
    world.now = next;
    world.heartbeat();
    await engine.wake();
    await settle();
    await engine.wake(); // follow-ups and deliveries the first wake asked for
    next += MIN;
  }
  world.now = at;
  world.heartbeat();
  await engine.wake();
  await settle();
}
