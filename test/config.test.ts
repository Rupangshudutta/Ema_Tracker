import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_USER_SETTINGS, MARGIN_OPTIONS_PCT, VOLUME_OPTIONS_USD, validateUserSettings } from '../core/config/settings.ts';
import { parseRuntimeEnv } from '../core/config/env.ts';

describe('user settings', () => {
  it('accepts the defaults and an empty object', () => {
    assert.deepEqual(validateUserSettings(DEFAULT_USER_SETTINGS), { ok: true, value: DEFAULT_USER_SETTINGS });
    assert.deepEqual(validateUserSettings({}), { ok: true, value: DEFAULT_USER_SETTINGS });
  });

  it('offers exactly the agreed margin and volume choices', () => {
    assert.deepEqual([...MARGIN_OPTIONS_PCT], [0, 0.01, 0.02, 0.03, 0.04, 0.05, 0.06, 0.07, 0.08, 0.09, 0.1]);
    assert.deepEqual([...VOLUME_OPTIONS_USD], [5e6, 10e6, 15e6, 20e6, 30e6, 50e6, 100e6]);
    for (const m of MARGIN_OPTIONS_PCT) assert.equal(validateUserSettings({ signal: { marginPct: m } }).ok, true);
  });

  it('rejects values outside the choices and reports each by path', () => {
    const r = validateUserSettings({ signal: { marginPct: 0.11 }, coins: { volumeThresholdUsd: 7e6, defaultTimeframes: ['2h'] } });
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.ok(r.errors.some(e => e.startsWith('signal.marginPct')));
      assert.ok(r.errors.some(e => e.startsWith('coins.volumeThresholdUsd')));
      assert.ok(r.errors.some(e => e.startsWith('coins.defaultTimeframes')));
    }
  });

  it('rejects unknown groups and keys instead of ignoring them', () => {
    const r = validateUserSettings({ coins: { volumeThresholdUsd: 10e6, extra: 1 }, other: {} });
    assert.equal(r.ok, false);
    if (!r.ok) assert.deepEqual(r.errors.sort(), ['unknown group: other', 'unknown setting: coins.extra']);
  });

  it('sorts timeframes, rejects duplicates, validates time and zone', () => {
    const r = validateUserSettings({ coins: { defaultTimeframes: ['4h', '5m', '15m'] } });
    assert.equal(r.ok && r.value.coins.defaultTimeframes.join(','), '5m,15m,4h');
    assert.equal(validateUserSettings({ coins: { defaultTimeframes: ['5m', '5m'] } }).ok, false);
    assert.equal(validateUserSettings({ monitoring: { dailyReportTime: '24:00' } }).ok, false);
    assert.equal(validateUserSettings({ monitoring: { timeZone: 'Mars/Base' } }).ok, false);
    assert.equal(validateUserSettings({ delivery: { pausedUntil: -5 } }).ok, false);
  });
});

describe('runtime environment', () => {
  // Built at runtime so no token-shaped string sits in the repo (keeps secret scanners quiet).
  const fakeToken = ['123456789', 'x'.repeat(35)].join(':');
  const good = { TELEGRAM_BOT_TOKEN: fakeToken, TELEGRAM_CHAT_ID: '987654321' };

  it('parses the minimum and defaults admins to the chat and role to active', () => {
    const r = parseRuntimeEnv(good);
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.deepEqual(r.value.adminUserIds, ['987654321']);
      assert.equal(r.value.role, 'active');
      assert.equal(r.value.healthcheckPingUrl, null);
    }
  });

  it('names missing or malformed variables without echoing their values', () => {
    const r = parseRuntimeEnv({ TELEGRAM_BOT_TOKEN: 'not-a-token-value', TELEGRAM_CHAT_ID: 'abc', RUNTIME_ROLE: 'primary', HEALTHCHECK_PING_URL: 'http://insecure.example' });
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.errors.length, 5);
      assert.ok(r.errors.every(e => !e.includes('not-a-token-value') && !e.includes('insecure.example')));
    }
  });
});
