// The messenger (fix for audit finding I3): every message is written to the notebook first, then sent, and only
// marked sent when Telegram accepts it. Failures are retried with backoff; nothing is dropped silently.
//   - on time          sent as is
//   - over 3 min late  sent with a LATE line
//   - over 30 min late listed once in a "missed while offline" summary
//   - over 6 h old     dropped and counted
//   - realtime messages whose candle has already closed are superseded by the close result
//   - 4 or more alerts due together go out as one digest
import { SYSTEM, TIMEFRAME_MS } from '../config/settings.ts';
import { describeTelegramFailure, splitMessage, type TelegramFailure, type TelegramResult } from '../notify/telegram.ts';
import type { OutboxRow, Store } from '../store/store.ts';
import { LATE_AFTER_MS, renderAlert, renderDigest, renderMissed, type AlertPayload, type MessagePayload } from './messages.ts';

export interface Sender {
  sendMessage(chatId: string, html: string): Promise<TelegramResult>;
}

export interface DeliverOptions {
  store: Store;
  sender: Sender;
  chatId: string;
  now: number;
  timeZone: string;
  /** Maximum Telegram calls in this run (Cloudflare's per-run outbound call budget). */
  maxSends: number;
}

export interface DeliveryReport {
  calls: number;
  sent: number;
  late: number;
  missed: number;
  expired: number;
  superseded: number;
  failed: number;
  /** The Telegram failure that stopped this run early, if any. */
  error: TelegramFailure | null;
  /** True when the call budget ran out with messages still due. */
  more: boolean;
}

const MAX_AGE_MS = SYSTEM.delivery.maxAlertAgeHours * 60 * 60_000;
const LATE_WINDOW_MS = SYSTEM.delivery.lateWindowMinutes * 60_000;
const BLOCKED_RETRY_MS = 10 * 60_000;

const retryDelay = (attempts: number): number => Math.min(15_000 * 2 ** attempts, 5 * 60_000);

const STAT_KEY: Record<MessagePayload['type'], string> = {
  confirmed: 'sent_confirmed',
  realtime: 'sent_realtime',
  'realtime-cancel': 'sent_cancel',
  'not-confirmed': 'sent_not_confirmed',
  note: 'sent_notes'
};

interface Parsed {
  row: OutboxRow;
  payload: MessagePayload;
}

