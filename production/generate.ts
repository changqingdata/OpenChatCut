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
2. 镜头时长**不要平均**，按内容给三档（${input.fps}fps 换算成帧）：
   - 短句、转折、过渡 → 2.0–2.5 秒
   - 陈述、数字、清单 → 3.5–4.0 秒
   - 金句、结论、收尾 → 5.0–6.0 秒
   相邻镜头要拉开差距。连续 5 个镜头都在 3.5 秒左右，整条片子会闷。
3. 每个镜头写 intent，一句话说清观众该记住什么。不要写"展示画面"这种空话。
4. 画面有两种来源，可以同时使用：
   - underlay：真实素材（实拍视频或照片），画满整屏
   - visual：图形配方，叠在素材之上或独占画面
5. **每个镜头都要写 underlay.query**（英文 2–5 个词，写画面里有什么，不要写情绪）
   和 **underlay.confidence**。confidence 说的是「这个检索词有多贴合**这一句话**」，
   不是有多贴合整条视频的主题：
   - "high"：画面里能直接看到这句话说的东西
   - "medium"：相关，但不是字面意思
   - "low"：这句话其实没有对应的实拍画面（程序不会用这条素材，宁可留空）
   自检：把这句话单独拿出来，观众看到这个画面会觉得对得上吗？
   反面例子：句子在讲「退步」，检索词却是 hourglass（沙漏讲的是时间，不是退步）→ 应该是 low。
6. 把"没有画面就废了"的镜头标 "essential": true（大约每 4–5 个镜头一个）。
   essential 和 confidence 是两件事：essential 说"必须有素材"，confidence 说"这条贴不贴"。
7. **每个镜头都要设 background**（如 "#0B0B0C"），即使你给了 underlay。
   程序可能不选用那条素材，那时 background 就是画面底色；没有它画面会露底。
8. 配方选择：
   - 一个具体数字、比例、倍数 → number-count
   - 一句要被记住的断言、转折、结论 → keyword-punch
   - 两到四个并列要点 → list-reveal
   - 前后 / 对错 / 表里的对照 → compare-stack
   - 一句引用或格言，需要慢下来 → quote-card
   - 完成度、占比、达成率 → progress-bar
   - 三个阶段以上、演进过程 → timeline-dots
   - 一个词需要最强冲击（整条视频最多一次）→ big-word-fill
   - 一条随时间变化的曲线、增长趋势 → line-chart
   - 两个量的大小对比（A 是 B 的几倍）→ bar-compare
   - 三个以上并列项，且每项能用一个图标代表 → icon-row
   - 进入新章节、新话题 → chapter-card
   - 引述某个人的话，需要身份归属 → lower-third
9. 有 underlay 的镜头，visual 的 layout 要避开画面中心，用 "tc" 或 "mc"，widthRatio 0.8–0.9。
10. 转场只在**段落转换处**用：给该镜头加 "transitionIn": { "type": "fade", "durationInFrames": 12 }。
    同一段内用硬切。一条 10 个镜头以上的视频应该有 1–3 个 fade，每个镜头都加会变成幻灯片。
11. 同一配方不要连续使用超过 2 次；相邻镜头尽量换配方，保持节奏。
12. 布局，按底座分两种：
    - **纯色卡片**（这一镜没有素材）：锚点用 "mc"；需要左右构图时用 "ml" 或 "mr"。
      不要用 tc —— 卡片上没有别的画面，顶部对齐会让中间 70% 全空，看起来像没做完。
    - **有素材**：锚点按画面空处选，"tc"（空在上方）、"mc"、"ml" 或 "mr"。
    - 任何情况都不要用 bl / bc / br —— 底部 16% 留给字幕。
    - widthRatio 用 0.85–0.95。
13. 参数必须遵守字数限制。超限会导致整份分镜被拒绝，所以宁可缩短文字。
14. 不要输出 beats 字段，也不要输出 beatId —— 只需要 shots。
15. 输出 music.category，从上面「配乐情绪分类」里选一个最贴合整条视频情绪的。选不出就省略 music 字段。
16. 回复必须是一个完整的、能直接解析的 JSON 对象，不要在 JSON 前后加任何文字。

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
    // Validate only, never rewrite. Filling schema defaults into the storyboard
    // bakes them in, and a baked default is indistinguishable from an authored
    // value — which defeats every later correction the compiler wants to make
    // (the over-footage colour is the one that bit). The compiler merges the
    // defaults at build time instead.
    const checked = checkParams(schema, visual.params ?? {});
    if (!checked.ok) {
      for (const error of checked.errors) errors.push(`${shot.id}: ${error}`);
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
