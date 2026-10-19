import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { TELEGRAM_TEXT_LIMIT, TelegramClient, escapeHtml, splitMessage } from '../core/notify/telegram.ts';
import type { FetchFn } from '../core/exchange/delta.ts';

// Built at runtime so no token-shaped string sits in the repo.
const TOKEN = ['42', 'y'.repeat(35)].join(':');

function fake(response: Response | Error): { fetch: FetchFn; calls: { url: string; init?: RequestInit }[] } {
  const calls: { url: string; init?: RequestInit }[] = [];
  return {
    calls,
    fetch: async (url, init) => {
      calls.push({ url, ...(init ? { init } : {}) });
      if (response instanceof Error) throw response;
      return response;
    }
  };
}
const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('TelegramClient.sendMessage', () => {
  it('posts HTML to the chat and returns the message id', async () => {
    const { fetch, calls } = fake(json(200, { ok: true, result: { message_id: 6651 } }));
    const r = await new TelegramClient(fetch, TOKEN).sendMessage('987', '<b>hi</b>');
    assert.deepEqual(r, { ok: true, messageId: 6651 });
    assert.equal(calls[0]!.url, `https://api.telegram.org/bot${TOKEN}/sendMessage`);
    const body = JSON.parse(String(calls[0]!.init?.body)) as Record<string, unknown>;
    assert.equal(body.chat_id, '987');
    assert.equal(body.parse_mode, 'HTML');
  });

  it('turns a 429 into a wait taken from retry_after', async () => {
    const { fetch } = fake(json(429, { ok: false, error_code: 429, description: 'Too Many Requests: retry after 7', parameters: { retry_after: 7 } }));
    assert.deepEqual(await new TelegramClient(fetch, TOKEN).sendMessage('1', 'x'), { ok: false, error: { kind: 'rate-limited', retryAfterMs: 7000 } });
  });

  it('reports rejections (bad HTML, revoked token, blocked bot) with Telegram\'s description', async () => {
    const parse = await new TelegramClient(fake(json(400, { ok: false, error_code: 400, description: "Bad Request: can't parse entities" })).fetch, TOKEN).sendMessage('1', '<b');
    assert.deepEqual(parse, { ok: false, error: { kind: 'rejected', status: 400, description: "Bad Request: can't parse entities" } });
    const revoked = await new TelegramClient(fake(json(401, { ok: false, error_code: 401, description: 'Unauthorized' })).fetch, TOKEN).sendMessage('1', 'x');
    assert.equal(!revoked.ok && revoked.error.kind, 'rejected');
  });

  it('separates server errors, timeouts and network errors, and never leaks the token', async () => {
    assert.deepEqual(await new TelegramClient(fake(new Response('bad gateway', { status: 502 })).fetch, TOKEN).sendMessage('1', 'x'), { ok: false, error: { kind: 'server', status: 502 } });
    const timeout = Object.assign(new Error('timed out'), { name: 'TimeoutError' });
    assert.deepEqual(await new TelegramClient(fake(timeout).fetch, TOKEN).sendMessage('1', 'x'), { ok: false, error: { kind: 'timeout' } });
    const leaky = new TypeError(`connect failed for https://api.telegram.org/bot${TOKEN}/sendMessage`);
    const r = await new TelegramClient(fake(leaky).fetch, TOKEN).sendMessage('1', 'x');
    assert.equal(!r.ok && r.error.kind, 'network');
    assert.ok(!JSON.stringify(r).includes(TOKEN));
  });

  it('refuses over-long text instead of letting Telegram cut it', async () => {
    const { fetch, calls } = fake(json(200, { ok: true, result: { message_id: 1 } }));
    const r = await new TelegramClient(fetch, TOKEN).sendMessage('1', 'x'.repeat(TELEGRAM_TEXT_LIMIT + 1));
    assert.equal(!r.ok && r.error.kind, 'rejected');
    assert.equal(calls.length, 0);
  });
});

describe('message helpers', () => {
  it('escapes the characters HTML parse mode needs', () => {
    assert.equal(escapeHtml('BTC <up> & "AT&T"'), 'BTC &lt;up&gt; &amp; "AT&amp;T"');
  });

  it('splits on line breaks within the limit and keeps entities whole', () => {
    const text = Array.from({ length: 50 }, (_, i) => `line ${i} &amp; more`).join('\n');
    const parts = splitMessage(text, 100);
    assert.ok(parts.every(p => p.length <= 100));
    assert.equal(parts.join('\n'), text);
    assert.ok(parts.every(p => !/&[a-z]*$/.test(p)));
    assert.deepEqual(splitMessage('short'), ['short']);
  });
});
