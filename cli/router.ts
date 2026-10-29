// Command routing. Nothing here may be imported before cli/profile.ts applied the
// profile override, which is why cli/main.ts imports this module dynamically:
// server/runtime-profile.ts freezes the active profile when it is first imported,
// and a static import chain from main.ts would freeze it too early.
import { flagBoolean, type CommandLine } from './args.ts';
import { UsageError } from './errors.ts';
import { runAssetsCommand } from './commands/assets.ts';
import { runApplyCommand } from './commands/apply.ts';
import { runCatalogCommand } from './commands/catalog.ts';
import { runCheckCommand } from './commands/check.ts';
import { runCompileCommand } from './commands/compile.ts';
import { runConfigCommand } from './commands/config.ts';
import { runEditCommand } from './commands/edit.ts';
import { runExportCommand } from './commands/export.ts';
import { runFootageCommand } from './commands/footage.ts';
import { runItemCommand } from './commands/item.ts';
import { runMcpCommand } from './mcp.ts';
import { runMediaCommand } from './commands/media.ts';
import { runProjectCommand } from './commands/project.ts';
import { runQcCommand } from './commands/qc.ts';
import { runRenderCommand } from './commands/render.ts';
import { runReviseCommand } from './commands/revise.ts';
import { runStartCommand } from './commands/start.ts';
import { runStillCommand } from './commands/still.ts';
import { runTranscribeCommand } from './commands/transcribe.ts';
import { runStoryboardCommand } from './commands/storyboard.ts';
import { runTimelineCommand } from './commands/timeline.ts';
import { runToolsCommand } from './commands/tools.ts';
import { runWhereCommand } from './commands/where.ts';
import { subLine } from './commands/common.ts';

export async function runCommand(commandLine: CommandLine): Promise<void> {
  const json = flagBoolean(commandLine, 'json');
  const [group, ...positionals] = commandLine.positionals;
  switch (group) {
    case 'project':
      return runProjectCommand(positionals, commandLine, json);
    case 'timeline':
      return runTimelineCommand(positionals, commandLine, json);
    case 'tools':
      return runToolsCommand(positionals, commandLine, json);
    case 'edit':
      return runEditCommand(subLine(commandLine, positionals), json);
    case 'item':
      return runItemCommand(positionals, commandLine, json);
    case 'media':
      return runMediaCommand(positionals, commandLine, json);
    case 'render':
      return runRenderCommand(subLine(commandLine, positionals), json);
    case 'start':
      return runStartCommand(subLine(commandLine, positionals), json);
    case 'still':
      return runStillCommand(subLine(commandLine, positionals), json);
    case 'compile':
      return runCompileCommand(subLine(commandLine, positionals), json);
    case 'storyboard':
      return runStoryboardCommand(subLine(commandLine, positionals), json);
    case 'assets':
      return runAssetsCommand(subLine(commandLine, positionals), json);
    case 'footage':
      return runFootageCommand(subLine(commandLine, positionals), json);
    case 'qc':
      return runQcCommand(subLine(commandLine, positionals), json);
    case 'catalog':
      return runCatalogCommand(subLine(commandLine, positionals), json);
    case 'check':
      return runCheckCommand(subLine(commandLine, positionals), json);
    case 'apply':
      return runApplyCommand(subLine(commandLine, positionals), json);
    case 'revise':
      return runReviseCommand(subLine(commandLine, positionals), json);
    case 'transcribe':
      return runTranscribeCommand(subLine(commandLine, positionals), json);
    case 'config':
      return runConfigCommand(subLine(commandLine, positionals), json);
    case 'export':
      return runExportCommand(positionals, commandLine, json);
    case 'mcp':
      return runMcpCommand();
    case 'where':
      return runWhereCommand(commandLine, json);
    case undefined:
      throw new UsageError('missing command');
    default:
      throw new UsageError(`unknown command "${group}"`);
  }
}
