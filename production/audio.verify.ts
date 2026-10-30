// The audio measurements were app-only: the maths was pure but the only decoder
// was WebAudio. `decodeMono` closes that, and this checks the three things that
// would make the numbers quietly wrong.
import { strict as assert } from 'node:assert';

import { decodeMono } from './audio-decode.ts';
import { analyzeAudioFile, DEFAULT_TARGET_LUFS } from '../cli/commands/audio.ts';
import { gainForTarget, integratedLoudnessFromSamples } from '../src/audio/loudness.ts';

const AUDIO = 'E:/Anacondapj/ChangqingCut/test/测试/路径/短视频测试.mp3';

// 1. decoding: the samples must match the file, or every later number is fiction
const audio = decodeMono(AUDIO);
assert.ok(audio.samples.length > 0, 'decoded something');
assert.equal(audio.sampleRate, 16_000, 'mono 16k');
const seconds = audio.samples.length / audio.sampleRate;
assert.ok(Math.abs(seconds - audio.durationMs / 1000) < 0.01, 'duration agrees with the sample count');
assert.ok(seconds > 20 && seconds < 40, `a 25s clip decoded as ${seconds.toFixed(2)}s`);
assert.ok(audio.samples.some((value) => value !== 0), 'samples are not silence');

// 2. loudness: a plausible number for speech, and the gain really hits the target
const lufs = integratedLoudnessFromSamples(audio.samples, audio.sampleRate);
assert.ok(lufs > -35 && lufs < -5, `speech measured at ${lufs.toFixed(1)} LUFS`);

const gain = gainForTarget(lufs, DEFAULT_TARGET_LUFS);
assert.ok(gain > 0.1 && gain < 10, `gain ${gain.toFixed(2)} is in range`);
assert.ok(
  Math.abs(gain - 10 ** ((DEFAULT_TARGET_LUFS - lufs) / 20)) < 0.01,
  'gain is the decibel conversion, not a guess',
);

const scaled = Float32Array.from(audio.samples, (value) => value * gain);
const after = integratedLoudnessFromSamples(scaled, audio.sampleRate);
assert.ok(
  Math.abs(after - DEFAULT_TARGET_LUFS) < 0.6,
  `applying the gain lands on the target: ${after.toFixed(1)} vs ${DEFAULT_TARGET_LUFS}`,
);

// 3. the report a command returns
const report = analyzeAudioFile(AUDIO, DEFAULT_TARGET_LUFS);
assert.equal(report.targetLufs, DEFAULT_TARGET_LUFS);
assert.equal(report.lufs, Number(lufs.toFixed(1)), 'the report rounds, it does not re-measure');
assert.ok(Array.isArray(report.beats) && Array.isArray(report.downbeats), 'beat arrays are always arrays');
assert.ok(report.bpm === null || report.bpm > 0, 'bpm is null or positive, never zero');

// A target that is already met must produce gain 1 rather than drifting.
assert.ok(Math.abs(gainForTarget(-16, -16) - 1) < 1e-9, 'a clip at target is left alone');

console.log(`audio.verify: ${seconds.toFixed(1)}s decoded, ${lufs.toFixed(1)} LUFS → ×${gain.toFixed(2)}, beats ${report.beats.length}`);
