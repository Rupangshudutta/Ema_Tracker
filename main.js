require('dotenv').config();
const axios = require('axios');
const colors = require('colors');
const figlet = require('figlet');
const path = require('path');
const fs = require('fs');
const { exec, execFile } = require('child_process');
const net = require('net');
const TelegramBot = require('node-telegram-bot-api');
const notifier = require('node-notifier');
const WebSocket = require('ws');
const { createObjectCsvWriter } = require('csv-writer');

let initialLoadComplete = false;
// ML configuration
let ML_ENABLED = false;

// Dual EMA crossover mode: when true, alerts on EMA(9) vs EMA(15) crossover instead of price vs single EMA
let DUAL_EMA_MODE = false;

// Configuration
let EMA_PERIOD = parseInt(process.env.EMA_PERIOD, 10) || 200;
let TIMEFRAME = process.env.TIMEFRAME || '15m';
let VOLUME_THRESHOLD = parseInt(process.env.VOLUME_THRESHOLD, 10) || 100_000_000;
const CHECK_INTERVAL = parseInt(process.env.CHECK_INTERVAL, 10) || 5 * 60 * 1000; // 5 minutes
const ALERT_COOLDOWN = parseInt(process.env.ALERT_COOLDOWN, 10) || 15 * 60 * 1000; // 15 minutes cooldown for alerts

// Telegram configuration — must be provided via environment variables
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.error('FATAL: TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID must be set as environment variables.');
    console.error('Create a .env file or set them in your deployment platform, then restart.');
    process.exit(1);
}

// Initialize Telegram bot with polling enabled
// const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });
// Initialize Telegram bot with better error handling
const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { 
    polling: {
      timeout: 30, // Shorter timeout
      limit: 100,
      retryTimeout: 5000 // Wait 5 seconds before retrying on error
    }
  });

  // Add specific error handlers
bot.on('polling_error', (error) => {
    log(`Telegram polling error: ${error.message}`, 'error');
    // Skip auto-reconnect while a graceful reconnect is running
    if (isReconnecting) return;

    // Restart polling after a delay if connection was reset
    if (error.code === 'ECONNRESET' || error.code === 'EFATAL') {
      log('Connection reset, restarting polling in 10 seconds...', 'warning');
      isReconnecting = true;
      setTimeout(() => {
        try {
          bot.stopPolling();
          setTimeout(() => {
            bot.startPolling();
            isReconnecting = false;
            log('Telegram polling restarted successfully', 'success');
          }, 1000);
        } catch (e) {
          isReconnecting = false;
          log(`Failed to restart polling: ${e.message}`, 'error');
        }
      }, 10000);
    }
  });


// Store last alert times and states for each symbol
const lastAlerts = new Map();
const coinStates = new Map(); // Tracks the current state of each coin (above/below EMA)
const trackedPairs = new Set(); // Keep track of pairs we're already monitoring

// Persist and restore alert state so restarts don't re-fire existing crossovers
const ALERT_STATE_PATH = path.join(__dirname, 'alert_state.json');
function loadAlertState() {
    try {
        if (!fs.existsSync(ALERT_STATE_PATH)) return;
        const { alerts, states } = JSON.parse(fs.readFileSync(ALERT_STATE_PATH, 'utf8'));
        if (Array.isArray(alerts)) for (const [k, v] of alerts) lastAlerts.set(k, v);
        if (Array.isArray(states)) for (const [k, v] of states) coinStates.set(k, v);
        log('Alert state restored from disk', 'info');
    } catch (e) {
        log(`Could not load alert state: ${e.message}`, 'warning');
    }
}
function saveAlertState() {
    fs.writeFile(ALERT_STATE_PATH, JSON.stringify({
        alerts: [...lastAlerts.entries()],
        states: [...coinStates.entries()]
    }), () => {});
}

// Deferred update queue — replaces unbounded 24h setTimeout calls
// Each entry: { executeAt: timestamp, fn: async () => ... }
const deferredUpdates = [];

// WebSocket related variables
const activeWebSockets = new Map(); // Track active WebSocket connections
const klineCache = new Map(); // Cache for kline data
const emaCache = new Map(); // Cache for calculated EMAs
const ema9Cache = new Map(); // Cache for EMA(9) values (dual mode)
const ema15Cache = new Map(); // Cache for EMA(15) values (dual mode)
const trainingData = new Map(); // Store historical data for ML training
const modelPerformance = new Map(); // Track ML model accuracy
const reconnectionAttempts = new Map(); // Track WebSocket reconnection attempts per symbol
const MAX_RECONNECTION_ATTEMPTS = 5;
const RECONNECTION_DELAY = 5000; // 5 seconds
const MIN_CROSS_PCT = 0.0005; // 0.05% minimum crossover margin to reduce whipsaw
// Validation constants — shared by settings loader and callback handler
const VALID_VOLUMES    = [50_000_000, 100_000_000, 200_000_000];
const VALID_TIMEFRAMES = ['1m', '5m', '15m', '1h', '4h'];
const VALID_EMA_PERIODS = [50, 100, 200];
let isReconnecting = false; // Prevents stacked reconnections during graceful restarts
let monitoringInterval = null; // Reference to the periodic check interval

// Telegram circuit breaker — pauses alert sends after 5 consecutive failures
let _tgFailCount = 0;
let _tgPausedUntil = 0;
async function safeSendAlert(chatId, text, opts) {
    if (Date.now() < _tgPausedUntil) {
        log('Telegram circuit open — alert suppressed', 'warning');
        return;
    }
    try {
        await bot.sendMessage(chatId, text, opts);
        _tgFailCount = 0;
    } catch (e) {
        if (++_tgFailCount >= 5) {
            _tgPausedUntil = Date.now() + 5 * 60 * 1000;
            log('Telegram circuit breaker tripped — pausing sends for 5 minutes', 'warning');
            _tgFailCount = 0;
        }
        throw e;
    }
}

// Build a TradingView chart URL for a given symbol (handles non-USDT pairs gracefully)
function getTradingViewUrl(symbol) {
    const base = symbol.endsWith('USDT') ? symbol.slice(0, -4) : symbol;
    return `https://www.tradingview.com/chart/?symbol=BINANCE:${base}USDT.P`;
}
let _indicatorsModule = null; // Cached module ref — avoids repeated require() on every closed candle
// Rate limiting for API calls
const API_RATE_LIMIT = 1200; // 1.2 seconds between API calls
let lastApiCall = 0;

// Helper function to enforce rate limiting
function enforceRateLimit() {
    const now = Date.now();
    const timeSinceLastCall = now - lastApiCall;

    if (timeSinceLastCall < API_RATE_LIMIT) {
        const delay = API_RATE_LIMIT - timeSinceLastCall;
        lastApiCall = now + delay;
        return new Promise(resolve => setTimeout(resolve, delay));
    }

    lastApiCall = now;
    return Promise.resolve();
}

// ML directories
const ML_DATA_DIR = path.join(__dirname, 'ml_data');
const CSV_DATA_DIR = path.join(__dirname, 'csv_data');
const MODEL_PATH = path.join(__dirname, 'ml_models');

// At the top of your file, after other requires
// const brainML = require('./src/ml/alternative');

// Create a log directory for persistent logging
const LOG_DIR = path.join(__dirname, 'logs');
if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR);
}

// Cached daily log file path — refreshes once per day to avoid per-call allocations
let _cachedLogDate = '';
let _cachedLogPath = '';
function getDailyLogPath() {
    const today = new Date().toISOString().split('T')[0];
    if (today !== _cachedLogDate) {
        _cachedLogDate = today;
        _cachedLogPath = path.join(LOG_DIR, `ema-tracker-${today}.log`);
    }
    return _cachedLogPath;
}

// Create ML directories
if (!fs.existsSync(ML_DATA_DIR)) {
    fs.mkdirSync(ML_DATA_DIR, { recursive: true });
}

if (!fs.existsSync(CSV_DATA_DIR)) {
    fs.mkdirSync(CSV_DATA_DIR, { recursive: true });
}

if (!fs.existsSync(MODEL_PATH)) {
    fs.mkdirSync(MODEL_PATH, { recursive: true });
}

// Log function that writes to both console and file
function log(message, type = 'info') {
    const timestamp = new Date().toISOString();
    const logMessage = `[${timestamp}] ${message}`;

    // Console logging with colors
    switch (type) {
        case 'error':
            console.error(logMessage.red);
            break;
        case 'success':
            console.log(logMessage.green);
            break;
        case 'warning':
            console.log(logMessage.yellow);
            break;
        default:
            console.log(logMessage);
    }

    // File logging
    const logFile = getDailyLogPath();
    fs.appendFileSync(logFile, logMessage + '\n');
}

// Check if TensorFlow.js can be loaded
function checkTensorFlowAvailability() {
    try {
        require('@tensorflow/tfjs-node');
        log('TensorFlow.js is available', 'success');
        return true;
    } catch (e) {
        try {
            require('@tensorflow/tfjs-node-cpu');
            log('TensorFlow.js CPU version is available', 'warning');
            return true;
        } catch (e2) {
            log(`TensorFlow.js is not available: ${e2.message}`, 'error');
            log('ML predictions will be disabled', 'warning');
            return false;
        }
    }
}

// Resolve SnoreToast binary bundled with node-notifier (Windows only)
const SNORE_TOAST = (() => {
    try {
        const p = path.join(require.resolve('node-notifier'), '..', 'vendor', 'snoreToast', 'snoretoast-x64.exe');
        return fs.existsSync(p) ? p : null;
    } catch (e) { return null; }
})();

// Register EMATracker as a toast-capable app so Windows shows notifications
// and pipe-based click callbacks work. Only needs to run once but is idempotent.
function registerToastApp() {
    if (process.platform !== 'win32' || !SNORE_TOAST) return;
    try {
        execFile(SNORE_TOAST, ['-install', 'EMA Tracker', SNORE_TOAST, 'EMATracker'], (err) => {
            if (err) log(`Toast app registration note: ${err.message}`, 'warning');
            else log('Toast app registered (EMATracker)', 'info');
        });
    } catch (e) { /* ignore */ }
}

