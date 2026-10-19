// Docker spare runtime: hosts the same engine as Cloudflare, on Node 24 with node:sqlite.
// It waits on standby (copying settings from Cloudflare) until it holds the Telegram connection, then sends alerts
// and long-polls Telegram for commands. See docs/RUNBOOK.md.
import { createServer, type IncomingMessage } from 'node:http';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { parseRuntimeEnv } from '../../core/config/env.ts';
import { SYSTEM } from '../../core/config/settings.ts';
import { Engine } from '../../core/app/engine.ts';
import type { FeedOpener } from '../../core/app/feed.ts';
import { handleHttp } from '../../core/app/http.ts';
import { TelegramClient, describeTelegramFailure } from '../../core/notify/telegram.ts';
import { Store } from '../../core/store/store.ts';
import { openSqlite } from './sqlite.ts';

const VERSION = '2.1.0';
const PORT = Number(process.env.PORT ?? 8787);
const HOST = process.env.HOST ?? '127.0.0.1';
const DATA_DIR = process.env.DATA_DIR ?? join(import.meta.dirname, '..', '..', 'data');
const POLL_TIMEOUT_SEC = 25;
const MAX_BODY_BYTES = 256 * 1024;
const UPGRADE_TIMEOUT_MS = 10_000;

const log = (line: string): void => console.log(`${new Date().toISOString()} ${line}`);
const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

mkdirSync(DATA_DIR, { recursive: true });
const db = openSqlite(join(DATA_DIR, 'ema-tracker.db'));
const parsed = parseRuntimeEnv(process.env, 'standby');
if (!parsed.ok) log(`config problems: ${parsed.errors.join('; ')}`);

const openFeed: FeedOpener = callbacks =>
  new Promise((resolve, reject) => {
    const ws = new WebSocket(SYSTEM.exchange.wsUrl);
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error(`no connection within ${UPGRADE_TIMEOUT_MS / 1000} s`));
    }, UPGRADE_TIMEOUT_MS);
    let opened = false;
    ws.addEventListener('open', () => {
      opened = true;
      clearTimeout(timer);
      resolve({
        send: data => ws.send(data),
        close: () => ws.close()
      });
    });
    ws.addEventListener('message', event => callbacks.onMessage(typeof event.data === 'string' ? event.data : ''));
    ws.addEventListener('close', event => {
      clearTimeout(timer);
      if (opened) callbacks.onClose(event.code, event.reason);
      else reject(new Error(`closed before opening (code ${event.code})`));
    });
  });

let timer: ReturnType<typeof setTimeout> | null = null;
let timerAt = Number.POSITIVE_INFINITY;
let stopping = false;

function requestWake(at: number): void {
  if (stopping) return;
  const now = Date.now();
  const target = Math.max(at, now);
  if (timer && timerAt <= target) return;
  if (timer) clearTimeout(timer);
  timerAt = target;
  timer = setTimeout(() => {
    timer = null;
    timerAt = Number.POSITIVE_INFINITY;
    void engine.wake();
  }, target - now);
}

const engine = new Engine(
  new Store(db),
  { runtime: 'Docker', version: VERSION, fetch: (url, init) => fetch(url, init), openFeed, requestWake, callBudget: Number.POSITIVE_INFINITY, print: log },
  parsed.ok ? parsed.value : null,
  parsed.ok ? [] : parsed.errors
);
engine.init();
requestWake(Date.now());

/** Long polling for Telegram commands, only while this engine holds the Telegram connection. */
async function pollTelegram(): Promise<void> {
  const env = parsed.ok ? parsed.value : null;
  if (!env) return;
  const tg = new TelegramClient((url, init) => fetch(url, init), env.telegramBotToken);
  let offset = Number(engine.store.getMeta('telegram_offset') ?? 0);
  while (!stopping) {
    if (engine.currentRole() !== 'active') {
      await sleep(5000);
      continue;
    }
    const r = await tg.getUpdates(offset, POLL_TIMEOUT_SEC);
    if (!r.ok) {
      // 409 means a webhook is set again (Cloudflare took over); the next minute's check moves us to standby.
      log(`telegram polling: ${describeTelegramFailure(r.error)}`);
      await sleep(r.error.kind === 'rate-limited' ? r.error.retryAfterMs : 5000);
      continue;
    }
    for (const update of r.result) {
      await engine.handleTelegramUpdate(update);
      offset = update.update_id + 1;
      engine.store.setMeta('telegram_offset', String(offset));
    }
  }
}
void pollTelegram();

async function toRequest(req: IncomingMessage): Promise<Request | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) return null;
    chunks.push(chunk as Buffer);
  }
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (typeof v === 'string') headers.set(k, v);
    else if (Array.isArray(v)) for (const x of v) headers.append(k, x);
  }
  const method = req.method ?? 'GET';
  return new Request(`http://${HOST}:${PORT}${req.url ?? '/'}`, { method, headers, ...(method === 'GET' || method === 'HEAD' ? {} : { body: Buffer.concat(chunks) }) });
}

const server = createServer((req, res) => {
  void (async () => {
    try {
      const request = await toRequest(req);
      if (!request) {
        res.writeHead(413).end('Too large');
        return;
      }
      const response = await handleHttp(request, engine);
      const headers: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        headers[key] = value;
      });
      res.writeHead(response.status, headers);
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch (err) {
      log(`http error: ${err instanceof Error ? err.message : String(err)}`);
      if (!res.headersSent) res.writeHead(500);
      res.end('Internal error');
    }
  })();
});
server.listen(PORT, HOST, () => log(`EMA Tracker ${VERSION} Docker spare listening on ${HOST}:${PORT} (data in ${DATA_DIR})`));

/** Hands alerts back to Cloudflare when this engine was sending, says goodbye in the chat, then exits. */
async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  log(`${signal}: shutting down`);
  if (timer) clearTimeout(timer);
  const reason = signal === 'SIGTERM' ? 'the Docker container is stopping' : 'the Docker spare was stopped from the keyboard';
  // compose gives 20 s (stop_grace_period); keep 5 s spare for closing the database.
  await Promise.race([engine.shutdown(reason).catch(err => log(`shutdown: ${err instanceof Error ? err.message : String(err)}`)), sleep(15_000)]);
  server.close();
  db.close();
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
