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
// The tool surface is the IR, not the timeline.
//
// An agent may edit a storyboard as finely as it likes — that is the directing
// work — but it never touches tracks, items or transforms. Those are the
// compiler's output, and hand-placing an item would cost both determinism and
// the ability to re-compile the same storyboard later.
//
// So the tools are named after the objects in that contract: catalog (what can
// be drawn), check (is this right), apply (put it on a timeline), revise (edit
// it), still (look at it), render (ship it). `pipeline_run` remains for the
// supervised one-command lane; it is not the path a director takes.

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
  stdout: string;
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
      resolvePromise({ ok: code === 0, data, stdout, stderr: stderr.trim(), code: code ?? 1 });
    });
  });
}

function runOcc(args: string[]): Promise<RunResult> {
  return runNode(OCC, args);
}

/**
 * MCP replies carry both a readable text block and a structured object.
 *
 * A failed command that printed no JSON used to reach the caller as
 * `{ ok: false }` and nothing else — the agent learned that something broke and
 * nothing about what. The tail of stdout is where a render says how far it got
 * before it died, so it travels with the failure.
 */
function reply(result: RunResult) {
  const payload = result.data ?? {
    ok: result.ok,
    ...(result.ok ? {} : { code: result.code }),
    ...(result.stderr ? { stderr: result.stderr.slice(-2000) } : {}),
    ...(result.ok ? {} : { tail: result.stdout.trim().split('\n').slice(-15).join('\n').slice(-1500) }),
  };
  return {
    ...(result.ok ? {} : { isError: true }),
    content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload as Record<string, unknown>,
  };
}

