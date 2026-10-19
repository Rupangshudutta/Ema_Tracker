// What the bot says. Every Telegram text is built here, so wording and layout live in one place.
// Alerts are stored as structured payloads and rendered at send time, which is how a delayed alert gets its LATE line.
import { SYSTEM, TIMEFRAME_MS, type Timeframe, type UserSettings } from '../config/settings.ts';
import type { Direction } from '../domain/signal.ts';
import { escapeHtml } from '../notify/telegram.ts';
import type { EngineStatus } from './engine.ts';

/** Ticker numbers shown with an alert; taken from the cached ticker so they never delay or block the alert (I5, I9). */
export interface TickerContext {
  change24hPct: number;
  turnoverUsd24h: number;
}

interface AlertBase {
  symbol: string;
  timeframe: Timeframe;
  direction: Direction;
  /** Start of the candle the alert is about. */
  candleStart: number;
}

export type AlertPayload =
  | (AlertBase & { type: 'confirmed'; close: number; spreadPct: number; marginPct: number; realtimeAt: number | null; realtimeCancelled: boolean; ctx: TickerContext | null })
  | (AlertBase & { type: 'realtime'; price: number; spreadPct: number; marginPct: number; ctx: TickerContext | null })
  | (AlertBase & { type: 'realtime-cancel'; price: number; spreadPct: number })
  | (AlertBase & { type: 'not-confirmed'; spreadPct: number; marginPct: number });

export type MessagePayload = AlertPayload | { type: 'note'; html: string };

export interface RenderOptions {
  timeZone: string;
  /** How late the message is going out, in ms; 0 or less means on time. */
  lateMs: number;
}

/** Messages later than this get a LATE line; normal delivery is a few seconds after the candle close. */
export const LATE_AFTER_MS = 3 * 60_000;

// ---------------------------------------------------------------- number and time formatting

const priceFormat = new Intl.NumberFormat('en-US', { maximumSignificantDigits: 6 });

export function fmtPrice(n: number): string {
  return priceFormat.format(n);
}

/** Signed percentage, for example +0.08% or −0.06%. */
export function fmtPct(n: number, digits = 2): string {
  const s = Math.abs(n).toFixed(digits);
  if (Number(s) === 0) return `${(0).toFixed(digits)}%`;
  return `${n > 0 ? '+' : '−'}${s}%`;
}

/** $412M, $1.2B, $850K. */
export function fmtUsd(n: number): string {
  const abs = Math.abs(n);
  const short = (v: number, unit: string): string => `$${v >= 100 ? Math.round(v) : Number(v.toFixed(1))}${unit}`;
  if (abs >= 1e9) return short(n / 1e9, 'B');
  if (abs >= 1e6) return short(n / 1e6, 'M');
  if (abs >= 1e3) return short(n / 1e3, 'K');
  return `$${Math.round(n)}`;
}

