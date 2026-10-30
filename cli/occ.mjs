#!/usr/bin/env node
// Launcher for the TypeScript CLI: `occ` resolves to this file once the package
// is linked (`npm link`), and it runs the real entry point through the repo's own
// tsx loader. Keep it dependency-free — it runs before any project code loads.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const entry = join(here, 'main.ts');

/**
 * Resolve the TypeScript loader against this file, not against the caller.
 *
 * `node --import tsx` resolves the bare specifier from the process cwd. A
 * launcher started from anywhere else — an MCP host, a desktop shortcut, a
 * scheduled task — fails with "Cannot find package 'tsx'" before a single line
 * of the CLI runs. The MCP server is the case that matters: its clients pick the
 * cwd, and nothing in the config can promise it will be this repository.
 */
function tsxLoader() {
  try {
    const require = createRequire(import.meta.url);
    return pathToFileURL(require.resolve('tsx')).href;
  } catch {
    // Fall back to the specifier: correct whenever the cwd is the repo, and a
    // clearer error than a silent failure if the dependency is genuinely absent.
    return 'tsx';
  }
}

const child = spawn(process.execPath, ['--import', tsxLoader(), entry, ...process.argv.slice(2)], {
  stdio: 'inherit',
  cwd: process.cwd(),
});

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
