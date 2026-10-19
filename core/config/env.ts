// Secrets and runtime switches, read from Cloudflare secrets/vars or the Docker .env.
// Values are never logged or echoed; errors name the variable only.

export type RuntimeRole = 'active' | 'standby';

export interface RuntimeEnv {
  telegramBotToken: string;
  telegramChatId: string;
  adminUserIds: string[];
  telegramWebhookSecret: string | null;
  healthcheckPingUrl: string | null;
  role: RuntimeRole;
  publicBaseUrl: string | null;
}

export type EnvResult = { ok: true; value: RuntimeEnv } | { ok: false; errors: string[] };

const NUMERIC_ID = /^-?\d+$/;
const BOT_TOKEN = /^\d+:[A-Za-z0-9_-]{30,}$/;
const WEBHOOK_SECRET = /^[A-Za-z0-9_-]{1,256}$/;

function optionalHttpsUrl(raw: string | undefined, name: string, errors: string[]): string | null {
  if (!raw) return null;
  try {
    const u = new URL(raw);
    if (u.protocol !== 'https:') throw new Error('not https');
    return u.toString();
  } catch {
    errors.push(`${name} must be an https:// URL`);
    return null;
  }
}

export function parseRuntimeEnv(raw: Readonly<Record<string, string | undefined>>): EnvResult {
  const errors: string[] = [];
  const token = raw.TELEGRAM_BOT_TOKEN ?? '';
  if (!BOT_TOKEN.test(token)) errors.push('TELEGRAM_BOT_TOKEN is missing or not in the <digits>:<key> format');

  const chatId = raw.TELEGRAM_CHAT_ID ?? '';
  if (!NUMERIC_ID.test(chatId)) errors.push('TELEGRAM_CHAT_ID is missing or not numeric');

  const admins = (raw.TELEGRAM_ADMIN_USER_IDS ?? chatId).split(',').map(s => s.trim()).filter(Boolean);
  if (!admins.length || !admins.every(id => NUMERIC_ID.test(id))) errors.push('TELEGRAM_ADMIN_USER_IDS must be comma-separated numeric IDs');

  const webhookSecret = raw.TELEGRAM_WEBHOOK_SECRET ?? null;
  if (webhookSecret !== null && !WEBHOOK_SECRET.test(webhookSecret)) errors.push('TELEGRAM_WEBHOOK_SECRET may only contain letters, digits, _ and - (1 to 256 characters)');

  const role = raw.RUNTIME_ROLE ?? 'active';
  if (role !== 'active' && role !== 'standby') errors.push('RUNTIME_ROLE must be active or standby');

  const healthcheckPingUrl = optionalHttpsUrl(raw.HEALTHCHECK_PING_URL, 'HEALTHCHECK_PING_URL', errors);
  const publicBaseUrl = optionalHttpsUrl(raw.PUBLIC_BASE_URL, 'PUBLIC_BASE_URL', errors);

  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    value: { telegramBotToken: token, telegramChatId: chatId, adminUserIds: admins, telegramWebhookSecret: webhookSecret, healthcheckPingUrl, role: role as RuntimeRole, publicBaseUrl }
  };
}
