// Telegram menus and commands (S5). Only the configured chat and admin user IDs are answered; anyone else is ignored.
// Buttons edit the menu message in place, so the chat does not fill up with menus.
import { MARGIN_OPTIONS_PCT, SYSTEM, TIMEFRAMES, VOLUME_OPTIONS_USD, isTimeframe, type Timeframe } from '../config/settings.ts';
import { escapeHtml, type InlineButton, type InlineKeyboard, type TelegramClient, type TelegramUpdate } from '../notify/telegram.ts';
import type { Engine } from './engine.ts';
import { fmtDateTime, fmtUsd, renderStatus, renderTopList, tzLabel, type TopListKind } from './messages.ts';

interface Screen {
  html: string;
  keyboard: InlineKeyboard;
}

const REPORT_TIMES = ['06:00', '07:00', '08:00', '09:00', '10:00', '12:00', '18:00', '21:00'] as const;
const PAUSE_CHOICES: readonly [number, string][] = [[60, '1 h'], [240, '4 h'], [720, '12 h'], [1440, '24 h']];

const button = (text: string, data: string): InlineButton => ({ text, callback_data: data });
const back = (to = 'nav:main'): InlineButton[] => [button('« Back', to)];
const rows = (buttons: InlineButton[], perRow: number): InlineButton[][] => {
  const out: InlineButton[][] = [];
  for (let i = 0; i < buttons.length; i += perRow) out.push(buttons.slice(i, i + perRow));
  return out;
};

/** The mini app only runs against Cloudflare (it needs a public HTTPS address) and only in a private chat. */
function miniAppUrl(engine: Engine): string | null {
  const env = engine.env;
  if (!env?.publicBaseUrl || env.telegramChatId.startsWith('-') || engine.host.runtime !== 'Cloudflare') return null;
  return `${env.publicBaseUrl.replace(/\/$/, '')}/app`;
}

function pausedUntil(engine: Engine): number | null {
  const until = engine.settings().delivery.pausedUntil;
  return until !== null && until > engine.now() ? until : null;
}

function mainScreen(engine: Engine): Screen {
  const s = engine.settings();
  const st = engine.status();
  const until = pausedUntil(engine);
  const tz = s.monitoring.timeZone;
  const app = miniAppUrl(engine);
  return {
    html: [
      `🤖 <b>EMA Tracker</b> · ${st.runtime} (${st.role})`,
      `EMA 9/15 · margin ${s.signal.marginPct.toFixed(2)}% · volume filter ${fmtUsd(s.coins.volumeThresholdUsd)} · ${st.coins.active} coins`,
      until ? `Alerts: ⏸ paused until ${fmtDateTime(until, tz)} ${tzLabel(tz)}` : 'Alerts: on',
      st.problems.length ? `⚠️ ${escapeHtml(st.problems.join('; '))}` : ''
    ].filter(Boolean).join('\n'),
    keyboard: {
      inline_keyboard: [
        [button('📊 Status', 'st'), button('⚙️ Settings', 'nav:set')],
        [button('📈 Top gainers', 'top:gainers'), button('📉 Top losers', 'top:losers')],
        [button('💰 Highest volume', 'top:volume')],
        [app ? { text: '🪙 Coins', web_app: { url: app } } : button('🪙 Coins', 'co')],
        [until ? button('▶️ Resume alerts', 'res') : button('⏸ Pause alerts', 'nav:p'), button('❓ Help', 'hp')]
      ]
    }
  };
}

