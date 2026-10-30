// `occ audio analyze` — loudness and tempo, on the command line.
//
// Both measurements already existed, but only inside the app: they take a
// Float32Array and the browser was the only thing that could produce one. This
// is the missing entry point, and it is what lets the pipeline normalise the
// voiceover instead of leaving every project at gain 1.
//
//   occ audio analyze <file> [--target -16] [--json]
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { GLOBAL_FLAGS, flagText, rejectUnknownFlags, type CommandLine } from '../args.ts';
import { UsageError } from '../errors.ts';
import { printJson, writeStdout } from '../output.ts';
import { decodeMono } from '../../production/audio-decode.ts';
import { gainForTarget, integratedLoudnessFromSamples } from '../../src/audio/loudness.ts';
import { analyzeBeats } from '../../src/audio/beats.ts';

const FLAGS = [...GLOBAL_FLAGS, 'target', 'json'] as const;

/** Web/podcast delivery target. Loud enough to hear on a phone, quiet enough to
 * leave headroom for music underneath. */
export const DEFAULT_TARGET_LUFS = -16;

export interface AudioAnalysis {
  file: string;
  durationMs: number;
  lufs: number;
  targetLufs: number;
  gain: number;
  bpm: number | null;
  beats: number[];
  downbeats: number[];
}

/** Measure one file. Shared with `apply`, which uses the gain on A1. */
export function analyzeAudioFile(file: string, targetLufs = DEFAULT_TARGET_LUFS): AudioAnalysis {
  const audio = decodeMono(file);
  const lufs = integratedLoudnessFromSamples(audio.samples, audio.sampleRate);
  const beats = analyzeBeats(audio.samples, audio.sampleRate);
  return {
    file,
    durationMs: audio.durationMs,
    lufs: Number(lufs.toFixed(1)),
    targetLufs,
    gain: Number(gainForTarget(lufs, targetLufs).toFixed(3)),
    bpm: beats.bpm ?? null,
    beats: beats.beats ?? [],
    downbeats: beats.downbeats ?? [],
  };
}

export async function runAudioCommand(commandLine: CommandLine, json: boolean): Promise<void> {
  rejectUnknownFlags(commandLine, FLAGS);
  const [verb, file] = commandLine.positionals;
  if (verb !== 'analyze') throw new UsageError('usage: occ audio analyze <file> [--target -16] [--json]');
  if (!file) throw new UsageError('occ audio analyze needs a file');

  const path = resolve(file);
  if (!existsSync(path)) throw new UsageError(`no such file: ${path}`);

  const targetFlag = flagText(commandLine, 'target');
  const target = targetFlag === undefined ? DEFAULT_TARGET_LUFS : Number(targetFlag);
  if (!Number.isFinite(target) || target > 0) {
    throw new UsageError(`--target expects a negative LUFS value, got "${targetFlag}"`);
  }

  const report = analyzeAudioFile(path, target);
  if (json) {
    printJson(report);
    return;
  }
  writeStdout(`${report.file}`);
  writeStdout(`  ${(report.durationMs / 1000).toFixed(2)}s · ${report.lufs} LUFS · gain ${report.gain}× to ${report.targetLufs}`);
  writeStdout(`  ${report.bpm ? `${report.bpm} BPM` : 'no stable tempo'} · ${report.beats.length} beats · ${report.downbeats.length} downbeats`);
}
