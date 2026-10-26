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
import type { Shot, Storyboard } from './types.ts';
import { validateStoryboard } from './validate.ts';
import type { SrtCue } from './srt.ts';

export interface PromptInput {
  cues: readonly SrtCue[];
  /** Mood categories the music library has; empty disables the music field. */
  musicCategories?: readonly string[];
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
  "music": { "category": "分类名，必须来自下方清单" },
  "shots": [
    {
      "id": "S01",
      "startFrame": 0,
      "endFrame": 105,
      "narration": { "text": "string", "startMs": 0, "endMs": 3500 },
      "intent": "一句话：观众这一镜该记住什么",
      "background": "#0B0B0C",
      "underlay": { "query": "english search words", "note": "为什么这一镜需要实拍" },
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

  const musicLine = input.musicCategories?.length
    ? `\n# 配乐情绪分类\n${input.musicCategories.join(' / ')}\n`
    : '';

  const user = `# 任务
${input.brief}

# 画布
${input.width}x${input.height}（${input.aspect}），${input.fps}fps，语言 ${input.language}，总时长约 ${(durationMs / 1000).toFixed(1)} 秒。

# 可用配方
${recipeCatalog(input.catalog)}
${musicLine}

# 字幕（时间 → 文本）
${cueLines}

# 输出格式
严格按这个结构输出 JSON：

${OUTPUT_SHAPE}

# 规则
1. 镜头必须覆盖整段字幕：第一个从第 0 帧开始，最后一个到总帧数结束，中间不留空洞、不重叠。
2. 一个镜头通常对应 1–3 条连续字幕。单镜 1.5–6 秒，平均 3–4 秒；开头 3 秒内必须出现第一个镜头。
3. 每个镜头写 intent，一句话说清观众该记住什么。不要写"展示画面"这种空话。
4. 画面有两种来源，可以同时使用：
   - underlay：真实素材（实拍视频或照片），画满整屏
   - visual：图形配方，叠在素材之上或独占画面
5. 什么时候加 underlay（这一条决定成片像不像视频，务必认真判断）：
   - 这句话讲的是**具体可见的东西**（人、场景、动作、物件、地点）→ 加 underlay
   - 这句话是**抽象观点、数字、对照、清单、结论** → 不加，保持纯图形卡片
   - 目标比例：大约每 3 个镜头里有 1 个用素材
   - 第一个镜头优先考虑素材：实拍开场最能建立"这是视频"的观感
   - query 用**英文**，2–5 个词，写画面里有什么，不要写情绪（"office worker typing" 而不是 "hard work"）
6. 有 underlay 的镜头：
   - 不要设 background（素材就是背景）
   - 可以同时给 visual 做叠加，但 layout 要避开画面中心，用 "tc" 或 "mc"，widthRatio 0.8–0.9
   - 只给 underlay 不给 visual 也合法，用于纯素材的过渡镜头
7. 纯图形镜头通常设 background（如 "#0B0B0C"），让画面成为完整卡片。
8. 配方选择：
   - 一个具体数字、比例、倍数 → number-count
   - 一句要被记住的断言、转折、结论 → keyword-punch
   - 两到四个并列要点 → list-reveal
   - 前后 / 对错 / 表里的对照 → compare-stack
   - 一句引用或格言，需要慢下来 → quote-card
   - 完成度、占比、达成率 → progress-bar
   - 三个阶段以上、演进过程 → timeline-dots
   - 一个词需要最强冲击（整条视频最多一次）→ big-word-fill
9. 同一配方不要连续使用超过 2 次；相邻镜头尽量换配方，保持节奏。
10. 布局：单行短句用 "bc" 或 "mc"，配 widthRatio 0.85–0.95；需要留白时用 "bl" 或 "ml"。
11. 参数必须遵守字数限制。超限会导致整份分镜被拒绝，所以宁可缩短文字。
12. 不要输出 beats 字段，也不要输出 beatId —— 只需要 shots。
13. 输出 music.category，从上面「配乐情绪分类」里选一个最贴合整条视频情绪的。选不出就省略 music 字段。
14. 回复必须是一个完整的、能直接解析的 JSON 对象，不要在 JSON 前后加任何文字。

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

// --- long form -----------------------------------------------------------

/**
 * Split cues into chapters of at most `maxSeconds`.
 *
 * A 15-minute talk is 417 cues and roughly 230 shots. The prompt still fits in
 * context, but the reply does not fit in any model's output budget — and even if
 * it did, quality degrades badly at the tail. Chapters keep every reply inside
 * the budget, and a failed chapter only costs that chapter.
 *
 * Cuts land on cue boundaries, so a sentence is never split across chapters.
 */
export function planChunks(cues: readonly SrtCue[], maxSeconds = 180): SrtCue[][] {
  if (!cues.length) return [];
  const chunks: SrtCue[][] = [];
  let current: SrtCue[] = [];
  let startedAt = cues[0]!.startMs;

  for (const cue of cues) {
    if (current.length && cue.endMs - startedAt > maxSeconds * 1000) {
      chunks.push(current);
      current = [];
      startedAt = cue.startMs;
    }
    current.push(cue);
  }
  if (current.length) chunks.push(current);
  return chunks;
}

/**
 * Re-base a chapter's cues to start at zero.
 *
 * Subtitle timestamps are absolute — chapter 7 opens at 00:12:30. Without this
 * the model derives frames from that absolute time, and the merge adds the
 * chapter offset on top, doubling the timeline. Rebasing keeps every chapter in
 * local time so accumulation is the only offset in play.
 */
export function rebaseCues(cues: readonly SrtCue[]): SrtCue[] {
  const start = cues[0]?.startMs ?? 0;
  if (!start) return [...cues];
  return cues.map((cue) => ({
    ...cue,
    startMs: Math.max(0, cue.startMs - start),
    endMs: Math.max(0, cue.endMs - start),
  }));
}

/**
 * Stitch chapter storyboards into one.
 *
 * Each chapter was generated as if it were the whole video: frames start at 0
 * and shot ids restart at S01. Both are rebased here, and the music choice is
 * taken from the first chapter that made one.
 */
export function mergeChunkStoryboards(parts: readonly Storyboard[]): Storyboard {
  const first = parts[0];
  if (!first) throw new Error('cannot merge an empty set of chapters');

  const shots: Shot[] = [];
  let offset = 0;
  let index = 0;

  for (const part of parts) {
    const lastEnd = part.shots.reduce((end, shot) => Math.max(end, shot.endFrame), 0);
    for (const shot of part.shots) {
      index += 1;
      shots.push({
        ...shot,
        id: `S${String(index).padStart(2, '0')}`,
        startFrame: shot.startFrame + offset,
        endFrame: shot.endFrame + offset,
      });
    }
    offset += lastEnd;
  }

  // A chapter generated against absolute timestamps opens at frame 9000 instead
  // of 0, and accumulating the offset on top would double the timeline. Ten
  // seconds of lead-in is already generous; anything beyond that is absolute time.
  parts.forEach((part, index) => {
    const first = part.shots[0];
    if (first && first.startFrame > 300) {
      throw new Error(
        `chapter ${index + 1} starts at frame ${first.startFrame} — it was generated against `
        + 'absolute timestamps instead of rebased ones',
      );
    }
  });

  const music = parts.map((part) => part.music).find(Boolean);

  return {
    ...first,
    ...(music ? { music } : {}),
    shots,
  };
}