function settingsScreen(engine: Engine): Screen {
  const s = engine.settings();
  return {
    html: [
      '⚙️ <b>Settings</b>',
      `<b>Margin</b> ${s.signal.marginPct.toFixed(2)}%: how far EMA 9 must pass EMA 15 before an alert (all coins, timeframes and alert types).`,
      `<b>Volume filter</b> ${fmtUsd(s.coins.volumeThresholdUsd)}: coins above this 24 h volume join the watchlist; coins below it pause.`,
      `<b>New coins start on</b> ${s.coins.defaultTimeframes.join(', ')}.`,
      `<b>Cancel notes</b> ${s.realtime.cancelNotes ? 'on' : 'off'}: a short note when a realtime cross reverses before the close.`,
      `<b>Daily report</b> at ${s.monitoring.dailyReportTime} ${tzLabel(s.monitoring.timeZone)}.`
    ].join('\n'),
    keyboard: {
      inline_keyboard: [
        [button(`Margin ${s.signal.marginPct.toFixed(2)}%`, 'nav:m'), button(`Volume ${fmtUsd(s.coins.volumeThresholdUsd)}`, 'nav:v')],
        [button(`New coins: ${s.coins.defaultTimeframes.join(', ')}`, 'nav:tf')],
        [button(`Cancel notes: ${s.realtime.cancelNotes ? 'on' : 'off'}`, 'cn'), button(`Report ${s.monitoring.dailyReportTime}`, 'nav:rt')],
        back()
      ]
    }
  };
}

function pickerScreen(title: string, options: { label: string; data: string; current: boolean }[], perRow: number): Screen {
  return {
    html: title,
    keyboard: { inline_keyboard: [...rows(options.map(o => button(o.current ? `✓ ${o.label}` : o.label, o.data)), perRow), back('nav:set')] }
  };
}

function marginScreen(engine: Engine): Screen {
  const current = engine.settings().signal.marginPct;
  return pickerScreen(
    '📏 <b>Margin</b>\nHow far EMA 9 must pass EMA 15, in percent of EMA 15. Higher = fewer, stronger alerts. Changing it rebuilds every coin quietly (no alerts from history).',
    MARGIN_OPTIONS_PCT.map(m => ({ label: `${m.toFixed(2)}%`, data: `m:${m}`, current: Math.abs(m - current) < 1e-9 })),
    4
  );
}

function volumeScreen(engine: Engine): Screen {
  const current = engine.settings().coins.volumeThresholdUsd;
  return pickerScreen(
    `💧 <b>Volume filter</b>\nCoins above this 24 h volume join the watchlist (up to ${SYSTEM.coins.maxWatchlistCoins}); coins below it pause and keep your timeframes.`,
    VOLUME_OPTIONS_USD.map(v => ({ label: fmtUsd(v), data: `v:${v}`, current: v === current })),
    4
  );
}

function defaultTfScreen(engine: Engine): Screen {
  const current = engine.settings().coins.defaultTimeframes;
  return pickerScreen(
    '🕒 <b>Timeframes for new coins</b>\nTap to tick or untick. Coins already on the watchlist keep their own timeframes (change those in Coins).',
    TIMEFRAMES.map(tf => ({ label: tf, data: `tf:${tf}`, current: current.includes(tf) })),
    4
  );
}

function reportTimeScreen(engine: Engine): Screen {
  const s = engine.settings();
  return pickerScreen(
    `☀️ <b>Daily report time</b> (${tzLabel(s.monitoring.timeZone)})\nThe report says the bot is alive and sums up the last 24 h.`,
    REPORT_TIMES.map(t => ({ label: t, data: `rt:${t}`, current: t === s.monitoring.dailyReportTime })),
    4
  );
}

function pauseScreen(): Screen {
  return {
    html: '⏸ <b>Pause alerts</b>\nWhile paused, alerts are recorded but not sent. Status messages and the daily report still come.',
    keyboard: { inline_keyboard: [rows(PAUSE_CHOICES.map(([min, label]) => button(label, `p:${min}`)), 4)[0]!, [button('Until I resume', 'p:0')], back()] }
  };
}

const TOP_KINDS: readonly TopListKind[] = ['gainers', 'losers', 'volume'];
const isTopKind = (v: string): v is TopListKind => (TOP_KINDS as readonly string[]).includes(v);

