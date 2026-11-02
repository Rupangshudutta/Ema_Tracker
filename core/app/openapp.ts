// "Open in the Delta app" page, served at /open/delta/<SYMBOL> (item 1, 2026-11-02).
// Delta publishes no app links (no apple-app-site-association or assetlinks.json on delta.exchange, nothing in Apple's
// or Google's records, no scheme in Delta's web app), so a plain https link always opens the browser. On Android an
// intent link can name the app itself (package com.deltaexchangeindia): if the app accepts its own website addresses
// it opens on the coin; if not, Android falls back to the website, so nothing gets worse than a plain link.
// The page offers three buttons (a tap is needed: Android opens another app only from a user gesture): the app on the
// coin, the app's home screen (through the Play Store's launch link, undocumented but widely used; without the app it
// shows the store page) and the website. Other phones go straight to the website.
import { escapeHtml } from '../notify/telegram.ts';
import { deltaUrl } from './links.ts';

/** Delta Exchange India's Android app (from the Play Store link in Delta's own web app). */
export const DELTA_ANDROID_PACKAGE = 'com.deltaexchangeindia';
const SYMBOL = /^[A-Z0-9]{2,24}$/;

export const OPEN_APP_CSP = ["default-src 'none'", "script-src 'self'", "style-src 'unsafe-inline'", "base-uri 'none'", "form-action 'none'"].join('; ');

/** Our page that opens a coin in the Delta app, or null when there is no public address (then use deltaUrl). */
export function deltaOpenUrl(publicBaseUrl: string | null | undefined, symbol: string): string | null {
  if (!publicBaseUrl || !SYMBOL.test(symbol)) return null;
  return `${publicBaseUrl.replace(/\/$/, '')}/open/delta/${symbol}`;
}

/** Android intent link: opens `webUrl` in the given app, or the website (`fallback`) when the app does not take it. */
function intentUrl(webUrl: string, pkg: string, fallback: string): string {
  const u = new URL(webUrl);
  return `intent://${u.host}${u.pathname}${u.search}#Intent;scheme=https;package=${pkg};S.browser_fallback_url=${encodeURIComponent(fallback)};end`;
}

/** The links the page offers, for one coin. */
export function deltaOpenLinks(symbol: string): { web: string; appCoin: string; appHome: string } | null {
  if (!SYMBOL.test(symbol)) return null;
  const web = deltaUrl(symbol);
  return {
    web,
    appCoin: intentUrl(web, DELTA_ANDROID_PACKAGE, web),
    // The Play Store's launch link opens an installed app on its home screen.
    appHome: `intent://launch?id=${DELTA_ANDROID_PACKAGE}#Intent;scheme=market;package=com.android.vending;S.browser_fallback_url=${encodeURIComponent(web)};end`
  };
}

/** The page for one coin; null for an invalid symbol (the route answers 404). */
export function deltaOpenPage(symbol: string): string | null {
  const links = deltaOpenLinks(symbol);
  if (!links) return null;
  // Data for the script, in a non-executed block; "<" is escaped so the JSON can never close the tag.
  const data = JSON.stringify(links).replace(/</g, '\\u003c');
  const name = escapeHtml(symbol);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${name} on Delta</title>
<style>
  body { margin: 0; padding: 24px 16px; font: 16px/1.45 -apple-system, system-ui, "Segoe UI", Roboto, sans-serif; background: #19222d; color: #f2f4f7; }
  h1 { font-size: 20px; margin: 0 0 6px; }
  p { color: #a9b3c1; margin: 0 0 18px; }
  .buttons { display: none; flex-direction: column; gap: 10px; }
  .buttons.show { display: flex; }
  a { display: block; text-align: center; padding: 14px; border-radius: 12px; text-decoration: none; font-weight: 600; border: 1px solid #3a4656; color: #f2f4f7; }
  a.main { background: #fd7d02; border-color: #fd7d02; color: #111; }
</style>
</head>
<body>
<h1>${name} on Delta Exchange</h1>
<p id="msg">Loading…</p>
<div class="buttons" id="buttons">
  <a class="main android" id="app-coin" href="#">Open ${name} in the Delta app</a>
  <a class="android" id="app-home" href="#">Open the Delta app (home screen)</a>
  <a id="web" href="#">Open ${name} on the Delta website</a>
</div>
<script type="application/json" id="links">${data}</script>
<script src="/open.js"></script>
</body>
</html>
`;
}

export const OPEN_APP_JS = String.raw`(function () {
  'use strict';
  var links = JSON.parse(document.getElementById('links').textContent);
  var android = /Android/i.test(navigator.userAgent);
  document.getElementById('app-coin').href = links.appCoin;
  document.getElementById('app-home').href = links.appHome;
  document.getElementById('web').href = links.web;
  var msg = document.getElementById('msg');
  var buttons = document.getElementById('buttons');
  if (!android) {
    Array.prototype.forEach.call(document.querySelectorAll('.android'), function (a) { a.style.display = 'none'; });
    msg.textContent = 'Delta has no app link for this phone, so the website opens instead.';
    buttons.className = 'buttons show';
    location.replace(links.web);
    return;
  }
  // No automatic attempt: Android only opens another app from a tap, and Telegram's own browser may refuse intent
  // links without one; an automatic try that falls back to the website would also hide these choices.
  msg.textContent = 'Tap to open:';
  buttons.className = 'buttons show';
})();
`;

/**
 * Where the coin-picker button and alerts send the owner for a coin on Delta: our page when its address is known and
 * served (Cloudflare), otherwise the website directly (the Docker spare, which often runs while Cloudflare is down).
 */
export function deltaLinkFor(openPageBase: string | null | undefined, symbol: string, underlying?: string | null): string {
  return deltaOpenUrl(openPageBase, symbol) ?? deltaUrl(symbol, underlying);
}
