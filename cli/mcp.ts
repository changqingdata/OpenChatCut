// `occ mcp` — the pipeline as an MCP server.
//
// The pipeline is a set of CLI commands. That is already an interface, but it is
// an interface for a shell. An agent that speaks MCP should not have to build
// command lines and parse stdout; it should call a tool.
//
// So this is a thin adapter, not a second implementation: every tool shells out
// to the same `occ` command a person would type, and returns its JSON. The CLI
// stays the single source of truth, and a change there reaches every client
// without touching this file.
//
// Run it with any MCP client:
//
//   { "mcpServers": { "openchatcut-pipeline": {
//       "command": "node", "args": ["cli/occ.mjs", "mcp"] } } }
//
// Deliberately three tools. A supervisor needs to look at the configuration, to
// check a storyboard, and to run the chain; anything finer-grained is the CLI's
// job, and exposing it here would only invite an agent to re-implement the
// pipeline one call at a time.

import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OCC = resolve(REPO_ROOT, 'cli', 'occ.mjs');
const MAKE_VIDEO = resolve(REPO_ROOT, 'production', 'make-video.mjs');

interface RunResult {
  ok: boolean;
  data?: unknown;
  stderr: string;
  code: number;
}

/** Run a Node script and capture its JSON payload. Never throws on a non-zero exit. */
function runNode(script: string, args: string[]): Promise<RunResult> {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [script, ...args], {
      cwd: REPO_ROOT,
      env: process.env,
      windowsHide: true,
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

    child.on('close', (code) => {
      // Commands may print a Node warning before the payload; take the document.
      const lines = stdout.split('\n');
      const start = lines.findIndex((line) => /^\s*[[{]/.test(line));
      let data: unknown;
      if (start !== -1) {
        try {
          data = JSON.parse(lines.slice(start).join('\n'));
        } catch {
          data = undefined;
        }
      }
      resolvePromise({ ok: code === 0, data, stderr: stderr.trim(), code: code ?? 1 });
    });
  });
}

function runOcc(args: string[]): Promise<RunResult> {
  return runNode(OCC, args);
}

/** MCP replies carry both a readable text block and a structured object. */
function reply(result: RunResult) {
  const payload = result.data ?? { ok: result.ok, stderr: result.stderr };
  return {
    ...(result.ok ? {} : { isError: true }),
    content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload as Record<string, unknown>,
  };
}

const TOOLS = [
  {
    name: 'pipeline_config',
    description: 'Where the pipeline reads its keys from, which of them are set, and which model it resolved. '
      + 'Key names only — values are never returned.',
    inputSchema: { type: 'object' as const, properties: {}, additionalProperties: false },
    handler: async () => reply(await runOcc(['config', '--json'])),
  },
  {
    name: 'pipeline_qc',
    description: 'Check a storyboard JSON for structural problems (gaps, one recipe dominating, adjacent footage, '
      + 'text near its limit) without compiling or rendering. Returns findings with error/warn/note severity; '
      + 'only "error" blocks.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        storyboard: { type: 'string' as const, description: 'Absolute path to a storyboard JSON file.' },
      },
      required: ['storyboard'],
      additionalProperties: false,
    },
    handler: async (args: Record<string, unknown>) =>
      reply(await runOcc(['qc', '--storyboard', String(args.storyboard), '--json', '--report-only'])),
  },
  {
    name: 'pipeline_run',
    description: 'Run the whole chain: storyboard → footage → QC → compile → render. '
      + 'Provide either `storyboard` (reuse one that already passed) or `generate: true` (call the model). '
      + 'Rendering a 15-minute video takes several minutes; pass render:false to stop after compiling.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        audio: { type: 'string' as const, description: 'Absolute path to the voiceover audio.' },
        srt: { type: 'string' as const, description: 'Absolute path to the subtitle file.' },
        brief: { type: 'string' as const, description: 'One line describing the video, e.g. "讲复利的短视频，25 秒".' },
        name: { type: 'string' as const, description: 'Project name. Reused when it already exists.' },
        size: { type: 'string' as const, description: 'WIDTHxHEIGHT, default 1080x1920.' },
        storyboard: { type: 'string' as const, description: 'Absolute path to a storyboard to reuse.' },
        generate: { type: 'boolean' as const, description: 'Call the configured model to write the storyboard.' },
        footageRatio: { type: 'number' as const, description: 'Share of shots with footage, 0..1. Default 0.34.' },
        render: { type: 'boolean' as const, description: 'Render the MP4. Default true.' },
      },
      required: ['audio', 'srt', 'brief', 'name'],
      additionalProperties: false,
    },
    handler: async (args: Record<string, unknown>) => {
      const argv = [
        '--audio', String(args.audio),
        '--srt', String(args.srt),
        '--brief', String(args.brief),
        '--name', String(args.name),
        '--json',
      ];
      if (args.size) argv.push('--size', String(args.size));
      if (args.storyboard) argv.push('--storyboard', String(args.storyboard));
      if (args.generate) argv.push('--generate');
      if (args.footageRatio !== undefined) argv.push('--footage-ratio', String(args.footageRatio));
      if (args.render === false) argv.push('--no-render');

      return reply(await runNode(MAKE_VIDEO, argv));
    },
  },
];

export async function runMcpCommand(): Promise<void> {
  const server = new Server(
    { name: 'openchatcut-pipeline', version: '1.0.0' },
    {
      capabilities: { tools: {} },
      instructions: 'The OpenChatCut production pipeline. Storyboard generation, footage resolution, QC, compile '
        + 'and render, all deterministic except the storyboard call. Prefer pipeline_run over driving the steps by '
        + 'hand — the order matters and the pipeline enforces it.',
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const tool = TOOLS.find((candidate) => candidate.name === request.params.name);
    if (!tool) {
      return {
        isError: true,
        content: [{ type: 'text' as const, text: `unknown tool: ${request.params.name}` }],
      };
    }
    return tool.handler((request.params.arguments ?? {}) as Record<string, unknown>);
  });

  await server.connect(new StdioServerTransport());
  // stdout carries the protocol now; anything a command prints must go to stderr,
  // which is why every tool shells out instead of calling into the commands.
}