// Show desktop notification.
// On Windows, uses SnoreToast directly with a named pipe so that click events are
// reliably detected and the URL is opened in the default browser.
function showDesktopNotification(title, message, type = 'info', url = null) {
    try {
        const displayMsg = url ? `${message}\n\uD83D\uDD17 Click to open chart` : message;

        if (process.platform === 'win32' && SNORE_TOAST) {
            if (url) {
                // Named-pipe approach: SnoreToast writes 'activate' into the pipe when clicked
                const pipeName = `\\\\.\\pipe\\emaTracker-${Date.now()}`;
                const pipeServer = net.createServer((stream) => {
                    let buf = '';
                    stream.on('data', (chunk) => {
                        // Different SnoreToast builds may emit UTF-16LE or UTF-8 callback payloads.
                        buf += `${chunk.toString('utf16le')}|${chunk.toString('utf8')}`;
                    });
                    stream.on('end', () => {
                        pipeServer.close();
                        const action = buf.toLowerCase();
                        if (action.includes('activate') || action.includes('clicked') || action.includes('buttonpressed')) {
                            // Use PowerShell Start-Process for reliable URL opening even when URL has '&' characters
                            const psUrl = String(url).replace(/'/g, "''");
                            exec(`powershell -NoProfile -Command "Start-Process '${psUrl}'"`, (err) => {
                                if (err) log(`Failed to open browser: ${err.message}`, 'error');
                            });
                        }
                    });
                    stream.on('error', () => {});
                });
                pipeServer.on('error', (err) => log(`Toast pipe error: ${err.message}`, 'error'));
                pipeServer.listen(pipeName, () => {
                    execFile(SNORE_TOAST, ['-t', title, '-m', displayMsg, '-pipeName', pipeName, '-appID', 'EMATracker'],
                        (err) => { if (err && err.code !== 0) { try { pipeServer.close(); } catch (e) {} } }
                    );
                });
                // Auto-close pipe server after 2 minutes if user never interacts
                setTimeout(() => { try { pipeServer.close(); } catch (e) {} }, 2 * 60 * 1000);
            } else {
                // No URL — fire-and-forget toast
                execFile(SNORE_TOAST, ['-t', title, '-m', displayMsg, '-appID', 'EMATracker']);
            }
        } else {
            // Non-Windows fallback
            notifier.notify({ title, message: displayMsg, sound: true });
        }

        log(`Desktop notification shown: ${title} - ${message}`);
    } catch (error) {
        log(`Failed to show desktop notification: ${error.message}`, 'error');
    }
}

// Initialize terminal
function initializeTerminal() {
    console.clear();
    console.log(figlet.textSync('EMA Tracker', { font: 'Standard' }).green);
    console.log('Monitoring Binance Futures for EMA Crossovers'.yellow.bold);
    console.log(`Configuration: ${DUAL_EMA_MODE ? 'EMA 9/15 Cross' : EMA_PERIOD + ' EMA'} | ${TIMEFRAME} Timeframe | Volume > ${VOLUME_THRESHOLD.toLocaleString()}`.cyan);
    console.log(`Alert Cooldown: ${ALERT_COOLDOWN / 60000} minutes`.magenta);
    console.log(`Telegram Alerts: Enabled for Chat ID ${TELEGRAM_CHAT_ID}`.blue);
    console.log(`WebSocket Real-Time Monitoring: Enabled`.green);
    console.log(`Machine Learning: ${ML_ENABLED ? 'Enabled'.green : 'Disabled'.red}`);
    console.log('='.repeat(80).dim);
    console.log('\nCROSSOVER EVENTS:'.cyan.bold);

    log(`EMA Tracker started with configuration: Mode=${DUAL_EMA_MODE ? 'EMA9/15' : 'EMA' + EMA_PERIOD}, Timeframe=${TIMEFRAME}, Volume Threshold=${VOLUME_THRESHOLD}, ML=${ML_ENABLED}`);
}

// Helper function to format volume
function formatVolume(volume) {
    if (volume >= 1_000_000_000) {
        return (volume / 1_000_000_000).toFixed(2) + 'B';
    } else if (volume >= 1_000_000) {
        return (volume / 1_000_000).toFixed(2) + 'M';
    } else if (volume >= 1_000) {
        return (volume / 1_000).toFixed(2) + 'K';
    }
    return volume.toFixed(2);
}

// Format price with appropriate precision based on value
function formatPrice(price) {
    if (price < 0.001) return price.toFixed(8);
    if (price < 1) return price.toFixed(6);
    if (price < 100) return price.toFixed(4);
    return price.toFixed(2);
}

// Function to get 24hr stats for a symbol
async function get24HrStats(symbol) {
    try {
        await enforceRateLimit();
        const response = await axios.get('https://fapi.binance.com/fapi/v1/ticker/24hr', {
            params: { symbol },
            timeout: 10000
        });
        return {
            priceChangePercent: parseFloat(response.data.priceChangePercent).toFixed(2),
            quoteVolume: parseFloat(response.data.quoteVolume)
        };
    } catch (error) {
        log(`Error fetching 24hr stats for ${symbol}: ${error.message}`, 'error');
        return { priceChangePercent: '0.00', quoteVolume: '0' };
    }
}

// Fetch Binance Futures pairs with 24hr quote volume above the threshold
async function getFuturesPairs() {
    try {
        // Enforce rate limiting
        await enforceRateLimit();
        
        const response = await axios.get('https://fapi.binance.com/fapi/v1/ticker/24hr', { timeout: 10000 });
        const newPairs = [];

        const pairs = response.data
            .filter(pair => {
                const volume = parseFloat(pair.quoteVolume);
                const symbol = pair.symbol;

                if (volume > VOLUME_THRESHOLD) {
                    // Only track new pairs that cross threshold after initial load
                    if (initialLoadComplete && !trackedPairs.has(symbol)) {
                        newPairs.push({
                            symbol,
                            volume,
                            price: parseFloat(pair.lastPrice),
                            change: parseFloat(pair.priceChangePercent)
                        });
                    }
                    trackedPairs.add(symbol);
                    return true;
                }
                return false;
            })
            .map(pair => pair.symbol);

        // Alert for new pairs that crossed the volume threshold (only after initial load)
        if (newPairs.length > 0) {
            alertNewHighVolumePairs(newPairs);
        }

        return pairs;
    } catch (error) {
        log(`Error fetching futures pairs: ${error.message}`, 'error');
        
        // Handle Binance rate-limit (429) and IP-ban (418) separately
        if (error.response && error.response.status === 429) {
            log('Rate limited by Binance (429). Waiting 5 minutes before next call...', 'warning');
            await new Promise(resolve => setTimeout(resolve, 5 * 60 * 1000));
        } else if (error.response && error.response.status === 418) {
            log('IP banned by Binance (418). Waiting 30 minutes before next call...', 'error');
            await new Promise(resolve => setTimeout(resolve, 30 * 60 * 1000));
        }
        
        return [];
    }
}

// Alert when new pairs cross the volume threshold
async function alertNewHighVolumePairs(newPairs) {
    for (const pair of newPairs) {
        const message = `🔔 *NEW HIGH VOLUME PAIR DETECTED*\n\n` +
            `*Symbol:* ${pair.symbol}\n` +
            `*Volume:* ${formatVolume(pair.volume)}\n` +
            `*Price:* ${formatPrice(pair.price)}\n` +
            `*24h Change:* ${pair.change.toFixed(2)}%\n` +
            `*Time:* ${new Date().toLocaleString()}\n\n` +
            `This pair has been added to the monitoring list.`;

        try {
            await bot.sendMessage(TELEGRAM_CHAT_ID, message, { parse_mode: 'Markdown' });

            // Show desktop notification — match Telegram content
            showDesktopNotification(
                `🔔 New High Volume Pair: ${pair.symbol}`,
                `Volume: ${formatVolume(pair.volume)}  Price: ${formatPrice(pair.price)}\n24h Change: ${pair.change.toFixed(2)}%  Added to monitoring`,
                'info',
                getTradingViewUrl(pair.symbol)
            );

            log(`New high volume pair alert sent for ${pair.symbol} with volume ${formatVolume(pair.volume)}`, 'success');

            // Setup WebSocket for the new pair
            setupSymbolWebSocket(pair.symbol);
        } catch (error) {
            log(`Error sending new pair alert for ${pair.symbol}: ${error.message}`, 'error');
        }
    }
}

// Retrieve historical candlestick data for the given symbol
async function getKlines(symbol) {
    try {
        // Request enough candles for the active EMA period
        const requiredPeriod = DUAL_EMA_MODE ? 15 : EMA_PERIOD;
        const limit = requiredPeriod + 100;

        const response = await axios.get('https://fapi.binance.com/fapi/v1/klines', {
            params: { symbol, interval: TIMEFRAME, limit: limit },
            timeout: 10000
        });

        const klines = response.data.map(k => ({
            time: k[0],
            open: parseFloat(k[1]),
            high: parseFloat(k[2]),
            low: parseFloat(k[3]),
            close: parseFloat(k[4]),
            volume: parseFloat(k[5])
        }));

        // Update the kline cache
        klineCache.set(symbol, klines);

        // Calculate and cache EMA based on current mode
        const closes = klines.map(k => k.close);

        if (DUAL_EMA_MODE) {
            // Dual EMA mode: calculate EMA(9) and EMA(15)
            const ema9Values = calculateEMA(closes, 9);
            const ema15Values = calculateEMA(closes, 15);
            ema9Cache.set(symbol, ema9Values);
            ema15Cache.set(symbol, ema15Values);
        } else {
            // Single EMA mode: calculate one EMA for the configured period
            const emaValues = calculateEMA(closes, EMA_PERIOD);
            emaCache.set(symbol, emaValues);
        }

        const minPeriod = DUAL_EMA_MODE ? 15 : EMA_PERIOD;
        if (klines.length < minPeriod) {
            log(`Warning: Not enough candles for ${symbol}. Needed ${minPeriod}, got ${klines.length}`, 'warning');
        }

        return klines;
    } catch (error) {
        log(`Error fetching klines for ${symbol}: ${error.message}`, 'error');
        return [];
    }
}

// Calculate the EMA for an array of prices given a period
function calculateEMA(prices, period) {
    if (prices.length < period) {
        log(`Warning: Not enough prices for EMA calculation. Needed ${period}, got ${prices.length}`, 'warning');
        return [];
    }

    const k = 2 / (period + 1);
    let emaArray = [];

    // Start with the simple moving average as the first EMA
    let sma = prices.slice(0, period).reduce((sum, p) => sum + p, 0) / period;
    let ema = sma;

    // Add the first EMA (which is the SMA)
    emaArray.push(ema);

    // Calculate EMA for the remaining prices
    for (let i = period; i < prices.length; i++) {
        ema = (prices[i] - ema) * k + ema;
        emaArray.push(ema);
    }

    return emaArray;
}

// Update EMA with a new price (for real-time updates)
function updateEMA(symbol, newPrice) {
    // Get cached EMA values
    let emaValues = emaCache.get(symbol);

    // If no cached values, we need to fetch historical data first
    if (!emaValues || emaValues.length === 0) {
        log(`No cached EMA values for ${symbol}, fetching historical data...`, 'warning');
        return false;
    }

    const k = 2 / (EMA_PERIOD + 1);
    const lastEMA = emaValues[emaValues.length - 1];
    const newEMA = (newPrice - lastEMA) * k + lastEMA;

    // Add the new EMA to the cache
    emaValues.push(newEMA);

    // Keep the cache size reasonable by removing older values
    if (emaValues.length > EMA_PERIOD * 2) {
        emaValues = emaValues.slice(-EMA_PERIOD * 2);
    }

    emaCache.set(symbol, emaValues);
    return true;
}

// Send Telegram notification with enhanced formatting
async function sendTelegramAlert(symbol, crossType, price, ema, difference) {
    try {
        const emoji = crossType === 'up' ? '🟢' : '🔴';
        const signal = crossType === 'up' ? 'BULLISH SIGNAL' : 'BEARISH SIGNAL';
        const formattedPrice = formatPrice(price);
        const formattedEma = formatPrice(ema);

        // Get 24hr stats for the symbol
        const stats = await get24HrStats(symbol);

        // Create a TradingView link
        const tradingViewUrl = getTradingViewUrl(symbol);

        const message = `${emoji} *${signal}* ${emoji}\n\n` +
            `*Symbol:* ${symbol}\n` +
            `*Price:* ${formattedPrice}\n` +
            `*EMA(${EMA_PERIOD}):* ${formattedEma}\n` +
            `*Difference:* ${difference.toFixed(2)}%\n` +
            `*24h Change:* ${stats.priceChangePercent}%\n` +
            `*24h Volume:* ${formatVolume(stats.quoteVolume)}\n` +
            `*Timeframe:* ${TIMEFRAME}\n\n` +
            `*Time:* ${new Date().toLocaleString()}\n\n` +
            `[View Chart on TradingView](${tradingViewUrl})`;

        await safeSendAlert(TELEGRAM_CHAT_ID, message, {
            parse_mode: 'Markdown',
            disable_web_page_preview: false
        });

        // Show desktop notification — mirrors Telegram message content
        // Clicking the toast opens the TradingView chart in the browser
        showDesktopNotification(
            `${crossType === 'up' ? '🟢 BULLISH' : '🔴 BEARISH'} — ${symbol}`,
            `Price: ${formattedPrice}  EMA(${EMA_PERIOD}): ${formattedEma}\nDiff: ${difference.toFixed(2)}%  24h: ${stats.priceChangePercent}%\nVol: ${formatVolume(stats.quoteVolume)}  TF: ${TIMEFRAME}`,
            crossType === 'up' ? 'info' : 'warning',
            tradingViewUrl
        );

        log(`Telegram alert sent for ${symbol} (${crossType})`, 'success');
    } catch (error) {
        log(`Error sending Telegram message: ${error.message}`, 'error');

        // Retry with simpler message if parse_mode might be the issue
        try {
            const simpleMessage = `${crossType === 'up' ? '🟢 BULLISH' : '🔴 BEARISH'} SIGNAL: ${symbol} at ${formatPrice(price)}`;
            await bot.sendMessage(TELEGRAM_CHAT_ID, simpleMessage);
            log(`Sent simplified alert for ${symbol} after error`, 'warning');
        } catch (retryError) {
            log(`Failed to send even simplified message: ${retryError.message}`, 'error');
        }
    }
}

// Check if we should alert for this symbol based on direction change and cooldown
function shouldAlert(symbol, currentState) {
    const now = Date.now();
    const previousState = coinStates.get(symbol);
    // Per-direction key so bullish and bearish each have their own cooldown window
    const alertKey = `${symbol}_${currentState}`;
    const lastAlertTime = lastAlerts.get(alertKey) || 0;

    if (previousState !== currentState && now - lastAlertTime >= ALERT_COOLDOWN) {
        coinStates.set(symbol, currentState);
        lastAlerts.set(alertKey, now);
        saveAlertState();
        return true;
    } else if (previousState !== currentState) {
        log(`Alert for ${symbol} (${currentState}) skipped due to cooldown.`, 'warning');
    }
    return false;
}

// WebSocket setup for a symbol
function setupSymbolWebSocket(symbol) {
    // Check reconnection attempts
    const attempts = reconnectionAttempts.get(symbol) || 0;
    if (attempts >= MAX_RECONNECTION_ATTEMPTS) {
        log(`Max reconnection attempts reached for ${symbol}. Stopping reconnections.`, 'warning');
        return null;
    }

    // Close existing connection if any
    if (activeWebSockets.has(symbol)) {
        try {
            activeWebSockets.get(symbol).close();
        } catch (e) {
            // Ignore errors when closing
        }
    }

    // Create WebSocket URL based on timeframe
    const wsSymbol = symbol.toLowerCase();
    const wsUrl = `wss://fstream.binance.com/ws/${wsSymbol}@kline_${TIMEFRAME}`;

    try {
        const ws = new WebSocket(wsUrl);
        let isConnected = false;

        ws.on('open', () => {
            isConnected = true;
            // Reset reconnection attempts on successful connection
            reconnectionAttempts.set(symbol, 0);
            log(`WebSocket connected for ${symbol}`, 'success');
        });

        ws.on('message', (data) => {
            try {
                const message = JSON.parse(data);

                // Process kline data
                if (message.e === 'kline') {
                    const kline = message.k;

                    // Only process if the candle is closed
                    if (kline.x === true) {
                        processClosedCandle(symbol, kline);
                    }
                }
            } catch (error) {
                log(`Error processing WebSocket message for ${symbol}: ${error.message}`, 'error');
            }
        });

        ws.on('error', (error) => {
            log(`WebSocket error for ${symbol}: ${error.message}`, 'error');

            // Skip auto-reconnect while a graceful reconnect is running
            if (isReconnecting) return;

            // Only attempt reconnection if we haven't exceeded max attempts
            const currentAttempts = reconnectionAttempts.get(symbol) || 0;
            if (currentAttempts < MAX_RECONNECTION_ATTEMPTS && trackedPairs.has(symbol)) {
                reconnectionAttempts.set(symbol, currentAttempts + 1);
                setTimeout(() => {
                    log(`Reconnecting WebSocket for ${symbol} (attempt ${currentAttempts + 1}/${MAX_RECONNECTION_ATTEMPTS})`, 'info');
                    setupSymbolWebSocket(symbol);
                }, RECONNECTION_DELAY);
            }
        });

        ws.on('close', () => {
            log(`WebSocket closed for ${symbol}`, 'warning');

            // Skip auto-reconnect while a graceful reconnect is running
            if (isReconnecting) return;

            // Only attempt reconnection if connection was established and we haven't exceeded max attempts
            if (isConnected && trackedPairs.has(symbol)) {
                const currentAttempts = reconnectionAttempts.get(symbol) || 0;
                if (currentAttempts < MAX_RECONNECTION_ATTEMPTS) {
                    reconnectionAttempts.set(symbol, currentAttempts + 1);
                    setTimeout(() => {
                        log(`Reconnecting WebSocket for ${symbol} (attempt ${currentAttempts + 1}/${MAX_RECONNECTION_ATTEMPTS})`, 'info');
                        setupSymbolWebSocket(symbol);
                    }, RECONNECTION_DELAY);
                }
            }
        });

        // Store the WebSocket connection
        activeWebSockets.set(symbol, ws);

        // Initialize with historical data
        getKlines(symbol).then(() => {
            log(`Historical data loaded for ${symbol}`, 'info');
        }).catch(error => {
            log(`Error loading historical data for ${symbol}: ${error.message}`, 'error');
        });

        return ws;
    } catch (error) {
        log(`Error setting up WebSocket for ${symbol}: ${error.message}`, 'error');
        return null;
    }
}


// Process a closed candle from WebSocket with improved ML data collection
async function processClosedCandle(symbol, kline) {
    try {
        // Get cached klines or initialize if not exists
        let klines = klineCache.get(symbol) || [];

        // Create new kline object
        const newKline = {
            time: kline.t,
            open: parseFloat(kline.o),
            high: parseFloat(kline.h),
            low: parseFloat(kline.l),
            close: parseFloat(kline.c),
            volume: parseFloat(kline.v)
        };

        // Add new kline to cache
        klines.push(newKline);

        // Keep cache size reasonable
        const maxCacheSize = DUAL_EMA_MODE ? 200 : EMA_PERIOD * 2;
        if (klines.length > maxCacheSize) {
            klines = klines.slice(-maxCacheSize);
        }

        klineCache.set(symbol, klines);

        // Get closes for EMA calculation
        const closes = klines.map(k => k.close);
        const volumes = klines.map(k => k.volume);

        // Calculate EMA values based on current mode
        if (DUAL_EMA_MODE) {
            // Dual EMA mode: calculate EMA(9) and EMA(15)
            const ema9Values = calculateEMA(closes, 9);
            const ema15Values = calculateEMA(closes, 15);
            ema9Cache.set(symbol, ema9Values);
            ema15Cache.set(symbol, ema15Values);

            // Check for dual EMA crossover (EMA9 vs EMA15)
            if (ema9Values.length >= 2 && ema15Values.length >= 2) {
                // Align arrays: EMA(9) starts 6 candles earlier than EMA(15), so trim the longer array
                const offset = ema9Values.length - ema15Values.length;
                const alignedEma9 = offset > 0 ? ema9Values.slice(offset) : ema9Values;
                const alignedEma15 = offset < 0 ? ema15Values.slice(-offset) : ema15Values;

                const lastEma9 = alignedEma9[alignedEma9.length - 1];
                const prevEma9 = alignedEma9[alignedEma9.length - 2];
                const lastEma15 = alignedEma15[alignedEma15.length - 1];
                const prevEma15 = alignedEma15[alignedEma15.length - 2];

                checkForDualEmaCrossover(symbol, prevEma9, lastEma9, prevEma15, lastEma15, closes[closes.length - 1]);
            }
        } else {
            // Single EMA mode — update incrementally if cached, fall back to full recalc on first candle
            const updated = updateEMA(symbol, newKline.close);
            if (!updated) {
                const freshEma = calculateEMA(closes, EMA_PERIOD);
                emaCache.set(symbol, freshEma);
            }
            const emaValues = emaCache.get(symbol) || [];

            // Check for price vs EMA crossover
            if (emaValues.length >= 2) {
                const lastPrice = closes[closes.length - 1];
                const prevPrice = closes[closes.length - 2];
                const lastEMA = emaValues[emaValues.length - 1];
                const prevEMA = emaValues[emaValues.length - 2];
                checkForCrossover(symbol, prevPrice, lastPrice, prevEMA, lastEMA);
            }
        }

        // Collect data for ML training if we have enough data
        if (klines.length >= 30 && ML_ENABLED && !DUAL_EMA_MODE) {
            const emaValues = emaCache.get(symbol) || [];
            if (emaValues.length === 0) return;

            // Calculate additional indicators — cache module ref so require() only runs once
            if (!_indicatorsModule) _indicatorsModule = require('./src/indicators');
            const { calculateRSI, calculateMACD, calculateBollingerBands } = _indicatorsModule;
            const rsi = calculateRSI(closes);
            const macd = calculateMACD(closes);
            const bb = calculateBollingerBands(closes);

            // Calculate ATR
            const atr = calculateATR(klines);

            // Create feature vector
            const dataPoint = {
                timestamp: kline.t,
                symbol: symbol,
                open: newKline.open,
                high: newKline.high,
                low: newKline.low,
                close: newKline.close,
                volume: newKline.volume,
                ema: emaValues[emaValues.length - 1],
                ema_diff: ((newKline.close - emaValues[emaValues.length - 1]) / emaValues[emaValues.length - 1] * 100),
                rsi: rsi[rsi.length - 1],
                macd: macd.macd[macd.macd.length - 1],
                macd_signal: macd.signal[macd.signal.length - 1],
                macd_hist: macd.histogram[macd.histogram.length - 1],
                bb_upper: bb.upper[bb.upper.length - 1],
                bb_middle: bb.middle[bb.middle.length - 1],
                bb_lower: bb.lower[bb.lower.length - 1],
                bb_width: (bb.upper[bb.upper.length - 1] - bb.lower[bb.lower.length - 1]) / bb.middle[bb.middle.length - 1],
                atr: atr,
                volume_change: volumes.length > 1 ? volumes[volumes.length - 1] / volumes[volumes.length - 2] - 1 : 0,
                // Target variable (to be filled later)
                future_price_change: null,
                label: null // 1 for price increase, 0 for decrease
            };

            // Store data in memory
            if (!trainingData.has(symbol)) {
                trainingData.set(symbol, []);
            }
            trainingData.get(symbol).push(dataPoint);

            // Keep training data size manageable (last 1000 candles)
            if (trainingData.get(symbol).length > 1000) {
                trainingData.set(symbol, trainingData.get(symbol).slice(-1000));
            }

            // Save to JSON file
            saveDataPoint(symbol, dataPoint);

            // Export to CSV periodically
            if (trainingData.get(symbol).length % 10 === 0) {
                exportToCSV(symbol);
            }

            // Schedule update of future price change (after 24 hours)
            deferredUpdates.push({ executeAt: Date.now() + 24 * 60 * 60 * 1000, fn: () => updateFuturePriceChange(symbol, kline.t) });
            deferredUpdates.sort((a, b) => a.executeAt - b.executeAt);
        }
    } catch (error) {
        log(`Error processing closed candle for ${symbol}: ${error.message}`, 'error');
    }
}

// Save data point to JSON file
async function saveDataPoint(symbol, dataPoint) {
    try {
        // Create directory for this symbol if it doesn't exist
        const symbolDir = path.join(ML_DATA_DIR, symbol);
        if (!fs.existsSync(symbolDir)) {
            fs.mkdirSync(symbolDir, { recursive: true });
        }

        // Use current month for filename to organize data
        const date = new Date();
        const filename = `${date.getFullYear()}-${(date.getMonth() + 1).toString().padStart(2, '0')}.json`;
        const filePath = path.join(symbolDir, filename);

        // Load existing data or create new array (async — won't block the event loop)
        let data = [];
        if (fs.existsSync(filePath)) {
            try {
                data = JSON.parse(await fs.promises.readFile(filePath, 'utf8'));
            } catch (e) {
                log(`Error reading data file for ${symbol}: ${e.message}`, 'error');
                data = [];
            }
        }

        // Add new data point
        data.push(dataPoint);

        // Save data back to file asynchronously to avoid blocking the event loop
        fs.writeFile(filePath, JSON.stringify(data, null, 2), (err) => {
            if (err) log(`Error writing data file for ${symbol}: ${err.message}`, 'error');
        });

        // Only log occasionally to avoid excessive logging
        if (data.length % 100 === 0) {
            log(`Collected ${data.length} data points for ${symbol} (${filename})`, 'info');
        }

        return true;
    } catch (error) {
        log(`Error saving data point for ${symbol}: ${error.message}`, 'error');
        return false;
    }
}

// Export training data to CSV for easier model training
// Cache one CsvWriter instance per file path — avoids reallocating on every candle close
const csvWriterCache = new Map();
function getCsvWriter(csvPath) {
    if (!csvWriterCache.has(csvPath)) {
        csvWriterCache.set(csvPath, createObjectCsvWriter({
            path: csvPath,
            header: [
                { id: 'timestamp', title: 'TIMESTAMP' },
                { id: 'symbol', title: 'SYMBOL' },
                { id: 'open', title: 'OPEN' },
                { id: 'high', title: 'HIGH' },
                { id: 'low', title: 'LOW' },
                { id: 'close', title: 'CLOSE' },
                { id: 'volume', title: 'VOLUME' },
                { id: 'ema', title: 'EMA' },
                { id: 'ema_diff', title: 'EMA_DIFF' },
                { id: 'rsi', title: 'RSI' },
                { id: 'macd', title: 'MACD' },
                { id: 'macd_signal', title: 'MACD_SIGNAL' },
                { id: 'macd_hist', title: 'MACD_HIST' },
                { id: 'bb_upper', title: 'BB_UPPER' },
                { id: 'bb_middle', title: 'BB_MIDDLE' },
                { id: 'bb_lower', title: 'BB_LOWER' },
                { id: 'bb_width', title: 'BB_WIDTH' },
                { id: 'atr', title: 'ATR' },
                { id: 'volume_change', title: 'VOLUME_CHANGE' },
                { id: 'future_price_change', title: 'FUTURE_PRICE_CHANGE' },
                { id: 'label', title: 'LABEL' }
            ]
        }));
    }
    return csvWriterCache.get(csvPath);
}

function exportToCSV(symbol) {
    try {
        if (!trainingData.has(symbol) || trainingData.get(symbol).length === 0) {
            return;
        }

        const data = trainingData.get(symbol);

        // Create directory for this symbol if it doesn't exist
        const symbolDir = path.join(CSV_DATA_DIR, symbol);
        if (!fs.existsSync(symbolDir)) {
            fs.mkdirSync(symbolDir, { recursive: true });
        }

        // Create CSV file path
        const csvPath = path.join(symbolDir, `${symbol}_training_data.csv`);

        // Define CSV writer (cached per path — avoids re-allocation on every call)
        const csvWriter = getCsvWriter(csvPath);

        // Write data to CSV
        csvWriter.writeRecords(data)
            .then(() => {
                log(`CSV export completed for ${symbol} with ${data.length} records`, 'success');
            })
            .catch(error => {
                log(`Error writing CSV for ${symbol}: ${error.message}`, 'error');
            });
    } catch (error) {
        log(`Error exporting to CSV for ${symbol}: ${error.message}`, 'error');
    }
}

// Export all training data to CSV
function exportAllDataToCSV() {
    try {
        log('Exporting all training data to CSV...', 'info');

        for (const [symbol, data] of trainingData.entries()) {
            if (data.length > 0) {
                exportToCSV(symbol);
            }
        }

        log('All training data exported to CSV successfully', 'success');
    } catch (error) {
        log(`Error exporting all data to CSV: ${error.message}`, 'error');
    }
}

// Process real-time candle updates
function processRealtimeCandle(symbol, kline, logUnconfirmed = true) {
    try {
        // Get cached klines
        const klines = klineCache.get(symbol);
        if (!klines || klines.length === 0) {
            return; // No historical data yet
        }

        // Get current price
        const currentPrice = parseFloat(kline.c);

        // Get cached EMA values
        const emaValues = emaCache.get(symbol);
        if (!emaValues || emaValues.length < 2) {
            return; // Not enough EMA values yet
        }

        // Get the last closed price and EMA
        const lastClosedPrice = klines[klines.length - 1].close;
        const lastEMA = emaValues[emaValues.length - 1];

        // Determine current state (above or below EMA)
        const prevState = lastClosedPrice > lastEMA ? 'above' : 'below';
        const currentState = currentPrice > lastEMA ? 'above' : 'below';

        // If state changed, we have a potential real-time crossover
        if (prevState !== currentState) {
            // Calculate difference percentage
            const difference = (currentPrice - lastEMA) / lastEMA * 100;

            // Only log if explicitly requested (for debugging)
            if (logUnconfirmed) {
                // Log the potential crossover but don't send alert yet
                console.log('\n');
                const crossType = currentState === 'above' ? 'up' : 'down';
                const crossLabel = crossType === 'up' ?
                    '▲'.yellow + ' POTENTIAL UPWARD CROSSOVER '.black.bgYellow :
                    '▼'.yellow + ' POTENTIAL DOWNWARD CROSSOVER '.black.bgYellow;

                console.log(crossLabel + ' ' + symbol.bold);
                console.log(`  Current Price: ${formatPrice(currentPrice)[crossType === 'up' ? 'green' : 'red']}`);
                console.log(`  EMA(${EMA_PERIOD}): ${formatPrice(lastEMA).cyan}`);
                console.log(`  Difference: ${difference.toFixed(2)}%`.yellow);
                console.log(`  Status: ${'REAL-TIME (Unconfirmed)'.yellow}`);
            }

            // Only log to file, not to console
            fs.appendFileSync(
                getDailyLogPath(),
                `[${new Date().toISOString()}] Potential ${currentState === 'above' ? 'upward' : 'downward'} crossover detected for ${symbol} (unconfirmed)\n`
            );
        }
    } catch (error) {
        // Only log to file, not to console
        fs.appendFileSync(
            getDailyLogPath(),
            `[${new Date().toISOString()}] Error processing real-time candle for ${symbol}: ${error.message}\n`
        );
    }
}

// Function to update future price change for training data
async function updateFuturePriceChange(symbol, timestamp) {
    try {
        if (!trainingData.has(symbol)) return;

        const data = trainingData.get(symbol);
        const dataPoint = data.find(d => d.timestamp === timestamp);

        if (!dataPoint) return;

        // Get current price
        const currentPrice = await getCurrentPrice(symbol);
        const originalPrice = dataPoint.close;

        // Calculate price change percentage
        const priceChange = ((currentPrice - originalPrice) / originalPrice * 100);

        // Update the data point
        dataPoint.future_price_change = priceChange;
        // 3-class label: 0 = bearish (<-1%), 1 = neutral, 2 = bullish (>+1%)
        const LABEL_THRESHOLD = 1.0;
        dataPoint.label = priceChange > LABEL_THRESHOLD ? 2 : priceChange < -LABEL_THRESHOLD ? 0 : 1;
        log(`Updated future price change for ${symbol}: ${priceChange.toFixed(2)}%`, 'info');

        // Update the data in JSON files
        updateStoredDataPoint(symbol, timestamp, priceChange);

        // Update CSV file
        exportToCSV(symbol);
    } catch (error) {
        log(`Error updating future price change: ${error.message}`, 'error');
    }
}

// Update a stored data point in JSON files
async function updateStoredDataPoint(symbol, timestamp, priceChange) {
    try {
        // Find the file containing this timestamp
        const symbolDir = path.join(ML_DATA_DIR, symbol);
        if (!fs.existsSync(symbolDir)) {
            return false;
        }

        const files = fs.readdirSync(symbolDir).filter(f => f.endsWith('.json'));

        for (const file of files) {
            const filePath = path.join(symbolDir, file);
            const data = JSON.parse(await fs.promises.readFile(filePath, 'utf8'));

            // Find the data point with matching timestamp
            const index = data.findIndex(d => d.timestamp === timestamp);
            if (index !== -1) {
                // Update the future price change
                data[index].future_price_change = priceChange;
                data[index].label = priceChange > 1.0 ? 2 : priceChange < -1.0 ? 0 : 1;

                // Save the updated data asynchronously
                fs.writeFile(filePath, JSON.stringify(data, null, 2), (err) => {
                    if (err) log(`Error writing updated data for ${symbol}: ${err.message}`, 'error');
                });
                return true;
            }
        }

        return false;
    } catch (error) {
        log(`Error updating stored data point for ${symbol}: ${error.message}`, 'error');
        return false;
    }
}

// Function to get current price
async function getCurrentPrice(symbol) {
    try {
        await enforceRateLimit();
        const response = await axios.get('https://fapi.binance.com/fapi/v1/ticker/price', {
            params: { symbol },
            timeout: 10000
        });
        return parseFloat(response.data.price);
    } catch (error) {
        log(`Error getting current price for ${symbol}: ${error.message}`, 'error');
        throw error;
    }
}

// Check for crossover and send alerts if needed with ML prediction
async function checkForCrossover(symbol, prevPrice, lastPrice, prevEMA, lastEMA) {
    try {
        // Determine current state (above or below EMA)
        const currentState = lastPrice > lastEMA ? 'above' : 'below';
        const difference = (lastPrice - lastEMA) / lastEMA * 100;

        // Get ML prediction if available
        let prediction = null;
        if (ML_ENABLED) {
            try {
                prediction = await predictPriceMovement(symbol, lastPrice, lastEMA, difference);
            } catch (predictionError) {
                log(`Error getting prediction for ${symbol}: ${predictionError.message}`, 'warning');
                // Continue without prediction
            }
        }

        // Upward crossover: price crossing from below to above EMA (with minimum margin)
        if (prevPrice < prevEMA && lastPrice > lastEMA && (lastPrice - lastEMA) / lastEMA > MIN_CROSS_PCT) {
            console.log('\n');
            console.log('▲'.green + ' UPWARD CROSSOVER '.white.bgGreen + ' ' + symbol.bold);
            console.log(`  Previous Price: ${formatPrice(prevPrice).gray} → Current Price: ${formatPrice(lastPrice).green}`);
            console.log(`  Previous EMA: ${formatPrice(prevEMA).gray} → Current EMA: ${formatPrice(lastEMA).cyan}`);
            console.log(`  Difference: ${difference.toFixed(2)}%`.yellow);

            if (prediction !== null) {
                console.log(`  ML Prediction: ${prediction.toFixed(2)}% expected change`.cyan);
            }

            if (shouldAlert(symbol, currentState)) {
                if (prediction !== null) {
                    await sendTelegramAlertWithML(symbol, 'up', lastPrice, lastEMA, difference, prediction);
                } else {
                    await sendTelegramAlert(symbol, 'up', lastPrice, lastEMA, difference);
                }
            }
        }
        // Downward crossover: price crossing from above to below EMA (with minimum margin)
        else if (prevPrice > prevEMA && lastPrice < lastEMA && (lastEMA - lastPrice) / lastEMA > MIN_CROSS_PCT) {
            console.log('\n');
            console.log('▼'.red + ' DOWNWARD CROSSOVER '.white.bgRed + ' ' + symbol.bold);
            console.log(`  Previous Price: ${formatPrice(prevPrice).gray} → Current Price: ${formatPrice(lastPrice).red}`);
            console.log(`  Previous EMA: ${formatPrice(prevEMA).gray} → Current EMA: ${formatPrice(lastEMA).cyan}`);
            console.log(`  Difference: ${difference.toFixed(2)}%`.yellow);

            if (prediction !== null) {
                console.log(`  ML Prediction: ${prediction.toFixed(2)}% expected change`.cyan);
            }

            if (shouldAlert(symbol, currentState)) {
                if (prediction !== null) {
                    await sendTelegramAlertWithML(symbol, 'down', lastPrice, lastEMA, difference, prediction);
                } else {
                    await sendTelegramAlert(symbol, 'down', lastPrice, lastEMA, difference);
                }
            }
        } else {
            // Update state even if no crossover
            coinStates.set(symbol, currentState);
        }
    } catch (error) {
        log(`Error checking for crossover for ${symbol}: ${error.message}`, 'error');
    }
}

// Check for dual EMA(9) vs EMA(15) crossover
async function checkForDualEmaCrossover(symbol, prevEma9, lastEma9, prevEma15, lastEma15, currentPrice) {
    try {
        // State: is EMA(9) above or below EMA(15)?
        const currentState = lastEma9 > lastEma15 ? 'ema9_above' : 'ema9_below';
        const difference = (lastEma9 - lastEma15) / lastEma15 * 100;

        // Bullish: EMA(9) crosses above EMA(15) (with minimum margin)
        if (prevEma9 < prevEma15 && lastEma9 > lastEma15 && (lastEma9 - lastEma15) / lastEma15 > MIN_CROSS_PCT) {
            console.log('\n');
            console.log('▲'.green + ' EMA 9/15 BULLISH CROSSOVER '.white.bgGreen + ' ' + symbol.bold);
            console.log(`  EMA(9): ${formatPrice(prevEma9).gray} → ${formatPrice(lastEma9).green}`);
            console.log(`  EMA(15): ${formatPrice(prevEma15).gray} → ${formatPrice(lastEma15).cyan}`);
            console.log(`  Price: ${formatPrice(currentPrice).white}`);
            console.log(`  EMA Spread: ${difference.toFixed(4)}%`.yellow);

            if (shouldAlert(symbol, currentState)) {
                await sendDualEmaAlert(symbol, 'up', currentPrice, lastEma9, lastEma15, difference);
            }
        }
        // Bearish: EMA(9) crosses below EMA(15) (with minimum margin)
        else if (prevEma9 > prevEma15 && lastEma9 < lastEma15 && (lastEma15 - lastEma9) / lastEma15 > MIN_CROSS_PCT) {
            console.log('\n');
            console.log('▼'.red + ' EMA 9/15 BEARISH CROSSOVER '.white.bgRed + ' ' + symbol.bold);
            console.log(`  EMA(9): ${formatPrice(prevEma9).gray} → ${formatPrice(lastEma9).red}`);
            console.log(`  EMA(15): ${formatPrice(prevEma15).gray} → ${formatPrice(lastEma15).cyan}`);
            console.log(`  Price: ${formatPrice(currentPrice).white}`);
            console.log(`  EMA Spread: ${difference.toFixed(4)}%`.yellow);

            if (shouldAlert(symbol, currentState)) {
                await sendDualEmaAlert(symbol, 'down', currentPrice, lastEma9, lastEma15, difference);
            }
        } else {
            coinStates.set(symbol, currentState);
        }
    } catch (error) {
        log(`Error checking dual EMA crossover for ${symbol}: ${error.message}`, 'error');
    }
}

// Send Telegram alert for dual EMA 9/15 crossover
async function sendDualEmaAlert(symbol, crossType, price, ema9, ema15, spread) {
    try {
        const emoji = crossType === 'up' ? '🟢' : '🔴';
        const signal = crossType === 'up' ? 'BULLISH EMA 9/15 CROSS' : 'BEARISH EMA 9/15 CROSS';

        // Get 24hr stats
        const stats = await get24HrStats(symbol);

        // TradingView link
        const tradingViewUrl = getTradingViewUrl(symbol);

        const message = `${emoji} *${signal}* ${emoji}\n\n` +
            `*Symbol:* ${symbol}\n` +
            `*Price:* ${formatPrice(price)}\n` +
            `*EMA(9):* ${formatPrice(ema9)}\n` +
            `*EMA(15):* ${formatPrice(ema15)}\n` +
            `*EMA Spread:* ${spread.toFixed(4)}%\n` +
            `*24h Change:* ${stats.priceChangePercent}%\n` +
            `*24h Volume:* ${formatVolume(stats.quoteVolume)}\n` +
            `*Timeframe:* ${TIMEFRAME}\n\n` +
            `*Time:* ${new Date().toLocaleString()}\n\n` +
            `[View Chart on TradingView](${tradingViewUrl})`;

        await safeSendAlert(TELEGRAM_CHAT_ID, message, {
            parse_mode: 'Markdown',
            disable_web_page_preview: false
        });

        // Show desktop notification — mirrors Telegram message content
        // Clicking the toast opens the TradingView chart in the browser
        showDesktopNotification(
            `${crossType === 'up' ? '🟢 EMA 9/15 BULL' : '🔴 EMA 9/15 BEAR'} — ${symbol}`,
            `EMA(9): ${formatPrice(ema9)}  EMA(15): ${formatPrice(ema15)}\nSpread: ${spread.toFixed(4)}%  24h: ${stats.priceChangePercent}%\nVol: ${formatVolume(stats.quoteVolume)}  TF: ${TIMEFRAME}`,
            crossType === 'up' ? 'info' : 'warning',
            tradingViewUrl
        );

        log(`Dual EMA alert sent for ${symbol} (${crossType})`, 'success');
    } catch (error) {
        log(`Error sending dual EMA alert: ${error.message}`, 'error');
        try {
            const simpleMsg = `${crossType === 'up' ? '🟢 BULLISH' : '🔴 BEARISH'} EMA 9/15 CROSS: ${symbol} at ${formatPrice(price)}`;
            await bot.sendMessage(TELEGRAM_CHAT_ID, simpleMsg);
        } catch (retryError) {
            log(`Failed to send even simplified dual EMA message: ${retryError.message}`, 'error');
        }
    }
}

// Function to make price movement prediction
async function predictPriceMovement(symbol, price, ema, emaDiff) {
    try {
        if (!ML_ENABLED) return null;

        // Get the ML model module
        const mlModel = require('./src/ml/model');

        // Get additional features for prediction
        const klines = klineCache.get(symbol) || [];
        if (klines.length < 30) return null;

        const closes = klines.map(k => k.close);
        const volumes = klines.map(k => k.volume || 0);

        // Calculate indicators
        const { calculateRSI, calculateMACD, calculateBollingerBands } = require('./src/indicators');
        const rsi = calculateRSI(closes);
        const macd = calculateMACD(closes);
        const bb = calculateBollingerBands(closes);
        const atr = calculateATR(klines);

        // Create feature object for prediction
        const features = {
            priceDiff: emaDiff,
            volume24h: volumes[volumes.length - 1],
            volumeChange: volumes[volumes.length - 1] / volumes[volumes.length - 2] - 1,
            relativeVolume: volumes[volumes.length - 1] / volumes.slice(-10).reduce((sum, vol) => sum + vol, 0) * 10,
            atr: atr || 0,
            bbWidth: (bb.upper[bb.upper.length - 1] - bb.lower[bb.lower.length - 1]) / bb.middle[bb.middle.length - 1],
            rsi: rsi[rsi.length - 1],
            macdHist: macd.histogram[macd.histogram.length - 1]
        };

        // Make prediction
        const prediction = await mlModel.predictPriceChange(symbol, features);

        // Update model performance tracking
        if (prediction !== null) {
            if (!modelPerformance.has(symbol)) {
                modelPerformance.set(symbol, {
                    predictions: 1,
                    correctPredictions: 0,
                    accuracy: 0,
                    lastTraining: '',
                    dataPoints: 0
                });
            } else {
                const perf = modelPerformance.get(symbol);
                perf.predictions++;
                modelPerformance.set(symbol, perf);
            }

            // Schedule accuracy update
            deferredUpdates.push({ executeAt: Date.now() + 24 * 60 * 60 * 1000, fn: () => updateModelAccuracy(symbol, price, prediction) });
            deferredUpdates.sort((a, b) => a.executeAt - b.executeAt);
        }

        return prediction;
    } catch (error) {
        log(`Error predicting price movement for ${symbol}: ${error.message}`, 'error');
        return null;
    }
}

// Update model accuracy after 24 hours
async function updateModelAccuracy(symbol, originalPrice, prediction) {
    try {
        // Get current price
        const currentPrice = await getCurrentPrice(symbol);

        // Calculate actual price change
        const actualChange = ((currentPrice - originalPrice) / originalPrice * 100);

        // Determine if prediction was correct (same direction)
        const predictionCorrect = (prediction > 0 && actualChange > 0) || (prediction < 0 && actualChange < 0);

        // Update model performance
        if (modelPerformance.has(symbol)) {
            const perf = modelPerformance.get(symbol);
            if (predictionCorrect) {
                perf.correctPredictions++;
            }
            perf.accuracy = perf.correctPredictions / perf.predictions;
            modelPerformance.set(symbol, perf);

            log(`Updated model accuracy for ${symbol}: ${(perf.accuracy * 100).toFixed(2)}% (${perf.correctPredictions}/${perf.predictions})`, 'info');
        }

        // Save performance data
        saveTrainingData();
    } catch (error) {
        log(`Error updating model accuracy for ${symbol}: ${error.message}`, 'error');
    }
}

// Setup WebSockets for all tracked pairs
async function setupAllWebSockets() {
    try {
        const pairs = await getFuturesPairs();

        // Only log to file, not to console
        fs.appendFileSync(
            getDailyLogPath(),
            `[${new Date().toISOString()}] Setting up WebSockets for ${pairs.length} pairs\n`
        );

        // Close any existing WebSockets for pairs that are no longer tracked
        for (const [symbol, ws] of activeWebSockets.entries()) {
            if (!pairs.includes(symbol)) {
                // Only log to file, not to console
                fs.appendFileSync(
                    getDailyLogPath(),
                    `[${new Date().toISOString()}] Closing WebSocket for ${symbol} (no longer tracked)\n`
                );
                try {
                    ws.close();
                } catch (e) {
                    // Ignore errors when closing
                }
                activeWebSockets.delete(symbol);
            }
        }

        // Setup WebSockets for all tracked pairs
        for (const symbol of pairs) {
            if (!activeWebSockets.has(symbol) || activeWebSockets.get(symbol).readyState !== WebSocket.OPEN) {
                setupSymbolWebSocket(symbol);

                // Add a small delay to avoid rate limiting
                await new Promise(resolve => setTimeout(resolve, 100));
            }
        }

        // Only log to file, not to console
        fs.appendFileSync(
            getDailyLogPath(),
            `[${new Date().toISOString()}] WebSocket setup completed for ${pairs.length} pairs\n`
        );
    } catch (error) {
        // Only log to file, not to console
        fs.appendFileSync(
            getDailyLogPath(),
            `[${new Date().toISOString()}] Error setting up WebSockets: ${error.message}\n`
        );
    }
}

// Check for EMA crossovers (traditional method, still used for initial load and periodic checks)
async function checkEMACross() {
    try {
        const pairs = await getFuturesPairs();
        const timestamp = new Date().toLocaleString();

        console.log(`\n[${timestamp}] ${'Checking'.cyan} ${pairs.length.toString().yellow} ${'pairs...'.cyan}`);
        process.stdout.write('Processing: '.cyan);

        // Fetch klines for all pairs concurrently with error handling
        const klinesPromises = pairs.map(pair =>
            getKlines(pair)
                .then(klines => ({ pair, klines, error: null }))
                .catch(error => ({ pair, klines: [], error }))
        );

        const results = await Promise.all(klinesPromises);

        for (let i = 0; i < results.length; i++) {
            const { pair, klines, error } = results[i];
            process.stdout.write('.');
            if ((i + 1) % 50 === 0) process.stdout.write('\n  ');

            const requiredPeriod = DUAL_EMA_MODE ? 15 : EMA_PERIOD;
            if (error || klines.length < requiredPeriod) {
                if (klines.length < requiredPeriod) {
                    log(`Skipping ${pair}: Not enough candles (${klines.length}/${requiredPeriod})`, 'warning');
                }
                continue;
            }

            const closes = klines.map(k => k.close);

            if (DUAL_EMA_MODE) {
                // Dual EMA 9/15 crossover check
                const ema9 = calculateEMA(closes, 9);
                const ema15 = calculateEMA(closes, 15);

                if (ema9.length < 2 || ema15.length < 2) {
                    log(`Skipping ${pair}: Not enough EMA values for dual mode`, 'warning');
                    continue;
                }

                // Align arrays — EMA(9) accumulates 6 more values than EMA(15)
                const _offset = ema9.length - ema15.length;
                const a9  = _offset > 0 ? ema9.slice(_offset)  : ema9;
                const a15 = _offset < 0 ? ema15.slice(-_offset) : ema15;

                const lastEma9  = a9[a9.length - 1];
                const prevEma9  = a9[a9.length - 2];
                const lastEma15 = a15[a15.length - 1];
                const prevEma15 = a15[a15.length - 2];

                checkForDualEmaCrossover(pair, prevEma9, lastEma9, prevEma15, lastEma15, closes[closes.length - 1]);
            } else {
                // Single EMA crossover check (price vs EMA)
                const ema = calculateEMA(closes, EMA_PERIOD);

                if (ema.length < 2) {
                    log(`Skipping ${pair}: Not enough EMA values calculated`, 'warning');
                    continue;
                }

                const lastPrice = closes[closes.length - 1];
                const lastEMA = ema[ema.length - 1];
                const prevPrice = closes[closes.length - 2];
                const prevEMA = ema[ema.length - 2];

                checkForCrossover(pair, prevPrice, lastPrice, prevEMA, lastEMA);
            }
        }

        console.log('\n');
        console.log(`Check completed at ${timestamp}. WebSockets are now monitoring in real-time.`.gray);
        console.log('='.repeat(80).dim);
    } catch (error) {
        log(`Error in checkEMACross: ${error.message}`, 'error');
        console.error('Stack trace:', error.stack);
    }
}

// Save training data to disk (both JSON and CSV)
function saveTrainingData() {
    try {
        log('Saving training data...', 'info');

        // Save each symbol's data
        for (const [symbol, data] of trainingData.entries()) {
            // Save to JSON
            const symbolDir = path.join(ML_DATA_DIR, symbol);
            if (!fs.existsSync(symbolDir)) {
                fs.mkdirSync(symbolDir, { recursive: true });
            }

            // Use current month for filename
            const date = new Date();
            const filename = `${date.getFullYear()}-${(date.getMonth() + 1).toString().padStart(2, '0')}.json`;
            const filePath = path.join(symbolDir, filename);

            fs.writeFile(filePath, JSON.stringify(data, null, 2), (err) => {
                if (err) log(`Error writing training data for ${symbol}: ${err.message}`, 'error');
            });

            // Export to CSV
            exportToCSV(symbol);
        }

        // Save model performance data
        const perfPath = path.join(ML_DATA_DIR, 'model_performance.json');
        fs.writeFile(perfPath, JSON.stringify(Array.from(modelPerformance.entries()), null, 2),
            (err) => { if (err) log(`Error writing model performance data: ${err.message}`, 'error'); }
        );

        log(`Saved training data for ${trainingData.size} symbols`, 'success');
    } catch (error) {
        log(`Error saving training data: ${error.message}`, 'error');
    }
}

// Load training data from disk
function loadTrainingData() {
    try {
        log('Loading training data...', 'info');

        if (!fs.existsSync(ML_DATA_DIR)) {
            fs.mkdirSync(ML_DATA_DIR, { recursive: true });
            log('Created ML data directory', 'info');
            return;
        }

        // Get all symbol directories
        const symbols = fs.readdirSync(ML_DATA_DIR)
            .filter(item => fs.statSync(path.join(ML_DATA_DIR, item)).isDirectory());

        for (const symbol of symbols) {
            const symbolDir = path.join(ML_DATA_DIR, symbol);
            const files = fs.readdirSync(symbolDir).filter(f => f.endsWith('.json'));

            let symbolData = [];

            for (const file of files) {
                try {
                    const filePath = path.join(symbolDir, file);
                    const fileData = JSON.parse(fs.readFileSync(filePath, 'utf8'));
                    symbolData = symbolData.concat(fileData);
                } catch (error) {
                    log(`Error loading data file ${file} for ${symbol}: ${error.message}`, 'warning');
                }
            }

            if (symbolData.length > 0) {
                trainingData.set(symbol, symbolData);
                log(`Loaded ${symbolData.length} data points for ${symbol}`, 'info');
            }
        }

        // Load model performance data
        const perfPath = path.join(ML_DATA_DIR, 'model_performance.json');
        if (fs.existsSync(perfPath)) {
            try {
                const perfData = JSON.parse(fs.readFileSync(perfPath, 'utf8'));
                for (const [symbol, data] of perfData) {
                    modelPerformance.set(symbol, data);
                }
                log(`Loaded performance data for ${modelPerformance.size} models`, 'info');
            } catch (error) {
                log(`Error loading model performance data: ${error.message}`, 'warning');
            }
        }

        log(`Loaded training data for ${trainingData.size} symbols`, 'success');
    } catch (error) {
        log(`Error loading training data: ${error.message}`, 'error');
    }
}

// Function to train all models
async function trainAllModels(chatId) {
    try {
        await bot.sendMessage(chatId, '🧠 Starting model training. This may take some time...');

        // Get all symbols with sufficient data
        const symbolsToTrain = Array.from(trainingData.keys())
            .filter(symbol => {
                const data = trainingData.get(symbol);
                // Only use data points with future price change values
                const validData = data.filter(d => d.future_price_change !== null);
                return validData.length >= 100;
            });

        if (symbolsToTrain.length === 0) {
            await bot.sendMessage(chatId, '❌ No symbols have enough data for training yet.');
            return;
        }

        await bot.sendMessage(chatId, `Training models for ${symbolsToTrain.length} symbols...`);

        let trainedCount = 0;
        let failedCount = 0;

        // Train models sequentially
        for (const symbol of symbolsToTrain) {
            try {
                const { trainModelForSymbol } = require('./src/ml/model');

                // Filter data to only include points with future price change
                const allData = trainingData.get(symbol);
                const validData = allData.filter(d => d.future_price_change !== null);

                if (validData.length < 100) {
                    log(`Not enough valid data points for ${symbol}: ${validData.length}`, 'warning');
                    failedCount++;
                    continue;
                }

                const result = await trainModelForSymbol(symbol);

                if (result) {
                    trainedCount++;

                    // Update model performance tracking
                    if (!modelPerformance.has(symbol)) {
                        modelPerformance.set(symbol, {
                            predictions: 0,
                            correctPredictions: 0,
                            accuracy: 0,
                            lastTraining: new Date().toISOString(),
                            dataPoints: validData.length
                        });
                    } else {
                        const perf = modelPerformance.get(symbol);
                        perf.lastTraining = new Date().toISOString();
                        perf.dataPoints = validData.length;
                        modelPerformance.set(symbol, perf);
                    }

                    // Send progress updates every 5 models
                    if (trainedCount % 5 === 0) {
                        await bot.sendMessage(
                            chatId,
                            `Progress: ${trainedCount}/${symbolsToTrain.length} models trained`
                        );
                    }
                } else {
                    failedCount++;
                }

                // Add a small delay between training sessions
                await new Promise(resolve => setTimeout(resolve, 5000));
            } catch (error) {
                log(`Error training model for ${symbol}: ${error.message}`, 'error');
                failedCount++;
            }
        }

        // Save updated model performance data
        saveTrainingData();

        await bot.sendMessage(
            chatId,
            `🧠 *ML Training Complete*\n\n` +
            `✅ Successfully trained: ${trainedCount} models\n` +
            `❌ Failed: ${failedCount} models\n\n` +
            `Use /mlstatus to check model performance.`,
            { parse_mode: 'Markdown' }
        );
    } catch (error) {
        log(`Error in trainAllModels: ${error.message}`, 'error');
        await bot.sendMessage(chatId, `❌ Error training models: ${error.message}`);
    }
}

// Enhanced Telegram alert with ML confidence
async function sendTelegramAlertWithML(symbol, crossType, price, ema, difference, prediction) {
    try {
        const emoji = crossType === 'up' ? '🟢' : '🔴';
        const signal = crossType === 'up' ? 'BULLISH SIGNAL' : 'BEARISH SIGNAL';
        const formattedPrice = formatPrice(price);
        const formattedEma = formatPrice(ema);

        // Get 24hr stats for the symbol
        const stats = await get24HrStats(symbol);

        // Format ML prediction with confidence emoji
        let confidenceEmoji = '⚠️'; // Neutral/uncertain
        if (Math.abs(prediction) > 3) {
            confidenceEmoji = prediction > 0 ? '🔥' : '❄️'; // Strong signal
        } else if (Math.abs(prediction) > 1) {
            confidenceEmoji = prediction > 0 ? '📈' : '📉'; // Moderate signal
        }

        // Create a TradingView link
        const tradingViewUrl = getTradingViewUrl(symbol);

        const message = `${emoji} *${signal}* ${emoji}\n\n` +
            `*Symbol:* ${symbol}\n` +
            `*Price:* ${formattedPrice}\n` +
            `*EMA(${EMA_PERIOD}):* ${formattedEma}\n` +
            `*Difference:* ${difference.toFixed(2)}%\n` +
            `*24h Change:* ${stats.priceChangePercent}%\n` +
            `*24h Volume:* ${formatVolume(stats.quoteVolume)}\n` +
            `*Timeframe:* ${TIMEFRAME}\n` +
            `*ML Prediction:* ${confidenceEmoji} ${prediction.toFixed(2)}% (24h)\n\n` +
            `*Time:* ${new Date().toLocaleString()}\n\n` +
            `[View Chart on TradingView](${tradingViewUrl})`;

        await safeSendAlert(TELEGRAM_CHAT_ID, message, {
            parse_mode: 'Markdown',
            disable_web_page_preview: false
        });

        // Show desktop notification — mirrors Telegram message content
        // Clicking the toast opens the TradingView chart in the browser
        showDesktopNotification(
            `${crossType === 'up' ? '🟢 BULLISH+ML' : '🔴 BEARISH+ML'} — ${symbol}`,
            `Price: ${formattedPrice}  EMA(${EMA_PERIOD}): ${formattedEma}\nDiff: ${difference.toFixed(2)}%  ML: ${confidenceEmoji} ${prediction.toFixed(2)}% (24h)\n24h: ${stats.priceChangePercent}%  TF: ${TIMEFRAME}`,
            crossType === 'up' ? 'info' : 'warning',
            tradingViewUrl
        );

        log(`ML-enhanced Telegram alert sent for ${symbol} (${crossType})`, 'success');
    } catch (error) {
        log(`Error sending ML-enhanced Telegram message: ${error.message}`, 'error');

        // Fall back to regular alert
        sendTelegramAlert(symbol, crossType, price, ema, difference);
    }
}

// Command handler
function handleMessage(msg) {
    const chatId = msg.chat.id;

    // Authorization: only the configured owner may control this bot
    if (String(chatId) !== String(TELEGRAM_CHAT_ID)) {
        bot.sendMessage(chatId, '⛔ Unauthorized.').catch(() => {});
        log(`Unauthorized access attempt from chatId ${chatId}`, 'warning');
        return;
    }

    if (msg.text === '/start' || msg.text === '/menu') {
        sendMainMenu(chatId);
    } else if (msg.text === '/status') {
        sendStatusUpdate(chatId);
    } else if (msg.text === '/settings') {
        sendSettingsMenu(chatId);
    } else if (msg.text === '/help') {
        sendHelpMessage(chatId);
    } else if (msg.text === '/top') {
        sendTopPerformers(chatId);
    } else if (msg.text === '/refresh') {
        refreshWebSockets(chatId);
    } else if (msg.text === '/mlstatus') {
        sendModelPerformance(chatId);
    } else if (msg.text === '/train') {
        trainAllModels(chatId);
    } else if (msg.text === '/collectdata') {
        startManualDataCollection(chatId);
    } else if (msg.text === '/exportcsv') {
        exportAllDataToCSV();
        bot.sendMessage(chatId, '📊 All training data exported to CSV format successfully!');
    }
}

// Function to manually collect data for all tracked pairs
async function startManualDataCollection(chatId) {
    try {
        await bot.sendMessage(chatId, '📊 Starting manual data collection for all tracked pairs...');

        const pairs = await getFuturesPairs();
        if (pairs.length === 0) {
            await bot.sendMessage(chatId, '❌ No pairs are currently being tracked.');
            return;
        }

        await bot.sendMessage(chatId, `Collecting data for ${pairs.length} pairs...`);

        let successCount = 0;
        let failedCount = 0;

        for (const symbol of pairs) {
            try {
                // Get historical klines
                const klines = await getKlines(symbol);
                if (klines.length < 30) {
                    log(`Skipping ${symbol}: Not enough candles`, 'warning');
                    failedCount++;
                    continue;
                }

                // Process each candle
                for (let i = 0; i < klines.length; i++) {
                    // Skip very old candles
                    if (i < klines.length - 100) continue;

                    const candle = klines[i];

                    // Create kline object in the format expected by processClosedCandle
                    const klineObj = {
                        t: candle.time,
                        o: candle.open.toString(),
                        h: candle.high.toString(),
                        l: candle.low.toString(),
                        c: candle.close.toString(),
                        v: candle.volume.toString()
                    };

                    // Process this candle
                    await processClosedCandle(symbol, klineObj);
                }

                successCount++;

                // Send progress updates
                if ((successCount + failedCount) % 10 === 0) {
                    await bot.sendMessage(
                        chatId,
                        `Progress: ${successCount + failedCount}/${pairs.length} pairs processed`
                    );
                }

                // Add a small delay to avoid rate limiting
                await new Promise(resolve => setTimeout(resolve, 500));
            } catch (error) {
                log(`Error collecting data for ${symbol}: ${error.message}`, 'error');
                failedCount++;
            }
        }

        // Save all collected data
        saveTrainingData();

        // Export to CSV
        exportAllDataToCSV();

        // Send completion message
        await bot.sendMessage(
            chatId,
            `📊 *Data Collection Complete*\n\n` +
            `✅ Successfully collected data for ${successCount} pairs\n` +
            `❌ Failed: ${failedCount} pairs\n\n` +
            `Future price changes will be updated in 24 hours.\n` +
            `Data has been exported to CSV format for easier analysis.`,
            { parse_mode: 'Markdown' }
        );
    } catch (error) {
        log(`Error in manual data collection: ${error.message}`, 'error');
        await bot.sendMessage(chatId, `❌ Error during data collection: ${error.message}`);
    }
}

// Graceful WebSocket reconnect — closes all connections, waits 30 s, then reconnects
// with whatever settings (TIMEFRAME, EMA_PERIOD, VOLUME_THRESHOLD) are currently active.
// Uses isReconnecting to prevent concurrent reconnects.
async function refreshWebSockets(chatId) {
    if (isReconnecting) {
        if (chatId) await bot.sendMessage(chatId, '⚠️ A reconnection is already in progress. Please wait for it to finish.').catch(() => {});
        return;
    }
    isReconnecting = true;
    try {
        log('Graceful reconnect started — closing all WebSocket streams...', 'info');
        if (chatId) await bot.sendMessage(chatId, '⏳ *Disconnecting all WebSocket streams...*', { parse_mode: 'Markdown' }).catch(() => {});

        // Terminate every active connection
        for (const [, ws] of activeWebSockets.entries()) {
            try { ws.close(); } catch (e) { /* ignore */ }
        }
        activeWebSockets.clear();
        reconnectionAttempts.clear();

        log('All WebSockets closed. Waiting 10 s before reconnecting...', 'info');
        if (chatId) await bot.sendMessage(chatId, '⏳ Waiting 10 seconds before reconnecting...').catch(() => {});

        await new Promise(resolve => setTimeout(resolve, 10000));

        log('Reconnecting WebSockets with current settings...', 'info');
        await setupAllWebSockets();

        if (chatId) await bot.sendMessage(chatId, '✅ *WebSocket connections re-established!*', { parse_mode: 'Markdown' }).catch(() => {});
        log('Graceful reconnect complete.', 'success');
    } catch (error) {
        log(`Error during graceful reconnect: ${error.message}`, 'error');
        if (chatId) await bot.sendMessage(chatId, `❌ Reconnect error: ${error.message}`).catch(() => {});
    } finally {
        isReconnecting = false;
    }
}

// Callback query handler for inline buttons
async function handleCallbackQuery(callbackQuery) {
    const action = callbackQuery.data;
    const chatId = callbackQuery.message.chat.id;

    // Authorization: silently reject callbacks from anyone other than the owner
    if (String(chatId) !== String(TELEGRAM_CHAT_ID)) {
        await bot.answerCallbackQuery(callbackQuery.id, { text: '⛔ Unauthorized.' }).catch(() => {});
        log(`Unauthorized callback attempt from chatId ${chatId}`, 'warning');
        return;
    }

    try {
        if (action === 'status') {
            await sendStatusUpdate(chatId);
        } else if (action === 'settings') {
            await sendSettingsMenu(chatId);
        } else if (action === 'top_gainers') {
            await sendTopPerformers(chatId, 'gainers');
        } else if (action === 'top_losers') {
            await sendTopPerformers(chatId, 'losers');
        } else if (action === 'top_volume') {
            await sendTopPerformers(chatId, 'volume');
        } else if (action === 'menu') {
            await sendMainMenu(chatId);
        } else if (action === 'help') {
            await sendHelpMessage(chatId);
        } else if (action === 'refresh_ws') {
            refreshWebSockets(chatId); // runs in background, sends its own progress messages
        } else if (action === 'export_csv') {
            exportAllDataToCSV();
            await bot.sendMessage(chatId, '📊 All training data exported to CSV format successfully!');
        } else if (action.startsWith('timeframe_')) {
            const newTimeframe = action.replace('timeframe_', '');
            if (!VALID_TIMEFRAMES.includes(newTimeframe)) {
                await bot.answerCallbackQuery(callbackQuery.id, { text: '⛔ Invalid timeframe.' });
                return;
            }
            TIMEFRAME = newTimeframe;
            log(`Timeframe updated to ${newTimeframe}`, 'success');
            saveSettings();
            await sendSettingsMenu(chatId); // show updated menu immediately
            refreshWebSockets(chatId);      // reconnect in background — sends its own progress msgs
        } else if (action.startsWith('ema_')) {
            const newEma = parseInt(action.replace('ema_', ''), 10);
            EMA_PERIOD = newEma;
            DUAL_EMA_MODE = false;
            log(`EMA period updated to ${newEma}, dual mode disabled`, 'success');
            saveSettings();
            ema9Cache.clear();
            ema15Cache.clear();
            emaCache.clear();
            coinStates.clear();
            await sendSettingsMenu(chatId); // show updated menu immediately
            refreshWebSockets(chatId);      // reconnect in background — sends its own progress msgs
        } else if (action === 'toggle_dual_ema') {
            DUAL_EMA_MODE = !DUAL_EMA_MODE;
            log(`Dual EMA 9/15 mode ${DUAL_EMA_MODE ? 'enabled' : 'disabled'}`, 'success');
            saveSettings();
            emaCache.clear();
            ema9Cache.clear();
            ema15Cache.clear();
            coinStates.clear();
            await bot.sendMessage(
                chatId,
                DUAL_EMA_MODE
                    ? '✅ *EMA 9/15 Crossover Mode Enabled*\nAlerts will fire when EMA(9) crosses EMA(15). Single EMA settings are ignored.'
                    : `✅ *EMA 9/15 Mode Disabled*\nReverted to Price vs EMA(${EMA_PERIOD}) crossover mode.`,
                { parse_mode: 'Markdown' }
            );
            await sendSettingsMenu(chatId); // show updated menu immediately
            refreshWebSockets(chatId);      // reconnect in background — sends its own progress msgs
        } else if (action.startsWith('volume_')) {
            const newVolume = parseInt(action.replace('volume_', ''), 10);
            if (!VALID_VOLUMES.includes(newVolume)) {
                await bot.answerCallbackQuery(callbackQuery.id, { text: '⛔ Invalid volume threshold.' });
                return;
            }
            VOLUME_THRESHOLD = newVolume;
            log(`Volume threshold updated to ${newVolume}`, 'success');
            saveSettings();
            await sendSettingsMenu(chatId); // show updated menu immediately
            refreshWebSockets(chatId);      // reconnect in background — re-fetches pairs with new threshold
        } else if (action === 'ml_status') {
            await sendModelPerformance(chatId);
        } else if (action === 'train_models') {
            await trainAllModels(chatId);
        } else if (action === 'toggle_ml') {
            ML_ENABLED = !ML_ENABLED;
            saveSettings();
            await bot.sendMessage(
                chatId,
                `🧠 Machine Learning is now ${ML_ENABLED ? 'enabled' : 'disabled'}`
            );
            await sendSettingsMenu(chatId);
        }

        // Answer callback query to remove loading state
        await bot.answerCallbackQuery(callbackQuery.id);
    } catch (error) {
        log(`Error handling callback query: ${error.message}`, 'error');
        await bot.answerCallbackQuery(callbackQuery.id, { text: 'An error occurred' });
    }
}

// Add this function to save settings to a file
function saveSettings() {
    try {
        const settings = {
            EMA_PERIOD,
            TIMEFRAME,
            VOLUME_THRESHOLD,
            CHECK_INTERVAL,
            ALERT_COOLDOWN,
            ML_ENABLED,
            DUAL_EMA_MODE
        };

        fs.writeFile(
            path.join(__dirname, 'settings.json'),
            JSON.stringify(settings, null, 2),
            (err) => { if (err) log(`Error writing settings file: ${err.message}`, 'error'); }
        );
        log('Settings saved to file', 'success');
    } catch (error) {
        log(`Error saving settings: ${error.message}`, 'error');
    }
}

// Add this function to load settings from file
function loadSettings() {
    try {
        const settingsPath = path.join(__dirname, 'settings.json');
        if (fs.existsSync(settingsPath)) {
            const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));

            // Update variables with saved settings (whitelist-validated to prevent corrupted settings file)
            if (VALID_EMA_PERIODS.includes(settings.EMA_PERIOD)) EMA_PERIOD = settings.EMA_PERIOD;
            if (VALID_TIMEFRAMES.includes(settings.TIMEFRAME)) TIMEFRAME = settings.TIMEFRAME;
            if (VALID_VOLUMES.includes(settings.VOLUME_THRESHOLD)) VOLUME_THRESHOLD = settings.VOLUME_THRESHOLD;
            ML_ENABLED = settings.ML_ENABLED !== undefined ? settings.ML_ENABLED : ML_ENABLED;
            DUAL_EMA_MODE = settings.DUAL_EMA_MODE !== undefined ? settings.DUAL_EMA_MODE : DUAL_EMA_MODE;

            log('Settings loaded from file', 'success');
        }
    } catch (error) {
        log(`Error loading settings: ${error.message}`, 'error');
    }
}

