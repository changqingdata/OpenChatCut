#!/usr/bin/env node
// Re-check the agent-facing lane end to end, without a model and without a render
// of the whole video.
//
//   node production/verify-agent-lane.mjs          catalog + lock + revise + check
//   node production/verify-agent-lane.mjs --full   also apply, still --width, determinism
//
// Every assertion here is one that has already failed once. The lock used to be
// enforced on one channel only; `apply` used to decide "already resolved" from an
// asset id that is scoped to a different project; `still` used to be 480px wide
// with no way to ask for more. This script is how those stay fixed.
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const FULL = process.argv.includes('--full');
const WORK = resolve('production/work/.tmp/verify-agent');
const FIXTURE = resolve('production/work/复利横屏v4/storyboard.json');
const AUDIO = 'E:/Anacondapj/ChangqingCut/test/测试/路径/短视频测试.mp3';
const SRT = 'E:/Anacondapj/ChangqingCut/test/测试/路径/短视频测试.srt';
const PROJECT = '验证-导演通道';

let failures = 0;
let checks = 0;

function check(label, ok, detail = '') {
  checks += 1;
  if (ok) {
    console.log(`  PASS  ${label}${detail ? `  (${detail})` : ''}`);
  } else {
    failures += 1;
    console.log(`  FAIL  ${label}${detail ? `  (${detail})` : ''}`);
  }
}

