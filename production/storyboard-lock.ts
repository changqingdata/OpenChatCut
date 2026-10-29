// The storyboard lock.
//
// A generated storyboard carries the hash of its own bytes. That is the only
// thing standing between "an agent edited a shot" and "a broken shot reached a
// render": `compile` writes a timeline, and a timeline has no validator of its
// own.
//
// Three states, and the difference between them is the whole design:
//
//   match     the file is byte-identical to what the pipeline wrote
//   edited    someone changed it after the fact
//   unlocked  no lock file — a hand-authored storyboard, which is legal
//
// The lock is not "you may not edit". It is "an edit that has not been through
// the validator may not be rendered". `revise` validates, writes, and re-locks;
// that is the sanctioned path. `--allow-edited` exists for the case where a
// hand-written file was locked by accident, not as a way to skip QC.
//
// This lived in `production/skill-host/` until it became clear that the MCP
// lane — the one an external agent uses — never checked it at all. A rule
// enforced on one of two channels is not a rule.

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

export interface StoryboardLock {
  file: string;
  hash: string;
  /** ISO timestamp of the write that produced this hash. */
  at: string;
  /** Which command produced the file: `storyboard`, `footage`, `revise`. */
  action?: string;
  /** The skill-host run that produced it, when there was one. */
  runId?: string;
}

export type LockState = 'match' | 'edited' | 'unlocked';

export interface LockInspection {
  file: string;
  /** Hash of the file as it is on disk right now. */
  hash: string;
  state: LockState;
  lock?: StoryboardLock;
}

export function hashFile(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

export function lockPath(file: string): string {
  return `${file}.lock.json`;
}

export function readLock(file: string): StoryboardLock | null {
  const at = lockPath(file);
  if (!existsSync(at)) return null;
  try {
    const parsed = JSON.parse(readFileSync(at, 'utf8')) as Partial<StoryboardLock>;
    // A corrupt lock is treated as no lock: the file it describes cannot be
    // proven either way, and refusing to compile would be a worse failure than
    // accepting a storyboard the validator is about to check anyway.
    return typeof parsed?.hash === 'string' ? (parsed as StoryboardLock) : null;
  } catch {
    return null;
  }
}

export function inspectLock(file: string): LockInspection {
  const hash = hashFile(file);
  const lock = readLock(file);
  if (!lock) return { file, hash, state: 'unlocked' };
  return lock.hash === hash
    ? { file, hash, state: 'match', lock }
    : { file, hash, state: 'edited', lock };
}

export function writeLock(
  file: string,
  meta: { action?: string; runId?: string } = {},
): StoryboardLock {
  const lock: StoryboardLock = {
    file,
    hash: hashFile(file),
    at: new Date().toISOString(),
    ...(meta.action ? { action: meta.action } : {}),
    ...(meta.runId ? { runId: meta.runId } : {}),
  };
  writeFileSync(lockPath(file), `${JSON.stringify(lock, null, 2)}\n`, 'utf8');
  return lock;
}

// Policy — what to do about an `edited` storyboard — deliberately lives in
// `cli/commands/common.ts`, not here. This module only answers "what state is
// this file in"; a module that both inspects and refuses is harder to reuse
// from `revise`, which needs the inspection in order to fix it.
