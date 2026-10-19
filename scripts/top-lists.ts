// Prints the three market lists (top gainers, top losers, highest volume) from live Delta India data, exactly as
// the Telegram menu shows them, without Telegram. Run: node scripts/top-lists.ts
import { Engine } from '../core/app/engine.ts';
import { renderTopList, type TopListKind } from '../core/app/messages.ts';
import { Store } from '../core/store/store.ts';
import { openSqlite } from '../runtimes/docker/sqlite.ts';

const engine = new Engine(
  new Store(openSqlite(':memory:')),
  { runtime: 'Docker', version: 'script', fetch: (url, init) => fetch(url, init), openFeed: () => Promise.reject(new Error('no feed in this script')), requestWake: () => {}, callBudget: Number.POSITIVE_INFINITY, print: () => {} },
  null,
  ['script run without Telegram']
);
engine.init();
for (const kind of ['gainers', 'losers', 'volume'] as TopListKind[]) {
  const r = await engine.topList(kind);
  console.log(renderTopList(kind, r.items, r.at, r.minVolumeUsd, new Set(), 'Asia/Kolkata').replace(/<\/?b>/g, ''));
  console.log('');
}
process.exit(0);
