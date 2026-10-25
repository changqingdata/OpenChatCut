#!/usr/bin/env node
// One command from audio + subtitles to a rendered vertical video.
//
//   node production/make-video.mjs \
//     --audio a.mp3 --srt a.srt --brief "讲复利" --name 复利v3
//
// It composes the existing `occ` commands rather than reimplementing them, so
// anything it does you can also do by hand, one step at a time.
//
// The only step that needs intelligence is the storyboard. Three ways to supply
// it, in order of preference:
//
//   --generate            call the configured LLM (needs LLM_<PROVIDER>_API_KEY)
//   --from <reply.json>   validate a storyboard written or produced elsewhere
//   --storyboard <sb.json> reuse one that already passed validation
//
// Captions are always built from --srt and burned into the render; pass
// --no-captions to skip them, or --captions-template <id> to change the look.
//
// Everything after the storyboard is deterministic.

import { execFile } from 'node:child_process';
import { mkdir, access, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';

const run = promisify(execFile);
const require = createRequire(import.meta.url);
const ffprobe = require('@ffprobe-installer/ffprobe').path;

const OCC = resolve('cli/occ.mjs');

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      args[key] = next;
      i += 1;
    } else {
      args[key] = true;
    }
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
for (const required of ['audio', 'srt', 'brief', 'name']) {
  if (!args[required]) {
    console.error(`missing --${required}\n`);
    console.error('usage: node production/make-video.mjs --audio a.mp3 --srt a.srt --brief "讲什么" --name 工程名');
    console.error('       [--generate | --from reply.json | --storyboard sb.json] [--out out.mp4] [--size 1080x1920]');
    process.exit(1);
  }
}

const audioPath = resolve(String(args.audio));
const srtPath = resolve(String(args.srt));
const projectName = String(args.name);
const size = String(args.size ?? '1080x1920');
const workDir = resolve('production/work', projectName);
const outPath = resolve(String(args.out ?? `${workDir}/out.mp4`));

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function occ(...cliArgs) {
  try {
    const { stdout } = await run(process.execPath, [OCC, ...cliArgs], {
      maxBuffer: 32 * 1024 * 1024,
      env: process.env,
    });
    return stdout;
  } catch (error) {
    const detail = error.stderr?.trim() || error.message;
    throw new Error(`occ ${cliArgs.slice(0, 2).join(' ')} failed:\n${detail}`);
  }
}

