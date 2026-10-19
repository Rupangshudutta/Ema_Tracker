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

const WHERE = 'add it in Cloudflare (Settings > Variables and Secrets, type Secret), or in .env.docker for the Docker spare';

/**
 * Forgives the usual paste mistakes around a value: surrounding quotes, the "NAME=" part copied from a .env file,
 * and stray whitespace. Never reports the value itself.
 */
function cleanPasted(value: string | undefined, name: string): string {
  if (!value) return '';
  return value
    .trim()
    .replace(new RegExp(`^${name}\\s*=\\s*`), '')
    .replace(/^(["'`])(.*)\1$/s, '$2')
    .trim();
}

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

/**
 * `defaultRole` is the runtime's own safe default: 'active' on Cloudflare, 'standby' in Docker, so a container started
 * without RUNTIME_ROLE never sends alerts alongside Cloudflare. Values are trimmed and an empty value counts as unset.
 */
export function parseRuntimeEnv(raw: Readonly<Record<string, string | undefined>>, defaultRole: RuntimeRole): EnvResult {
  const errors: string[] = [];
  const get = (name: string): string | undefined => {
    const v = raw[name]?.trim();
    return v ? v : undefined;
  };

  const tokenRaw = get('TELEGRAM_BOT_TOKEN');
  const token = cleanPasted(tokenRaw, 'TELEGRAM_BOT_TOKEN').replace(/^bot(?=\d+:)/i, '');
  if (!tokenRaw) errors.push(`TELEGRAM_BOT_TOKEN is missing: ${WHERE}`);
  else if (!BOT_TOKEN.test(token)) errors.push('TELEGRAM_BOT_TOKEN is set but is not a bot token (expected <digits>:<key> exactly as @BotFather shows it)');

  const chatRaw = get('TELEGRAM_CHAT_ID');
  const chatId = cleanPasted(chatRaw, 'TELEGRAM_CHAT_ID');
  if (!chatRaw) errors.push(`TELEGRAM_CHAT_ID is missing: ${WHERE}`);
  else if (!NUMERIC_ID.test(chatId)) errors.push('TELEGRAM_CHAT_ID is set but is not a number (your chat ID, for example 123456789)');

  const adminRaw = get('TELEGRAM_ADMIN_USER_IDS');
  const isGroupChat = chatId.startsWith('-');
  if (!adminRaw && isGroupChat) errors.push('TELEGRAM_ADMIN_USER_IDS is required when TELEGRAM_CHAT_ID is a group (a group ID never matches a user)');
  const admins = (adminRaw ?? chatId).split(',').map(s => s.trim()).filter(Boolean);
  if (!admins.length || !admins.every(id => NUMERIC_ID.test(id))) errors.push('TELEGRAM_ADMIN_USER_IDS must be comma-separated numeric IDs');

  const webhookSecret = get('TELEGRAM_WEBHOOK_SECRET') ?? null;
  if (webhookSecret !== null && !WEBHOOK_SECRET.test(webhookSecret)) errors.push('TELEGRAM_WEBHOOK_SECRET may only contain letters, digits, _ and - (1 to 256 characters)');

  const role = get('RUNTIME_ROLE') ?? defaultRole;
  if (role !== 'active' && role !== 'standby') errors.push('RUNTIME_ROLE must be active or standby');

  const healthcheckPingUrl = optionalHttpsUrl(get('HEALTHCHECK_PING_URL'), 'HEALTHCHECK_PING_URL', errors);
  const publicBaseUrl = optionalHttpsUrl(get('PUBLIC_BASE_URL'), 'PUBLIC_BASE_URL', errors);

  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    value: { telegramBotToken: token, telegramChatId: chatId, adminUserIds: admins, telegramWebhookSecret: webhookSecret, healthcheckPingUrl, role: role as RuntimeRole, publicBaseUrl }
  };
}
