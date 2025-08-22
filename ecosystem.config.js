module.exports = {
  apps: [{
    name: "ema-tracker",
    script: "node.js",
    watch: false,
    env: {
      NODE_ENV: "production",
      EMA_PERIOD: "200",
      TIMEFRAME: "5m",
      VOLUME_THRESHOLD: "100000000",
      CHECK_INTERVAL: "300000",
      ALERT_COOLDOWN: "900000",
      TELEGRAM_BOT_TOKEN: "7986381613:AAGPKqQuOb7d1Mb-ARuVwNPi9bS5mX3y_ZQ",
      TELEGRAM_CHAT_ID: "2066913287"
    },
    error_file: "logs/pm2-error.log",
    out_file: "logs/pm2-output.log",
    log_date_format: "YYYY-MM-DD HH:mm:ss",
    max_memory_restart: "200M",
    restart_delay: 3000,
    autorestart: true
  }]
};