function jsonOf(stdout) {
  // Commands may print a Node warning before the payload; skip to the first
  // line that opens a JSON document, then take everything after it.
  const lines = stdout.split('\n');
  const start = lines.findIndex((line) => /^\s*[[{]/.test(line));
  if (start === -1) throw new Error(`command produced no JSON://n${stdout.slice(0, 300)}`);
  return JSON.parse(lines.slice(start).join('\n'));
}

function step(message) {
  console.log(`\n▸ ${message}`);
}

// --- 1. duration ----------------------------------------------------------

step('probe audio');
const { stdout: probeOut } = await run(ffprobe, [
  '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', audioPath,
]);
const seconds = Number(probeOut.trim());
if (!Number.isFinite(seconds) || seconds <= 0) throw new Error(`cannot read duration of ${audioPath}`);
const fps = 30;
const durationFrames = Math.round(seconds * fps);
console.log(`  ${seconds.toFixed(2)}s → ${durationFrames} frames @ ${fps}fps`);

// --- 2. project -----------------------------------------------------------

step(`project ${projectName}`);
const listOut = await occ('project', 'list', '--json');
const listed = jsonOf(listOut);
const projects = Array.isArray(listed) ? listed : (listed.projects ?? []);
let projectId = projects.find((project) => project.name === projectName)?.id;
if (projectId) {
  console.log(`  reusing ${projectId}`);
} else {
  const created = await occ('project', 'new', projectName, '--size', size, '--fps', String(fps));
  projectId = created.match(/created\s+([0-9a-f-]{36})/)?.[1];
  if (!projectId) throw new Error(`could not read the new project id from: ${created.trim()}`);
  console.log(`  created ${projectId}`);
}

// --- 3. audio into the pool ----------------------------------------------

step('import voiceover');
const imported = jsonOf(await occ(
  'tools', 'call', 'import_asset', '--project', projectName,
  '--args', JSON.stringify({ path: audioPath }), '--apply', '--json',
));
// `occ tools call --json` reports { ops: [{ tool, result }] }; import_asset
// answers with { imported: [...] }. A re-run of the same file imports nothing
// and reports a duplicate, so fall back to the pool entry with that name.
const importResult = imported.ops?.[0]?.result;
let assetId = importResult?.imported?.[0]?.id;
if (!assetId) {
  const pool = jsonOf(await occ('media', 'list', '--project', projectName, '--json'));
  const base = audioPath.split(/[\\/]/).pop();
  const match = (pool.assets ?? []).find((entry) => entry.sourceFilename === base || entry.name === base);
  assetId = match?.id;
  if (assetId) console.log(`  already in the pool, reusing ${assetId}`);
}
if (!assetId) throw new Error(`could not read the imported asset id: ${JSON.stringify(imported).slice(0, 400)}`);
console.log(`  asset ${assetId}`);

// --- 4. storyboard --------------------------------------------------------

const storyboardPath = resolve(`${workDir}/storyboard.json`);
await mkdir(dirname(storyboardPath), { recursive: true });

if (args.storyboard) {
  step('reuse storyboard');
  console.log(`  ${resolve(String(args.storyboard))}`);
} else if (args.from) {
  step('validate storyboard from file');
  await occ('storyboard', '--srt', srtPath, '--brief', String(args.brief),
    '--from', resolve(String(args.from)), '--out', storyboardPath, '--size', size);
  console.log(`  → ${storyboardPath}`);
} else if (args.generate) {
  step('generate storyboard');
  await occ('storyboard', '--srt', srtPath, '--brief', String(args.brief),
    '--generate', '--out', storyboardPath, '--size', size);
  console.log(`  → ${storyboardPath}`);
} else {
  step('emit prompt (no key, no reply given)');
  const prompt = await occ('storyboard', '--srt', srtPath, '--brief', String(args.brief), '--prompt');
  const promptPath = resolve(`${workDir}/prompt.txt`);
  await mkdir(dirname(promptPath), { recursive: true });
  const { writeFile } = await import('node:fs/promises');
  await writeFile(promptPath, prompt, 'utf8');
  console.log(`  prompt → ${promptPath}`);
  console.log('  answer it, then re-run with --from <reply.json>');
  process.exit(0);
}

const effectiveStoryboard = args.storyboard ? resolve(String(args.storyboard)) : storyboardPath;

// --- 5. compile -----------------------------------------------------------

step('compile onto the timeline');
const compiled = jsonOf(await occ(
  'compile', projectName, '--storyboard', effectiveStoryboard,
  '--timeline', 'tl-main', '--replace', '--apply', '--json',
  // Captions come from the subtitle file so the burned-in text matches what is
  // actually said, not what the storyboard asked for.
  '--srt', srtPath,
  ...(args['captions-template'] ? ['--captions-template', String(args['captions-template'])] : []),
  ...(args['no-captions'] ? ['--no-captions'] : []),
));
console.log(`  ${compiled.items} items on ${compiled.timelineId}`);
for (const warning of compiled.warnings ?? []) console.log(`  warning: ${warning.message}`);

// --- 6. voiceover onto A1 -------------------------------------------------

step('place voiceover on A1');
await occ('tools', 'call', 'edit_item', '--project', projectName, '--args', JSON.stringify({
  adds: [{ type: 'audio', assetId, track: 'A1', fromFrame: 0, durationInFrames: durationFrames }],
}), '--apply');

// --- 7. background music --------------------------------------------------

const finalStoryboard = JSON.parse(await readFile(effectiveStoryboard, 'utf8'));
const musicCategory = finalStoryboard.music?.category;
if (musicCategory && !args['no-music']) {
  step(`music: ${musicCategory}`);
  await occ('assets', 'place', projectName,
    '--role', 'music',
    '--category', String(musicCategory),
    '--min-duration', String(Math.ceil(seconds)),
    // Cap to the video so the fade-out lands inside the cut rather than 90s later.
    '--duration-frames', String(durationFrames),
    '--volume', String(args['music-volume'] ?? 0.14));
} else if (!args['no-music']) {
  step('music: none chosen');
}

// --- 8. sound effects -----------------------------------------------------

// A recipe can declare the effect it earns, but placement is a pipeline
// decision: one per recipe, at its first appearance, three at most. A 259-shot
// video would otherwise fire an effect every four seconds and read as noise.
const sfxPlan = [];
const seenRecipes = new Set();
for (const shot of finalStoryboard.shots ?? []) {
  const recipeId = shot.visual?.recipe;
  if (!recipeId || seenRecipes.has(recipeId)) continue;
  seenRecipes.add(recipeId);

  let schema;
  try {
    schema = JSON.parse(await readFile(`production/recipes/${recipeId}/schema.json`, 'utf8'));
  } catch {
    continue;
  }
  if (!schema.sfx) continue;
  sfxPlan.push({ recipeId, shot, sfx: schema.sfx });
  if (sfxPlan.length >= 3) break;
}

if (sfxPlan.length && !args['no-sfx']) {
  for (const { recipeId, shot, sfx } of sfxPlan) {
    step(`sfx: ${recipeId} @ ${shot.startFrame}`);
    // A missing effect is a polish problem, not a reason to lose the render.
    try {
      await occ('assets', 'place', projectName,
        '--role', 'sound_effect',
        '--category', String(sfx.category),
        ...(sfx.query ? ['--query', String(sfx.query)] : []),
        '--track', 'A3',
        '--from-frame', String(shot.startFrame),
        '--volume', String(sfx.volume ?? 0.35));
    } catch (error) {
      console.log(`  skipped: ${String(error.message).split('\n').pop()}`);
    }
  }
} else if (!args['no-sfx']) {
  step('sfx: none declared');
}

// --- 9. render ------------------------------------------------------------

step('render');
await mkdir(dirname(outPath), { recursive: true });
// Absolute path is mandatory: a relative --out breaks the AAC delay probe.
await occ('render', projectName, '--out', outPath, '--resolution', '1080p', '--quiet');

if (!(await exists(outPath))) throw new Error(`render reported success but ${outPath} is missing`);
console.log(`\n✓ ${outPath}`);
console.log(`  storyboard: ${effectiveStoryboard}`);
