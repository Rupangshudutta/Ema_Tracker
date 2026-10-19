// Every setting the bot uses, grouped by responsibility. Mirrors docs/SETTINGS_REFERENCE.md.
// Two kinds:
//   SYSTEM       fixed values reviewed in git (change = code review + deploy)
//   UserSettings values you change from Telegram; validated here before they are stored
// Secrets and runtime switches are read from the environment in env.ts, never from this file.

export const TIMEFRAMES = ['5m', '15m', '1h', '4h'] as const;
export type Timeframe = (typeof TIMEFRAMES)[number];

export const TIMEFRAME_MS: Readonly<Record<Timeframe, number>> = {
  '5m': 5 * 60_000,
  '15m': 15 * 60_000,
  '1h': 60 * 60_000,
  '4h': 4 * 60 * 60_000
};

/** Margin choices offered in Telegram, in percent (0.00% to 0.10% in 0.01% steps). */
export const MARGIN_OPTIONS_PCT = [0, 0.01, 0.02, 0.03, 0.04, 0.05, 0.06, 0.07, 0.08, 0.09, 0.1] as const;

/** Volume-filter choices offered in Telegram, in USD of 24 h turnover. */
export const VOLUME_OPTIONS_USD = [5e6, 10e6, 15e6, 20e6, 30e6, 50e6, 100e6] as const;

export const SYSTEM = {
  exchange: {
    restBase: 'https://api.india.delta.exchange',
    wsUrl: 'wss://socket.india.delta.exchange',
    userAgent: 'ema-tracker/2.0 (+https://github.com/Rupangshudutta/Ema_Tracker)',
    requestTimeoutMs: 8_000,
    maxRetries: 3,
    contractType: 'perpetual_futures'
  },
  coins: {
    maxWatchlistCoins: 16,
    universeRefreshMinutes: 15,
    dropGraceMinutes: 60
  },
  signal: {
    emaFast: 9,
    emaSlow: 15,
    candleHistory: 150,
    rebuildHistory: 1000
  },
  realtime: {
    channel: 'v2/ticker',
    /** Delta sends a heartbeat every 30 s once enabled, so 35 s of silence means the connection is dead (Delta docs). */
    feedStaleSeconds: 35,
    /** Waits before reconnecting after 0, 1, 2... quick drops in a row. Delta allows 150 connections per IP per 5 min and asks for 5 to 10 min after a refusal. */
    reconnectDelaysSeconds: [2, 5, 15, 60, 300, 600],
    /** A connection that dies sooner than this counts as a quick drop. */
    healthyAfterSeconds: 60
  },
  timing: {
    settleSeconds: 3
  },
  delivery: {
    digestThreshold: 4,
    lateWindowMinutes: 30,
    maxAlertAgeHours: 6,
    requestBatchSize: 40
  },
  monitoring: {
    healthPingMinutes: 5
  }
} as const;

export interface UserSettings {
  coins: {
    /** Minimum 24 h volume for a coin to join or stay on the watchlist. */
    volumeThresholdUsd: number;
    /** Timeframes a newly qualifying coin starts with. */
    defaultTimeframes: Timeframe[];
  };
  signal: {
    /** How far EMA 9 must pass EMA 15, in percent, for every coin, timeframe and alert type. */
    marginPct: number;
  };
  realtime: {
    /** Send a note when a realtime cross undoes itself before the candle closes. */
    cancelNotes: boolean;
  };
  delivery: {
    /** Epoch ms until which all alerts are paused, or null. */
    pausedUntil: number | null;
  };
  monitoring: {
    /** Local time of the daily report, HH:MM. */
    dailyReportTime: string;
    /** IANA time zone for the daily report. */
    timeZone: string;
  };
}

export const DEFAULT_USER_SETTINGS: UserSettings = {
  coins: { volumeThresholdUsd: 10e6, defaultTimeframes: ['15m'] },
  signal: { marginPct: 0.05 },
  realtime: { cancelNotes: true },
  delivery: { pausedUntil: null },
  monitoring: { dailyReportTime: '09:00', timeZone: 'Asia/Kolkata' }
};

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; errors: string[] };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
/** The list element equal to v (within float noise), so stored values are always the exact canonical option. */
const canonical = (v: unknown, list: readonly number[]): number | undefined => (typeof v === 'number' ? list.find(x => Math.abs(x - v) < 1e-9) : undefined);

