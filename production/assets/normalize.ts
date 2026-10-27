// Stock libraries serve a lot of NTSC-rate footage (30000/1001, 60000/1001).
// The Remotion compositor reads that rational as a plain integer, so a frame at
// 4.87s becomes "position 146030" — 4.87 × 30000 — and the render dies with
// "No frame found at position 146030". Nothing in our code is wrong; the clip
// just has to arrive at a constant integer rate.
//
// So every downloaded video is checked once and transcoded only when its rate is
// a fraction. Constant-rate, CRF 20, no audio: the underlay is muted anyway, and
// re-encoding a B-roll clip at that quality is not visible under a scrim.
import { spawn } from 'node:child_process';
import { rename, rm, stat } from 'node:fs/promises';
import { ffmpegBin, ffprobeBin } from '../../server/media-binaries.ts';

/** "30000/1001" is not integer; "30/1" and "25" are. */
export function isIntegerFrameRate(rate: string): boolean {
  const trimmed = rate.trim();
  if (!trimmed) return false;
  const [numerator, denominator] = trimmed.split('/');
  const top = Number(numerator);
  const bottom = denominator === undefined ? 1 : Number(denominator);
  if (!Number.isFinite(top) || !Number.isFinite(bottom) || bottom === 0 || top <= 0) return false;
  return top % bottom === 0;
}

/** Nearest whole frame rate: 29.97 → 30, 59.94 → 60, 25 → 25. */
export function integerRateFor(rate: string): number {
  const [numerator, denominator] = rate.trim().split('/');
  const top = Number(numerator);
  const bottom = denominator === undefined ? 1 : Number(denominator);
  if (!Number.isFinite(top) || !Number.isFinite(bottom) || bottom === 0 || top <= 0) return 30;
  return Math.max(1, Math.round(top / bottom));
}

function run(binary: string, args: readonly string[]): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(binary, args, { windowsHide: true });
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk: Buffer) => { out += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk: Buffer) => { err += chunk.toString('utf8'); });
    child.on('error', rejectPromise);
    child.on('close', (code) => {
      if (code === 0) resolvePromise(out);
      else rejectPromise(new Error(`${binary} exited ${code}: ${err.trim().slice(-400)}`));
    });
  });
}

/** The first video stream's declared rate, or '' when the file has no video. */
export async function probeFrameRate(file: string): Promise<string> {
  const out = await run(ffprobeBin(), [
    '-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=r_frame_rate', '-of', 'csv=p=0', file,
  ]);
  return out.trim().split('\n')[0] ?? '';
}

export interface NormalizeResult {
  /** False when the clip already had a whole frame rate and was left alone. */
  changed: boolean;
  before: string;
  after: string;
  bytesBefore: number;
  bytesAfter: number;
}

/**
 * Re-encode `file` in place when its frame rate is fractional.
 *
 * Best effort by design: a clip that cannot be re-encoded is left as it is, and
 * the caller still gets a usable file. Failing the whole video because one stock
 * clip has an odd rate would be worse than the odd rate itself.
 */
export async function normalizeVideoRate(file: string): Promise<NormalizeResult> {
  const before = await probeFrameRate(file).catch(() => '');
  const bytesBefore = await stat(file).then((info) => info.size).catch(() => 0);
  if (!before || isIntegerFrameRate(before)) {
    return { changed: false, before, after: before, bytesBefore, bytesAfter: bytesBefore };
  }

  const target = integerRateFor(before);
  const temp = `${file}.cfr.mp4`;
  try {
    await run(ffmpegBin(), [
      '-y', '-v', 'error',
      '-i', file,
      '-vf', `fps=${target}`,
      '-c:v', 'libx264', '-crf', '20', '-preset', 'veryfast',
      '-pix_fmt', 'yuv420p', '-an', '-movflags', '+faststart',
      temp,
    ]);
    const bytesAfter = await stat(temp).then((info) => info.size);
    if (bytesAfter === 0) throw new Error('transcode produced an empty file');
    await rename(temp, file);
    return { changed: true, before, after: `${target}/1`, bytesBefore, bytesAfter };
  } catch {
    await rm(temp, { force: true });
    return { changed: false, before, after: before, bytesBefore, bytesAfter: bytesBefore };
  }
}