// Send main menu with ML options
async function sendMainMenu(chatId) {
    const keyboard = {
        inline_keyboard: [
            [{ text: '📊 Status', callback_data: 'status' }],
            [{ text: '⚙️ Settings', callback_data: 'settings' }],
            [
                { text: '📈 Top Gainers', callback_data: 'top_gainers' },
                { text: '📉 Top Losers', callback_data: 'top_losers' }
            ],
            [{ text: '💰 Highest Volume', callback_data: 'top_volume' }],
            [{ text: '🔄 Refresh WebSockets', callback_data: 'refresh_ws' }],
            [
                { text: '🧠 ML Status', callback_data: 'ml_status' },
                { text: '🔬 Train Models', callback_data: 'train_models' }
            ],
            [
                { text: '📊 Export CSV', callback_data: 'export_csv' },
                { text: '❓ Help', callback_data: 'help' }
            ]
        ]
    };

    await bot.sendMessage(chatId, '*EMA Tracker Bot Menu*\nSelect an option:', {
        parse_mode: 'Markdown',
        reply_markup: keyboard
    });
}

// Send status update
async function sendStatusUpdate(chatId) {
    try {
        const pairs = await getFuturesPairs();
        const activeWsCount = Array.from(activeWebSockets.values())
            .filter(ws => ws.readyState === WebSocket.OPEN).length;

        const message = `*EMA Tracker Status*\n\n` +
            `*Active Configuration:*\n` +
            `- EMA Mode: ${DUAL_EMA_MODE ? 'EMA 9/15 Crossover' : 'Price vs EMA(' + EMA_PERIOD + ')'}\n` +
            `- Timeframe: ${TIMEFRAME}\n` +
            `- Volume Threshold: ${VOLUME_THRESHOLD.toLocaleString()}\n` +
            `- Monitoring: ${pairs.length} pairs\n` +
            `- Active WebSockets: ${activeWsCount}/${pairs.length}\n` +
            `- Machine Learning: ${ML_ENABLED ? 'Enabled ✅' : 'Disabled ❌'}\n` +
            `- Last Check: ${new Date().toLocaleString()}\n\n` +
            `Bot is actively monitoring for ${DUAL_EMA_MODE ? 'EMA 9/15' : 'EMA'} crossovers in real-time.`;

        await bot.sendMessage(chatId, message, {
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [
                    [{ text: '🔄 Refresh WebSockets', callback_data: 'refresh_ws' }],
                    [{ text: '🔙 Back to Menu', callback_data: 'menu' }]
                ]
            }
        });
    } catch (error) {
        log(`Error sending status update: ${error.message}`, 'error');
        await bot.sendMessage(chatId, '❌ Error fetching status');
    }
}

