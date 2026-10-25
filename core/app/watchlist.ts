// Watchlist rules (pure functions; the engine stores the result).
//   - Coins above the volume filter join automatically on the default timeframes (15m unless changed), up to the cap.
//   - Once on the watchlist a coin stays until the user removes it: a volume drop never pauses or removes it
//     (owner's rule, 2026-10-25). The filter only decides which new coins join and what the coin picker offers.
//   - A coin the user removed (all timeframes unticked) stays out, even while it is above the filter.
//   - Only a coin Delta stops trading (delisted or halted) for the grace period is paused, because there are no
//     prices to watch; it resumes on the same timeframes when trading restarts. Our own failed ticker fetch never
//     pauses anything (the rules only run on a fresh ticker list).
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

/** Delta lists the contract and trades it right now. */
export function isTrading(t: DeltaTicker | undefined): boolean {
  return t !== undefined && t.tradingStatus === 'operational';
}

/** Above the volume filter: may join automatically, and the coin picker offers it. */
export function qualifies(t: DeltaTicker | undefined, s: UserSettings): boolean {
  return t !== undefined && isTrading(t) && t.turnoverUsd24h > s.coins.volumeThresholdUsd;
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
    const trading = isTrading(t);
    if (row.status === 'paused') {
      if (trading) resumable.push(row); // also brings back coins an older version paused for low volume
      continue;
    }
    if (trading) {
      active++;
      if (row.belowSince !== null) out.rows.push({ ...row, belowSince: null, updatedAt: now });
      continue;
    }
    // belowSince now means "not trading since".
    const since = row.belowSince ?? now;
    if (now - since >= graceMs) {
      out.rows.push({ ...row, status: 'paused', belowSince: since, updatedAt: now });
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
    return { ok: true, row: { ...existing, timeframes: tfs, origin: 'user', updatedAt: now }, droppedTimeframes, message: `${symbol}: ${tfs.join(', ')}${existing.status === 'paused' ? ' (paused while Delta is not trading it)' : ''}` };
  }
  if (!qualifies(universe.get(symbol), s)) return { ok: false, reason: `${symbol} is not above your volume filter right now` };
  const active = rows.filter(r => r.status === 'active').length;
  if (active >= cap) return { ok: false, reason: `The watchlist is full (${cap} coins). Remove a coin first.` };
  return { ok: true, row: { symbol, timeframes: tfs, origin: 'user', status: 'active', belowSince: null, updatedAt: now }, droppedTimeframes, message: `${symbol} added: ${tfs.join(', ')}` };
}
