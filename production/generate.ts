// Storyboard generation: prompt construction and response validation.
//
// Split deliberately into two halves so the model call is swappable:
//
//   buildStoryboardPrompt()  → text you can hand to any model
//   checkStoryboard()        → validates whatever came back
//
// That split is what lets the pipeline run without an API key: emit the prompt,
// paste the answer back, and the same validation applies. When a key is present
// the CLI wires the two together and retries once with the validation errors.
import type { RecipeSchema } from './recipes/load.ts';
import { checkParams } from './recipes/load.ts';
import type { Storyboard } from './types.ts';
import { validateStoryboard } from './validate.ts';
import type { SrtCue } from './srt.ts';

export interface PromptInput {
  cues: readonly SrtCue[];
  brief: string;
  width: number;
  height: number;
  fps: number;
  aspect: string;
  language: string;
  catalog: ReadonlyMap<string, RecipeSchema>;
}

function formatMs(ms: number): string {
  const totalSeconds = ms / 1000;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds - minutes * 60;
  return `${String(minutes).padStart(2, '0')}:${seconds.toFixed(2).padStart(5, '0')}`;
}

function recipeCatalog(catalog: ReadonlyMap<string, RecipeSchema>): string {
  const lines: string[] = [];
  for (const schema of catalog.values()) {
    lines.push(`### ${schema.id} — ${schema.name}`);
    if (schema.intent) lines.push(schema.intent);
    lines.push(`box: ${schema.box.width}x${schema.box.height}`);
    const params: string[] = [];
    for (const [key, param] of Object.entries(schema.params)) {
      if (['ink', 'accent', 'muted', 'bg', 'displayFont', 'bodyFont'].includes(key)) continue;
      const bits = [`type=${param.type}`];
      if (param.required) bits.push('required');
      if (param.maxChars !== undefined) bits.push(`maxChars=${param.maxChars}`);
      if (param.maxItems !== undefined) bits.push(`maxItems=${param.maxItems}`);
      if (param.itemMaxChars !== undefined) bits.push(`itemMaxChars=${param.itemMaxChars}`);
      if (param.min !== undefined) bits.push(`min=${param.min}`);
      if (param.max !== undefined) bits.push(`max=${param.max}`);
      if (param.values) bits.push(`values=${param.values.join('|')}`);
      if (param.default !== undefined && param.default !== '') bits.push(`default=${JSON.stringify(param.default)}`);
      params.push(`  - ${key}: ${bits.join(', ')}${param.description ? ` — ${param.description}` : ''}`);
    }
    lines.push(...params);
    lines.push('');
  }
  return lines.join('\n');
}

const OUTPUT_SHAPE = `{
  "version": 1,
  "meta": {
    "title": "string",
    "runId": "string (kebab-case, stable)",
    "aspect": "9:16",
    "width": 1080, "height": 1920, "fps": 30,
    "language": "zh"
  },
  "rhythm": { "avgShotSec": 3.5, "maxShotSec": 6, "grammarChangeEverySec": 6, "maxRepeatRecipe": 2, "hookMaxSec": 3.5 },
  "beats": [
    { "id": "b1", "role": "hook|context|point|proof|turn|cta", "text": "string", "startMs": 0, "endMs": 3000, "shotIds": ["S01"] }
  ],
  "shots": [
    {
      "id": "S01",
      "beatId": "b1",
      "startFrame": 0,
      "endFrame": 105,
      "narration": { "text": "string", "startMs": 0, "endMs": 3500 },
      "intent": "一句话：观众这一镜该记住什么",
      "background": "#0B0B0C",
      "visual": {
        "kind": "mg",
        "recipe": "recipe-id",
        "params": { },
        "layout": { "anchor": "full|tl|tc|tr|ml|mc|mr|bl|bc|br", "widthRatio": 0.9 }
      }
    }
  ]
}`;