// Send settings menu with ML toggle and dual EMA option
async function sendSettingsMenu(chatId) {
    // Build the EMA mode display string
    const emaModeText = DUAL_EMA_MODE ? 'EMA 9/15 Cross' : `EMA ${EMA_PERIOD}`;

    const keyboard = {
        inline_keyboard: [
            [
                { text: '1m', callback_data: 'timeframe_1m' },
                { text: '5m', callback_data: 'timeframe_5m' },
                { text: '15m', callback_data: 'timeframe_15m' },
                { text: '1h', callback_data: 'timeframe_1h' },
                { text: '4h', callback_data: 'timeframe_4h' }
            ],
            [
                { text: 'EMA 50', callback_data: 'ema_50' },
                { text: 'EMA 100', callback_data: 'ema_100' },
                { text: 'EMA 200', callback_data: 'ema_200' }
            ],
            [
                { text: `EMA 9/15 Cross: ${DUAL_EMA_MODE ? 'Enabled ✅' : 'Disabled ❌'}`, callback_data: 'toggle_dual_ema' }
            ],
            [
                { text: 'Vol 50M', callback_data: 'volume_50000000' },
                { text: 'Vol 100M', callback_data: 'volume_100000000' },
                { text: 'Vol 200M', callback_data: 'volume_200000000' }
            ],
            [
                { text: `ML: ${ML_ENABLED ? 'Enabled ✅' : 'Disabled ❌'}`, callback_data: 'toggle_ml' }
            ],
            [{ text: '🔙 Back to Menu', callback_data: 'menu' }]
        ]
    };

    const configText = DUAL_EMA_MODE
        ? `*Settings*\n\nCurrent Configuration:\n- EMA Mode: 9/15 Crossover ✅\n- Timeframe: ${TIMEFRAME}\n- Volume Threshold: ${formatVolume(VOLUME_THRESHOLD)}\n- Machine Learning: ${ML_ENABLED ? 'Enabled ✅' : 'Disabled ❌'}\n\n_When EMA 9/15 is active, single EMA settings (50/100/200) are ignored._\n\nSelect a new setting:`
        : `*Settings*\n\nCurrent Configuration:\n- EMA: ${EMA_PERIOD}\n- Timeframe: ${TIMEFRAME}\n- Volume Threshold: ${formatVolume(VOLUME_THRESHOLD)}\n- Machine Learning: ${ML_ENABLED ? 'Enabled ✅' : 'Disabled ❌'}\n\nSelect a new setting:`;

    await bot.sendMessage(chatId, configText, {
        parse_mode: 'Markdown',
        reply_markup: keyboard
    });
}