/** The v1 bot's Top Gainers / Top Losers / Highest Volume lists, with buttons to switch between them. */
async function topScreen(engine: Engine, kind: TopListKind): Promise<Screen> {
  const r = await engine.topList(kind);
  const watched = new Set(engine.watchRows().filter(w => w.status === 'active').map(w => w.symbol));
  return {
    html: renderTopList(kind, r.items, r.at, r.minVolumeUsd, watched, engine.settings().monitoring.timeZone),
    keyboard: {
      inline_keyboard: [
        [button('📈 Gainers', 'top:gainers'), button('📉 Losers', 'top:losers'), button('💰 Volume', 'top:volume')],
        back()
      ]
    }
  };
}

function statusScreen(engine: Engine): Screen {
  return { html: renderStatus(engine.status(), engine.now()), keyboard: { inline_keyboard: [[button('🔄 Refresh', 'st')], back()] } };
}

function coinsScreen(engine: Engine): Screen {
  const watch = engine.watchRows();
  const active = watch.filter(w => w.status === 'active');
  const paused = watch.filter(w => w.status === 'paused');
  const removed = watch.filter(w => w.status === 'removed');
  const volumes = new Map(engine.coinList().map(c => [c.symbol, c.turnoverUsd24h]));
  const vol = (s: string): string => {
    const v = volumes.get(s);
    return v === null || v === undefined ? '' : ` · ${fmtUsd(v)}`;
  };
  const app = miniAppUrl(engine);
  const lines = [
    `🪙 <b>Watchlist</b> (${active.length}/${SYSTEM.coins.maxWatchlistCoins})`,
    ...active.map(w => `${escapeHtml(w.symbol)} · ${w.timeframes.join(', ')}${vol(w.symbol)}`),
    ...paused.map(w => `${escapeHtml(w.symbol)} · ⏸ paused (below the volume filter) · ${w.timeframes.join(', ')}`)
  ];
  if (!active.length && !paused.length) lines.push('No coins yet: they join within 15 minutes of the bot starting.');
  if (removed.length) lines.push(`Removed by you: ${removed.map(w => escapeHtml(w.symbol)).join(', ')}`);
  lines.push('', app ? 'Tap <b>Open coin picker</b> to search coins and tick timeframes.' : 'Change with /watch BTCUSD 5m 15m · remove with /unwatch BTCUSD');
  return { html: lines.join('\n'), keyboard: { inline_keyboard: [...(app ? [[{ text: '🔎 Open coin picker', web_app: { url: app } }]] : []), back()] } };
}

function helpScreen(engine: Engine): Screen {
  const s = engine.settings();
  return {
    html: [
      '❓ <b>How the alerts work</b>',
      `Every coin on the watchlist is checked on each ticked timeframe (${TIMEFRAMES.join(', ')}) for EMA 9 crossing EMA 15 by more than the margin (${s.signal.marginPct.toFixed(2)}%).`,
      '⚡ <b>REALTIME</b>: the live price crossed while the candle is still open. At most one per candle.',
      '↩️ <b>REALTIME CANCELLED</b>: that cross reversed before the close.',
      '✅ <b>CONFIRMED</b>: the closed candle confirms the cross. This is the one to trust.',
      '❌ <b>NOT CONFIRMED</b>: the realtime cross did not hold at the close.',
      '⏰ <b>LATE</b>: held up by an outage. After 30 min alerts come in one summary; after 6 h they are dropped.',
      '',
      'Commands: /start menu · /status · /top (gainers, losers, volume) · /coins · /watch BTCUSD 5m 15m · /unwatch BTCUSD · /pause 60 · /resume · /settings',
      engine.host.runtime === 'Cloudflare' ? 'Engine switch: /use_docker hands alerts to the Docker spare on your PC.' : 'Engine switch: /use_cloudflare hands alerts back to Cloudflare.'
    ].join('\n'),
    keyboard: { inline_keyboard: [back()] }
  };
}

interface CallbackResult {
  screen?: Screen;
  toast?: string;
}

