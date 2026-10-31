// Where one music track ends and the next begins.
//
// A long cut cannot be scored by one song — the library is tracks, not loops — so
// `assets place --loop` chains several end to end. The seam used to land wherever
// the previous file happened to run out, which is almost never a bar line: the
// next track's downbeat arrives mid-phrase and the join reads as a mistake.
//
// The fix is to end the outgoing track on one of its own downbeats. The incoming
// track then starts at its beginning, on its own beat one, and both sides of the
// seam are metrically correct.
//
// Kept as a pure function so the arithmetic is testable without downloading
// anything: give it a track length and the downbeats, get a cut point back.

export interface DownbeatCutOptions {
  /**
   * Do not cut before this share of the track. A downbeat four seconds in would
   * leave a two-minute track almost entirely unused, and the next one would run
   * just as short — the bed would stutter instead of flowing.
   */
  minRatio?: number;
}

/**
 * The last downbeat at or before `naturalFrames`, in frames.
 *
 * Returns null when the track has no usable downbeat — a speech-like or
 * rubato track has no bar lines to land on, and a hard cut is then the honest
 * answer rather than a cut at a beat nobody can hear.
 */
export function downbeatCut(
  naturalFrames: number,
  downbeatsSec: readonly number[],
  fps: number,
  options: DownbeatCutOptions = {},
): number | null {
  if (!(naturalFrames > 0) || !(fps > 0) || !downbeatsSec.length) return null;
  const floor = naturalFrames * (options.minRatio ?? 0.5);
  let best: number | null = null;
  for (const seconds of downbeatsSec) {
    if (!Number.isFinite(seconds) || seconds <= 0) continue;
    const frame = Math.round(seconds * fps);
    if (frame > naturalFrames || frame < floor) continue;
    if (best === null || frame > best) best = frame;
  }
  return best;
}

/**
 * How long a track should run when another one follows it.
 *
 * `null` means "leave it whole" — either the track has no downbeats, or the
 * alignment would throw away too much of it.
 */
export function chainedDuration(
  naturalFrames: number,
  downbeatsSec: readonly number[],
  fps: number,
  options: DownbeatCutOptions = {},
): { frames: number; aligned: boolean } {
  const cut = downbeatCut(naturalFrames, downbeatsSec, fps, options);
  return cut === null
    ? { frames: naturalFrames, aligned: false }
    : { frames: cut, aligned: true };
}
