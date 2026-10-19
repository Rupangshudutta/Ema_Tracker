// Golden tests on recorded Delta India candles (test/fixtures/delta). They pin down behaviour on real data:
// a change that alters any alert decision fails here and has to be accepted deliberately.
// To accept a deliberate change: UPDATE_GOLDEN=1 npm test, then review the diff of test/golden/*.json.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { MARGIN_OPTIONS_PCT, SYSTEM } from '../core/config/settings.ts';
import { emaSeries } from '../core/domain/ema.ts';
import { evaluateConfirmed, type ConfirmedCross, type SignalState } from '../core/domain/signal.ts';
import { loadDeltaFixtures } from './helpers.ts';

const PAIR = { fast: SYSTEM.signal.emaFast, slow: SYSTEM.signal.emaSlow };
const fixtures = loadDeltaFixtures();
const EVAL_FROM = 400; // candles before this index only warm up the side

const key = (c: ConfirmedCross): string => `${c.candleStart}:${c.direction}`;

/** Independent check: plain crossovers counted directly from the two EMA series, no hysteresis code involved. */
function rawCrossCount(closes: number[], fromIndex: number): number {
  const f = emaSeries(closes, PAIR.fast);
  const s = emaSeries(closes, PAIR.slow);
  const gap = (i: number): number => f[i - (PAIR.fast - 1)]! - s[i - (PAIR.slow - 1)]!;
  let n = 0;
  for (let i = Math.max(fromIndex, PAIR.slow); i < closes.length; i++) if ((gap(i - 1) < 0 && gap(i) > 0) || (gap(i - 1) > 0 && gap(i) < 0)) n++;
  return n;
}

describe('golden: recorded Delta India candles', () => {
  it(`loaded ${fixtures.length} fixtures of 1,000 closed candles`, () => {
    assert.equal(fixtures.length, 32);
    for (const f of fixtures) assert.equal(f.candles.length, 1000, `${f.symbol} ${f.timeframe}`);
  });

  it('margin 0 finds exactly the plain crossovers', () => {
    for (const f of fixtures) {
      const from = f.candles[EVAL_FROM - 1]!.start;
      const r = evaluateConfirmed(f.candles, PAIR, 0, null, from);
      assert.equal(r.crosses.length, rawCrossCount(f.candles.map(c => c.close), EVAL_FROM), `${f.symbol} ${f.timeframe}`);
    }
  });

  it('cycle-by-cycle runs with a remembered side and 150 candles give the full-history answer', () => {
    for (const margin of [0, 0.05, 0.1]) {
      for (const f of fixtures) {
        const from = f.candles[EVAL_FROM - 1]!.start;
        const full = evaluateConfirmed(f.candles, PAIR, margin, null, from).crosses.map(key);
        let state: SignalState | null = evaluateConfirmed(f.candles.slice(0, EVAL_FROM), PAIR, margin, null, Infinity).state;
        const incremental: string[] = [];
        for (let i = EVAL_FROM; i < f.candles.length; i++) {
          const window = f.candles.slice(i - SYSTEM.signal.candleHistory + 1, i + 1);
          const r = evaluateConfirmed(window, PAIR, margin, state, f.candles[i - 1]!.start);
          assert.equal(r.status, 'advanced', `${f.symbol} ${f.timeframe} at ${i}`);
          incremental.push(...r.crosses.map(key));
          state = r.state;
        }
        assert.deepEqual(incremental, full, `${f.symbol} ${f.timeframe} margin ${margin}`);
      }
    }
  });

  it('alert counts per margin match the frozen snapshot', () => {
    const counts: Record<string, Record<string, number>> = {};
    for (const margin of MARGIN_OPTIONS_PCT) {
      const row: Record<string, number> = {};
      for (const f of fixtures) {
        const n = evaluateConfirmed(f.candles, PAIR, margin, null, f.candles[EVAL_FROM - 1]!.start).crosses.length;
        row[f.timeframe] = (row[f.timeframe] ?? 0) + n;
      }
      counts[margin.toFixed(2)] = row;
    }
    const dir = join(import.meta.dirname, 'golden');
    const file = join(dir, 'margin-sweep.json');
    if (process.env.UPDATE_GOLDEN === '1' || !existsSync(file)) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(file, JSON.stringify(counts, null, 2) + '\n');
      if (process.env.UPDATE_GOLDEN !== '1') assert.fail('golden/margin-sweep.json was missing and has been created; review it and run again');
    }
    assert.deepEqual(counts, JSON.parse(readFileSync(file, 'utf8')));
  });
});
