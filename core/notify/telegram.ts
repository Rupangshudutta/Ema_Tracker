// Telegram Bot API client, runtime-agnostic.
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
export type TelegramCall<T> = { ok: true; result: T } | { ok: false; error: TelegramFailure };

export interface TelegramClientOptions {
  apiBase?: string;
  timeoutMs?: number;
}

export interface InlineButton {
  text: string;
  callback_data?: string;
  web_app?: { url: string };
  url?: string;
}
export interface InlineKeyboard {
  inline_keyboard: InlineButton[][];
}

export interface WebhookInfo {
  url: string;
  pending_update_count?: number;
  last_error_message?: string;
}

/** The parts of a Telegram Update this bot reads. */
export interface TelegramUpdate {
  update_id: number;
  message?: { message_id: number; chat: { id: number; type: string }; from?: { id: number }; text?: string };
  callback_query?: { id: string; from: { id: number }; data?: string; message?: { message_id: number; chat: { id: number; type: string } } };
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

export function describeTelegramFailure(e: TelegramFailure): string {
  switch (e.kind) {
    case 'rate-limited': return `rate limited, retry after ${Math.round(e.retryAfterMs / 1000)} s`;
    case 'rejected': return `rejected (HTTP ${e.status}): ${e.description}`;
    case 'server': return `Telegram server error HTTP ${e.status}`;
    case 'network': return `network: ${e.message}`;
    case 'timeout': return 'timeout';
  }
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

  /** Calls any Bot API method with a JSON body. One attempt; retrying is the caller's decision. */
  async call<T>(method: string, params: Record<string, unknown>, timeoutMs = this.timeoutMs): Promise<TelegramCall<T>> {
    let res: Response;
    try {
      res = await this.fetchFn(`${this.apiBase}/bot${this.token}/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(params),
        signal: AbortSignal.timeout(timeoutMs)
      });
    } catch (err) {
      const name = err instanceof Error ? err.name : '';
      if (name === 'TimeoutError' || name === 'AbortError') return { ok: false, error: { kind: 'timeout' } };
      return { ok: false, error: { kind: 'network', message: this.redact(err instanceof Error ? err.message : String(err)) } };
    }
    let body: { ok?: unknown; result?: unknown; description?: unknown; parameters?: { retry_after?: unknown } } = {};
    try {
      body = (await res.json()) as typeof body;
    } catch {
      // Non-JSON bodies happen on proxies and outages; the status code decides below.
    }
    if (res.ok && body.ok === true) return { ok: true, result: body.result as T };
    if (res.status === 429) {
      const seconds = typeof body.parameters?.retry_after === 'number' ? body.parameters.retry_after : 5;
      return { ok: false, error: { kind: 'rate-limited', retryAfterMs: seconds * 1000 } };
    }
    if (res.status >= 500) return { ok: false, error: { kind: 'server', status: res.status } };
    const description = typeof body.description === 'string' ? this.redact(body.description) : `HTTP ${res.status}`;
    return { ok: false, error: { kind: 'rejected', status: res.status, description } };
  }

  /** Sends one message (HTML parse mode). */
  async sendMessage(chatId: string, html: string, options: { disablePreview?: boolean; replyMarkup?: InlineKeyboard } = {}): Promise<TelegramResult> {
    if (html.length > TELEGRAM_TEXT_LIMIT) {
      return { ok: false, error: { kind: 'rejected', status: 400, description: `message is ${html.length} characters; split it first` } };
    }
    const r = await this.call<{ message_id?: unknown }>('sendMessage', {
      chat_id: chatId,
      text: html,
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: options.disablePreview ?? true },
      ...(options.replyMarkup ? { reply_markup: options.replyMarkup } : {})
    });
    if (!r.ok) return r;
    const id = r.result?.message_id;
    if (typeof id !== 'number') return { ok: false, error: { kind: 'rejected', status: 200, description: 'reply without message_id' } };
    return { ok: true, messageId: id };
  }

  /** Replaces a message's text and buttons. "message is not modified" counts as success. */
  async editMessage(chatId: string, messageId: number, html: string, replyMarkup?: InlineKeyboard): Promise<TelegramCall<unknown>> {
    const r = await this.call<unknown>('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text: html,
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
      ...(replyMarkup ? { reply_markup: replyMarkup } : {})
    });
    if (!r.ok && r.error.kind === 'rejected' && r.error.description.includes('message is not modified')) return { ok: true, result: true };
    return r;
  }

  answerCallback(callbackQueryId: string, text?: string): Promise<TelegramCall<unknown>> {
    return this.call('answerCallbackQuery', { callback_query_id: callbackQueryId, ...(text ? { text } : {}) });
  }

  setWebhook(url: string, secretToken: string): Promise<TelegramCall<unknown>> {
    return this.call('setWebhook', { url, secret_token: secretToken, allowed_updates: ['message', 'callback_query'], max_connections: 4 });
  }

  /** Keeps queued updates, so a command sent during a switch is answered by the runtime taking over. */
  deleteWebhook(): Promise<TelegramCall<unknown>> {
    return this.call('deleteWebhook', { drop_pending_updates: false });
  }

  getWebhookInfo(): Promise<TelegramCall<WebhookInfo>> {
    return this.call<WebhookInfo>('getWebhookInfo', {});
  }

  /** Long polling (Docker runtime only; Telegram refuses it while a webhook is set). */
  getUpdates(offset: number, timeoutSec: number): Promise<TelegramCall<TelegramUpdate[]>> {
    return this.call<TelegramUpdate[]>('getUpdates', { offset, timeout: timeoutSec, allowed_updates: ['message', 'callback_query'] }, (timeoutSec + 10) * 1000);
  }

  private redact(text: string): string {
    return this.token ? text.split(this.token).join('<token>') : text;
  }
}