export function isTimeframe(v: unknown): v is Timeframe {
  return typeof v === 'string' && (TIMEFRAMES as readonly string[]).includes(v);
}

function validTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * Validates stored or incoming settings. Unknown keys are rejected, missing groups fall back to defaults,
 * and every invalid field is reported by path so a bad value is never silently replaced.
 */
export function validateUserSettings(input: unknown): ValidationResult<UserSettings> {
  if (!isRecord(input)) return { ok: false, errors: ['settings must be an object'] };
  const errors: string[] = [];
  const known: Record<keyof UserSettings, readonly string[]> = {
    coins: ['volumeThresholdUsd', 'defaultTimeframes'],
    signal: ['marginPct'],
    realtime: ['cancelNotes'],
    delivery: ['pausedUntil'],
    monitoring: ['dailyReportTime', 'timeZone']
  };
  for (const key of Object.keys(input)) if (!Object.hasOwn(known, key)) errors.push(`unknown group: ${key}`);
  const group = (name: keyof UserSettings): Record<string, unknown> => {
    const g = input[name];
    if (g === undefined) return {};
    if (!isRecord(g)) {
      errors.push(`${name} must be an object`);
      return {};
    }
    for (const k of Object.keys(g)) if (!known[name].includes(k)) errors.push(`unknown setting: ${name}.${k}`);
    return g;
  };
  const d = DEFAULT_USER_SETTINGS;
  const coins = group('coins');
  const signal = group('signal');
  const realtime = group('realtime');
  const delivery = group('delivery');
  const monitoring = group('monitoring');

  const volume = canonical(coins.volumeThresholdUsd ?? d.coins.volumeThresholdUsd, VOLUME_OPTIONS_USD);
  if (volume === undefined) errors.push(`coins.volumeThresholdUsd must be one of ${VOLUME_OPTIONS_USD.join(', ')}`);

  const tfs = coins.defaultTimeframes ?? d.coins.defaultTimeframes;
  const tfList = Array.isArray(tfs) ? tfs : [];
  if (!Array.isArray(tfs) || !tfList.length || !tfList.every(isTimeframe) || new Set(tfList).size !== tfList.length) {
    errors.push(`coins.defaultTimeframes must be one or more distinct values from ${TIMEFRAMES.join(', ')}`);
  }

  const margin = canonical(signal.marginPct ?? d.signal.marginPct, MARGIN_OPTIONS_PCT);
  if (margin === undefined) errors.push(`signal.marginPct must be one of ${MARGIN_OPTIONS_PCT.join(', ')}`);

  const cancelNotes = realtime.cancelNotes ?? d.realtime.cancelNotes;
  if (typeof cancelNotes !== 'boolean') errors.push('realtime.cancelNotes must be true or false');

  const pausedUntil = delivery.pausedUntil === undefined ? d.delivery.pausedUntil : delivery.pausedUntil;
  if (pausedUntil !== null && !(typeof pausedUntil === 'number' && Number.isInteger(pausedUntil) && pausedUntil > 0)) {
    errors.push('delivery.pausedUntil must be null or epoch milliseconds');
  }

  const reportTime = monitoring.dailyReportTime ?? d.monitoring.dailyReportTime;
  if (typeof reportTime !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(reportTime)) errors.push('monitoring.dailyReportTime must be HH:MM');

  const tz = monitoring.timeZone ?? d.monitoring.timeZone;
  if (typeof tz !== 'string' || !validTimeZone(tz)) errors.push('monitoring.timeZone must be an IANA time zone such as Asia/Kolkata');

  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    value: {
      coins: { volumeThresholdUsd: volume!, defaultTimeframes: [...(tfList as Timeframe[])].sort((a, b) => TIMEFRAME_MS[a] - TIMEFRAME_MS[b]) },
      signal: { marginPct: margin! },
      realtime: { cancelNotes: cancelNotes as boolean },
      delivery: { pausedUntil: pausedUntil as number | null },
      monitoring: { dailyReportTime: reportTime as string, timeZone: tz as string }
    }
  };
}
