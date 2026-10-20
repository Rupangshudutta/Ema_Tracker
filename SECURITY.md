# Security policy

## Supported versions

| Version | Supported |
| --- | --- |
| v2 (`main`) | Yes |
| v1 (`main.js`, tag `v1-final`) | No, retired |

## Where secrets live

| Secret | Where |
| --- | --- |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `HEALTHCHECK_PING_URL` (and optional `TELEGRAM_ADMIN_USER_IDS`, `TELEGRAM_WEBHOOK_SECRET`) | Cloudflare: Workers & Pages → ema-tracker → Settings → Variables and Secrets, type **Secret** (a plain variable is wiped by the next deploy) |
| The same values for the Docker spare | `.env.docker` on the machine that runs it (git-ignored) |
| Local testing | `.dev.vars` (git-ignored) |

Never commit a secret. `npm run check`, which runs before every Cloudflare deploy, starts with a secret scan
(`scripts/secret-scan.ts`) that fails on anything shaped like a Telegram bot token, a Healthchecks ping URL or a
private key in a tracked file. Tests build secret-shaped values at runtime.

The bot only answers the configured chat and admin user IDs. The Telegram webhook requires Telegram's secret header,
the mini app checks Telegram's signed init data, and the Cloudflare/Docker sync uses a key derived from the bot token.

## Known incident

Commits of the retired v1 bot (for example in `ecosystem.config.js`) contain a Telegram bot token, and the repository is
public. Treat any token that was ever committed or shared as compromised: revoke it in @BotFather (`/revoke`) and store
the new one only as a Cloudflare secret.

## Reporting a vulnerability

Use GitHub's private reporting: the repository's **Security** tab → **Report a vulnerability**. Please do not open a
public issue for security problems.