const TOOLS = [
  {
    name: 'pipeline_catalog',
    description: 'What the pipeline can render: every recipe with its jobs, parameter names and a reference still, '
      + 'plus canvas presets, footage-density constants and music moods. Start here — a recipe you do not know '
      + 'about is a recipe you will not use. Pass recipe for one recipe in full, full for every schema.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        recipe: { type: 'string' as const, description: 'Recipe id, e.g. "compare-stack".' },
        full: { type: 'boolean' as const, description: 'Include every parameter schema. Large; prefer per-recipe.' },
      },
      additionalProperties: false,
    },
    handler: async (args: Record<string, unknown>) => {
      const argv = ['catalog', '--json'];
      if (args.recipe) argv.push('--recipe', String(args.recipe));
      if (args.full) argv.push('--full');
      return reply(await runOcc(argv));
    },
  },
  {
    name: 'pipeline_start',
    description: 'One call from "here is my voiceover" to "here is a draft you can look at": creates the project, '
      + 'transcribes, writes the storyboard (or reuses one you pass), applies it to the timeline, and renders a few '
      + 'preview frames. Does not render the video. Start here — then look at the previews, and use pipeline_revise '
      + 'only for the shots that are wrong.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        audio: { type: 'string' as const, description: 'Absolute path to the voiceover audio.' },
        srt: { type: 'string' as const, description: 'Absolute path to the subtitle file.' },
        name: { type: 'string' as const, description: 'Project name. Created when it does not exist.' },
        brief: { type: 'string' as const, description: 'One line: what the video is about. Needed unless you pass a storyboard.' },
        size: { type: 'string' as const, description: 'WIDTHxHEIGHT, default 1080x1920. Ignored when reusing a project.' },
        generate: { type: 'boolean' as const, description: 'Let the configured model write the storyboard.' },
        storyboard: { type: 'string' as const, description: 'Absolute path to a storyboard you wrote; skips generation.' },
        from: { type: 'string' as const, description: 'Absolute path to a model reply to validate instead of generating.' },
        preview: { type: 'number' as const, description: 'How many preview frames to render, 0-12. Default 4.' },
        previewWidth: { type: 'number' as const, description: 'Preview width in px. Default 640.' },
      },
      required: ['audio', 'srt', 'name'],
      additionalProperties: false,
    },
    handler: async (args: Record<string, unknown>) => {
      const argv = ['start', '--audio', String(args.audio), '--srt', String(args.srt),
        '--name', String(args.name), '--json'];
      if (args.brief) argv.push('--brief', String(args.brief));
      if (args.size) argv.push('--size', String(args.size));
      if (args.generate) argv.push('--generate');
      if (args.storyboard) argv.push('--storyboard', String(args.storyboard));
      if (args.from) argv.push('--from', String(args.from));
      if (args.preview !== undefined) argv.push('--preview', String(args.preview));
      if (args.previewWidth !== undefined) argv.push('--preview-width', String(args.previewWidth));
      return reply(await runOcc(argv));
    },
  },
  {
    name: 'pipeline_check',
    description: 'One call, three answers: does the storyboard validate, what does QC say about how it will look, '
      + 'and the eight-column scorecard. Run it after every edit — it is the only judge that does not argue back.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        storyboard: { type: 'string' as const, description: 'Absolute path to a storyboard JSON file.' },
        size: { type: 'string' as const, description: 'Expected canvas, WIDTHxHEIGHT. Rejects a mismatched meta.' },
        allowEdited: { type: 'boolean' as const, description: 'Accept a storyboard that was edited outside revise.' },
      },
      required: ['storyboard'],
      additionalProperties: false,
    },
    handler: async (args: Record<string, unknown>) => {
      const argv = ['check', '--storyboard', String(args.storyboard), '--json'];
      if (args.size) argv.push('--size', String(args.size));
      if (args.allowEdited) argv.push('--allow-edited');
      return reply(await runOcc(argv));
    },
  },
  {
    name: 'pipeline_apply',
    description: 'Put a storyboard onto a timeline: decide footage density, resolve clips, compile the three lanes, '
      + 'burn captions, and lay voiceover/music/effects on A1/A2/A3. Does not render — this is the cheap middle '
      + 'point between editing and shipping.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        project: { type: 'string' as const, description: 'Project name or id. Must exist at the storyboard canvas.' },
        storyboard: { type: 'string' as const, description: 'Absolute path to a storyboard JSON file.' },
        audio: { type: 'string' as const, description: 'Absolute path to the voiceover audio.' },
        srt: { type: 'string' as const, description: 'Absolute path to the subtitle file, for burned-in captions.' },
        timing: { type: 'string' as const, description: 'Absolute path to occ transcribe output, for word timing.' },
        replace: { type: 'boolean' as const, description: 'Replace the timeline if it already has items.' },
        footageRatio: { type: 'number' as const, description: 'Share of shots with footage, 0..1. Default 0.34.' },
        musicCategory: { type: 'string' as const, description: 'Mood from the catalog; defaults to the storyboard music.' },
        noMusic: { type: 'boolean' as const, description: 'Skip the music bed.' },
        noSfx: { type: 'boolean' as const, description: 'Skip sound effects.' },
        captionsPacing: { type: 'string' as const, description: 'phrase (default) or word (3x slower to render).' },
        allowEdited: { type: 'boolean' as const, description: 'Accept a storyboard edited outside revise.' },
      },
      required: ['project', 'storyboard', 'audio'],
      additionalProperties: false,
    },
    handler: async (args: Record<string, unknown>) => {
      const argv = ['apply', String(args.project), '--storyboard', String(args.storyboard),
        '--audio', String(args.audio), '--json'];
      if (args.srt) argv.push('--srt', String(args.srt));
      if (args.timing) argv.push('--timing', String(args.timing));
      if (args.replace) argv.push('--replace');
      if (args.footageRatio !== undefined) argv.push('--footage-ratio', String(args.footageRatio));
      if (args.musicCategory) argv.push('--music-category', String(args.musicCategory));
      if (args.noMusic) argv.push('--no-music');
      if (args.noSfx) argv.push('--no-sfx');
      if (args.captionsPacing) argv.push('--captions-pacing', String(args.captionsPacing));
      if (args.allowEdited) argv.push('--allow-edited');
      return reply(await runOcc(argv));
    },
  },
  {
    name: 'pipeline_revise',
    description: 'Edit a storyboard the sanctioned way: apply ops (or replace the file wholesale), validate, and '
      + 're-lock. A storyboard edited outside this tool is refused by compile, because the edit never met the '
      + 'validator. Cut points come from startFrame; endFrame follows the next shot. '
      + 'Ops: set / recipe / layout / retime / remove.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        storyboard: { type: 'string' as const, description: 'Absolute path to the storyboard to edit in place.' },
        ops: { type: 'string' as const, description: 'Absolute path to a JSON array of ops.' },
        replaceWith: { type: 'string' as const, description: 'Absolute path to a new storyboard to adopt instead.' },
      },
      required: ['storyboard'],
      additionalProperties: false,
    },
    handler: async (args: Record<string, unknown>) => {
      const argv = ['revise', String(args.storyboard), '--json'];
      if (args.ops) argv.push('--ops', String(args.ops));
      if (args.replaceWith) argv.push('--replace-with', String(args.replaceWith));
      return reply(await runOcc(argv));
    },
  },
  {
    name: 'pipeline_still',
    description: 'Render still frames of a compiled timeline to JPEG files and return their paths. This is how you '
      + 'look at your own work: a caption overlap or a card that is too wide is invisible in the JSON. Pass width '
      + 'to read the type (480 shows that a layout is wrong, not why).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        project: { type: 'string' as const, description: 'Project name or id.' },
        out: { type: 'string' as const, description: 'Absolute directory for the JPEGs.' },
        frames: { type: 'string' as const, description: 'Comma-separated frames, e.g. "20,180,400".' },
        width: { type: 'number' as const, description: 'Output width in px, e.g. 1080. Default 480-640.' },
      },
      required: ['project', 'out', 'frames'],
      additionalProperties: false,
    },
    handler: async (args: Record<string, unknown>) => {
      const argv = ['still', String(args.project), '--out', String(args.out),
        '--frames', String(args.frames), '--json'];
      if (args.width !== undefined) argv.push('--width', String(args.width));
      return reply(await runOcc(argv));
    },
  },
  {
    name: 'pipeline_render',
    description: 'Render the timeline to MP4. from/to render a range — use it to check one shot without paying '
      + 'for the whole video.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        project: { type: 'string' as const, description: 'Project name or id.' },
        out: { type: 'string' as const, description: 'Absolute path for the MP4. Relative paths break AAC probing.' },
        from: { type: 'string' as const, description: 'First frame or second, e.g. "168" or "5.6s".' },
        to: { type: 'string' as const, description: 'Last frame or second.' },
        resolution: { type: 'string' as const, description: '480p / 720p / 1080p / 4k. Default 1080p.' },
      },
      required: ['project', 'out'],
      additionalProperties: false,
    },
    handler: async (args: Record<string, unknown>) => {
      const argv = ['render', String(args.project), '--out', String(args.out), '--json'];
      if (args.from) argv.push('--from', String(args.from));
      if (args.to) argv.push('--to', String(args.to));
      if (args.resolution) argv.push('--resolution', String(args.resolution));
      return reply(await runOcc(argv));
    },
  },
  {
    name: 'pipeline_qc',
    description: 'QC findings only, no validation or scorecard. Kept for callers that only want the list; '
      + 'prefer pipeline_check, which includes this and tells you whether the storyboard can compile at all.',
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
    description: 'Start and render in one call, with no checkpoint: audio + subtitles + brief in, an MP4 out. '
      + 'Use it when the user asked for a finished video and does not want to look first; otherwise prefer '
      + 'pipeline_start, which stops where a human can still change their mind.',
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
  {
    name: 'pipeline_config',
    description: 'Where the pipeline reads its keys from, which of them are set, and which model it resolved. '
      + 'Key names only — values are never returned.',
    inputSchema: { type: 'object' as const, properties: {}, additionalProperties: false },
    handler: async () => reply(await runOcc(['config', '--json'])),
  },
];

export async function runMcpCommand(): Promise<void> {
  const server = new Server(
    { name: 'openchatcut-pipeline', version: '1.0.0' },
    {
      capabilities: { tools: {} },
      instructions: 'The OpenChatCut production pipeline. The default flow is two calls: pipeline_start with the '
        + 'voiceover, subtitles and one line of brief gives you a project, a storyboard, a timeline and a few '
        + 'preview frames; then pipeline_render ships it. Look at the previews before rendering. '
        + 'When a shot is wrong, pipeline_revise edits the storyboard (never the timeline), and pipeline_apply puts '
        + 'it back. pipeline_catalog is what to read before writing a storyboard yourself: it carries the document '
        + 'shape, the recipes, and one reference still per recipe.',
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
