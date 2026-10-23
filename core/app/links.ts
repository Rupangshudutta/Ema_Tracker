// Links that open a coin's chart: TradingView (on a chosen timeframe) and Delta Exchange India's own trade page.
// Both are plain https links, so on a phone they open in the browser, or in the TradingView or Delta app when the app
// takes over those links.
import { SYSTEM, type Timeframe } from '../config/settings.ts';

/** TradingView's interval codes for our timeframes (minutes). */
const TRADINGVIEW_INTERVAL: Readonly<Record<Timeframe, string>> = { '1m': '1', '3m': '3', '5m': '5', '15m': '15', '1h': '60', '4h': '240' };

/** TradingView chart of a Delta India perpetual, opened on `timeframe` (15m unless an alert says otherwise). */
export function tradingViewUrl(symbol: string, timeframe: Timeframe = SYSTEM.links.defaultChartTimeframe): string {
  const params = new URLSearchParams({ symbol: `DELTAIN:${symbol}.P`, interval: TRADINGVIEW_INTERVAL[timeframe] });
  return `${SYSTEM.links.tradingViewChart}?${params.toString()}`;
}

/**
 * Delta Exchange India's trade page for a perpetual, for example .../BTC/BTCUSD. Delta's chart there opens on the
 * timeframe last picked on that device; Delta has no link setting for it (checked 2026-10-23).
 * Every Delta India perpetual is named <underlying>USD (checked on all 237), which is the fallback when the
 * underlying is not known.
 */
export function deltaUrl(symbol: string, underlying?: string | null): string {
  const base = underlying || symbol.replace(/USD$/, '');
  return `${SYSTEM.links.deltaTrade}/${encodeURIComponent(base)}/${encodeURIComponent(symbol)}`;
}