export function buildStoryboardPrompt(input: PromptInput): { system: string; user: string } {
  const system = [
    '你是一位短视频分镜导演。你把一段口播的字幕切成镜头，为每个镜头选择视觉配方并填写参数。',
    '你只输出一个 JSON 对象，不要 Markdown 代码块，不要解释，不要在 JSON 前后加任何文字。',
    '你填写的每个参数都必须满足给定的约束，否则整份分镜会被拒绝。',
  ].join('\n');

  const durationMs = input.cues.length ? input.cues[input.cues.length - 1]!.endMs : 0;
  const cueLines = input.cues.map((cue) => `${formatMs(cue.startMs)} → ${formatMs(cue.endMs)}  ${cue.text}`).join('\n');

  const user = `# 任务
${input.brief}

# 画布
${input.width}x${input.height}（${input.aspect}），${input.fps}fps，语言 ${input.language}，总时长约 ${(durationMs / 1000).toFixed(1)} 秒。

# 可用配方
${recipeCatalog(input.catalog)}

# 字幕（时间 → 文本）
${cueLines}

# 输出格式
严格按这个结构输出 JSON：

${OUTPUT_SHAPE}

# 规则
1. 镜头必须覆盖整段字幕：第一个从第 0 帧开始，最后一个到总帧数结束，中间不留空洞、不重叠。
2. 一个镜头通常对应 1–3 条连续字幕。单镜 1.5–6 秒，平均 3–4 秒；开头 3 秒内必须出现第一个镜头。
3. 每个镜头写 intent，一句话说清观众该记住什么。不要写"展示画面"这种空话。
4. 大多数镜头设 background（如 "#0B0B0C"），让画面成为完整卡片；只有需要叠在素材上时才省略。
5. 配方选择：
   - 一个具体数字、比例、倍数 → number-count
   - 一句要被记住的断言、转折、结论 → keyword-punch
   - 两到四个并列要点 → list-reveal
   - 前后 / 对错 / 表里的对照 → compare-stack
6. 同一配方不要连续使用超过 2 次；相邻镜头尽量换配方，保持节奏。
7. 布局：单行短句用 "bc" 或 "mc"，配 widthRatio 0.85–0.95；需要留白时用 "bl" 或 "ml"。
8. 参数必须遵守字数限制。超限会导致整份分镜被拒绝，所以宁可缩短文字。

现在输出 JSON。`;

  return { system, user };
}

/** Pull the JSON object out of a model reply that may be fenced or padded. */
export function extractJson(text: string): unknown {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1]!.trim() : trimmed;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) {
    throw new Error('response contains no JSON object');
  }
  return JSON.parse(body.slice(start, end + 1));
}

export interface StoryboardCheck {
  ok: boolean;
  errors: string[];
  warnings: string[];
  storyboard?: Storyboard;
}

/**
 * Validate a candidate storyboard: structure first, then every `mg` shot's
 * params against its recipe schema.
 */
export function checkStoryboard(value: unknown, catalog: ReadonlyMap<string, RecipeSchema>): StoryboardCheck {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, errors: ['storyboard must be a JSON object'], warnings: [] };
  }
  const storyboard = value as Storyboard;

  const structural = validateStoryboard(storyboard);
  const errors = [...structural.errors];
  const warnings = structural.warnings.map((warning) => `${warning.shotId ?? '-'}: ${warning.message}`);

  for (const shot of storyboard.shots ?? []) {
    const visual = shot?.visual;
    if (visual?.kind !== 'mg') continue;
    const schema = catalog.get(visual.recipe);
    if (!schema) {
      errors.push(`${shot.id}: unknown recipe "${visual.recipe}" (have: ${[...catalog.keys()].join(', ')})`);
      continue;
    }
    const checked = checkParams(schema, visual.params ?? {});
    if (!checked.ok) {
      for (const error of checked.errors) errors.push(`${shot.id}: ${error}`);
    } else {
      visual.params = checked.value;
    }
  }

  return { ok: errors.length === 0, errors, warnings, ...(errors.length === 0 ? { storyboard } : {}) };
}

/** Feedback appended to a retry when the first answer failed validation. */
export function repairPrompt(errors: readonly string[]): string {
  return `上一版分镜没有通过校验，问题如下：

${errors.map((error) => `- ${error}`).join('\n')}

请修正这些问题并重新输出完整 JSON。不要只输出改动的部分。`;
}
