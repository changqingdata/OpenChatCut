#!/usr/bin/env node
// Host layer for the occ-video skill: the only entry point an agent needs.
//
// Why this exists at all: `run_skill_script` starts the process in the skill
// directory, hands it a whitespace-split command string, caps the call at
// 120s, and passes no environment worth relying on. The pipeline needs the
// opposite of all four:
//
//   cwd        the repository root (the default profile derives its media
//              directory from process.cwd(), so a wrong cwd 404s every clip)
//   args       one token per flag value (spaces arrive as %20)
//   duration   a 15-minute render takes ~7 minutes
//   env        OPENCHATCUT_DATA_DIR unset, so media resolves to
//              <repo>/public/media/uploads
//
// So every call returns immediately with a durable run record, and the agent
// polls `status`.
//
// This file lives in the repository, not in the installed skill directory. The
// skill ships a six-line bootstrap that imports it, so there is exactly one
// copy of this logic and it is versioned, diffable and testable. The invariant
// this layer holds: it knows about environments, never about video. It does not
// know where a render lands — `make-video.mjs` prints an `artifact:` line and
// this reads it.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, openSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HOST_FILE = fileURLToPath(import.meta.url);
const HOST_DIR = dirname(HOST_FILE);
/** Where this file lives when it is run straight out of the repository. */
const REPO_DEFAULT = resolve(HOST_DIR, '..', '..');
const WAIT_DEFAULT = 45_000;
const WAIT_MAX = 100_000;

const emit = (obj) => process.stdout.write(`${JSON.stringify(obj, null, 2)}\n`);

function die(code, message, hint) {
  emit({ ok: false, code, message, ...(hint ? { hint } : {}) });
  process.exit(1);
}

/**
 * The tool splits the command on whitespace, so a space arrives as %20.
 * Callers also wrap values in quotes out of habit; the split does not honour
 * quoting, so `--audio "E:/a.mp3"` arrives with literal quotes and every file
 * lookup fails on a path that starts with a quote. Accept and drop them.
 */
export function decode(token) {
  let out = token.replace(/%(20|25|09)/gi, (m) => {
    const u = m.toUpperCase();
    if (u === '%20') return ' ';
    if (u === '%09') return '\t';
    return '%';
  });
  if (out.length >= 2) {
    const head = out[0];
    if ((head === '"' || head === "'") && out[out.length - 1] === head) out = out.slice(1, -1);
  }
  return out;
}

