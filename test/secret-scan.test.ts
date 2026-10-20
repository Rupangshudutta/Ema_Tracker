import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { findSecrets } from '../scripts/lib/secret-patterns.ts';

// Secret-shaped test values are built at runtime so this file never contains one.
const token = ['7123456789', 'A'.repeat(11) + 'b_c-'.repeat(6)].join(':');
const pingUrl = `https://hc-ping.com/${['1a2b3c4d', '5e6f', '7a8b', '9c0d', '1e2f3a4b5c6d'].join('-')}`;
const keyHeader = ['-----BEGIN', 'PRIVATE KEY-----'].join(' ');

describe('secret scan', () => {
  it('finds bot tokens, Healthchecks ping URLs and private keys, by line', () => {
    const text = ['ok line', `TELEGRAM_BOT_TOKEN=${token}`, 'x', `ping: ${pingUrl}`, keyHeader].join('\n');
    assert.deepEqual(findSecrets(text), [
      { line: 2, kind: 'Telegram bot token' },
      { line: 4, kind: 'Healthchecks ping URL' },
      { line: 5, kind: 'private key' }
    ]);
  });

  it('ignores look-alikes: times, prices, short keys and the plain Healthchecks site', () => {
    const text = ['12:30:45', 'BTCUSD 81957.5:0.99', '123456789:short', 'https://healthchecks.io/docs/', 'https://hc-ping.com/'].join('\n');
    assert.deepEqual(findSecrets(text), []);
  });
});
