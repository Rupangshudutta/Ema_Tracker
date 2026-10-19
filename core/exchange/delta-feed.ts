// Delta India live feed (v2/ticker) message handling, independent of the socket implementation.
// Message shapes verified live: "subscriptions" and "unsubscribed" acks list channels and symbols; after an
// unsubscribe no further ticker messages arrive for that symbol; ticker messages carry close and timestamp (µs).
import { SYSTEM } from '../config/settings.ts';

export type FeedEvent =
  | { type: 'ticker'; symbol: string; price: number; timestampMs: number }
  | { type: 'subscribed'; symbols: string[] }
  | { type: 'unsubscribed'; symbols: string[] }
  | { type: 'error'; message: string }
  | { type: 'ignored'; reason: string };

const CHANNEL = SYSTEM.realtime.channel;

function channelSymbols(m: Record<string, unknown>): string[] {
  const channels = Array.isArray(m.channels) ? m.channels : [];
  const out: string[] = [];
  for (const c of channels) {
    const ch = c as { name?: unknown; symbols?: unknown };
    if (ch.name === CHANNEL && Array.isArray(ch.symbols)) for (const s of ch.symbols) if (typeof s === 'string') out.push(s);
  }
  return out;
}

export function parseFeedMessage(raw: string): FeedEvent {
  let m: unknown;
  try {
    m = JSON.parse(raw);
  } catch {
    return { type: 'ignored', reason: 'not JSON' };
  }
  if (typeof m !== 'object' || m === null) return { type: 'ignored', reason: 'not an object' };
  const msg = m as Record<string, unknown>;
  switch (msg.type) {
    case CHANNEL: {
      const price = typeof msg.close === 'number' ? msg.close : Number(msg.close);
      const ts = typeof msg.timestamp === 'number' ? msg.timestamp : Number(msg.timestamp);
      if (typeof msg.symbol !== 'string' || !(price > 0) || !Number.isFinite(ts)) return { type: 'ignored', reason: 'ticker without symbol, price or time' };
      return { type: 'ticker', symbol: msg.symbol, price, timestampMs: Math.floor(ts / 1000) };
    }
    case 'subscriptions':
      return { type: 'subscribed', symbols: channelSymbols(msg) };
    case 'unsubscribed':
      return { type: 'unsubscribed', symbols: channelSymbols(msg) };
    case 'error':
      return { type: 'error', message: typeof msg.message === 'string' ? msg.message : JSON.stringify(msg).slice(0, 300) };
    default:
      return { type: 'ignored', reason: `type ${String(msg.type)}` };
  }
}

const frame = (type: 'subscribe' | 'unsubscribe', symbols: readonly string[]): string =>
  JSON.stringify({ type, payload: { channels: [{ name: CHANNEL, symbols: [...symbols] }] } });

export const subscribeMessage = (symbols: readonly string[]): string => frame('subscribe', symbols);
export const unsubscribeMessage = (symbols: readonly string[]): string => frame('unsubscribe', symbols);

/** What to send so the live subscriptions match the watchlist (removed coins are unsubscribed, closing their feed). */
export function diffSubscriptions(current: ReadonlySet<string>, wanted: ReadonlySet<string>): { subscribe: string[]; unsubscribe: string[] } {
  return {
    subscribe: [...wanted].filter(s => !current.has(s)).sort(),
    unsubscribe: [...current].filter(s => !wanted.has(s)).sort()
  };
}