async function onCallback(engine: Engine, data: string, actor: string): Promise<CallbackResult> {
  const [kind, value = ''] = data.split(/:(.*)/s) as [string, string?];
  const failed = (errors: string[]): CallbackResult => ({ toast: `Not saved: ${errors[0] ?? 'invalid value'}`.slice(0, 190) });
  switch (kind) {
    case 'top':
      return isTopKind(value) ? { screen: await topScreen(engine, value) } : { screen: mainScreen(engine) };
    case 'nav':
      return {
        screen:
          value === 'set' ? settingsScreen(engine)
          : value === 'm' ? marginScreen(engine)
          : value === 'v' ? volumeScreen(engine)
          : value === 'tf' ? defaultTfScreen(engine)
          : value === 'rt' ? reportTimeScreen(engine)
          : value === 'p' ? pauseScreen()
          : mainScreen(engine)
      };
    case 'st':
      return { screen: statusScreen(engine), toast: 'Updated' };
    case 'hp':
      return { screen: helpScreen(engine) };
    case 'co':
      return { screen: coinsScreen(engine) };
    case 'm': {
      const margin = Number(value);
      const r = engine.updateSettings(`margin ${engine.settings().signal.marginPct} -> ${margin}`, actor, s => ({ ...s, signal: { marginPct: margin } }));
      return r.ok ? { screen: settingsScreen(engine), toast: `Margin set to ${margin.toFixed(2)}%` } : failed(r.errors);
    }
    case 'v': {
      const volume = Number(value);
      const r = engine.updateSettings(`volume filter ${engine.settings().coins.volumeThresholdUsd} -> ${volume}`, actor, s => ({ ...s, coins: { ...s.coins, volumeThresholdUsd: volume } }));
      return r.ok ? { screen: settingsScreen(engine), toast: `Volume filter set to ${fmtUsd(volume)}` } : failed(r.errors);
    }
    case 'tf': {
      if (!isTimeframe(value)) return { toast: 'Unknown timeframe' };
      const current = engine.settings().coins.defaultTimeframes;
      const next: Timeframe[] = current.includes(value) ? current.filter(t => t !== value) : [...current, value];
      if (!next.length) return { toast: 'Keep at least one timeframe' };
      const r = engine.updateSettings(`new-coin timeframes ${current.join(',')} -> ${next.join(',')}`, actor, s => ({ ...s, coins: { ...s.coins, defaultTimeframes: next } }));
      return r.ok ? { screen: defaultTfScreen(engine), toast: `New coins: ${engine.settings().coins.defaultTimeframes.join(', ')}` } : failed(r.errors);
    }
    case 'cn': {
      const on = !engine.settings().realtime.cancelNotes;
      const r = engine.updateSettings(`cancel notes ${on ? 'on' : 'off'}`, actor, s => ({ ...s, realtime: { cancelNotes: on } }));
      return r.ok ? { screen: settingsScreen(engine), toast: `Cancel notes ${on ? 'on' : 'off'}` } : failed(r.errors);
    }
    case 'rt': {
      const r = engine.updateSettings(`daily report time -> ${value}`, actor, s => ({ ...s, monitoring: { ...s.monitoring, dailyReportTime: value } }));
      return r.ok ? { screen: settingsScreen(engine), toast: `Daily report at ${value}` } : failed(r.errors);
    }
    case 'p': {
      const minutes = Number(value);
      const r = engine.pause(minutes > 0 ? minutes : null, actor);
      return r.ok ? { screen: mainScreen(engine), toast: minutes > 0 ? `Paused for ${PAUSE_CHOICES.find(p => p[0] === minutes)?.[1] ?? `${minutes} min`}` : 'Paused until you resume' } : failed(r.errors);
    }
    case 'res': {
      const r = engine.resume(actor);
      return r.ok ? { screen: mainScreen(engine), toast: 'Alerts resumed' } : failed(r.errors);
    }
    default:
      return { screen: mainScreen(engine), toast: 'That button is from an older menu' };
  }
}

function parsePauseMinutes(arg: string | undefined): number | null | 'bad' {
  if (!arg) return 60;
  const m = /^(\d+)\s*(m|min|h)?$/i.exec(arg);
  if (!m) return 'bad';
  const v = Number(m[1]) * (m[2]?.toLowerCase() === 'h' ? 60 : 1);
  return v > 0 && v <= 30 * 24 * 60 ? v : 'bad';
}

