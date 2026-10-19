// Watchlist rules (pure functions; the engine stores the result).
//   - Coins above the volume filter join automatically on the default timeframes (15m unless changed), up to the cap.
//   - A coin the user removed (all timeframes unticked) stays out, even while it is above the filter.
//   - A coin that falls below the filter for the grace period is paused, and resumes on the same timeframes.
//   - Changing the filter applies at once (grace 0); a coin is never paused because our own ticker fetch failed.
import { SYSTEM, TIMEFRAME_MS, type Timeframe, type UserSettings } from '../config/settings.ts';
import type { DeltaTicker } from '../exchange/delta.ts';
import type { WatchRow } from '../store/store.ts';

export type Universe = ReadonlyMap<string, DeltaTicker>;

export interface WatchlistChange {
  /** Rows to write (new or changed). */
  rows: WatchRow[];
  joined: { symbol: string; turnoverUsd24h: number; change24hPct: number }[];
  paused: { symbol: string; turnoverUsd24h: number | null }[];
  resumed: string[];
  /** Coins that pass the filter but did not fit under the cap. */
  overCap: number;
}

export function qualifies(t: DeltaTicker | undefined, s: UserSettings): boolean {
  return t !== undefined && t.tradingStatus === 'operational' && t.turnoverUsd24h > s.coins.volumeThresholdUsd;
}

export const sortTimeframes = (tfs: readonly Timeframe[]): Timeframe[] => [...new Set(tfs)].sort((a, b) => TIMEFRAME_MS[a] - TIMEFRAME_MS[b]);

export function applyUniverse(rows: readonly WatchRow[], universe: Universe, s: UserSettings, now: number, graceMs: number, cap: number = SYSTEM.coins.maxWatchlistCoins): WatchlistChange {
  const out: WatchlistChange = { rows: [], joined: [], paused: [], resumed: [], overCap: 0 };
  const known = new Set(rows.map(r => r.symbol));
  let active = 0;
  const resumable: WatchRow[] = [];

  for (const row of rows) {
    if (row.status === 'removed') continue;
    const t = universe.get(row.symbol);
    const ok = qualifies(t, s);
    if (row.status === 'paused') {
      if (ok) resumable.push(row);
      continue;
    }
    if (ok) {
      active++;
      if (row.belowSince !== null) out.rows.push({ ...row, belowSince: null, updatedAt: now });
      continue;
    }
    const below = row.belowSince ?? now;
    if (now - below >= graceMs) {
      out.rows.push({ ...row, status: 'paused', belowSince: below, updatedAt: now });
      out.paused.push({ symbol: row.symbol, turnoverUsd24h: t?.turnoverUsd24h ?? null });
    } else {
      active++;
      if (row.belowSince === null) out.rows.push({ ...row, belowSince: now, updatedAt: now });
    }
  }

  const byVolume = (a: string, b: string): number => (universe.get(b)?.turnoverUsd24h ?? 0) - (universe.get(a)?.turnoverUsd24h ?? 0);
  for (const row of resumable.sort((a, b) => byVolume(a.symbol, b.symbol))) {
    if (active >= cap) {
      out.overCap++;
      continue;
    }
    active++;
    out.rows.push({ ...row, status: 'active', belowSince: null, updatedAt: now });
    out.resumed.push(row.symbol);
  }

  const newcomers = [...universe.values()].filter(t => !known.has(t.symbol) && qualifies(t, s)).sort((a, b) => b.turnoverUsd24h - a.turnoverUsd24h);
  for (const t of newcomers) {
    if (active >= cap) {
      out.overCap++;
      continue;
    }
    active++;
    out.rows.push({ symbol: t.symbol, timeframes: sortTimeframes(s.coins.defaultTimeframes), origin: 'auto', status: 'active', belowSince: null, updatedAt: now });
    out.joined.push({ symbol: t.symbol, turnoverUsd24h: t.turnoverUsd24h, change24hPct: t.change24hPct });
  }
  return out;
}

export type CoinEdit =
  | { ok: true; row: WatchRow; droppedTimeframes: Timeframe[]; message: string }
  | { ok: false; reason: string };

/**
 * The user ticks timeframes for one coin (mini app or /watch). No timeframes removes the coin. Adding a coin requires
 * it to pass the volume filter and the watchlist to have room; editing a paused coin keeps it paused.
 */
export function editCoin(rows: readonly WatchRow[], universe: Universe, s: UserSettings, symbol: string, timeframes: readonly Timeframe[], now: number, cap: number = SYSTEM.coins.maxWatchlistCoins): CoinEdit {
  const existing = rows.find(r => r.symbol === symbol);
  const tfs = sortTimeframes(timeframes);
  const before = existing?.status === 'removed' ? [] : existing?.timeframes ?? [];
  const droppedTimeframes = before.filter(tf => !tfs.includes(tf));
  if (!tfs.length) {
    if (!existing || existing.status === 'removed') return { ok: false, reason: `${symbol} is not on the watchlist` };
    return { ok: true, row: { ...existing, timeframes: [], origin: 'user', status: 'removed', belowSince: null, updatedAt: now }, droppedTimeframes, message: `${symbol} removed: no more alerts, live feed closed` };
  }
  if (existing && existing.status !== 'removed') {
    return { ok: true, row: { ...existing, timeframes: tfs, origin: 'user', updatedAt: now }, droppedTimeframes, message: `${symbol}: ${tfs.join(', ')}${existing.status === 'paused' ? ' (paused while below the volume filter)' : ''}` };
  }
  if (!qualifies(universe.get(symbol), s)) return { ok: false, reason: `${symbol} is not above your volume filter right now` };
  const active = rows.filter(r => r.status === 'active').length;
  if (active >= cap) return { ok: false, reason: `The watchlist is full (${cap} coins). Remove a coin first.` };
  return { ok: true, row: { symbol, timeframes: tfs, origin: 'user', status: 'active', belowSince: null, updatedAt: now }, droppedTimeframes, message: `${symbol} added: ${tfs.join(', ')}` };
}
