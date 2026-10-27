#!/usr/bin/env node
// The only entry point an agent needs to drive the production pipeline.
//
// Why this file exists: `run_skill_script` starts the process in the skill
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
// polls `status`. Nothing here is a sandbox escape: the tool's cwd is a
// starting directory, not a jail — this script simply changes into the
// repository the user configured.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, openSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SKILL_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG_FILE = join(SKILL_DIR, 'config.json');
const WAIT_DEFAULT = 45_000;
const WAIT_MAX = 100_000;

const emit = (obj) => process.stdout.write(`${JSON.stringify(obj, null, 2)}\n`);

function die(code, message, hint) {
  emit({ ok: false, code, message, ...(hint ? { hint } : {}) });
  process.exit(1);
}

/** The tool splits the command on whitespace, so a space arrives as %20. */
function decode(token) {
  return token.replace(/%(20|25|09)/gi, (m) => {
    const u = m.toUpperCase();
    if (u === '%20') return ' ';
    if (u === '%09') return '\t';
    return '%';
  });
}

function sha256File(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function loadConfig() {
  if (!existsSync(CONFIG_FILE)) {
    die('not-configured', `skill is not configured (missing ${CONFIG_FILE})`, 'run: node scripts/step.mjs init <repoRoot>');
  }
  let cfg;
  try {
    cfg = JSON.parse(readFileSync(CONFIG_FILE, 'utf8'));
  } catch (error) {
    die('bad-config', `config.json is not valid JSON: ${error.message}`, 'run: node scripts/step.mjs init <repoRoot>');
  }
  const root = resolve(String(cfg.repoRoot ?? ''));
  if (!existsSync(join(root, 'cli', 'main.ts'))) {
    die('bad-config', `repoRoot does not look like an OpenChatCut checkout: ${root}`, 'run: node scripts/step.mjs init <repoRoot>');
  }
  return { ...cfg, repoRoot: root };
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
function checkStoryboardLock(cfg, args, allowEdited) {
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

function parseRunArgs(rest) {
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

function newRunId() {
  const now = new Date();
  const stamp = now.toISOString().replace(/[-:T]/g, '').slice(0, 14);
  return `${stamp}-${Math.random().toString(36).slice(2, 7)}`;
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
function sleepSync(ms) {
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
function cmdInit(args) {
  const root = resolve(decode(args[0] ?? ''));
  if (!root || !existsSync(join(root, 'cli', 'main.ts'))) {
    die('bad-repo', `not an OpenChatCut checkout: ${root || '(empty)'}`, 'pass the absolute repository path, e.g. node scripts/step.mjs init E:/path/to/OpenChatCut');
  }
  const cfg = { repoRoot: root };
  writeFileSync(CONFIG_FILE, `${JSON.stringify(cfg, null, 2)}\n`, 'utf8');
  const bin = ensureCli(cfg);
  emit({ ok: true, configured: CONFIG_FILE, repoRoot: root, cli: bin });
}

function cmdDoctor() {
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name, ok, detail });
  const cfg = loadConfig();
  add('config', true, cfg.repoRoot);

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

  const envFile = join(cfg.repoRoot, '.env.local');
  let keys = [];
  if (existsSync(envFile)) {
    keys = readFileSync(envFile, 'utf8')
      .split(/\r?\n/)
      .map((line) => line.split('=', 1)[0].trim())
      .filter((name) => name && !name.startsWith('#'));
  }
  // Names only, never values — and only the ones that decide whether
  // `storyboard --generate` can run. The full list is noise to an agent.
  const llm = keys.filter((name) => /^LLM_[A-Z0-9]+_API_KEY$/.test(name)).map((name) => name.slice(4, -8).toLowerCase());
  add(
    'keys',
    llm.length > 0,
    llm.length
      ? `${keys.length} keys; storyboard --generate available via: ${llm.join(', ')}`
      : 'no LLM key in .env.local — use --prompt (hand the prompt to an external model) or --from (feed its reply back)',
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

  emit({ ok: checks.every((c) => c.ok), checks, repoRoot: cfg.repoRoot });
  process.exit(checks.every((c) => c.ok) ? 0 : 1);
}

function cmdRun(rest) {
  const cfg = loadConfig();
  const { opts, argv } = parseRunArgs(rest);
  if (argv.length === 0) die('bad-usage', 'run needs an occ subcommand', 'e.g. run -- render --project 名字 --out E:/abs.mp4');
  const bin = ensureCli(cfg);
  const decoded = argv.map(decode);
  const storyboard = checkStoryboardLock(cfg, decoded, opts.allowEdited);

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
  const child = spawn(process.execPath, [join(SKILL_DIR, 'scripts', '_child.mjs'), recordFile, bin, ...decoded], {
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
  init: cmdInit,
  doctor: cmdDoctor,
  run: cmdRun,
  status: cmdStatus,
  runs: cmdRuns,
};

function main() {
  const [command, ...rest] = process.argv.slice(2);
  if (!command || command === '--help' || command === 'help') {
    emit({
      ok: true,
      usage: [
        'node scripts/step.mjs init <repoRoot>',
        'node scripts/step.mjs doctor',
        'node scripts/step.mjs run [--wait ms] [--allow-edited] -- <occ subcommand> [flags]',
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

main();