// Send help message
async function sendHelpMessage(chatId) {
    const helpText = `*EMA Tracker Bot Help*\n\n` +
        `This bot monitors Binance Futures markets for EMA crossovers and sends alerts when they occur.\n\n` +
        `*Available Commands:*\n` +
        `/menu - Show the main menu\n` +
        `/status - Check bot status\n` +
        `/settings - Configure bot settings\n` +
        `/top - View top performing coins\n` +
        `/refresh - Refresh WebSocket connections\n` +
        `/mlstatus - Check ML model performance\n` +
        `/train - Train ML models manually\n` +
        `/collectdata - Manually collect training data\n` +
        `/exportcsv - Export data to CSV format\n` +
        `/help - Show this help message\n\n` +
        `*How It Works:*\n` +
        `The bot uses WebSockets to track price movements in real-time.\n\n` +
        `*Price vs EMA Mode:* Detects when price crosses above or below a single EMA (50/100/200) on the ${TIMEFRAME} timeframe.\n\n` +
        `*EMA 9/15 Cross Mode:* Detects when EMA(9) crosses above or below EMA(15) — a short-term momentum strategy. Toggle it in Settings.\n\n` +
        `*Machine Learning:*\n` +
        `When enabled, ML models predict future price movements after crossovers to enhance signal quality.`;

    await bot.sendMessage(chatId, helpText, {
        parse_mode: 'Markdown',
        reply_markup: {
            inline_keyboard: [[{ text: '🔙 Back to Menu', callback_data: 'menu' }]]
        }
    });
}

