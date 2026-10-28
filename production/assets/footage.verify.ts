// Verifies the candidate ranking. The rule it replaced preferred whichever
// clip happened to be exactly 1080 wide, which is how an unrelated Shanghai
// skyline beat twelve stacked-coins clips offered at 1280.
//
//   npx tsx production/assets/footage.verify.ts

import assert from 'node:assert/strict';
import { rank } from './footage.ts';
import type { MaterialItem } from './types.ts';

function clip(id: string, width: number, durationSec: number): MaterialItem {
  return {
    provider: 'test',
    providerId: id,
    role: 'video',
    label: id,
    width,
    height: Math.round((width * 9) / 16),
    durationSec,
    downloadUrl: `https://example.invalid/${id}.mp4`,
  };
}

const ids = (items: readonly MaterialItem[]) => items.map((item) => item.providerId);

// The shot needs 2.5s. Two relevant clips at 1280 sit before an unrelated one at
// exactly 1080; provider order says the 1280s are more relevant, so they win.
const mixed = rank([
  clip('coins-a', 1280, 8),
  clip('coins-b', 1280, 12),
  clip('skyline', 1080, 12),
], 2.5);
assert.deepEqual(ids(mixed), ['coins-a', 'coins-b', 'skyline'], 'width is not a relevance signal');

// A clip narrower than the delivery is still worse than one that is wide enough,
// even if the narrow one comes first.
const narrow = rank([clip('small', 640, 9), clip('wide', 1920, 9)], 2.5);
assert.deepEqual(ids(narrow), ['wide', 'small'], 'a rendition under the delivery width loses');

// Covering the shot outranks everything: a short clip freezes on its last frame.
const covering = rank([clip('short', 1920, 1.5), clip('long', 1280, 6)], 2.5);
assert.deepEqual(ids(covering), ['long', 'short'], 'a clip that covers the shot wins');

// Among short clips the one closest to the shot wins.
const shortfall = rank([clip('tiny', 1280, 0.8), clip('nearly', 1280, 2.2)], 2.5);
assert.deepEqual(ids(shortfall), ['nearly', 'tiny'], 'the smaller shortfall wins');

// An unknown width is not evidence of a bad clip — do not sort it below a known
// good one on that basis alone.
const unknown = rank([
  { ...clip('unknown', 0, 9), width: undefined },
  clip('known', 1280, 9),
], 2.5);
assert.deepEqual(ids(unknown), ['unknown', 'known'], 'unknown width is not disqualifying');

// Stable: the same list ranks the same way every time.
assert.deepEqual(ids(rank([clip('a', 1280, 9), clip('b', 1280, 9)], 2.5)), ['a', 'b'], 'ties keep provider order');

console.log('footage.verify: ranking by coverage, width floor and provider order OK');
