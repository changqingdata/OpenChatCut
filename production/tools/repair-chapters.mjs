#!/usr/bin/env node
// Repair a chapter-merged storyboard whose later chapters used absolute frames.
//
// Before `rebaseCues` existed, a chapter that opened at 00:12:30 produced shots
// starting near frame 22500, and the merge added the chapter offset on top. The
// result is one continuous run followed by a jump of roughly the whole elapsed
// time, repeated once per affected chapter.
//
// The fix is the same logic the generator now applies up front: split at the
// jumps, rebase each segment to where the previous one ended. This repairs an
// existing file without spending another model call.
//
//   node production/tools/repair-chapters.mjs <in.json> [out.json]

import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const [, , input, output] = process.argv;
if (!input) {
  console.error('usage: node production/tools/repair-chapters.mjs <in.json> [out.json]');
  process.exit(1);
}

const source = resolve(input);
const target = resolve(output ?? input.replace(/\.json$/, '.repaired.json'));

const storyboard = JSON.parse(await readFile(source, 'utf8'));
const shots = storyboard.shots ?? [];
if (!shots.length) {
  console.error('no shots in the storyboard');
  process.exit(1);
}

// Split wherever the next shot does not start where the previous one ended.
const segments = [];
let current = [shots[0]];
for (let index = 1; index < shots.length; index += 1) {
  const previous = shots[index - 1];
  const shot = shots[index];
  if (shot.startFrame !== previous.endFrame) {
    segments.push(current);
    current = [];
  }
  current.push(shot);
}
segments.push(current);

let cursor = 0;
let repaired = 0;
const out = [];

for (const segment of segments) {
  const shift = segment[0].startFrame - cursor;
  if (shift !== 0) repaired += segment.length;
  for (const shot of segment) {
    const startFrame = shot.startFrame - shift;
    out.push({ ...shot, startFrame, endFrame: shot.endFrame - shift });
  }
  cursor = segment[segment.length - 1].endFrame - shift;
}

storyboard.shots = out;
await writeFile(target, `${JSON.stringify(storyboard, null, 2)}\n`, 'utf8');

const duration = out[out.length - 1].endFrame;
console.log(`segments: ${segments.length}`);
console.log(`shifted: ${repaired} shots`);
console.log(`duration: ${duration} frames (${(duration / (storyboard.meta?.fps ?? 30)).toFixed(1)}s)`);
console.log(`→ ${target}`);
