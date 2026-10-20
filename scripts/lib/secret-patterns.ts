// What the secret scan looks for. A match is reported by file, line and kind only; the value is never printed.

export interface SecretPattern {
  kind: string;
  pattern: RegExp;
}

export const SECRET_PATTERNS: readonly SecretPattern[] = [
  // @BotFather tokens: bot ID, a colon, then a 35-character key (which may end in "-", so no \b at the end).
  { kind: 'Telegram bot token', pattern: /(?<![\w-])\d{8,10}:[A-Za-z0-9_-]{35}(?![\w-])/ },
  // Healthchecks.io ping URLs carry a UUID that lets anyone report "alive" or "down".
  { kind: 'Healthchecks ping URL', pattern: /hc-ping\.com\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i },
  { kind: 'private key', pattern: /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/ }
];

export interface SecretFinding {
  line: number;
  kind: string;
}

/** Lines (1-based) of `text` that look like a secret, with what they look like. */
export function findSecrets(text: string): SecretFinding[] {
  const out: SecretFinding[] = [];
  const lines = text.split(/\r?\n/);
  lines.forEach((content, i) => {
    for (const p of SECRET_PATTERNS) if (p.pattern.test(content)) out.push({ line: i + 1, kind: p.kind });
  });
  return out;
}