export function sha256File(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

/**
 * Repo root comes from the bootstrap (which read the skill's config.json), or
 * from this file's own location when run inside the checkout.
 */
function loadConfig() {
  const configFile = process.env.OCC_SKILL_CONFIG?.trim();
  let cfg = {};
  if (configFile && existsSync(configFile)) {
    try {
      cfg = JSON.parse(readFileSync(configFile, 'utf8'));
    } catch (error) {
      die('bad-config', `config.json is not valid JSON: ${error.message}`, `fix or delete ${configFile}`);
    }
  }
  const root = resolve(process.env.OCC_REPO_ROOT?.trim() || String(cfg.repoRoot ?? '') || REPO_DEFAULT);
  if (!existsSync(join(root, 'cli', 'main.ts'))) {
    die(
      'bad-repo',
      `not an OpenChatCut checkout: ${root}`,
      'reinstall the skill from the repository: node production/skill/install.mjs',
    );
  }
  return { repoRoot: root, dataDir: cfg.dataDir };
}

function runsDir(repoRoot) {
  const dir = join(repoRoot, 'production', 'work', '.runs');
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** The child environment: the tool's PATH/HOME plus nothing that redirects media. */
function childEnv(cfg) {
  const env = { ...process.env };
  delete env.OPENCHATCUT_DATA_DIR;
  if (cfg.dataDir) env.OPENCHATCUT_DATA_DIR = cfg.dataDir;
  return env;
}

/** Build the bundled CLI once; it turns a 6s tsx start-up into ~0.4s. */
function ensureCli(cfg) {
  const bin = join(cfg.repoRoot, 'cli-dist', 'occ.mjs');
  if (existsSync(bin)) return bin;
  const build = spawnSync(process.execPath, [join(cfg.repoRoot, 'scripts', 'build-cli.mjs')], {
    cwd: cfg.repoRoot,
    encoding: 'utf8',
    env: childEnv(cfg),
  });
  if (build.status !== 0 || !existsSync(bin)) {
    die('cli-build-failed', `could not build cli-dist/occ.mjs (exit ${build.status})`, (build.stderr ?? '').trim().slice(-800) || 'run: npm run build:cli');
  }
  return bin;
}

/** A generated storyboard carries a lock; a hand-edited one must not. */
export function checkStoryboardLock(cfg, args, allowEdited) {
  const at = args.indexOf('--storyboard');
  if (at < 0 || at + 1 >= args.length) return null;
  const file = resolve(cfg.repoRoot, decode(args[at + 1]));
  if (!existsSync(file)) return null;
  const hash = sha256File(file);
  const lockFile = `${file}.lock.json`;
  if (!existsSync(lockFile)) return { file, hash, state: 'unlocked' };
  let lock;
  try {
    lock = JSON.parse(readFileSync(lockFile, 'utf8'));
  } catch {
    return { file, hash, state: 'unlocked' };
  }
  if (lock.hash === hash) return { file, hash, state: 'match', generatedAt: lock.at };
  if (allowEdited) return { file, hash, state: 'edited-allowed' };
  die(
    'storyboard-edited',
    `generated storyboard was modified outside the pipeline: ${file}`,
    'Do not hand-edit a generated storyboard — it bypasses the validator and QC. Re-run the storyboard step with the QC complaint folded into --brief, or pass --allow-edited when the storyboard is hand-authored on purpose.',
  );
}

export function parseRunArgs(rest) {
  const opts = { wait: WAIT_DEFAULT, allowEdited: false };
  let i = 0;
  while (i < rest.length) {
    const token = rest[i];
    if (token === '--wait') {
      const value = Number(rest[i + 1]);
      if (!Number.isFinite(value)) die('bad-usage', '--wait needs milliseconds', 'e.g. run --wait 90000 -- render …');
      opts.wait = Math.min(Math.max(value, 1000), WAIT_MAX);
      i += 2;
      continue;
    }
    if (token === '--allow-edited') {
      opts.allowEdited = true;
      i += 1;
      continue;
    }
    break; // the first token that is not ours starts the occ argv
  }
  // `--` is the explicit separator; drop it so it never becomes the subcommand.
  if (rest[i] === '--') i += 1;
  return { opts, argv: rest.slice(i) };
}

export function newRunId(now = new Date()) {
  const stamp = now.toISOString().replace(/[-:T]/g, '').slice(0, 14);
  return `${stamp}-${Math.random().toString(36).slice(2, 7)}`;
}

/** Artifacts a step announced on stdout, plus any --out path it was given. */
export function collectArtifacts(args, log) {
  const found = new Set();
  for (const match of log.matchAll(/^artifact:\s*(.+)$/gm)) found.add(match[1].trim());
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--out' || args[i] === '--out-dir') {
      const value = args[i + 1];
      if (value) found.add(value);
    }
  }
  return [...found];
}

