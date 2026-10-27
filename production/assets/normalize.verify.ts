// Verifies the frame-rate normaliser's decision rules. The transcode itself is
// exercised by running the pipeline over a real NTSC clip; what must not drift
// is which rates get treated as fractional, because that decision silently
// decides whether a render survives.
//
//   npx tsx production/assets/normalize.verify.ts

import assert from 'node:assert/strict';
import { integerRateFor, isIntegerFrameRate } from './normalize.ts';

// Whole rates are left alone.
for (const rate of ['30/1', '25/1', '24/1', '60/1', '30', '25', ' 30/1 ']) {
  assert.equal(isIntegerFrameRate(rate), true, `${rate} is a whole rate`);
}

// NTSC rates are the ones that break the compositor's seek maths.
for (const rate of ['30000/1001', '60000/1001', '24000/1001', '29.97', '23.976']) {
  assert.equal(isIntegerFrameRate(rate), false, `${rate} is fractional`);
}

// A rate that divides evenly is whole even when written as a fraction.
assert.equal(isIntegerFrameRate('60/2'), true, '60/2 is 30');

// Garbage must not be mistaken for a usable rate: an unknown rate is treated as
// fractional so the file gets normalised rather than trusted.
for (const rate of ['', 'abc', '0/1', '30/0', '-30/1']) {
  assert.equal(isIntegerFrameRate(rate), false, `"${rate}" is not a usable rate`);
}

// The target is the nearest whole rate, so 29.97 keeps its speed.
assert.equal(integerRateFor('30000/1001'), 30);
assert.equal(integerRateFor('60000/1001'), 60);
assert.equal(integerRateFor('24000/1001'), 24);
assert.equal(integerRateFor('25/1'), 25);
assert.equal(integerRateFor('30'), 30);
assert.equal(integerRateFor('nonsense'), 30, 'an unreadable rate falls back to 30');

console.log('normalize.verify: frame-rate decisions OK');
