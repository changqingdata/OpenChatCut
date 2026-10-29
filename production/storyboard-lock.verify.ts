// Contract test for the storyboard lock.
//
// The lock is the only thing standing between "an agent edited a shot" and "a
// broken shot reached a render", so its states have to be exact: `match` is a
// file the pipeline wrote, `edited` is one it did not, `unlocked` is a
// hand-authored storyboard that was never generated. Getting `unlocked` wrong
// would refuse every hand-written storyboard; getting `edited` wrong would let
// every edit through.
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { inspectLock, readLock, writeLock, lockPath } from './storyboard-lock.ts';

const dir = resolve('production/work/.tmp/lock-verify');
rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });

const file = resolve(dir, 'sb.json');
writeFileSync(file, '{"version":1}\n', 'utf8');

// --- no lock ---------------------------------------------------------------

assert.equal(readLock(file), null, 'no lock file reads as null');
assert.equal(inspectLock(file).state, 'unlocked', 'a hand-authored storyboard is legal');

// --- locked ----------------------------------------------------------------

const lock = writeLock(file, { action: 'storyboard' });
assert.equal(lock.action, 'storyboard', 'the producing command is recorded');
assert.equal(lock.hash.length, 64, 'sha256 hex');
assert.equal(inspectLock(file).state, 'match', 'an untouched file matches its lock');
assert.equal(readLock(file)?.hash, lock.hash, 'the lock survives a round trip');

// --- edited ----------------------------------------------------------------

writeFileSync(file, '{"version":1,"shots":[]}\n', 'utf8');
const edited = inspectLock(file);
assert.equal(edited.state, 'edited', 'a changed file no longer matches');
assert.notEqual(edited.hash, lock.hash, 'and the hash is what changed');

// --- re-locked -------------------------------------------------------------

// This is what `revise` does after a validated edit: the new bytes get their own
// lock, and the file is trusted again without anyone passing --allow-edited.
const relock = writeLock(file, { action: 'revise' });
assert.equal(inspectLock(file).state, 'match', 'a re-lock makes the new bytes the baseline');
assert.notEqual(relock.hash, lock.hash, 'the baseline moved');

// --- corrupt lock ----------------------------------------------------------

writeFileSync(lockPath(file), 'not json', 'utf8');
assert.equal(readLock(file), null, 'an unreadable lock is no lock');
assert.equal(inspectLock(file).state, 'unlocked', 'and the file is treated as hand-authored');

rmSync(dir, { recursive: true, force: true });
console.log('storyboard-lock.verify: states, hashing and re-lock OK');
