// Worker half of step.mjs: runs the bundled CLI as a real child, so the exit
// code survives even though the caller (step.mjs) has already returned. Writes
// the terminal state back into the run record — that file is the only thing the
// agent polls, so it must be updated exactly once, atomically.
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';

const [recordFile, occBin, ...argv] = process.argv.slice(2);
const record = JSON.parse(readFileSync(recordFile, 'utf8'));

/** Write through a temp file: a poller must never read a half-written record. */
function writeRecord(next) {
  const tmp = `${recordFile}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  renameSync(tmp, recordFile);
}

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

/** Every `--out` / `--out-dir` path the command was given, resolved. */
function outPaths() {
  const found = [];
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--out' || argv[i] === '--out-dir') {
      const value = argv[i + 1];
      if (value) found.push(resolve(record.cwd, value));
    }
  }
  return found;
}

function describe(path) {
  if (!existsSync(path)) return null;
  const info = statSync(path);
  if (info.isFile()) return { path, bytes: info.size };
  if (info.isDirectory()) {
    const files = readdirSync(path)
      .slice(0, 40)
      .map((name) => ({ name, bytes: statSync(join(path, name)).size }));
    return { path, files };
  }
  return { path };
}

/** A generated storyboard carries its hash; compile refuses a silent hand-edit. */
function lockStoryboard() {
  const at = argv.indexOf('--storyboard');
  const out = argv.indexOf('--out');
  const target = out >= 0 ? argv[out + 1] : at >= 0 ? argv[at + 1] : null;
  if (!target || !existsSync(target) || !target.endsWith('.json')) return null;
  const lock = { file: target, hash: sha256(target), at: new Date().toISOString(), action: record.action, runId: record.id };
  writeFileSync(`${target}.lock.json`, `${JSON.stringify(lock, null, 2)}\n`, 'utf8');
  return lock;
}

const child = spawn(process.execPath, [occBin, ...argv], {
  cwd: record.cwd,
  env: process.env,
  stdio: 'inherit',
  windowsHide: true,
});

child.on('error', (error) => {
  writeRecord({ ...record, status: 'done', exitCode: -1, endedAt: new Date().toISOString(), error: String(error) });
  process.exit(1);
});

child.on('exit', (code, signal) => {
  const next = {
    ...record,
    status: 'done',
    exitCode: code ?? (signal ? -1 : 0),
    signal: signal ?? null,
    endedAt: new Date().toISOString(),
    artifacts: outPaths().map(describe).filter(Boolean),
  };
  if (next.exitCode === 0 && (record.action === 'storyboard' || record.action === 'footage')) {
    const lock = lockStoryboard();
    if (lock) next.storyboard = { file: lock.file, hash: lock.hash, state: 'locked' };
  }
  writeRecord(next);
  process.exit(0);
});
