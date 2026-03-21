module.exports = {
  apps: [{
    name: "ema-tracker",
    script: "main.js",
    cwd: __dirname,
    watch: false,
    // Tokens and secrets come from .env via dotenv — do NOT put them here
    env: {
      NODE_ENV: "production"
    },
    error_file: "logs/pm2-error.log",
    out_file: "logs/pm2-output.log",
    log_date_format: "YYYY-MM-DD HH:mm:ss",
    max_memory_restart: "200M",
    restart_delay: 3000,
    autorestart: true,
    // Restart if it crashes, back off up to 30s between retries
    exp_backoff_restart_delay: 100,
    max_restarts: 10
  }]
};
