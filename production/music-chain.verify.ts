// A music bed longer than one track is a chain, and the seam is where it shows.
//
// The old behaviour cut wherever the file ended. With 20-second library tracks
// and a 25-second cut that is one seam in the middle of a phrase, which reads as
// a mistake even when nobody can say why. Ending the outgoing track on its own
// downbeat puts the incoming track's beat one on a bar line.
//
// The arithmetic is pure, so it is tested here without downloading anything; the
// last block checks it against a real bundled track.
import { strict as assert } from 'node:assert';

import { chainedDuration, downbeatCut } from './assets/music-chain.ts';
import { analyzeAudioFile } from '../cli/commands/audio.ts';

const FPS = 30;
const TRACK = 'E:/Anacondapj/OpenChatCut/assets/audio/track-1.mp3';

// --- 1. the cut lands on the last usable downbeat ---------------------------

const beats = [1.0, 2.0, 3.0, 4.0, 5.0];
assert.equal(downbeatCut(180, beats, FPS), 150, '5.0s is the last downbeat inside a 6s track');
assert.equal(downbeatCut(120, [1.0, 2.0, 7.0], FPS), 60, 'a downbeat past the end is not a candidate');

// A downbeat in the first half would throw most of the track away, and the next
// track would then be cut just as short — the bed would stutter instead of flow.
assert.equal(downbeatCut(600, [1.0], FPS), null, 'nothing before the halfway mark is usable');
assert.equal(downbeatCut(600, [1.0, 12.0], FPS), 360, 'a downbeat just past halfway is usable');

assert.equal(downbeatCut(600, [], FPS), null, 'no downbeats means no alignment');
assert.equal(downbeatCut(0, beats, FPS), null, 'a zero-length track has no cut');
assert.equal(downbeatCut(600, [Number.NaN, -1, 0], FPS), null, 'garbage is ignored, not propagated');

// --- 2. the wrapper reports whether it aligned -----------------------------

const aligned = chainedDuration(600, [5.0, 10.0, 15.0, 19.0], FPS);
assert.equal(aligned.aligned, true);
assert.equal(aligned.frames, 570, '19s → 570 frames');

const unaligned = chainedDuration(600, [1.0], FPS);
assert.deepEqual(unaligned, { frames: 600, aligned: false }, 'falls back to the whole track');

// --- 3. against a real track ----------------------------------------------

const report = analyzeAudioFile(TRACK);
assert.ok(report.downbeats.length >= 4, `the bundled track has downbeats (${report.downbeats.length})`);

const natural = Math.round((report.durationMs / 1000) * FPS);
const real = chainedDuration(natural, report.downbeats, FPS);
assert.equal(real.aligned, true, 'a real track aligns');
assert.ok(real.frames < natural, 'the cut is before the end');
assert.ok(real.frames > natural * 0.5, 'and after the halfway mark');

// --- 4. the seam a 25s cut would actually get -----------------------------

// Two 20s tracks covering a 766-frame cut: the first ends on its downbeat, the
// second starts there and runs to the end.
const LIMIT = 766;
let cursor = 0;
const seams: number[] = [];
let tracks = 0;
for (const downbeats of [report.downbeats, report.downbeats]) {
  if (cursor >= LIMIT) break;
  const remaining = LIMIT - cursor;
  const duration = remaining > natural ? chainedDuration(natural, downbeats, FPS).frames : remaining;
  if (cursor > 0) seams.push(cursor);
  cursor += duration;
  tracks += 1;
}
assert.equal(tracks, 2, 'two tracks cover a 25.5s cut');
assert.equal(seams.length, 1, 'exactly one seam');
assert.ok(seams[0]! < natural, 'the seam sits inside the first track, on its downbeat');
assert.ok(cursor >= LIMIT, `the bed still covers the cut (${cursor} >= ${LIMIT})`);

console.log(`music-chain.verify: seam at frame ${seams[0]} (${(seams[0]! / FPS).toFixed(2)}s) of a ${(natural / FPS).toFixed(0)}s track, bed covers ${cursor} frames`);