export async function deliver(o: DeliverOptions): Promise<DeliveryReport> {
  const { store, now } = o;
  const report: DeliveryReport = { calls: 0, sent: 0, late: 0, missed: 0, expired: 0, superseded: 0, failed: 0, error: null, more: false };
  const stats: Record<string, number> = {};
  const count = (key: string, n = 1): void => {
    stats[key] = (stats[key] ?? 0) + n;
  };

  const superseded: string[] = [];
  const expired: string[] = [];
  const broken: string[] = [];
  const missed: { row: OutboxRow; payload: AlertPayload }[] = [];
  const alerts: { row: OutboxRow; payload: AlertPayload }[] = [];
  const noteRows: Parsed[] = [];

  for (const row of store.duePending(now, 200)) {
    let payload: MessagePayload;
    try {
      payload = JSON.parse(row.payload) as MessagePayload;
    } catch {
      broken.push(row.id);
      continue;
    }
    const age = now - row.eventAt;
    if (payload.type === 'note') {
      if (age > MAX_AGE_MS) expired.push(row.id);
      else noteRows.push({ row, payload });
      continue;
    }
    const realtimeKind = payload.type === 'realtime' || payload.type === 'realtime-cancel';
    if (realtimeKind && now >= payload.candleStart + TIMEFRAME_MS[payload.timeframe]) superseded.push(row.id);
    else if (age > MAX_AGE_MS) expired.push(row.id);
    else if (age > LATE_WINDOW_MS) missed.push({ row, payload });
    else alerts.push({ row, payload });
  }

  store.markOutbox(superseded, 'superseded', now);
  store.markOutbox(expired, 'expired', now);
  store.markOutbox(broken, 'failed', now, null, 'stored payload is not valid JSON');
  report.superseded = superseded.length;
  report.expired = expired.length;
  report.failed = broken.length;

  /** Sends text (split if needed); returns the first message ID, null when out of budget, or the failure. */
  const sendText = async (html: string): Promise<{ ok: true; messageId: number } | { ok: false; error: TelegramFailure } | null> => {
    const parts = splitMessage(html);
    if (o.maxSends - report.calls < parts.length) {
      report.more = true;
      return null;
    }
    let first: number | null = null;
    for (const part of parts) {
      report.calls++;
      const r = await o.sender.sendMessage(o.chatId, part);
      if (!r.ok) return r;
      first ??= r.messageId;
    }
    return { ok: true, messageId: first! };
  };

  /** Applies a failure to the rows it concerns; returns true when the run should stop. */
  const onFailure = (error: TelegramFailure, rows: readonly OutboxRow[]): boolean => {
    const ids = rows.map(r => r.id);
    const why = describeTelegramFailure(error);
    count('telegram_errors');
    if (error.kind === 'rejected' && error.status === 400) {
      // Our text was malformed; retrying the same text cannot help. Counted and shown in the daily report.
      store.markOutbox(ids, 'failed', now, null, why);
      report.failed += ids.length;
      return false;
    }
    report.error = error;
    if (error.kind === 'rate-limited') store.delayPending(now + error.retryAfterMs);
    else if (error.kind === 'rejected') store.retryLater(ids, now + BLOCKED_RETRY_MS, why); // revoked token, bot blocked or chat gone
    else store.retryLater(ids, now + retryDelay(Math.max(...rows.map(r => r.attempts))), why);
    return true;
  };

  const markSent = (items: readonly { row: OutboxRow; payload: MessagePayload }[], messageId: number): void => {
    store.markOutbox(items.map(i => i.row.id), 'sent', now, messageId);
    report.sent += items.length;
    for (const i of items) count(STAT_KEY[i.payload.type]);
  };

  try {
    if (missed.length) {
      const r = await sendText(renderMissed(missed.map(m => ({ payload: m.payload, eventAt: m.row.eventAt })), expired.length, o.timeZone));
      if (!r) return report;
      if (!r.ok) {
        if (onFailure(r.error, missed.map(m => m.row))) return report;
      } else {
        store.markOutbox(missed.map(m => m.row.id), 'missed', now, r.messageId);
        report.missed = missed.length;
      }
    }

    if (alerts.length >= SYSTEM.delivery.digestThreshold) {
      const oldest = Math.min(...alerts.map(a => a.row.eventAt));
      const r = await sendText(renderDigest(alerts.map(a => a.payload), now, { timeZone: o.timeZone, lateMs: now - oldest }));
      if (!r) return report;
      if (!r.ok) {
        if (onFailure(r.error, alerts.map(a => a.row))) return report;
      } else {
        markSent(alerts, r.messageId);
        report.late += alerts.filter(a => now - a.row.eventAt > LATE_AFTER_MS).length;
      }
    } else {
      for (const a of alerts) {
        const lateMs = now - a.row.eventAt;
        const r = await sendText(renderAlert(a.row.id, a.payload, { timeZone: o.timeZone, lateMs }));
        if (!r) return report;
        if (!r.ok) {
          if (onFailure(r.error, [a.row])) return report;
          continue;
        }
        markSent([a], r.messageId);
        if (lateMs > LATE_AFTER_MS) report.late++;
      }
    }

    for (const n of noteRows) {
      if (n.payload.type !== 'note') continue;
      const r = await sendText(n.payload.html);
      if (!r) return report;
      if (!r.ok) {
        if (onFailure(r.error, [n.row])) return report;
        continue;
      }
      markSent([n], r.messageId);
    }
    return report;
  } finally {
    count('late', report.late);
    count('missed', report.missed);
    count('expired', report.expired);
    count('superseded', report.superseded);
    count('failed', report.failed);
    store.addStats(stats);
  }
}