// Send top performers (gainers, losers, or by volume)
async function sendTopPerformers(chatId, type = 'gainers') {
    try {
        await bot.sendMessage(chatId, '⏳ Fetching data...');

        await enforceRateLimit();
        const response = await axios.get('https://fapi.binance.com/fapi/v1/ticker/24hr', { timeout: 10000 });
        let coins = response.data.filter(coin => coin.symbol.endsWith('USDT'));

        // Sort based on type
        if (type === 'gainers') {
            coins.sort((a, b) => parseFloat(b.priceChangePercent) - parseFloat(a.priceChangePercent));
            coins = coins.slice(0, 10); // Top 10 gainers
        } else if (type === 'losers') {
            coins.sort((a, b) => parseFloat(a.priceChangePercent) - parseFloat(b.priceChangePercent));
            coins = coins.slice(0, 10); // Top 10 losers
        } else if (type === 'volume') {
            coins.sort((a, b) => parseFloat(b.quoteVolume) - parseFloat(a.quoteVolume));
            coins = coins.slice(0, 10); // Top 10 by volume
        }

        let title;
        if (type === 'gainers') title = '📈 *Top Gainers (24h)*';
        else if (type === 'losers') title = '📉 *Top Losers (24h)*';
        else title = '💰 *Highest Volume (24h)*';

        let message = `${title}\n\n`;

        coins.forEach((coin, index) => {
            const symbol = coin.symbol;
            const price = formatPrice(parseFloat(coin.lastPrice));
            const change = parseFloat(coin.priceChangePercent).toFixed(2);
            const volume = formatVolume(parseFloat(coin.quoteVolume));

            const changeEmoji = parseFloat(change) >= 0 ? '🟢' : '🔴';
            message += `${index + 1}. ${symbol}: ${price} (${changeEmoji} ${change}%) - Vol: ${volume}\n`;
        });

        await bot.sendMessage(chatId, message, {
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [
                    [
                        { text: '📈 Gainers', callback_data: 'top_gainers' },
                        { text: '📉 Losers', callback_data: 'top_losers' },
                        { text: '💰 Volume', callback_data: 'top_volume' }
                    ],
                    [{ text: '🔙 Back to Menu', callback_data: 'menu' }]
                ]
            }
        });
    } catch (error) {
        log(`Error fetching top performers: ${error.message}`, 'error');
        await bot.sendMessage(chatId, '❌ Error fetching data');
    }
}

