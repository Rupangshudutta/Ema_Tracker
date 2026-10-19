// Records closed Delta India candles as test fixtures (read-only public API, no keys).
// Run: npm run fixtures:delta   Output: test/fixtures/delta/<SYMBOL>_<tf>.json
// Fixtures are frozen on purpose: the golden tests compare every future change against the same data.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SYSTEM, TIMEFRAME_MS, type Timeframe } from '../core/config/settings.ts';
import { closedSeries, type Candle } from '../core/domain/candles.ts';

const OUT_DIR = join(import.meta.dirname, '..', 'test', 'fixtures', 'delta');
const CANDLES = 1000;
const MIN_TURNOVER_USD = 10e6;
const PLAN: { timeframes: Timeframe[]; coins: number }[] = [
  { timeframes: ['5m', '15m'], coins: 12 },
  { timeframes: ['1h', '4h'], coins: 4 }
];
const headers = { 'User-Agent': SYSTEM.exchange.userAgent, Accept: 'application/json' };

async function getJson(path: string): Promise<{ json: unknown; serverNow: number }> {
  const res = await fetch(SYSTEM.exchange.restBase + path, { headers, signal: AbortSignal.timeout(SYSTEM.exchange.requestTimeoutMs) });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${path}`);
  const date = res.headers.get('date');
  return { json: await res.json(), serverNow: date ? Date.parse(date) : Date.now() };
}

const { json: tickers } = await getJson(`/v2/tickers?contract_types=${SYSTEM.exchange.contractType}`);
const ranked = ((tickers as { result: { symbol: string; turnover_usd: string }[] }).result)
  .map(t => ({ symbol: t.symbol, turnover: Number(t.turnover_usd) }))
  .filter(t => Number.isFinite(t.turnover) && t.turnover > MIN_TURNOVER_USD)
  .sort((a, b) => b.turnover - a.turnover);

mkdirSync(OUT_DIR, { recursive: true });
for (const { timeframes, coins } of PLAN) {
  for (const { symbol } of ranked.slice(0, coins)) {
    for (const tf of timeframes) {
      const interval = TIMEFRAME_MS[tf];
      const endSec = Math.floor(Date.now() / 1000);
      const startSec = endSec - Math.ceil(((CANDLES + 2) * interval) / 1000);
      const { json, serverNow } = await getJson(`/v2/history/candles?resolution=${tf}&symbol=${symbol}&start=${startSec}&end=${endSec}`);
      const rows: Candle[] = (json as { result: { time: number; open: number; high: number; low: number; close: number; volume: number }[] }).result.map(r => ({
        start: r.time * 1000, open: Number(r.open), high: Number(r.high), low: Number(r.low), close: Number(r.close), volume: Number(r.volume)
      }));
      const check = closedSeries(rows, interval, serverNow);
      if (!check.ok) {
        console.warn(`skip ${symbol} ${tf}: ${check.problem} (${check.detail})`);
        continue;
      }
      const candles = check.candles.slice(-CANDLES);
      writeFileSync(join(OUT_DIR, `${symbol}_${tf}.json`), JSON.stringify({ symbol, timeframe: tf, intervalMs: interval, firstStart: candles[0]!.start, recordedAt: new Date(serverNow).toISOString(), closes: candles.map(c => c.close) }) + '\n');
      console.log(`${symbol} ${tf}: ${candles.length} closed candles`);
      await new Promise(r => setTimeout(r, 200));
    }
  }
}