function readRecord(dir, id) {
  const file = join(dir, `${id}.json`);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** Synchronous sleep: the whole CLI is a poll loop, so this stays on one thread. */
export function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function waitForRecord(dir, id, budget) {
  const deadline = Date.now() + budget;
  let record = readRecord(dir, id);
  while (record && record.status === 'running' && Date.now() < deadline) {
    sleepSync(250);
    record = readRecord(dir, id);
  }
  return record;
}

function report(dir, record, waited) {
  if (!record) die('unknown-run', 'no run record with that id', 'run: node scripts/step.mjs runs');
  const log = record.log && existsSync(record.log) ? readFileSync(record.log, 'utf8') : '';
  // A render log is tens of thousands of "rendering 93%" lines; a prompt is
  // ~11k of text the agent must see whole. Size decides, not the action.
  const tail = log.length <= 20_000 ? log : `…${log.slice(-4000)}`;
  emit({
    ok: record.status === 'done' && record.exitCode === 0,
    runId: record.id,
    status: record.status,
    action: record.action,
    exitCode: record.exitCode,
    startedAt: record.startedAt,
    endedAt: record.endedAt ?? null,
    durationMs: record.endedAt ? Date.parse(record.endedAt) - Date.parse(record.startedAt) : null,
    waitedMs: waited,
    artifacts: record.artifacts ?? [],
    storyboard: record.storyboard ?? null,
    tail,
  });
  process.exit(0);
}

// ── actions ──────────────────────────────────────────────────────────────────

function cmdDoctor() {
  const checks = [];
  // `soft` checks never fail the run: no LLM key only blocks --generate, and
  // --prompt / --from are legitimate ways to work without one.
  const add = (name, ok, detail, soft = false) => checks.push({ name, ok, detail, ...(soft ? { soft } : {}) });
  const cfg = loadConfig();
  add('repo', true, cfg.repoRoot);

  const bin = ensureCli(cfg);
  add('cli', existsSync(bin), bin);

  // The default profile resolves media from process.cwd(); a data-dir override
  // silently points it somewhere else and every clip 404s.
  const env = childEnv(cfg);
  const where = spawnSync(process.execPath, [bin, 'where', '--json'], { cwd: cfg.repoRoot, env, encoding: 'utf8' });
  let parsed = null;
  try {
    parsed = JSON.parse(where.stdout);
  } catch {
    add('occ', false, `where --json failed (exit ${where.status}): ${(where.stderr ?? '').trim().slice(-400)}`);
  }
  if (parsed) {
    add('occ', true, `${parsed.mode} profile`);
    const mediaDir = String(parsed.mediaDir ?? '');
    let uploads = 0;
    try {
      uploads = readdirSync(mediaDir).length;
    } catch {
      uploads = -1;
    }
    add('media-dir', uploads > 0, `${mediaDir} (${uploads < 0 ? 'missing' : `${uploads} files`})`);
    add('env-clean', !('OPENCHATCUT_DATA_DIR' in process.env), 'OPENCHATCUT_DATA_DIR is inherited from the app process; the child strips it unless config.dataDir is set');
  }

  const recipes = join(cfg.repoRoot, 'production', 'recipes');
  let recipeCount = 0;
  try {
    recipeCount = readdirSync(recipes).filter((name) => existsSync(join(recipes, name, 'index.jsx'))).length;
  } catch {
    recipeCount = 0;
  }
  add('recipes', recipeCount >= 15, `${recipeCount} recipes`);

  // Names only, never values — and a name with an empty value is not a
  // provider. Reporting it as one sends the agent straight into a failed
  // --generate, so this reads the value length.
  const envFile = join(cfg.repoRoot, '.env.local');
  const values = new Map();
  if (existsSync(envFile)) {
    for (const line of readFileSync(envFile, 'utf8').split(/\r?\n/)) {
      const at = line.indexOf('=');
      if (at > 0) values.set(line.slice(0, at).trim(), line.slice(at + 1).replace(/[\s\r]/g, ''));
    }
  }
  const llm = [...values.entries()]
    .filter(([name, value]) => /^LLM_[A-Z0-9]+_API_KEY$/.test(name) && value.length > 0)
    .map(([name]) => name.slice(4, -8).toLowerCase());
  add(
    'keys',
    llm.length > 0,
    llm.length
      ? `storyboard --generate available via: ${llm.join(', ')}`
      : 'no LLM key has a value in .env.local — --generate cannot work. Use --prompt (hand the prompt to an external model) or --from (feed its reply back)',
    true,
  );

  const ffmpeg = spawnSync('ffmpeg', ['-version'], { encoding: 'utf8', env });
  add('ffmpeg', ffmpeg.status === 0, ffmpeg.status === 0 ? String(ffmpeg.stdout).split('\n', 1)[0] : 'not on PATH');

  const runs = runsDir(cfg.repoRoot);
  let active = 0;
  for (const name of readdirSync(runs).filter((n) => n.endsWith('.json') && n !== 'latest.json')) {
    const record = readRecord(runs, name.replace(/\.json$/, ''));
    if (record?.status === 'running') active += 1;
  }
  add('runs', true, `${runs} (${active} running)`);

  const blocking = checks.filter((c) => !c.ok && !c.soft);
  emit({ ok: blocking.length === 0, checks, repoRoot: cfg.repoRoot });
  process.exit(blocking.length === 0 ? 0 : 1);
}

function cmdRun(rest) {
  const cfg = loadConfig();
  const { opts, argv } = parseRunArgs(rest);
  if (argv.length === 0) die('bad-usage', 'run needs an occ subcommand', 'e.g. run -- render --project 名字 --out E:/abs.mp4');
  const bin = ensureCli(cfg);
  const decoded = argv.map(decode);
  // `make` is the one-command orchestrator (audio + srt + brief → mp4). It is
  // the right verb for "make me a video"; `run` stays the surgical lane.
  const isMake = decoded[0] === 'make';
  const program = isMake ? join(cfg.repoRoot, 'production', 'make-video.mjs') : bin;
  const args = isMake ? decoded.slice(1) : decoded;
  const storyboard = isMake ? null : checkStoryboardLock(cfg, decoded, opts.allowEdited);

  const dir = runsDir(cfg.repoRoot);
  const id = newRunId();
  const record = {
    id,
    action: decoded[0],
    argv: decoded,
    cwd: cfg.repoRoot,
    startedAt: new Date().toISOString(),
    status: 'running',
    log: join(dir, `${id}.log`),
    storyboard,
  };
  const recordFile = join(dir, `${id}.json`);
  writeFileSync(recordFile, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  writeFileSync(join(dir, 'latest.json'), `${JSON.stringify({ id }, null, 2)}\n`, 'utf8');

  const fd = openSync(record.log, 'a');
  const child = spawn(process.execPath, [join(HOST_DIR, '_child.mjs'), recordFile, program, ...args], {
    cwd: cfg.repoRoot,
    env: childEnv(cfg),
    detached: true,
    stdio: ['ignore', fd, fd],
    windowsHide: true,
  });
  child.unref();

  const started = Date.now();
  const finished = waitForRecord(dir, id, opts.wait);
  report(dir, finished, Date.now() - started);
}

function cmdStatus(rest) {
  const cfg = loadConfig();
  const dir = runsDir(cfg.repoRoot);
  let id = rest.find((token) => !token.startsWith('-')) ?? 'latest';
  if (id === 'latest') {
    const pointer = join(dir, 'latest.json');
    if (!existsSync(pointer)) die('no-runs', 'no run has been started yet', 'run: node scripts/step.mjs run -- where');
    id = JSON.parse(readFileSync(pointer, 'utf8')).id;
  }
  let budget = WAIT_DEFAULT;
  const at = rest.indexOf('--wait');
  if (at >= 0) {
    const value = Number(rest[at + 1]);
    if (Number.isFinite(value)) budget = Math.min(Math.max(value, 1000), WAIT_MAX);
  }
  const started = Date.now();
  report(dir, waitForRecord(dir, id, budget), Date.now() - started);
}

function cmdRuns() {
  const cfg = loadConfig();
  const dir = runsDir(cfg.repoRoot);
  const rows = readdirSync(dir)
    .filter((name) => name.endsWith('.json') && name !== 'latest.json')
    .map((name) => readRecord(dir, name.replace(/\.json$/, '')))
    .filter(Boolean)
    .sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)))
    .slice(0, 20)
    .map((r) => ({ runId: r.id, action: r.action, status: r.status, exitCode: r.exitCode ?? null, startedAt: r.startedAt }));
  emit({ ok: true, runs: rows });
}

const COMMANDS = {
  doctor: cmdDoctor,
  run: cmdRun,
  status: cmdStatus,
  runs: cmdRuns,
};

export function run(argv = process.argv.slice(2)) {
  const [command, ...rest] = argv;
  if (!command || command === '--help' || command === 'help') {
    emit({
      ok: true,
      usage: [
        'node scripts/step.mjs doctor',
        'node scripts/step.mjs run [--wait ms] [--allow-edited] -- <occ subcommand | make> [flags]',
        'node scripts/step.mjs status [<runId>|latest] [--wait ms]',
        'node scripts/step.mjs runs',
      ],
      note: 'Flags are split on whitespace by the caller: write a space as %20.',
    });
    return;
  }
  const handler = COMMANDS[command];
  if (!handler) die('unknown-command', `unknown command "${command}"`, `one of: ${Object.keys(COMMANDS).join(', ')}`);
  handler(rest);
}

// Run when invoked directly (node production/skill-host/step.mjs …), but not
// when the skill's bootstrap imports this module and calls run() itself.
if (process.argv[1] && resolve(process.argv[1]) === resolve(HOST_FILE)) run();