/** 1 min 23 s, 12 min, 2 h 5 min. */
export function fmtDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return s % 60 && m < 10 ? `${m} min ${s % 60} s` : `${m} min`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h} h ${m % 60} min` : `${h} h`;
}

const timeFormats = new Map<string, Intl.DateTimeFormat>();
function formatter(timeZone: string, withDate: boolean): Intl.DateTimeFormat {
  const key = `${timeZone}|${withDate}`;
  let f = timeFormats.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23', ...(withDate ? { day: 'numeric', month: 'short' } : {}) });
    timeFormats.set(key, f);
  }
  return f;
}

/** Short label for the time zone: IST for India, otherwise the zone's own short name. */
export function tzLabel(timeZone: string): string {
  if (timeZone === 'Asia/Kolkata') return 'IST';
  const part = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'short' }).formatToParts(0).find(p => p.type === 'timeZoneName');
  return part?.value ?? timeZone;
}

export function fmtTime(ms: number, timeZone: string): string {
  return formatter(timeZone, false).format(ms);
}

export function fmtDateTime(ms: number, timeZone: string): string {
  return formatter(timeZone, true).format(ms);
}

// ---------------------------------------------------------------- alerts

const dirWord = (d: Direction): string => (d === 'up' ? 'bullish' : 'bearish');
const dirIcon = (d: Direction): string => (d === 'up' ? '🟢' : '🔴');
const sideWord = (d: Direction): string => (d === 'up' ? 'above' : 'below');
const coin = (p: AlertBase): string => `<b>${escapeHtml(p.symbol)} ${p.timeframe}</b>`;
const closeAt = (p: AlertBase): number => p.candleStart + TIMEFRAME_MS[p.timeframe];

function contextLine(lead: string, ctx: TickerContext | null): string {
  if (!ctx) return lead;
  return `${lead} · 24h ${fmtPct(ctx.change24hPct)} · vol ${fmtUsd(ctx.turnoverUsd24h)}`;
}

function lateLine(o: RenderOptions): string[] {
  return o.lateMs > LATE_AFTER_MS ? [`⏰ <b>LATE</b> by ${fmtDuration(o.lateMs)} (held up by an outage)`] : [];
}

export function renderAlert(id: string, p: AlertPayload, o: RenderOptions): string {
  const tz = tzLabel(o.timeZone);
  const lines: string[] = [...lateLine(o)];
  switch (p.type) {
    case 'confirmed': {
      lines.push(
        '✅ <b>CONFIRMED</b> · candle closed',
        `${dirIcon(p.direction)} ${coin(p)} ${dirWord(p.direction)} cross`,
        `EMA 9 closed ${sideWord(p.direction)} EMA 15: gap ${fmtPct(p.spreadPct, 3)} (margin ${p.marginPct.toFixed(2)}%)`,
        contextLine(`Close ${fmtPrice(p.close)}`, p.ctx)
      );
      if (p.realtimeAt !== null && p.realtimeCancelled) lines.push('↩️ The realtime alert was cancelled before the close, but the close confirmed the cross.');
      else if (p.realtimeAt !== null) lines.push(`⚡ The realtime alert came ${fmtDuration(closeAt(p) - p.realtimeAt)} before the close.`);
      lines.push(`Candle ${fmtTime(p.candleStart, o.timeZone)}–${fmtTime(closeAt(p), o.timeZone)} ${tz} · <code>${id}</code>`);
      break;
    }
    case 'realtime':
      lines.push(
        '⚡ <b>REALTIME</b> · candle still open',
        `${dirIcon(p.direction)} ${coin(p)} ${dirWord(p.direction)} cross`,
        `On the live price EMA 9 is ${sideWord(p.direction)} EMA 15: gap ${fmtPct(p.spreadPct, 3)} (margin ${p.marginPct.toFixed(2)}%)`,
        contextLine(`Price ${fmtPrice(p.price)}`, p.ctx),
        `Candle closes ${fmtTime(closeAt(p), o.timeZone)} ${tz}; you get CONFIRMED or NOT CONFIRMED then. · <code>${id}</code>`
      );
      break;
    case 'realtime-cancel':
      lines.push(
        `↩️ <b>REALTIME CANCELLED</b> · ${coin(p)}`,
        `The ${dirWord(p.direction)} cross reversed before the close: gap now ${fmtPct(p.spreadPct, 3)}, price ${fmtPrice(p.price)}.`,
        `Candle closes ${fmtTime(closeAt(p), o.timeZone)} ${tz}. · <code>${id}</code>`
      );
      break;
    case 'not-confirmed':
      lines.push(
        `❌ <b>NOT CONFIRMED</b> · ${coin(p)}`,
        `The realtime ${dirWord(p.direction)} cross did not hold at the ${fmtTime(closeAt(p), o.timeZone)} ${tz} close: gap ${fmtPct(p.spreadPct, 3)} (margin ${p.marginPct.toFixed(2)}%). · <code>${id}</code>`
      );
      break;
  }
  return lines.join('\n');
}

const TYPE_ICON: Record<AlertPayload['type'], string> = { confirmed: '✅', realtime: '⚡', 'realtime-cancel': '↩️', 'not-confirmed': '❌' };

/** One compact line per alert, for digests and the missed-alerts summary. */
export function alertLine(p: AlertPayload): string {
  const head = `${TYPE_ICON[p.type]} ${dirIcon(p.direction)} ${escapeHtml(p.symbol)} ${p.timeframe}`;
  switch (p.type) {
    case 'confirmed': return `${head} ${dirWord(p.direction)} confirmed · close ${fmtPrice(p.close)} · ${fmtPct(p.spreadPct, 3)}`;
    case 'realtime': return `${head} ${dirWord(p.direction)} realtime · price ${fmtPrice(p.price)} · ${fmtPct(p.spreadPct, 3)}`;
    case 'realtime-cancel': return `${head} ${dirWord(p.direction)} realtime cancelled · ${fmtPct(p.spreadPct, 3)}`;
    case 'not-confirmed': return `${head} ${dirWord(p.direction)} not confirmed · ${fmtPct(p.spreadPct, 3)}`;
  }
}

/** Several alerts that are due together, in one message (fewer notifications at busy candle closes). */
export function renderDigest(items: readonly AlertPayload[], at: number, o: RenderOptions): string {
  return [...lateLine(o), `📦 <b>${items.length} alerts</b> at ${fmtTime(at, o.timeZone)} ${tzLabel(o.timeZone)}`, ...items.map(alertLine)].join('\n');
}

/** Alerts more than the LATE window behind, listed once instead of sent one by one. */
export function renderMissed(items: readonly { payload: AlertPayload; eventAt: number }[], droppedOld: number, timeZone: string): string {
  const lines = [
    `🕳️ <b>Missed while offline</b>: ${items.length} alert${items.length === 1 ? ' was' : 's were'} more than ${SYSTEM.delivery.lateWindowMinutes} min late, so here they are in one list.`,
    ...items.map(i => `${fmtTime(i.eventAt, timeZone)} ${alertLine(i.payload)}`)
  ];
  if (droppedOld) lines.push(`${droppedOld} more ${droppedOld === 1 ? 'was' : 'were'} older than ${SYSTEM.delivery.maxAlertAgeHours} h and dropped.`);
  return lines.join('\n');
}

// ---------------------------------------------------------------- status and daily report

const n = (v: number | undefined): string => (v ?? 0).toLocaleString('en-US');

function settingsLine(s: UserSettings): string {
  return `Margin ${s.signal.marginPct.toFixed(2)}% · volume filter ${fmtUsd(s.coins.volumeThresholdUsd)} · new coins on ${s.coins.defaultTimeframes.join(', ')} · cancel notes ${s.realtime.cancelNotes ? 'on' : 'off'} · daily report ${s.monitoring.dailyReportTime} ${tzLabel(s.monitoring.timeZone)}`;
}

function feedLine(st: EngineStatus, now: number): string {
  const f = st.feed;
  if (!f.wanted) return 'Live feed: idle (no coins on the watchlist)';
  if (f.connected) return `Live feed: connected · ${f.wanted} coin${f.wanted === 1 ? '' : 's'}`;
  const down = f.downSince === null ? '' : ` for ${fmtDuration(now - f.downSince)}`;
  const next = f.nextConnectAt === null ? '' : `, reconnecting in ${fmtDuration(Math.max(0, f.nextConnectAt - now))}`;
  return `Live feed: <b>down</b>${down}${next}${f.quickDrops ? ` (${f.quickDrops} quick drops in a row)` : ''}`;
}

export function renderStatus(st: EngineStatus, now: number): string {
  const tz = st.settings.monitoring.timeZone;
  const paused = st.settings.delivery.pausedUntil;
  return [
    `📊 <b>Status</b> · ${fmtTime(now, tz)} ${tzLabel(tz)}`,
    `Engine: ${st.runtime} · <b>${st.role}</b> (${escapeHtml(st.roleReason)}) · v${escapeHtml(st.version)}`,
    st.problems.length ? `Health: ⚠️ ${escapeHtml(st.problems.join('; '))}` : 'Health: ✅ all good',
    feedLine(st, now),
    `Coins: ${st.coins.active} watched · ${st.coins.paused} paused · ${st.coins.removed} removed · ${st.coins.series} coin-timeframes`,
    `Last candle check: ${st.lastMinuteAt === null ? 'not yet' : `${fmtDuration(now - st.lastMinuteAt)} ago`}`,
    st.delta.failingSince === null ? 'Delta API: ok' : `Delta API: <b>failing</b> for ${fmtDuration(now - st.delta.failingSince)} (${escapeHtml(st.delta.lastError ?? '')})`,
    `Messages waiting: ${st.outbox.pending}`,
    paused !== null && paused > now ? `Alerts: ⏸ paused until ${fmtDateTime(paused, tz)} ${tzLabel(tz)}` : 'Alerts: on',
    settingsLine(st.settings)
  ].join('\n');
}

export function renderDailyReport(st: EngineStatus, stats: Readonly<Record<string, number>>, windowMs: number, now: number): string {
  const tz = st.settings.monitoring.timeZone;
  const hours = Math.max(1, Math.round(windowMs / 3_600_000));
  const sent = (stats.sent_confirmed ?? 0) + (stats.sent_realtime ?? 0) + (stats.sent_cancel ?? 0) + (stats.sent_not_confirmed ?? 0) + (stats.sent_notes ?? 0);
  const upPct = st.feed.wanted ? Math.max(0, 100 * (1 - (stats.feed_down_ms ?? 0) / windowMs)) : null;
  const restCalls = (stats.rest_ok ?? 0) + (stats.rest_fail ?? 0) + (stats.rest_429 ?? 0);
  const lines = [
    `☀️ <b>Daily report</b> · ${fmtDateTime(now, tz)} ${tzLabel(tz)}`,
    `I'm alive: ${st.runtime} is sending alerts · v${escapeHtml(st.version)}`,
    `Coins: ${st.coins.active} watched · ${st.coins.paused} paused · ${st.coins.removed} removed`,
    `Last ${hours} h: ✅ ${n(stats.alerts_confirmed)} confirmed · ⚡ ${n(stats.alerts_realtime)} realtime · ↩️ ${n(stats.alerts_realtime_cancel)} cancelled · ❌ ${n(stats.alerts_not_confirmed)} not confirmed${stats.alerts_suppressed ? ` · ${n(stats.alerts_suppressed)} held back while paused` : ''}`,
    `Delivery: ${n(sent)} messages · ${n(stats.late)} late · ${n(stats.missed)} in a missed-summary · ${n(stats.expired)} dropped (too old) · ${n(stats.failed)} failed`,
    upPct === null ? 'Live feed: idle' : `Live feed: up ${upPct.toFixed(1)}% · ${n(stats.feed_drops)} drops · price fallback ${n(stats.fallback_minutes)} min`,
    `Delta API: ${n(restCalls)} calls · ${n(stats.rest_fail)} failed · ${n(stats.rest_429)} rate-limited${stats.series_problems ? ` · ${n(stats.series_problems)} late or missing candles` : ''}`,
    settingsLine(st.settings)
  ];
  if (st.problems.length) lines.push(`⚠️ Right now: ${escapeHtml(st.problems.join('; '))}`);
  return lines.join('\n');
}

