// Alert IDs: the same inputs always give the same ID, so the ledger can refuse duplicates (guarantee G5)
// and every message can show its ID.
import type { Timeframe } from '../config/settings.ts';
import type { Direction } from './signal.ts';

export type AlertKind = 'confirmed' | 'realtime' | 'realtime-cancel' | 'not-confirmed';

export interface AlertKey {
  kind: AlertKind;
  symbol: string;
  timeframe: Timeframe;
  candleStart: number;
  direction: Direction;
}

/** First 16 hex characters of SHA-256 over the key fields. Uses Web Crypto, available on Cloudflare and Node 24. */
export async function alertId(key: AlertKey): Promise<string> {
  const text = [key.kind, key.symbol, key.timeframe, String(key.candleStart), key.direction].join('|');
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest).slice(0, 8), b => b.toString(16).padStart(2, '0')).join('');
}
