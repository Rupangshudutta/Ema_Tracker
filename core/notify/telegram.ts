// Telegram Bot API client (sendMessage only), runtime-agnostic.
// Documented behaviour relied on: errors carry error_code and description, a 429 carries parameters.retry_after
// (seconds), and message text is limited to 4096 characters. The bot token is only ever placed in the URL and
// never appears in results or errors returned from here.
import type { FetchFn } from '../exchange/delta.ts';

export const TELEGRAM_TEXT_LIMIT = 4096;

export type TelegramFailure =
  | { kind: 'rate-limited'; retryAfterMs: number }
  /** 4xx other than 429: bad request (for example HTML parse error), revoked token (401), bot blocked (403). Not worth retrying as is. */
  | { kind: 'rejected'; status: number; description: string }
  | { kind: 'server'; status: number }
  | { kind: 'network'; message: string }
  | { kind: 'timeout' };

export type TelegramResult = { ok: true; messageId: number } | { ok: false; error: TelegramFailure };

export interface TelegramClientOptions {
  apiBase?: string;
  timeoutMs?: number;
}

/** Escapes text for Telegram's HTML parse mode (only &, < and > need escaping). */
export function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Splits text into chunks of at most `limit` characters, preferring line breaks, never splitting inside an HTML entity. */
export function splitMessage(text: string, limit = TELEGRAM_TEXT_LIMIT): string[] {
  if (limit < 16) throw new RangeError('limit too small');
  const parts: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    let cut = rest.lastIndexOf('\n', limit);
    if (cut <= 0) cut = limit;
    const amp = rest.lastIndexOf('&', cut - 1);
    if (amp !== -1 && amp > cut - 10 && rest.indexOf(';', amp) >= cut) cut = amp;
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/, '');
  }
  if (rest.length) parts.push(rest);
  return parts;
}

export class TelegramClient {
  private readonly fetchFn: FetchFn;
  private readonly token: string;
  private readonly apiBase: string;
  private readonly timeoutMs: number;

  constructor(fetchFn: FetchFn, token: string, options: TelegramClientOptions = {}) {
    this.fetchFn = fetchFn;
    this.token = token;
    this.apiBase = options.apiBase ?? 'https://api.telegram.org';
    this.timeoutMs = options.timeoutMs ?? 10_000;
  }

  /** Sends one message (HTML parse mode). One attempt; retrying is the caller's (outbox's) decision. */
  async sendMessage(chatId: string, html: string, options: { disablePreview?: boolean } = {}): Promise<TelegramResult> {
    if (html.length > TELEGRAM_TEXT_LIMIT) {
      return { ok: false, error: { kind: 'rejected', status: 400, description: `message is ${html.length} characters; split it first` } };
    }
    let res: Response;
    try {
      res = await this.fetchFn(`${this.apiBase}/bot${this.token}/sendMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text: html, parse_mode: 'HTML', link_preview_options: { is_disabled: options.disablePreview ?? true } }),
        signal: AbortSignal.timeout(this.timeoutMs)
      });
    } catch (err) {
      const name = err instanceof Error ? err.name : '';
      if (name === 'TimeoutError' || name === 'AbortError') return { ok: false, error: { kind: 'timeout' } };
      return { ok: false, error: { kind: 'network', message: this.redact(err instanceof Error ? err.message : String(err)) } };
    }
    let body: { ok?: unknown; result?: { message_id?: unknown }; description?: unknown; parameters?: { retry_after?: unknown } } = {};
    try {
      body = (await res.json()) as typeof body;
    } catch {
      // Non-JSON bodies happen on proxies and outages; the status code decides below.
    }
    if (res.ok && body.ok === true && typeof body.result?.message_id === 'number') return { ok: true, messageId: body.result.message_id };
    if (res.status === 429) {
      const seconds = typeof body.parameters?.retry_after === 'number' ? body.parameters.retry_after : 5;
      return { ok: false, error: { kind: 'rate-limited', retryAfterMs: seconds * 1000 } };
    }
    if (res.status >= 500) return { ok: false, error: { kind: 'server', status: res.status } };
    const description = typeof body.description === 'string' ? this.redact(body.description) : `HTTP ${res.status}`;
    return { ok: false, error: { kind: 'rejected', status: res.status, description } };
  }

  private redact(text: string): string {
    return this.token ? text.split(this.token).join('<token>') : text;
  }
}