export async function handleUpdate(engine: Engine, tg: TelegramClient, update: TelegramUpdate): Promise<void> {
  const env = engine.env;
  if (!env) return;
  const admins = new Set(env.adminUserIds);
  const chatId = env.telegramChatId;

  const q = update.callback_query;
  if (q) {
    const allowed = admins.has(String(q.from.id)) && q.message !== undefined && String(q.message.chat.id) === chatId;
    if (!allowed) {
      await tg.answerCallback(q.id, 'Not allowed');
      return;
    }
    const r = await onCallback(engine, q.data ?? '', `user:${q.from.id}`);
    if (r.screen && q.message) await tg.editMessage(chatId, q.message.message_id, r.screen.html, r.screen.keyboard);
    await tg.answerCallback(q.id, r.toast);
    return;
  }

  const m = update.message;
  if (!m?.text || !m.from || !admins.has(String(m.from.id)) || String(m.chat.id) !== chatId) return;
  const actor = `user:${m.from.id}`;
  const [first = '', ...args] = m.text.trim().split(/\s+/);
  const command = first.toLowerCase().replace(/@\w+$/, '');
  const send = async (html: string, keyboard?: InlineKeyboard): Promise<void> => {
    const r = await tg.sendMessage(chatId, html, keyboard ? { replyMarkup: keyboard } : {});
    if (!r.ok) throw new Error(`reply failed: ${r.error.kind}`);
  };
  const show = (s: Screen): Promise<void> => send(s.html, s.keyboard);

  switch (command) {
    case '/start':
    case '/menu':
      return show(mainScreen(engine));
    case '/top':
    case '/gainers':
      return show(await topScreen(engine, 'gainers'));
    case '/losers':
      return show(await topScreen(engine, 'losers'));
    case '/volume':
      return show(await topScreen(engine, 'volume'));
    case '/status':
      return show(statusScreen(engine));
    case '/settings':
      return show(settingsScreen(engine));
    case '/coins':
      return show(coinsScreen(engine));
    case '/help':
      return show(helpScreen(engine));
    case '/watch':
    case '/unwatch': {
      const symbol = (args[0] ?? '').toUpperCase();
      if (!/^[A-Z0-9_.-]{2,40}$/.test(symbol)) return send(`Which coin? For example <code>${command} BTCUSD${command === '/watch' ? ' 5m 15m' : ''}</code>`);
      const tfs = command === '/unwatch' ? [] : args.slice(1).map(a => a.toLowerCase());
      if (command === '/watch' && !tfs.length) return send(`Which timeframes? For example <code>/watch BTCUSD 5m 15m</code> (${TIMEFRAMES.join(', ')}).`);
      const r = engine.setCoinTimeframes(symbol, tfs, actor);
      return send(r.ok ? `✅ ${escapeHtml(r.message)}` : `❌ ${escapeHtml(r.reason)}`);
    }
    case '/pause': {
      const minutes = parsePauseMinutes(args[0]);
      if (minutes === 'bad') return send('Use <code>/pause 60</code> (minutes) or <code>/pause 4h</code>.');
      const r = engine.pause(minutes, actor);
      const s = engine.settings();
      return send(r.ok ? `⏸ Alerts paused until ${fmtDateTime(r.until, s.monitoring.timeZone)} ${tzLabel(s.monitoring.timeZone)}. Send /resume to restart them.` : `❌ ${escapeHtml(r.errors.join('; '))}`);
    }
    case '/resume': {
      const r = engine.resume(actor);
      return send(r.ok ? '▶️ Alerts are on.' : `❌ ${escapeHtml(r.errors.join('; '))}`);
    }
    case '/use_docker':
      return send(escapeHtml(await engine.handOverToDocker(actor)));
    case '/use_cloudflare':
      return send(escapeHtml((await engine.handBackToCloudflare(actor)).message));
    default:
      return send('Send /start for the menu.');
  }
}