// Add a command to check model performance
async function sendModelPerformance(chatId) {
    try {
        if (modelPerformance.size === 0) {
            await bot.sendMessage(chatId, '❌ No model performance data available yet.');
            return;
        }

        let message = '*ML Model Performance*\n\n';

        // Sort symbols by accuracy
        const sortedSymbols = Array.from(modelPerformance.keys())
            .sort((a, b) => {
                const aMetrics = modelPerformance.get(a);
                const bMetrics = modelPerformance.get(b);
                return (bMetrics.accuracy || 0) - (aMetrics.accuracy || 0);
            })
            .slice(0, 10); // Top 10 performing models

        for (const symbol of sortedSymbols) {
            const metrics = modelPerformance.get(symbol);
            if (!metrics || metrics.predictions < 10) continue; // Skip models with few predictions

            message += `*${symbol}*\n` +
                `- Overall Accuracy: ${((metrics.accuracy || 0) * 100).toFixed(2)}%\n` +
                `- Total Predictions: ${metrics.predictions || 0}\n` +
                `- Data Points: ${metrics.dataPoints || 0}\n` +
                `- Last Trained: ${metrics.lastTraining ? new Date(metrics.lastTraining).toLocaleString() : 'Unknown'}\n\n`;
        }

        // Add summary statistics
        const totalModels = modelPerformance.size;
        const totalPredictions = Array.from(modelPerformance.values())
            .reduce((sum, metrics) => sum + (metrics.predictions || 0), 0);
        const avgAccuracy = Array.from(modelPerformance.values())
            .filter(metrics => metrics.predictions >= 10)
            .reduce((sum, metrics) => sum + (metrics.accuracy || 0), 0) /
            Array.from(modelPerformance.values()).filter(metrics => metrics.predictions >= 10).length;

        message += `*Summary Statistics*\n` +
            `- Total Models: ${totalModels}\n` +
            `- Total Predictions: ${totalPredictions}\n` +
            `- Average Accuracy: ${(avgAccuracy * 100).toFixed(2)}%\n\n` +
            `Use /train to train all models or /collectdata to gather more training data.`;

        await bot.sendMessage(chatId, message, {
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [
                    [
                        { text: '🧠 Train Models', callback_data: 'train_models' },
                        { text: '📊 Export Data', callback_data: 'export_csv' }
                    ],
                    [{ text: '🔙 Back to Menu', callback_data: 'menu' }]
                ]
            }
        });
    } catch (error) {
        log(`Error sending model performance: ${error.message}`, 'error');
        await bot.sendMessage(chatId, '❌ Error fetching model performance data');
    }
}

