# S8: retiring the old bot (done 2026-10-20)

Approved and done on 2026-10-20. The last v1 state is the git tag `v1-final`; restore any file with
`git checkout v1-final -- <path>`. `src/ml` and `TensorFlow.js` stay until the AI work is decided. After the removal
`npm audit` reports 0 vulnerabilities (was 18) and the build installs only the three pinned development tools.

## Remove (old v1 bot, replaced by v2)

| File or folder | What it was | Why it can go |
| --- | --- | --- |
| `main.js` | The whole v1 bot (Bybit, 3,152 lines) | Replaced by `core/` and `runtimes/`; the audit's bugs I1 to I14 live here |
| `src/indicators.js` | RSI, MACD, Bollinger for v1 alert text | v2 uses EMA 9/15 only |
| `scripts/setup.js`, `scripts/data_sync.js` | v1 setup and data sync | Not used by v2 |
| `settings.json`, `alert_state.json` | v1 state files (tracked in git, baked into images) | v2 keeps state in its SQLite notebook |
| `Dockerfile` (repo root) | v1 image: Node 18, root user, no health check (I6) | Replaced by `runtimes/docker/Dockerfile` |
| `fly.toml`, `render.yaml`, `railway.json`, `Procfile` | Hosting configs that claimed free plans that do not exist (I12) | v2 runs on Cloudflare, spare in Docker |
| `ecosystem.config.js` | PM2 config; held a token-shaped string in git history (I4) | Not used by v2 |
| `package_minimal.json`, `jsconfig.json` | v1 leftovers | Not used |
| `down.png`, `up.png`, `image.png` | v1 desktop-notification icons and a screenshot | v2 has no desktop notifications |
| `Docomendation.txt` | v1 notes | Superseded by `docs/` |
| `.env.example` | v1 variable list (Bybit) | Replaced by `.dev.vars.example` and `.env.docker.example` |
| v1 packages in `package.json`: axios, chokidar, colors, csv-writer, dotenv, figlet, fs, node-notifier, node-telegram-bot-api, path, ws | v1 runtime dependencies, 19 audit findings and deprecated sub-packages (I10, B4) | v2 has zero runtime packages; every Cloudflare build stops installing them |
| `package.json` scripts `start`, `setup`, `dev`, `pm2` and `"main": "main.js"` | v1 entry points | Replaced by `check`, `test`, `cf:*` and the Docker command |

## Your call (the AI work you plan later)

| File or folder | Proposal |
| --- | --- |
| `src/ml/*`, `TensorFlow.js` | Not used by v2. Remove them from `main` and keep them only under the `v1-final` tag, or keep them in place until the AI phase starts. |

## Rewrite

| File | Change |
| --- | --- |
| `README.md` | v2: what it does, how alerts work, setup links to `docs/RUNBOOK.md`; no free-hosting claims |
| `SECURITY.md` | Where secrets live (Cloudflare secrets, `.env.docker`), the token history incident and how to report issues |

## Keep

`core/`, `runtimes/`, `test/`, `docs/`, `scripts/record-*.ts` and `scripts/shadow-run.ts` (test tools), `wrangler.jsonc`,
`tsconfig*.json`, `worker-configuration.d.ts`, `.dev.vars.example`, `.env.docker.example`, `.node-version`, `.npmrc`.

## Checks after removal

1. `npm run check` passes (type checks and all tests).
2. A Cloudflare build from `main` installs only the three dev tools and deploys.
3. `docker compose -f runtimes/docker/compose.yaml up -d --build` still builds.
