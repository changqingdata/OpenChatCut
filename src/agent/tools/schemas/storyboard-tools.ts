import type { AgentToolSchema } from '../../tool-schema';

// Two tools, one object. A storyboard is the thing the app now owns: the agent
// reads it, edits it, and applies it — never the timeline.
export const STORYBOARD_TOOL_SCHEMAS: AgentToolSchema[] = [
  {
    name: 'apply_storyboard',
    description: [
      'Compile a storyboard onto the open timeline: layout, tracks, base plates, graphics, captions — all as ONE',
      'undoable step. This is how a shot list becomes a video, and it replaces the timeline rather than appending',
      'unless replace:false. Every shot needs startFrame/endFrame (endFrame = the next shot\'s startFrame), a',
      'visual with a recipe from the template catalog, and narration text for its caption.',
      'Returns QC findings before anything is rendered, so an overlap or a repeated line is caught here,',
      'plus `unresolved`: shots that asked for footage but whose clip is not in this project pool. Fetch those',
      '(search_stock_media → download_media → import_asset) and apply again; this tool does not use the network.',
      'The storyboard is stored on the project, which makes "apply, look, change one shot, apply again" cheap.',
    ].join(' '),
    input_schema: {
      type: 'object',
      properties: {
        storyboard: {
          type: 'object',
          description: 'The storyboard IR: {version, meta:{width,height,fps,...}, shots:[...]}.',
        },
        replace: { type: 'boolean', description: 'Replace the timeline items instead of appending (default true).' },
        captions: { type: 'boolean', description: 'Build the caption overlay from narration (default true).' },
        captionTemplate: { type: 'string', description: 'Caption style id, e.g. "deyi-card".' },
        captionPacing: { type: 'string', enum: ['phrase', 'word'], description: 'phrase (default) or word-level.' },
        timelineId: { type: 'string', description: 'Target timeline; defaults to the active one.' },
      },
      required: ['storyboard'],
    },
  },
  {
    name: 'get_storyboard',
    description: [
      'Read the storyboard stored on the open project, plus whether the timeline still matches it (hash).',
      'Use this before editing a shot: apply_storyboard replaces the whole timeline, so an edit means reading the',
      'board, changing one shot, and applying again. Returns null when the project has no storyboard.',
    ].join(' '),
    input_schema: { type: 'object', properties: {} },
  },
];

export const STORYBOARD_TOOL_NAMES = new Set(STORYBOARD_TOOL_SCHEMAS.map((tool) => tool.name));
