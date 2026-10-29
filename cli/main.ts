// `occ` — OpenChatCut command line. Runs against the local project library with
// no app, no browser and no MCP session in the loop; writes still go through the
// same offline edit-session contract the app and external agents use.
import { flagText, parseCommandLine } from './args.ts';
import { EXIT_FAILURE, EXIT_OK, EXIT_USAGE, UsageError, failureEnvelope, failureLines } from './errors.ts';
import { writeStderr, writeStdout } from './output.ts';
import { applyGlobalOptions } from './profile.ts';

const USAGE = `occ — OpenChatCut command line

Usage
  occ project list [--all] [--json]
  occ project show [<project>] [--doc] [--json]
  occ project new <name> [--size 1920x1080] [--fps 30] [--json]
  occ timeline show [<project>] [--json]
  occ timeline items [<project>] [--track <track id>] [--timeline <id>] [--json]
  occ media ls [<project>] [--json]
  occ render [<project>] --out <file> [--resolution 1080p] [--fps 30] [--codec h264] [--from <frame|4s>] [--to <frame|4s>] [--dry-run] [--quiet]
  occ still [<project>] --out <dir> --frames <n,n,…> [--timeline <id>] [--json]
  occ compile [<project>] --storyboard <file.json> [--timeline <id>] [--replace] [--apply] [--json]
  occ storyboard --srt <file.srt> --brief "<one line>" (--prompt | --from <reply> | --generate) [--out <file.json>]
  occ assets search --role <role> [--query q] [--category c] [--limit n] [--json]
  occ assets place <project> --role music --category c --min-duration s [--track A2] [--volume 0.14]
  occ footage resolve <project> --storyboard <in.json> [--out <out.json>] [--max-clips n] [--dry-run]
  occ qc --storyboard <file.json> [--strict] [--json]
  occ catalog [--recipe <id>] [--full] [--json]
  occ check --storyboard <file.json> [--size WxH] [--json]
  occ apply <project> --storyboard <file.json> --audio <file> [--srt <file>] [--replace] [--json]
  occ revise <file.json> (--ops <ops.json> | --replace-with <file.json>) [--json]
  occ transcribe --audio <file> [--model base] [--language zh] [--out timing.json] [--json]
  occ config [--json]
  occ mcp                      run the pipeline as an MCP server on stdio
  occ export jianying [<project>] [--draft-name <name>] [--out-dir <dir>] [--json]
  occ item move <clip> [--track <track>] [--start <frame|4s>] [--apply]
  occ item trim <clip> [--start <frame>] [--duration <frames|4s>] [--fade-in <s>] [--fade-out <s>] [--ripple] [--apply]
  occ item split <clip> --at <frame|4s> [--apply]
  occ item rm <clip> [--ripple] [--apply]
  occ item dup <clip> [--apply]
  occ tools ls [--all] [--json]
  occ tools call <tool> [--args '<json>' | --args @file.json] [--apply] [--json]
  occ edit --ops '[{"tool":"set_aspect_ratio","args":{"ratio":"9:16"}}]' [--apply] [--json]
  occ where [--json]

Global flags
  --project <id|prefix|name>   project to act on (default: most recently updated)
  --data-dir <path>            use a specific OpenChatCut library instead of the active profile
  --json                       machine-readable output on stdout
  --help                       this text

Writes
  Only \`occ tools call --apply\` writes. It opens one offline edit session, commits
  atomically through the same revision check the app uses, and snapshots a pre-edit
  version, so every committed command is undoable from the app's version history.
  Without --apply the draft is discarded and the project is left untouched.

Projects
  <project> accepts a full id, a unique id prefix, or a unique name.`;

/**
 * Print a failure and pick the exit code.
 *
 * `--json` gets the envelope rather than prose: a caller that asked for machine
 * output should not have to parse a sentence to learn which stage failed. The
 * exit code is unchanged, so scripts that branch on it keep working.
 */
function reportError(error: unknown, json: boolean, step?: string): number {
  const usage = error instanceof UsageError;

  if (json) {
    writeStderr(JSON.stringify(failureEnvelope(error, step), null, 2));
  } else {
    for (const line of failureLines(error)) writeStderr(line);
    if (usage) writeStderr('Run `occ --help` for usage.');
  }

  return usage ? EXIT_USAGE : EXIT_FAILURE;
}

export async function run(argv: readonly string[]): Promise<number> {
  let commandLine;
  try {
    commandLine = parseCommandLine(argv);
  } catch (error) {
    // Parsing failed, so there is no --json to honour: a caller that cannot even
    // form a command line gets the human form.
    return reportError(error, false, 'parse');
  }

  if (commandLine.flags.has('help')) {
    writeStdout(USAGE);
    return EXIT_OK;
  }
  if (commandLine.positionals.length === 0) {
    writeStdout(USAGE);
    return EXIT_USAGE;
  }

  // The failing stage is inferred from the command the caller asked for, so a
  // supervisor reading the envelope does not have to map subcommands to stages.
  const step = commandLine.positionals[0] ? String(commandLine.positionals[0]) : undefined;
  const json = commandLine.flags.has('json');

  try {
    applyGlobalOptions({ dataDir: flagText(commandLine, 'data-dir') });
  } catch (error) {
    return reportError(error, json, 'setup');
  }

  try {
    // Dynamic on purpose: static import would load server/runtime-profile.ts (and
    // therefore freeze the profile) before --data-dir was applied above.
    const { runCommand } = await import('./router.ts');
    await runCommand(commandLine);
    return EXIT_OK;
  } catch (error) {
    return reportError(error, json, step);
  }
}

process.exitCode = await run(process.argv.slice(2));
