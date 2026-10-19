// Lists the CONFIRMED crosses the bot would have sent in the last N hours for the current watchlist coins
// (coins above the volume filter, on the given timeframes), from live Delta India data and the bot's own rule.
// Run: node scripts/recent-crosses.ts --hours=8 --timeframes=15m --margin=0.05 --min-volume=10000000
import { SYSTEM, TIMEFRAME_MS, isTimeframe, type Timeframe } from '../core/config/settings.ts';
import { closedSeries } from '../core/domain/candles.ts';
import { evaluateConfirmed } from '../core/domain/signal.ts';
import { DeltaClient } from '../core/exchange/delta.ts';

const arg = (name: string, fallback: string): string => process.argv.find(a => a.startsWith(`--${name}=`))?.split('=')[1] ?? fallback;
const hours = Number(arg('hours', '8'));
const timeframes = arg('timeframes', '15m').split(',').filter(isTimeframe) as Timeframe[];
const margin = Number(arg('margin', '0.05'));
const minVolume = Number(arg('min-volume', '10000000'));

const client = new DeltaClient((url, init) => fetch(url, init));
const tk = await client.tickers();
if (!tk.ok) throw new Error(`tickers failed: ${JSON.stringify(tk.error)}`);
const coins = tk.value.tickers
  .filter(t => t.turnoverUsd24h > minVolume && t.tradingStatus === 'operational')
  .sort((a, b) => b.turnoverUsd24h - a.turnoverUsd24h)
  .slice(0, SYSTEM.coins.maxWatchlistCoins)
  .map(t => t.symbol);
const since = tk.serverNow - hours * 3_600_000;
const fmt = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
let total = 0;
for (const tf of timeframes) {
  for (const symbol of coins) {
    const r = await client.candles(symbol, tf, SYSTEM.signal.rebuildHistory, tk.serverNow);
    if (!r.ok) {
      console.log(`${symbol} ${tf}: fetch failed (${r.error.kind})`);
      continue;
    }
    const check = closedSeries(r.value, TIMEFRAME_MS[tf], r.serverNow, SYSTEM.signal.emaSlow);
    if (!check.ok) continue;
    const res = evaluateConfirmed(check.candles, { fast: SYSTEM.signal.emaFast, slow: SYSTEM.signal.emaSlow }, margin, null, since);
    for (const c of res.crosses) {
      total++;
      console.log(`${fmt.format(c.candleStart + TIMEFRAME_MS[tf])} IST  ${symbol.padEnd(9)} ${tf.padEnd(3)} ${c.direction === 'up' ? 'bullish' : 'bearish'}  gap ${c.spreadPct.toFixed(3)}%`);
    }
  }
}
console.log(`\n${total} confirmed crosses in the last ${hours} h on ${coins.length} coins (${timeframes.join(', ')}, margin ${margin}%)`);
process.exit(0);