// Send initial startup message to Telegram
async function sendStartupMessage() {
    try {
        const message = `🤖 *EMA Tracker Bot Started* 🤖\n\n` +
            `*Configuration:*\n` +
            `- EMA Mode: ${DUAL_EMA_MODE ? 'EMA 9/15 Crossover' : 'Price vs EMA(' + EMA_PERIOD + ')'}\n` +
            `- Timeframe: ${TIMEFRAME}\n` +
            `- Volume Threshold: ${VOLUME_THRESHOLD.toLocaleString()}\n` +
            `- Check Interval: ${(CHECK_INTERVAL / 60000).toFixed(1)} minutes\n` +
            `- Alert Cooldown: ${(ALERT_COOLDOWN / 60000).toFixed(1)} minutes\n` +
            `- WebSocket Monitoring: Enabled\n` +
            `- ML Enhancement: ${ML_ENABLED ? 'Enabled' : 'Disabled'}\n\n` +
            `Bot is now monitoring for ${DUAL_EMA_MODE ? 'EMA 9/15' : 'EMA'} crossovers in real-time${ML_ENABLED ? ' with ML predictions' : ''}...`;

        await bot.sendMessage(TELEGRAM_CHAT_ID, message, { parse_mode: 'Markdown' });
        log('Startup message sent to Telegram', 'success');

        // Show desktop notification — mirrors startup message content
        showDesktopNotification(
            '🤖 EMA Tracker Started',
            `Mode: ${DUAL_EMA_MODE ? 'EMA 9/15 Crossover' : 'Price vs EMA(' + EMA_PERIOD + ')'}\nTimeframe: ${TIMEFRAME}  Vol: ${formatVolume(VOLUME_THRESHOLD)}\nML: ${ML_ENABLED ? 'Enabled' : 'Disabled'}`,
            'info'
        );

        // Send the menu after startup message
        await sendMainMenu(TELEGRAM_CHAT_ID);
    } catch (error) {
        log(`Error sending startup message: ${error.message}`, 'error');
    }
}

// WebSocket heartbeat function to keep connections alive
function startWebSocketHeartbeat() {
    // Check WebSocket connections every minute
    setInterval(() => {
        // Don't interfere while a graceful reconnect is in progress
        if (isReconnecting) return;
        try {
            let reconnected = 0;

            for (const [symbol, ws] of activeWebSockets.entries()) {
                // If WebSocket is closed or closing, reconnect
                if (ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) {
                    // Only log to file, not to console
                    fs.appendFileSync(
                        getDailyLogPath(),
                        `[${new Date().toISOString()}] WebSocket for ${symbol} is closed or closing. Reconnecting...\n`
                    );
                    setupSymbolWebSocket(symbol);
                    reconnected++;
                }
            }

            if (reconnected > 0) {
                // Only log to file, not to console
                fs.appendFileSync(
                    getDailyLogPath(),
                    `[${new Date().toISOString()}] Reconnected ${reconnected} WebSocket connections during heartbeat check\n`
                );
            }
        } catch (error) {
            // Only log to file, not to console
            fs.appendFileSync(
                getDailyLogPath(),
                `[${new Date().toISOString()}] Error in WebSocket heartbeat: ${error.message}\n`
            );
        }
    }, 60000); // Check every minute
}

// Schedule periodic model training
function scheduleModelTraining() {
    // Train models every 12 hours
    setInterval(async () => {
        if (!ML_ENABLED) {
            log('Scheduled model training skipped - ML is disabled', 'info');
            return;
        }

        log('Starting scheduled model training...', 'info');

        try {
            // Get all symbols with sufficient data
            const symbolsToTrain = Array.from(trainingData.keys())
                .filter(symbol => {
                    const data = trainingData.get(symbol);
                    // Only use data points with future price change values
                    const validData = data.filter(d => d.future_price_change !== null);
                    return validData.length >= 100;
                });

            if (symbolsToTrain.length === 0) {
                log('No symbols have enough data for training yet.', 'warning');
                return;
            }

            log(`Training models for ${symbolsToTrain.length} symbols`, 'info');

            let trainedCount = 0;
            let failedCount = 0;

            // Train models sequentially to avoid memory issues
            for (const symbol of symbolsToTrain) {
                try {
                    const { trainModelForSymbol } = require('./src/ml/model');

                    // Filter data to only include points with future price change
                    const allData = trainingData.get(symbol);
                    const validData = allData.filter(d => d.future_price_change !== null);

                    if (validData.length < 100) {
                        log(`Not enough valid data points for ${symbol}: ${validData.length}`, 'warning');
                        failedCount++;
                        continue;
                    }

                    const result = await trainModelForSymbol(symbol);

                    if (result) {
                        trainedCount++;

                        // Update model performance tracking
                        if (!modelPerformance.has(symbol)) {
                            modelPerformance.set(symbol, {
                                predictions: 0,
                                correctPredictions: 0,
                                accuracy: 0,
                                lastTraining: new Date().toISOString(),
                                dataPoints: validData.length
                            });
                        } else {
                            const perf = modelPerformance.get(symbol);
                            perf.lastTraining = new Date().toISOString();
                            perf.dataPoints = validData.length;
                            modelPerformance.set(symbol, perf);
                        }
                    } else {
                        failedCount++;
                    }

                    // Add a small delay between training sessions
                    await new Promise(resolve => setTimeout(resolve, 5000));
                } catch (error) {
                    log(`Error training model for ${symbol}: ${error.message}`, 'error');
                    failedCount++;
                }
            }

            // Save updated model performance data
            saveTrainingData();

            log(`Scheduled training completed. Trained ${trainedCount}/${symbolsToTrain.length} models.`, 'success');

            // Send notification about training completion
            if (trainedCount > 0) {
                await bot.sendMessage(
                    TELEGRAM_CHAT_ID,
                    `🧠 *ML Model Training Completed*\n\n` +
                    `Successfully trained ${trainedCount} models.\n` +
                    `These models will now be used to enhance crossover alerts with price predictions.`,
                    { parse_mode: 'Markdown' }
                );
            }
        } catch (error) {
            log(`Error in scheduled model training: ${error.message}`, 'error');
        }
    }, 12 * 60 * 60 * 1000); // 12 hours
}

// Set up message and callback query handlers
bot.on('message', handleMessage);
bot.on('callback_query', handleCallbackQuery);

// Handle process termination gracefully
async function gracefulShutdown(signal) {
    try {
        log(`Received ${signal}. Shutting down gracefully...`, 'warning');
        // Close all WebSocket connections
        for (const [symbol, ws] of activeWebSockets.entries()) {
                try {
                    ws.close();
                    log(`Closed WebSocket for ${symbol}`, 'info');
                } catch (e) {
                    // Ignore errors when closing
                }
            }

        await bot.sendMessage(TELEGRAM_CHAT_ID, '⚠️ EMA Tracker Bot is shutting down...');

        // Show desktop notification
        showDesktopNotification(
            'EMA Tracker Shutting Down',
            'The bot is shutting down gracefully',
            'warning'
        );

        process.exit(0);
    } catch (error) {
        log(`Error during shutdown: ${error.message}`, 'error');
        process.exit(1);
    }
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

// Error handling for unhandled rejections
process.on('unhandledRejection', (reason, promise) => {
    log(`Unhandled Rejection at: ${promise}, reason: ${reason}`, 'error');

    // Show desktop notification for unhandled rejection
    showDesktopNotification(
        'Error in EMA Tracker',
        'An unhandled rejection occurred. Check logs for details.',
        'error'
    );
});


// // installRequiredPackages — COMMENTED OUT: not needed, packages are installed via npm
// async function installRequiredPackages() { ... }

// Calculate ATR (Average True Range) using Wilder's smoothing
function calculateATR(klines, period = 14) {
    if (klines.length < period + 1) {
        return null;
    }

    const trueRanges = [];

    // Calculate True Range for each candle
    for (let i = 1; i < klines.length; i++) {
        const high = klines[i].high;
        const low = klines[i].low;
        const prevClose = klines[i - 1].close;

        // True Range is the greatest of:
        // 1. Current High - Current Low
        // 2. |Current High - Previous Close|
        // 3. |Current Low - Previous Close|
        const tr1 = high - low;
        const tr2 = Math.abs(high - prevClose);
        const tr3 = Math.abs(low - prevClose);

        const trueRange = Math.max(tr1, tr2, tr3);
        trueRanges.push(trueRange);
    }

    // Wilder's smoothed ATR: seed with SMA of first `period` TRs, then smooth
    let atr = trueRanges.slice(0, period).reduce((sum, tr) => sum + tr, 0) / period;
    for (let i = period; i < trueRanges.length; i++) {
        atr = (atr * (period - 1) + trueRanges[i]) / period;
    }

    return atr;
}

// Remove log files older than 7 days to prevent unbounded disk growth
function rotateLogs() {
    try {
        const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
        if (!fs.existsSync(LOG_DIR)) return;
        const files = fs.readdirSync(LOG_DIR).filter(f => f.endsWith('.log'));
        for (const file of files) {
            const filePath = path.join(LOG_DIR, file);
            const stats = fs.statSync(filePath);
            if (stats.mtimeMs < sevenDaysAgo) {
                fs.unlinkSync(filePath);
                log(`Rotated old log file: ${file}`, 'info');
            }
        }
    } catch (error) {
        log(`Error rotating logs: ${error.message}`, 'error');
    }
}

// Initialize the terminal and start monitoring
async function initialize() {
    try {
        // Initialize terminal and load settings
        initializeTerminal();
        loadSettings();
        loadAlertState(); // restore last-alert timestamps so restarts don't re-fire crossovers
        rotateLogs();

        // Register toast app so click-to-open works on Windows
        registerToastApp();

        console.log('\nStarting initial check...'.green);

        // Initialize ML components
        console.log('Initializing machine learning components...'.cyan);

        // Create models directory if it doesn't exist
        const modelsDir = path.join(__dirname, 'models');
        if (!fs.existsSync(modelsDir)) {
            fs.mkdirSync(modelsDir);
        }

        // Create ML data directory if it doesn't exist
        if (!fs.existsSync(ML_DATA_DIR)) {
            fs.mkdirSync(ML_DATA_DIR, { recursive: true });
        }

        // Check if TensorFlow.js is available
        ML_ENABLED = checkTensorFlowAvailability() && ML_ENABLED;

        // Load ML training data if ML is enabled
        if (ML_ENABLED) {
            loadTrainingData();
        }

        // Send startup message
        await sendStartupMessage();

        // Do initial check to populate data
        await checkEMACross();

        // Setup WebSockets for all tracked pairs
        await setupAllWebSockets();

        // Start WebSocket heartbeat
        startWebSocketHeartbeat();

        // Periodically reset reconnection counters for maxed-out symbols and re-attempt
        setInterval(() => {
            for (const [symbol, attempts] of reconnectionAttempts.entries()) {
                if (attempts >= MAX_RECONNECTION_ATTEMPTS && trackedPairs.has(symbol) && !activeWebSockets.has(symbol)) {
                    log(`Resetting reconnection counter for ${symbol} and re-attempting...`, 'info');
                    reconnectionAttempts.set(symbol, 0);
                    setupSymbolWebSocket(symbol);
                }
            }
        }, 5 * 60 * 1000); // every 5 minutes

        // Schedule model training if ML is enabled
        if (ML_ENABLED) {
            scheduleModelTraining();
        }

        // Schedule periodic saving of training data
        setInterval(saveTrainingData, 30 * 60 * 1000); // Save every 30 minutes

        // Process deferred updates (replaces unbounded 24h setTimeout timers)
        setInterval(async () => {
            const now = Date.now();
            while (deferredUpdates.length > 0 && deferredUpdates[0].executeAt <= now) {
                const task = deferredUpdates.shift();
                try { await task.fn(); } catch (e) { log(`Deferred update error: ${e.message}`, 'error'); }
            }
        }, 60 * 1000); // check every minute

        // Now set flag to enable volume threshold notifications for subsequent checks
        initialLoadComplete = true;
        log('Initial load complete. Volume threshold notifications enabled for new pairs.', 'info');

        // Run the check at the specified interval as a backup
        // This is in addition to the real-time WebSocket monitoring
        monitoringInterval = setInterval(async () => {
            log('Running periodic check as backup to WebSockets...', 'info');
            await checkEMACross();
        }, CHECK_INTERVAL);

        log(`Initialization complete. Bot is now monitoring in real-time via WebSockets${ML_ENABLED ? ' with ML enhancement' : ''}.`, 'success');
    } catch (error) {
        log(`Failed to initialize: ${error.message}`, 'error');

        // Show desktop notification for startup failure
        showDesktopNotification(
            'EMA Tracker Failed to Start',
            `Error: ${error.message}`,
            'error'
        );

        // Try to send error message to Telegram
        try {
            await bot.sendMessage(TELEGRAM_CHAT_ID, `❌ *Error Starting Bot*\n\n${error.message}`, {
                parse_mode: 'Markdown'
            });
        } catch (e) {
            log(`Could not send error message to Telegram: ${e.message}`, 'error');
        }
    }
}

// Start the bot
initialize();