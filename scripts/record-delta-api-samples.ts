// Records real Delta India replies (REST and live feed) as contract-test samples. Read-only public API.
// Run: node scripts/record-delta-api-samples.ts   Output: test/fixtures/delta-api/*.json
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SYSTEM } from '../core/config/settings.ts';

const OUT = join(import.meta.dirname, '..', 'test', 'fixtures', 'delta-api');
mkdirSync(OUT, { recursive: true });
const headers = { 'User-Agent': SYSTEM.exchange.userAgent, Accept: 'application/json' };
const save = (name: string, data: unknown): void => writeFileSync(join(OUT, `${name}.json`), JSON.stringify(data, null, 1) + '\n');

async function record(name: string, path: string, trim?: (body: { result: unknown[] }) => unknown): Promise<void> {
  const res = await fetch(SYSTEM.exchange.restBase + path, { headers });
  const body = (await res.json()) as { result: unknown[] };
  save(name, { status: res.status, date: res.headers.get('date'), body: trim ? trim(body) : body });
  console.log(`${name}: HTTP ${res.status}`);
}

const keep = (symbols: string[]) => (b: { result: unknown[] }) => ({ ...b, result: (b.result as { symbol: string }[]).filter(t => symbols.includes(t.symbol)) });
const end = Math.floor(Date.now() / 1000);
await record('tickers', `/v2/tickers?contract_types=${SYSTEM.exchange.contractType}`, keep(['BTCUSD', 'ETHUSD', 'SOLUSD']));
await record('ticker-btc', '/v2/tickers/BTCUSD');
await record('products', `/v2/products?contract_types=${SYSTEM.exchange.contractType}&states=live&page_size=500`, keep(['BTCUSD', 'ETHUSD']));
await record('candles-btc-5m', `/v2/history/candles?resolution=5m&symbol=BTCUSD&start=${end - 6 * 300}&end=${end}`);
await record('candles-unknown-symbol', `/v2/history/candles?resolution=5m&symbol=NOSUCHCOIN&start=${end - 900}&end=${end}`);

// Live feed: subscribe, unsubscribe, keep the first message of each type.
const feed: Record<string, unknown> = {};
await new Promise<void>(done => {
  const ws = new WebSocket(SYSTEM.exchange.wsUrl);
  ws.onopen = () => ws.send(JSON.stringify({ type: 'subscribe', payload: { channels: [{ name: SYSTEM.realtime.channel, symbols: ['BTCUSD'] }] } }));
  ws.onmessage = e => {
    const m = JSON.parse(String(e.data)) as { type: string };
    if (!(m.type in feed)) feed[m.type] = m;
    if (m.type === 'v2/ticker' && !('unsubscribed' in feed)) ws.send(JSON.stringify({ type: 'unsubscribe', payload: { channels: [{ name: SYSTEM.realtime.channel, symbols: ['BTCUSD'] }] } }));
    if ('unsubscribed' in feed && 'v2/ticker' in feed) {
      ws.close();
      done();
    }
  };
  setTimeout(() => { ws.close(); done(); }, 30_000);
});
save('feed-messages', feed);
console.log('feed message types:', Object.keys(feed).join(', '));
