// Who may talk to the bot, all derived from the bot token so there are no extra secrets to manage.
//   - Telegram webhook: Telegram sends our secret in X-Telegram-Bot-Api-Secret-Token (set with setWebhook)
//   - Mini app: Telegram signs initData with a key derived from the bot token (Telegram docs, "Validating data
//     received via the Mini App"); the user ID inside must be one of the admins
//   - Runtime sync: the Docker spare and Cloudflare share the token, so both can derive the same key
const encoder = new TextEncoder();

async function hmac(key: string | Uint8Array<ArrayBuffer>, data: string): Promise<Uint8Array<ArrayBuffer>> {
  const raw = typeof key === 'string' ? encoder.encode(key) : key;
  const k = await crypto.subtle.importKey('raw', raw, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, encoder.encode(data)));
}

const hex = (bytes: Uint8Array): string => Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');

/** Compares two strings in time independent of where they differ. */
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** The webhook secret: TELEGRAM_WEBHOOK_SECRET when set, otherwise derived from the bot token (64 hex characters). */
export async function webhookSecret(botToken: string, explicit: string | null): Promise<string> {
  return explicit ?? hex(await hmac(botToken, 'ema-tracker/telegram-webhook'));
}

/** Bearer key for the Cloudflare <-> Docker state sync. */
export async function syncKey(botToken: string): Promise<string> {
  return hex(await hmac(botToken, 'ema-tracker/runtime-sync'));
}

export type InitDataCheck = { ok: true; userId: number } | { ok: false; reason: string };

/**
 * Validates a mini app's initData string: HMAC-SHA256 over the sorted key=value lines, keyed with
 * HMAC-SHA256("WebAppData", botToken), must equal `hash`; auth_date must be recent. Newer Telegram clients add a
 * `signature` field; it is accepted whether or not it is part of the signed lines (both checks use the bot token).
 */
export async function validateInitData(initData: string, botToken: string, nowMs: number, maxAgeSec = 24 * 60 * 60): Promise<InitDataCheck> {
  if (!initData || initData.length > 8192) return { ok: false, reason: 'missing init data' };
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash || !/^[0-9a-f]{64}$/.test(hash)) return { ok: false, reason: 'missing hash' };
  const fields = [...params.entries()].filter(([k]) => k !== 'hash');
  const secret = await hmac('WebAppData', botToken);
  const signed = async (list: [string, string][]): Promise<string> => hex(await hmac(secret, list.map(([k, v]) => `${k}=${v}`).sort().join('\n')));
  let valid = safeEqual(await signed(fields), hash);
  if (!valid && params.has('signature')) valid = safeEqual(await signed(fields.filter(([k]) => k !== 'signature')), hash);
  if (!valid) return { ok: false, reason: 'bad signature' };
  const authDate = Number(params.get('auth_date'));
  if (!Number.isFinite(authDate) || nowMs / 1000 - authDate > maxAgeSec) return { ok: false, reason: 'init data expired; reopen the mini app' };
  let userId: unknown;
  try {
    userId = (JSON.parse(params.get('user') ?? '{}') as { id?: unknown }).id;
  } catch {
    return { ok: false, reason: 'bad user field' };
  }
  if (typeof userId !== 'number' || !Number.isSafeInteger(userId)) return { ok: false, reason: 'no user in init data' };
  return { ok: true, userId };
}

/** Builds signed initData the way Telegram does (used by tests and local checks, never with a real token in git). */
export async function signInitData(fields: Readonly<Record<string, string>>, botToken: string): Promise<string> {
  const secret = await hmac('WebAppData', botToken);
  const lines = Object.entries(fields).map(([k, v]) => `${k}=${v}`).sort().join('\n');
  const params = new URLSearchParams(fields);
  params.set('hash', hex(await hmac(secret, lines)));
  return params.toString();
}
