// The coin picker, a Telegram mini app served at /app (S5). It lists coins above the volume filter plus the
// watchlist, with a search bar and per-coin timeframe ticks. Each tap saves at once; the server checks the user's
// Telegram signature, the volume filter and the 16-coin cap. Colours follow the user's Telegram theme.

export const MINI_APP_CSP = [
  "default-src 'none'",
  "script-src 'self' https://telegram.org",
  "style-src 'unsafe-inline'",
  "connect-src 'self'",
  'img-src data:',
  "base-uri 'none'",
  "form-action 'none'"
].join('; ');

export const MINI_APP_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Coins</title>
<script src="https://telegram.org/js/telegram-web-app.js"></script>
<style>
  :root {
    --bg: var(--tg-theme-bg-color, #ffffff);
    --text: var(--tg-theme-text-color, #111111);
    --hint: var(--tg-theme-hint-color, #707579);
    --card: var(--tg-theme-section-bg-color, var(--tg-theme-secondary-bg-color, #f2f3f5));
    --line: var(--tg-theme-section-separator-color, rgba(127,127,127,.25));
    --accent: var(--tg-theme-button-color, #2481cc);
    --accent-text: var(--tg-theme-button-text-color, #ffffff);
    --danger: var(--tg-theme-destructive-text-color, #d93025);
    --up: #1e9e5a;
    --down: #d93025;
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; background: var(--bg); color: var(--text); font: 15px/1.4 -apple-system, system-ui, "Segoe UI", Roboto, sans-serif; }
  header { position: sticky; top: 0; z-index: 2; background: var(--bg); padding: 12px 16px 8px; border-bottom: 1px solid var(--line); }
  h1 { margin: 0; font-size: 20px; }
  .hint { color: var(--hint); font-size: 13px; margin: 2px 0 10px; }
  input[type=search] { width: 100%; padding: 10px 12px; border-radius: 10px; border: 1px solid var(--line); background: var(--card); color: var(--text); font-size: 16px; outline: none; }
  input[type=search]:focus { border-color: var(--accent); }
  .filters { display: flex; gap: 6px; margin-top: 8px; }
  .filters button { flex: 1; min-height: 34px; border-radius: 9px; border: 1px solid var(--line); background: transparent; color: var(--text); font-size: 13px; }
  .filters button.on { background: var(--accent); color: var(--accent-text); border-color: var(--accent); }
  main { padding: 8px 12px 96px; }
  .coin { background: var(--card); border-radius: 12px; padding: 10px 12px; margin: 8px 0; }
  .row { display: flex; align-items: center; gap: 8px; }
  .sym { font-weight: 600; font-size: 16px; }
  .badge { font-size: 11px; padding: 2px 7px; border-radius: 999px; border: 1px solid var(--line); color: var(--hint); white-space: nowrap; }
  .badge.active { color: var(--up); border-color: var(--up); }
  .badge.paused { color: #b7791f; border-color: #b7791f; }
  .stats { margin-left: auto; text-align: right; font-size: 12px; color: var(--hint); white-space: nowrap; }
  .pos { color: var(--up); } .neg { color: var(--down); }
  .tfs { display: flex; gap: 6px; margin-top: 8px; }
  .tf { flex: 1; min-height: 40px; border-radius: 9px; border: 1px solid var(--line); background: transparent; color: var(--text); font-size: 14px; font-weight: 600; }
  .tf.on { background: var(--accent); color: var(--accent-text); border-color: var(--accent); }
  .tf:disabled { opacity: .5; }
  .remove { margin-left: 4px; min-height: 40px; padding: 0 10px; border-radius: 9px; border: 1px solid var(--line); background: transparent; color: var(--danger); font-size: 13px; }
  .note { font-size: 12px; color: var(--hint); margin-top: 6px; }
  .empty { text-align: center; color: var(--hint); padding: 40px 16px; }
  #toast { position: fixed; left: 12px; right: 12px; bottom: calc(16px + env(safe-area-inset-bottom)); padding: 10px 14px; border-radius: 10px; background: #222; color: #fff; font-size: 14px; opacity: 0; transform: translateY(8px); transition: opacity .2s, transform .2s; pointer-events: none; }
  #toast.show { opacity: .95; transform: none; }
  #toast.bad { background: var(--danger); }
</style>
</head>
<body>
<header>
  <h1>Coins</h1>
  <p id="meta" class="hint">Loading…</p>
  <input id="q" type="search" placeholder="Search, for example btc" autocomplete="off" autocapitalize="characters" spellcheck="false" aria-label="Search coins">
  <div class="filters" role="group" aria-label="Show">
    <button type="button" data-filter="all" class="on">All</button>
    <button type="button" data-filter="watched">Watching</button>
    <button type="button" data-filter="available">Not watched</button>
  </div>
</header>
<main id="list" aria-live="polite"></main>
<div id="toast" role="status"></div>
<script src="/app.js"></script>
</body>
</html>
`;

export const MINI_APP_JS = String.raw`(function () {
  'use strict';
  var TFS = ['5m', '15m', '1h', '4h'];
  var tg = window.Telegram && window.Telegram.WebApp;
  var initData = tg ? tg.initData : '';
  var state = { coins: [], meta: null, query: '', filter: 'all', busy: {} };
  var list = document.getElementById('list');
  var meta = document.getElementById('meta');
  var toastEl = document.getElementById('toast');
  var toastTimer = null;

  function usd(n) {
    if (n === null || n === undefined) return '';
    if (n >= 1e9) return '$' + (n / 1e9).toFixed(1) + 'B';
    if (n >= 1e6) return '$' + (n >= 1e8 ? Math.round(n / 1e6) : (n / 1e6).toFixed(1)) + 'M';
    return '$' + Math.round(n / 1e3) + 'K';
  }
  function toast(text, bad) {
    toastEl.textContent = text;
    toastEl.className = 'show' + (bad ? ' bad' : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.className = ''; }, 2600);
    if (tg && tg.HapticFeedback) tg.HapticFeedback.notificationOccurred(bad ? 'error' : 'success');
  }
  function api(method, body) {
    return fetch('/api/coins', {
      method: method,
      headers: { 'content-type': 'application/json', 'x-telegram-init-data': initData },
      body: body ? JSON.stringify(body) : undefined
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (!r.ok) throw new Error(j.error || ('Error ' + r.status));
        return j;
      });
    });
  }
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }
  function renderMeta() {
    var m = state.meta;
    if (!m) return;
    meta.textContent = 'Above ' + usd(m.volumeThresholdUsd) + ' volume · margin ' + Number(m.marginPct).toFixed(2) + '% · watching ' + m.active + '/' + m.cap +
      (m.role === 'active' ? '' : ' · on standby, changes go through the Docker spare');
  }
  function visible(c) {
    var q = state.query.trim().toUpperCase();
    if (q && c.symbol.indexOf(q) === -1) return false;
    if (state.filter === 'watched') return c.status === 'active' || c.status === 'paused';
    if (state.filter === 'available') return c.status === 'available' || c.status === 'removed';
    return true;
  }
  function render() {
    renderMeta();
    list.textContent = '';
    var shown = state.coins.filter(visible);
    if (!shown.length) {
      list.appendChild(el('div', 'empty', state.coins.length ? 'No coin matches.' : 'No coins above the volume filter right now.'));
      return;
    }
    shown.forEach(function (c) {
      var card = el('div', 'coin');
      var top = el('div', 'row');
      top.appendChild(el('span', 'sym', c.symbol));
      var label = c.status === 'active' ? 'Watching' : c.status === 'paused' ? 'Paused' : c.status === 'removed' ? 'Removed' : 'Not watched';
      top.appendChild(el('span', 'badge ' + c.status, label));
      var stats = el('span', 'stats');
      stats.appendChild(document.createTextNode(usd(c.turnoverUsd24h) + ' '));
      if (typeof c.change24hPct === 'number') {
        var ch = el('span', c.change24hPct >= 0 ? 'pos' : 'neg', (c.change24hPct >= 0 ? '+' : '') + c.change24hPct.toFixed(2) + '%');
        stats.appendChild(ch);
      }
      top.appendChild(stats);
      card.appendChild(top);

      var row = el('div', 'tfs');
      TFS.forEach(function (tf) {
        var on = c.timeframes.indexOf(tf) !== -1;
        var b = el('button', 'tf' + (on ? ' on' : ''), tf);
        b.type = 'button';
        b.disabled = !!state.busy[c.symbol];
        b.setAttribute('aria-pressed', on ? 'true' : 'false');
        b.addEventListener('click', function () {
          var next = on ? c.timeframes.filter(function (t) { return t !== tf; }) : c.timeframes.concat([tf]);
          save(c, next);
        });
        row.appendChild(b);
      });
      if (c.status === 'active' || c.status === 'paused') {
        var rm = el('button', 'remove', 'Remove');
        rm.type = 'button';
        rm.disabled = !!state.busy[c.symbol];
        rm.addEventListener('click', function () { save(c, []); });
        row.appendChild(rm);
      }
      card.appendChild(row);
      if (c.status === 'paused') card.appendChild(el('div', 'note', 'Below the volume filter: alerts resume on these timeframes when volume recovers.'));
      if (c.status === 'removed') card.appendChild(el('div', 'note', 'You removed this coin. Tick a timeframe to add it back.'));
      list.appendChild(card);
    });
  }
  function save(coin, timeframes) {
    state.busy[coin.symbol] = true;
    render();
    api('POST', { symbol: coin.symbol, timeframes: timeframes }).then(function (j) {
      if (j.coin) {
        state.coins = state.coins.map(function (c) { return c.symbol === j.coin.symbol ? j.coin : c; });
      } else {
        state.coins = state.coins.map(function (c) { return c.symbol === coin.symbol ? Object.assign({}, c, { status: 'removed', timeframes: [] }) : c; });
      }
      state.meta = Object.assign({}, state.meta, j);
      toast(j.message || 'Saved');
    }).catch(function (e) {
      toast(e.message, true);
    }).then(function () {
      delete state.busy[coin.symbol];
      render();
    });
  }
  function load() {
    api('GET').then(function (j) {
      state.coins = j.coins || [];
      state.meta = j;
      render();
    }).catch(function (e) {
      meta.textContent = '';
      list.textContent = '';
      list.appendChild(el('div', 'empty', e.message));
    });
  }

  document.getElementById('q').addEventListener('input', function (e) { state.query = e.target.value; render(); });
  Array.prototype.forEach.call(document.querySelectorAll('.filters button'), function (b) {
    b.addEventListener('click', function () {
      state.filter = b.getAttribute('data-filter');
      Array.prototype.forEach.call(document.querySelectorAll('.filters button'), function (x) { x.className = x === b ? 'on' : ''; });
      render();
    });
  });

  if (!initData) {
    meta.textContent = '';
    list.appendChild(el('div', 'empty', 'Open this page from the Coins button in the EMA Tracker bot in Telegram.'));
    return;
  }
  tg.ready();
  tg.expand();
  load();
})();
`;
