// Verifies the host layer's pure parts: argument decoding, flag parsing and
// artifact collection. These are the rules an agent can only learn by failing,
// so they get tested rather than trusted.
//
//   node production/skill-host/step.verify.mjs
//
// Deliberately no model and no browser: the whole point of keeping this logic
// in the repository is that it can be checked in a second.
import assert from 'node:assert/strict';
import { collectArtifacts, collectProject, decode, newRunId, parseRunArgs } from './step.mjs';

// --- decode ---------------------------------------------------------------
// The caller splits the command on whitespace, so a space can only arrive as
// %20; quotes survive as literal characters.

assert.equal(decode('--brief'), '--brief', 'plain token passes through');
assert.equal(decode('复利%20的力量'), '复利 的力量', '%20 becomes a space');
assert.equal(decode('a%09b'), 'a\tb', '%09 becomes a tab');
assert.equal(decode('100%25'), '100%', '%25 becomes a percent sign');
assert.equal(decode('%2520'), '%20', 'an escaped percent is not decoded twice');
assert.equal(decode('"E:/a b.mp3"'), 'E:/a b.mp3', 'balanced double quotes are dropped');
assert.equal(decode("'E:/a.mp3'"), 'E:/a.mp3', 'balanced single quotes are dropped');
assert.equal(decode('"E:/a.mp3'), '"E:/a.mp3', 'an unbalanced quote is left alone');
assert.equal(decode('"'), '"', 'a lone quote is left alone');
assert.equal(decode('E:/他说.mp3'), 'E:/他说.mp3', 'CJK paths are untouched');

// --- parseRunArgs ---------------------------------------------------------
// Our flags come before the subcommand; everything from the subcommand on is
// passed through verbatim.

assert.deepEqual(parseRunArgs(['where']), { opts: { wait: 45_000, allowEdited: false }, argv: ['where'] });
assert.deepEqual(
  parseRunArgs(['--wait', '9000', 'render', '--project', 'x']),
  { opts: { wait: 9000, allowEdited: false }, argv: ['render', '--project', 'x'] },
  'wait is consumed, the subcommand and its flags are not',
);
assert.equal(parseRunArgs(['--wait', '999999', 'status']).opts.wait, 100_000, 'wait is clamped to the tool ceiling');
assert.equal(parseRunArgs(['--wait', '1', 'status']).opts.wait, 1000, 'wait has a floor');
assert.equal(parseRunArgs(['--allow-edited', 'qc', '--json']).opts.allowEdited, true);
assert.deepEqual(parseRunArgs(['--wait', '5000', '--', 'make', '--name', 'x']).argv, ['make', '--name', 'x'], 'the separator never becomes the subcommand');
// A flag that only looks like ours belongs to the subcommand, not to us.
assert.deepEqual(parseRunArgs(['render', '--wait', '1']).argv, ['render', '--wait', '1'], 'flags after the subcommand are the subcommand’s');

// --- collectArtifacts -----------------------------------------------------
// `make` takes no --out; it announces what it produced instead, so the host
// never has to know the work directory layout.

const makeLog = [
  '▸ render',
  '',
  '✓ E:\\work\\p1\\out.mp4',
  '  storyboard: E:\\work\\p1\\storyboard.json',
  'artifact: E:\\work\\p1\\out.mp4',
].join('\n');
assert.deepEqual(collectArtifacts([], makeLog), ['E:\\work\\p1\\out.mp4'], 'the announced artifact is collected');
assert.deepEqual(collectArtifacts([], 'nothing here'), [], 'a log without an artifact yields nothing');

assert.deepEqual(
  collectArtifacts(['still', '--out', 'E:/stills', '--frames', '15'], ''),
  ['E:/stills'],
  '--out is collected even when nothing was announced',
);
assert.deepEqual(
  collectArtifacts(['render', '--out', 'E:/a.mp4'], 'artifact: E:/a.mp4\n'),
  ['E:/a.mp4'],
  'the same path announced twice is collected once',
);
assert.deepEqual(collectArtifacts(['x', '--out-dir', 'E:/d'], ''), ['E:/d'], '--out-dir counts as an output');

// --- collectProject -------------------------------------------------------
// `make` announces the project it wrote into. The id matters: it is what the
// agent hands the user instead of calling target_project and killing the turn.
assert.deepEqual(
  collectProject('✓ E:/w/out.mp4\nartifact: E:/w/out.mp4\nproject: 14c1d2e5-8aef-4384-a797-d53ee7e4139a 桌面测试3\n'),
  { id: '14c1d2e5-8aef-4384-a797-d53ee7e4139a', name: '桌面测试3' },
  'the project line yields id and name',
);
assert.deepEqual(
  collectProject('project: 14c1d2e5-8aef-4384-a797-d53ee7e4139a\n'),
  { id: '14c1d2e5-8aef-4384-a797-d53ee7e4139a', name: null },
  'a name is optional',
);
assert.equal(collectProject('project: 桌面测试3\n'), null, 'a name without an id is not a project line');
assert.equal(collectProject(''), null, 'no line, no project');

// --- newRunId -------------------------------------------------------------
const id = newRunId(new Date('2026-10-27T03:12:33.000Z'));
assert.match(id, /^20261027031233-[a-z0-9]{5}$/, 'run ids sort by time and stay unique enough');

console.log('skill-host.verify: decode, flags, artifacts, project and run ids OK');
