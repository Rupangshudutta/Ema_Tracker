import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { renderAlert } from '../core/app/messages.ts';
import { OPEN_APP_JS, deltaLinkFor, deltaOpenLinks, deltaOpenPage, deltaOpenUrl } from '../core/app/openapp.ts';
import { handleHttp } from '../core/app/http.ts';
import { BASE, FakeWorld, envFor, makeEngine, runUntil } from './fake-world.ts';

const WEB = 'https://www.delta.exchange/app/futures/trade/BTC/BTCUSD';

describe('open in the Delta app (Android)', () => {
  it('builds the page address only for a valid symbol and a known public address', () => {
    assert.equal(deltaOpenUrl(`${BASE}/`, 'BTCUSD'), `${BASE}/open/delta/BTCUSD`);
    assert.equal(deltaOpenUrl(null, 'BTCUSD'), null);
    assert.equal(deltaOpenUrl(BASE, 'btc"usd'), null);
    assert.equal(deltaLinkFor(null, 'BTCUSD'), WEB, 'without a public address the website link is used');
  });

  it('names the Delta app and always falls back to the website', () => {
    const l = deltaOpenLinks('BTCUSD')!;
    assert.equal(l.web, WEB);
    assert.equal(l.appCoin, `intent://www.delta.exchange/app/futures/trade/BTC/BTCUSD#Intent;scheme=https;package=com.deltaexchangeindia;S.browser_fallback_url=${encodeURIComponent(WEB)};end`);
    assert.equal(l.appHome, `intent://launch?id=com.deltaexchangeindia#Intent;scheme=market;package=com.android.vending;S.browser_fallback_url=${encodeURIComponent(WEB)};end`);
    assert.equal(deltaOpenLinks('<script>'), null);
  });

  it('serves the page and its script; rejects anything that is not a symbol', async () => {
    const engine = makeEngine(new FakeWorld(Date.UTC(2026, 10, 2)));
    const page = await handleHttp(new Request(`${BASE}/open/delta/BTCUSD`), engine);
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-security-policy') ?? '', /script-src 'self'/);
    const html = await page.text();
    assert.match(html, /Open BTCUSD in the Delta app/);
    assert.ok(html.includes('<script type="application/json" id="links">'));
    assert.equal((await handleHttp(new Request(`${BASE}/open/delta/btc%3Cx%3E`), engine)).status, 404);
    assert.equal((await handleHttp(new Request(`${BASE}/open/delta/`), engine)).status, 404);
    const js = await (await handleHttp(new Request(`${BASE}/open.js`), engine)).text();
    assert.doesNotThrow(() => new Function(js));
    assert.equal(js, OPEN_APP_JS);
  });

  function runPage(userAgent: string) {
    const links = deltaOpenLinks('BTCUSD')!;
    const els: Record<string, { href?: string; textContent: string; className: string; style: { display?: string } }> = {};
    for (const id of ['links', 'app-coin', 'app-home', 'web', 'msg', 'buttons']) els[id] = { textContent: '', className: '', style: {} };
    els.links!.textContent = JSON.stringify(links);
    els.buttons!.className = 'buttons';
    const doc = { getElementById: (id: string) => els[id], querySelectorAll: () => [els['app-coin'], els['app-home']] };
    const loc = { href: 'page', replaced: null as string | null, replace(u: string) { this.replaced = u; } };
    new Function('document', 'navigator', 'location', OPEN_APP_JS)(doc, { userAgent }, loc);
    return { els, loc, links };
  }

  it('on Android shows the three buttons at once and never navigates by itself (a tap opens the app)', () => {
    const { els, loc, links } = runPage('Mozilla/5.0 (Linux; Android 14; Pixel 8) Mobile');
    assert.equal(els.buttons!.className, 'buttons show');
    assert.equal(els['app-coin']!.href, links.appCoin);
    assert.equal(els['app-home']!.href, links.appHome);
    assert.equal(els.web!.href, links.web);
    assert.equal(loc.href, 'page', 'no automatic navigation');
    assert.equal(loc.replaced, null);
  });

  it('on iPhone and desktop goes straight to the website and hides the app buttons', () => {
    const { els, loc, links } = runPage('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)');
    assert.equal(loc.replaced, links.web);
    assert.equal(els['app-coin']!.style.display, 'none');
    assert.equal(els['app-home']!.style.display, 'none');
  });

  it('answers 404, never an error, for malformed or lowercase addresses', async () => {
    const engine = makeEngine(new FakeWorld(Date.UTC(2026, 10, 2)));
    for (const bad of ['%', '%E0%A4%A', 'btcusd', 'BTC/USD', 'BTC%25USD']) {
      assert.equal((await handleHttp(new Request(`${BASE}/open/delta/${bad}`), engine)).status, 404, bad);
    }
  });

  it('the Docker spare links straight to the website (the page lives on Cloudflare, which may be down)', async () => {
    const w = new FakeWorld(Date.UTC(2026, 10, 2, 3, 0, 3500));
    w.coins.set('BTCUSD', { turnover: 400e6, price: () => 100 });
    w.webhookUrl = '';
    const docker = makeEngine(w, 'Docker', envFor({ role: 'standby' }));
    await runUntil(w, docker, w.now + 2 * 60_000);
    assert.equal(docker.coinList().find(c => c.symbol === 'BTCUSD')?.deltaUrl, WEB);
  });

  it('keeps the page safe: the data block cannot close its script tag', () => {
    const html = deltaOpenPage('BTCUSD')!;
    const block = html.slice(html.indexOf('id="links">'), html.indexOf('</script>', html.indexOf('id="links">')));
    assert.ok(!block.slice('id="links">'.length).includes('<'), 'no raw "<" inside the JSON block');
  });

  it('alerts send the Delta link through the page when the public address is known', () => {
    const p = { type: 'realtime' as const, symbol: 'SOLUSD', timeframe: '15m' as const, direction: 'up' as const, candleStart: Date.UTC(2026, 10, 2), price: 1, spreadPct: 0.1, marginPct: 0.05, ctx: null };
    assert.match(renderAlert('x', p, { timeZone: 'Asia/Kolkata', lateMs: 0, linkBase: BASE }), new RegExp(`<a href="${BASE.replace(/[.]/g, '\\.')}/open/delta/SOLUSD">Delta</a>`));
    assert.match(renderAlert('x', p, { timeZone: 'Asia/Kolkata', lateMs: 0 }), /<a href="https:\/\/www\.delta\.exchange\/app\/futures\/trade\/SOL\/SOLUSD">Delta<\/a>/);
  });
});
