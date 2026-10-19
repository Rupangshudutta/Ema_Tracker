# EMA Tracker v2 Docker spare (fix for audit finding I6): Node 24, non-root, real health check, no npm packages.
# Build and run from the repository root:
#   docker compose -f runtimes/docker/compose.yaml up -d --build
FROM node:24.21.0-alpine

ENV NODE_ENV=production \
    DATA_DIR=/data \
    HOST=0.0.0.0 \
    PORT=8787

WORKDIR /app
# v2 has no runtime packages: only the TypeScript sources are copied, and Node runs them directly.
COPY core ./core
COPY runtimes/package.json ./runtimes/package.json
COPY runtimes/docker ./runtimes/docker
RUN mkdir -p /data && chown node:node /data

USER node
VOLUME ["/data"]
EXPOSE 8787

HEALTHCHECK --interval=60s --timeout=10s --start-period=90s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8787/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"]

CMD ["node", "--disable-warning=ExperimentalWarning", "runtimes/docker/main.ts"]
