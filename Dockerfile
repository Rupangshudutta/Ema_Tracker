# ─────────────────────────────────────────────────────────
# Dockerfile — EMA Tracker
# Supports Railway, Render, Fly.io, Oracle Cloud, Koyeb
# ─────────────────────────────────────────────────────────

FROM node:18-alpine

# Set working directory
WORKDIR /app

# Copy dependency manifests first (layer cache)
COPY package*.json ./

# Install only production dependencies
RUN npm ci --omit=dev

# Copy all source files
COPY . .

# Runtime data directories will be created by the bot on first run
# Logs, ml_data, csv_data are written to /app/* inside the container

ENV NODE_ENV=production

# Health check — just verify node can start
HEALTHCHECK --interval=60s --timeout=10s --start-period=30s CMD node -e "console.log('ok')"

CMD ["node", "main.js"]
