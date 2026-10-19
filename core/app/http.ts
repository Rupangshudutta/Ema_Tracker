// HTTP routes, the same on Cloudflare (Tracker Durable Object) and Docker (node:http):
//   GET  /health                 status for uptime checks (no secrets)
//   POST /telegram/webhook       Telegram updates (Cloudflare only; Telegram's secret header required)
//   GET  /app, /app.js           the coin-picker mini app
//   GET  /api/coins              mini app data (Telegram-signed initData required, admins only)
//   POST /api/coins              tick timeframes for a coin
//   POST /api/sync/heartbeat     Docker spare checks in (Cloudflare only; key derived from the bot token)
//   GET  /api/sync/state         settings and watchlist for the Docker spare
//   PUT  /api/sync/state         settings and watchlist back from the Docker spare (only while Cloudflare is on standby)
import { safeEqual, syncKey, validateInitData, webhookSecret } from './auth.ts';
import type { Engine } from './engine.ts';
import { MINI_APP_CSP, MINI_APP_HTML, MINI_APP_JS } from './miniapp.ts';
import type { TelegramUpdate } from '../notify/telegram.ts';
import type { PortableState } from '../store/store.ts';
import { SYSTEM } from '../config/settings.ts';

const MAX_BODY_BYTES = 256 * 1024;
const STALL_MS = 3 * 60_000;

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } });
const text = (body: string, status: number): Response => new Response(body, { status, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } });

async function readJson(request: Request): Promise<unknown> {
  const declared = Number(request.headers.get('content-length') ?? 0);
  if (declared > MAX_BODY_BYTES) return undefined;
  const raw = await request.text();
  if (raw.length > MAX_BODY_BYTES) return undefined;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}

export async function handleHttp(request: Request, engine: Engine): Promise<Response> {
  const url = new URL(request.url);
  const method = request.method;
  const path = url.pathname.replace(/\/+$/, '') || '/';
  try {
    if (path === '/health' && method === 'GET') return health(engine);
    if (path === '/telegram/webhook' && method === 'POST' && engine.host.runtime === 'Cloudflare') return await webhook(request, engine);
    if (path === '/app' && method === 'GET') return new Response(MINI_APP_HTML, { headers: { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': MINI_APP_CSP, 'cache-control': 'no-cache', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' } });
    if (path === '/app.js' && method === 'GET') return new Response(MINI_APP_JS, { headers: { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-cache', 'x-content-type-options': 'nosniff' } });
    if (path === '/api/coins' && (method === 'GET' || method === 'POST')) return await coins(request, engine);
    if (path.startsWith('/api/sync/') && engine.host.runtime === 'Cloudflare') return await sync(request, engine, path, method);
    if (path === '/') return text('EMA Tracker v2. Open Telegram and send /start.', 200);
    return text('Not found', 404);
  } catch (err) {
    console.log(`[http] ${method} ${path} failed: ${err instanceof Error ? err.message : String(err)}`);
    return text('Internal error', 500);
  }
}

function health(engine: Engine): Response {
  const st = engine.status();
  const now = engine.now();
  const stalled = (st.lastMinuteAt ?? st.startedAt) < now - STALL_MS;
  const body = {
    ok: st.healthy,
    runtime: st.runtime,
    version: st.version,
    role: st.role,
    roleReason: st.roleReason,
    problems: st.problems,
    feed: { connected: st.feed.connected, coins: st.feed.wanted, quickDrops: st.feed.quickDrops },
    coins: st.coins,
    lastMinuteAt: st.lastMinuteAt === null ? null : new Date(st.lastMinuteAt).toISOString(),
    pendingMessages: st.outbox.pending
  };
  // A standby engine is healthy while its timer runs; an active one must also be free of problems.
  return json(body, stalled || (st.role === 'active' && !st.healthy) ? 503 : 200);
}

async function webhook(request: Request, engine: Engine): Promise<Response> {
  const env = engine.env;
  if (!env) return text('Not configured', 503);
  const expected = await webhookSecret(env.telegramBotToken, env.telegramWebhookSecret);
  if (!safeEqual(request.headers.get('x-telegram-bot-api-secret-token') ?? '', expected)) return text('Forbidden', 403);
  const update = (await readJson(request)) as TelegramUpdate | undefined;
  if (!update || typeof update.update_id !== 'number') return text('Bad request', 400);
  // Always 200 once the update is accepted: a failure is logged, and a retry from Telegram would not fix it.
  await engine.handleTelegramUpdate(update);
  return text('ok', 200);
}

async function coins(request: Request, engine: Engine): Promise<Response> {
  const env = engine.env;
  if (!env) return json({ error: 'The bot is not configured yet.' }, 503);
  const auth = await validateInitData(request.headers.get('x-telegram-init-data') ?? '', env.telegramBotToken, engine.now());
  if (!auth.ok) return json({ error: `Not signed in: ${auth.reason}` }, 401);
  if (!env.adminUserIds.includes(String(auth.userId))) return json({ error: 'This bot is private.' }, 403);

  const summary = (): Record<string, unknown> => {
    const s = engine.settings();
    const st = engine.status();
    return { volumeThresholdUsd: s.coins.volumeThresholdUsd, marginPct: s.signal.marginPct, defaultTimeframes: s.coins.defaultTimeframes, active: st.coins.active, cap: SYSTEM.coins.maxWatchlistCoins, role: st.role, runtime: st.runtime };
  };
  if (request.method === 'GET') return json({ ...summary(), coins: engine.coinList() });

  if (engine.status().role !== 'active') return json({ error: 'Cloudflare is on standby (the Docker spare is sending alerts). Use /watch in the chat instead.' }, 409);
  const body = (await readJson(request)) as { symbol?: unknown; timeframes?: unknown } | undefined;
  if (!body || typeof body.symbol !== 'string' || !Array.isArray(body.timeframes) || !body.timeframes.every(t => typeof t === 'string')) return json({ error: 'Bad request' }, 400);
  const r = engine.setCoinTimeframes(body.symbol, body.timeframes as string[], `user:${auth.userId} (mini app)`);
  if (!r.ok) return json({ error: r.reason }, 422);
  return json({ ok: true, message: r.message, coin: engine.coinList().find(c => c.symbol === body.symbol) ?? null, ...summary() });
}

async function sync(request: Request, engine: Engine, path: string, method: string): Promise<Response> {
  const env = engine.env;
  if (!env) return json({ error: 'not configured' }, 503);
  const auth = request.headers.get('authorization') ?? '';
  if (!safeEqual(auth, `Bearer ${await syncKey(env.telegramBotToken)}`)) return json({ error: 'forbidden' }, 403);
  if (path === '/api/sync/heartbeat' && method === 'POST') {
    const body = (await readJson(request)) as { role?: unknown } | undefined;
    return json(engine.peerHeartbeat(body?.role));
  }
  if (path === '/api/sync/state' && method === 'GET') return json(engine.exportState());
  if (path === '/api/sync/state' && method === 'PUT') {
    if (engine.status().role !== 'standby') return json({ error: 'Cloudflare is active; it keeps its own settings' }, 409);
    const body = (await readJson(request)) as PortableState | undefined;
    if (!body) return json({ error: 'bad request' }, 400);
    const r = engine.importState(body, 'sync from Docker');
    return r.ok ? json({ ok: true }) : json({ error: r.errors.join('; ') }, 422);
  }
  return json({ error: 'not found' }, 404);
}
