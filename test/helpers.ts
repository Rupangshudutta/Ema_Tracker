// Shared test helpers: fixture loading and candle construction.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Timeframe } from '../core/config/settings.ts';
import type { Candle } from '../core/domain/candles.ts';

export interface Fixture {
  symbol: string;
  timeframe: Timeframe;
  intervalMs: number;
  candles: Candle[];
}

const FIXTURE_DIR = join(import.meta.dirname, 'fixtures', 'delta');

/** Builds candles from closes on a regular grid. OHLC are set to the close, which the signal rules ignore. */
export function candlesFrom(closes: readonly number[], firstStart: number, intervalMs: number): Candle[] {
  return closes.map((close, i) => ({ start: firstStart + i * intervalMs, open: close, high: close, low: close, close, volume: 1 }));
}

export function loadDeltaFixtures(): Fixture[] {
  return readdirSync(FIXTURE_DIR)
    .filter(f => f.endsWith('.json'))
    .sort()
    .map(f => {
      const raw = JSON.parse(readFileSync(join(FIXTURE_DIR, f), 'utf8')) as { symbol: string; timeframe: Timeframe; intervalMs: number; firstStart: number; closes: number[] };
      return { symbol: raw.symbol, timeframe: raw.timeframe, intervalMs: raw.intervalMs, candles: candlesFrom(raw.closes, raw.firstStart, raw.intervalMs) };
    });
}