/** Run `occ`, returning the exit code and the JSON payload if there is one. */
function occ(args, { expectFailure = false } = {}) {
  let stdout = '';
  let stderr = '';
  let code = 0;
  try {
    stdout = execFileSync(process.execPath, ['cli/occ.mjs', ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (error) {
    code = error.status ?? 1;
    stdout = String(error.stdout ?? '');
    stderr = String(error.stderr ?? '');
    if (!expectFailure) {
      console.error(`\nocc ${args.join(' ')} failed (exit ${code})\n${stderr.slice(-800)}`);
    }
  }
  // A failed command prints its envelope on stderr, not stdout — that is where
  // `{ ok: false, error: { code } }` lives.
  const json = jsonBlock(stdout) ?? jsonBlock(stderr);
  return { code, json, stdout, stderr };
}

/**
 * Find the JSON document in a stream that may be preceded by warnings.
 *
 * Node prints `ExperimentalWarning: SQLite ...` to stderr before anything else,
 * so "does this start with {" is the wrong test — both success payloads (stdout)
 * and failure envelopes (stderr) sit behind it.
 */
function jsonBlock(text) {
  const lines = text.split('\n');
  const start = lines.findIndex((line) => /^\s*[[{]/.test(line));
  if (start === -1) return undefined;
  try {
    return JSON.parse(lines.slice(start).join('\n'));
  } catch {
    return undefined;
  }
}

function jpegWidth(file) {
  const buffer = readFileSync(file);
  for (let i = 0; i < buffer.length - 9; i += 1) {
    if (buffer[i] === 0xFF && (buffer[i + 1] === 0xC0 || buffer[i + 1] === 0xC2)) {
      return buffer.readUInt16BE(i + 7);
    }
  }
  return 0;
}

if (!existsSync(FIXTURE)) {
  console.error(`fixture missing: ${FIXTURE}\nRun one video first (occ storyboard / make) and re-run this.`);
  process.exit(1);
}
rmSync(WORK, { recursive: true, force: true });
mkdirSync(WORK, { recursive: true });

// --- 1. catalog ------------------------------------------------------------

console.log('\ncatalog');
const catalog = occ(['catalog', '--json']);
check('catalog returns 15 recipes', catalog.json?.recipes?.length === 15, `${catalog.json?.recipes?.length}`);
check('the index stays small enough to keep in context',
  JSON.stringify(catalog.json).length < 8192, `${JSON.stringify(catalog.json).length} bytes`);
check('every recipe declares what it can draw',
  (catalog.json?.recipes ?? []).every((recipe) => Array.isArray(recipe.jobs) && recipe.jobs.length > 0));
check('every recipe has a reference still',
  (catalog.json?.recipes ?? []).every((recipe) => typeof recipe.still === 'string' && existsSync(recipe.still)),
  `${(catalog.json?.recipes ?? []).filter((recipe) => recipe.still).length}/15`);
const detail = occ(['catalog', '--recipe', 'compare-stack', '--json']);
check('one recipe can be read in full', Object.keys(detail.json?.recipe?.params ?? {}).length > 0);

// --- 2. the lock -----------------------------------------------------------

console.log('\nstoryboard lock');
const locked = resolve(WORK, 'sb.json');
copyFileSync(FIXTURE, locked);
const relock = occ(['revise', locked, '--replace-with', FIXTURE, '--json']);
check('revise --replace-with validates and locks', relock.json?.lock?.state === 'match', relock.json?.lock?.state);
check('an untouched storyboard passes', occ(['check', '--storyboard', locked, '--json']).code === 0);

// One byte of drift is enough: the hash is the whole mechanism.
writeFileSync(locked, `${readFileSync(locked, 'utf8')}\n`, 'utf8');
const edited = occ(['check', '--storyboard', locked, '--json'], { expectFailure: true });
check('a hand-edit is refused', edited.code === 1 && edited.json?.error?.code === 'storyboard-edited',
  edited.json?.error?.code);
check('--allow-edited lets it through', occ(['check', '--storyboard', locked, '--allow-edited', '--json']).code === 0);

// --- 3. revise -------------------------------------------------------------

console.log('\nrevise');
const fixture = JSON.parse(readFileSync(FIXTURE, 'utf8'));
const firstShot = fixture.shots[0].id;
const ops = resolve(WORK, 'ops.json');
writeFileSync(ops, `${JSON.stringify([{ op: 'set', shot: firstShot, path: 'background', value: '#0A0A0B' }], null, 2)}\n`, 'utf8');
const revised = occ(['revise', locked, '--ops', ops, '--json']);
check('revise applies the op', revised.json?.applied?.length === 1, revised.json?.applied?.join(', '));
check('and re-locks, so the edit is trusted again', revised.json?.lock?.state === 'match');
check('the edited file now checks clean', occ(['check', '--storyboard', locked, '--json']).code === 0);
const after = JSON.parse(readFileSync(locked, 'utf8'));
check('the edit actually landed', after.shots[0].background === '#0A0A0B');

// A revise that would break coverage must write nothing.
const badOps = resolve(WORK, 'bad-ops.json');
writeFileSync(badOps, `${JSON.stringify([{ op: 'remove', shot: after.shots[0].id }], null, 2)}\n`, 'utf8');
const bytesBefore = statSync(locked).size;
const refused = occ(['revise', locked, '--ops', badOps, '--json'], { expectFailure: true });
check('an invalid revise is refused', refused.code === 1 && refused.json?.written === false);
check('and leaves the file untouched', statSync(locked).size === bytesBefore);

// --- 4. full lane ----------------------------------------------------------

if (FULL) {
  if (!existsSync(AUDIO) || !existsSync(SRT)) {
    console.log(`\nskipped apply/still: fixture audio missing\n  ${AUDIO}`);
  } else {
    console.log('\napply');
    occ(['project', 'show', PROJECT, '--json'], { expectFailure: true })
      .code === 0 || occ(['project', 'new', PROJECT, '--size', '1920x1080', '--fps', '30']);
    const applied = occ(['apply', PROJECT, '--storyboard', locked, '--audio', AUDIO, '--srt', SRT,
      '--replace', '--json']);
    check('apply writes a timeline', applied.code === 0, applied.json?.steps?.join(' | '));
    check('with the expected lanes', applied.json?.items === 25, `${applied.json?.items} items`);
    check('footage is materialised into this project, not inherited',
      (applied.json?.steps ?? []).some((step) => step.startsWith('footage:')),
      (applied.json?.steps ?? []).find((step) => step.startsWith('footage:')));

    console.log('\nstill');
    const outDir = resolve(WORK, 'stills');
    const still = occ(['still', PROJECT, '--out', outDir, '--frames', '60', '--width', '1080', '--json']);
    const file = still.json?.written?.[0]?.path;
    check('still honours --width', Boolean(file) && jpegWidth(file) === 1080, file ? `${jpegWidth(file)}px` : 'no file');

    if (process.argv.includes('--determinism')) {
      console.log('\ndeterminism');
      const md5 = [];
      for (const run of [1, 2]) {
        const mp4 = resolve(WORK, `det-${run}.mp4`);
        occ(['render', PROJECT, '--out', mp4, '--from', '168', '--to', '244', '--quiet']);
        const jpg = resolve(WORK, `det-${run}.jpg`);
        execFileSync('ffmpeg', ['-v', 'error', '-ss', '1', '-i', mp4, '-frames:v', '1', '-y', jpg], { stdio: 'ignore' });
        md5.push(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'frame=pkt_size', '-of', 'csv=p=0', jpg], { encoding: 'utf8' }).trim()
          || String(statSync(jpg).size));
      }
      check('two renders of the same range agree', md5[0] === md5[1], md5.join(' vs '));
    }
  }
}

console.log(`\n${checks - failures}/${checks} checks passed${FULL ? '' : '  (pass --full to include apply and still)'}`);
process.exit(failures ? 1 : 0);