// ---------------------------------------------------------------- notes

const tfList = (tfs: readonly Timeframe[]): string => tfs.join(', ');

export const notes = {
  joined(symbols: readonly { symbol: string; turnoverUsd24h: number }[], tfs: readonly Timeframe[]): string {
    const list = symbols.map(s => `${escapeHtml(s.symbol)} (${fmtUsd(s.turnoverUsd24h)})`).join(', ');
    return `🆕 <b>Joined the watchlist</b> on ${tfList(tfs)}: ${list}.\nOpen <b>Coins</b> in the menu to change timeframes or remove them.`;
  },
  paused(symbols: readonly { symbol: string; turnoverUsd24h: number | null }[], thresholdUsd: number): string {
    const list = symbols.map(s => `${escapeHtml(s.symbol)}${s.turnoverUsd24h === null ? ' (no longer listed)' : ` (${fmtUsd(s.turnoverUsd24h)})`}`).join(', ');
    return `⏸ <b>Paused</b>: ${list} fell below your ${fmtUsd(thresholdUsd)} volume filter. They resume on the same timeframes if volume recovers.`;
  },
  resumed(symbols: readonly string[]): string {
    return `▶️ <b>Resumed</b>: ${symbols.map(escapeHtml).join(', ')} ${symbols.length === 1 ? 'is' : 'are'} back above your volume filter.`;
  },
  capReached(count: number, cap: number): string {
    return `ℹ️ ${count} more coin${count === 1 ? '' : 's'} pass your volume filter, but the watchlist is full (${cap} coins). Remove a coin or raise the filter to make room.`;
  },
  live(version: string, runtime: string, coins: number, s: UserSettings): string {
    return [
      `🟢 <b>EMA Tracker v2 is running</b> on ${escapeHtml(runtime)}`,
      `Version ${escapeHtml(version)}`,
      `Watching ${coins} Delta India coin${coins === 1 ? '' : 's'} · margin ${s.signal.marginPct.toFixed(2)}% · volume filter ${fmtUsd(s.coins.volumeThresholdUsd)}`,
      'Alerts: ⚡ REALTIME while a candle is open, ✅ CONFIRMED at the close.',
      'Send /start for the menu.'
    ].join('\n');
  },
  warning(title: string, detail: string): string {
    return `⚠️ <b>${escapeHtml(title)}</b>\n${escapeHtml(detail)}`;
  },
  recovered(title: string, detail: string): string {
    return `✅ <b>${escapeHtml(title)}</b>\n${escapeHtml(detail)}`;
  }
};
