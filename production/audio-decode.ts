// Decode audio to mono samples, on the command line.
//
// The app measures loudness and tempo with WebAudio (`OfflineAudioContext`),
// which does not exist in Node. The *math* behind both is already pure —
// `integratedLoudnessFromSamples` and `analyzeBeats` take a Float32Array and a
// sample rate — so the only missing piece was a decoder. ffmpeg is already a
// hard dependency of the render path, so this uses it rather than shipping one.
import { execFileSync } from 'node:child_process';

export interface DecodedAudio {
  samples: Float32Array;
  sampleRate: number;
  durationMs: number;
}

/** Mono, 16 kHz: enough for a 400 ms loudness block and a tempo grid. */
const SAMPLE_RATE = 16_000;

export function decodeMono(path: string): DecodedAudio {
  let raw: Buffer;
  try {
    raw = execFileSync(
      'ffmpeg',
      ['-v', 'error', '-i', path, '-ac', '1', '-ar', String(SAMPLE_RATE), '-f', 'f32le', '-'],
      { maxBuffer: 512 * 1024 * 1024 },
    );
  } catch (error) {
    const detail = (error as { stderr?: Buffer }).stderr?.toString().trim();
    throw new Error(`could not decode ${path}${detail ? `: ${detail.split('\n').at(-1)}` : ''}`);
  }

  // Copy: the Buffer's backing store is not guaranteed to be 4-byte aligned for
  // Float32Array, and a misaligned view throws on construction.
  const aligned = new ArrayBuffer(raw.length - (raw.length % 4));
  new Uint8Array(aligned).set(raw.subarray(0, aligned.byteLength));
  const samples = new Float32Array(aligned);

  return {
    samples,
    sampleRate: SAMPLE_RATE,
    durationMs: Math.round((samples.length / SAMPLE_RATE) * 1000),
  };
}
