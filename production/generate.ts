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
  /**
   * Search terms that read as ideas rather than images. Injected rather than
   * hardcoded so the prompt and the scorecard cannot drift apart.
   */
  cliches?: readonly string[];
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

function outputShape(input: PromptInput): string {
  return `{
  "version": 1,
  "meta": {
    "title": "string",
    "runId": "string (kebab-case, stable)",
    "aspect": "${input.aspect}",
    "width": ${input.width}, "height": ${input.height}, "fps": ${input.fps},
    "language": "${input.language}"
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
      "underlay": { "subject": "这句话里的具体名词", "query": "english search words", "confidence": "high|medium|low", "essential": false },
      "visual": {
        "kind": "mg",
        "recipe": "recipe-id",
        "params": { },
        "layout": { "anchor": "full|tl|tc|tr|ml|mc|mr|bl|bc|br", "widthRatio": 0.9 }
      }
    }
  ]
}`;
}

export function buildStoryboardPrompt(input: PromptInput): { system: string; user: string } {
  const durationMs = input.cues.length ? input.cues[input.cues.length - 1]!.endMs : 0;
  const cueLines = input.cues.map((cue) => `${formatMs(cue.startMs)} → ${formatMs(cue.endMs)}  ${cue.text}`).join('\n');

  const musicLine = input.musicCategories?.length
    ? `\n# 配乐情绪分类\n${input.musicCategories.join(' / ')}\n`
    : '';

  // Static first. The catalogue and the rules are ~9k characters that do not
  // change from one chunk of a video to the next, so they belong in `system`
  // where the provider's prefix cache covers them; a 15-minute video is cut
  // into five chunks and used to re-send that block five times. What actually
  // varies — the brief, this chunk's length, its subtitles — stays in `user`,
  // which also leaves the script as the last thing the model reads.
  const system = [
    '你是一位短视频分镜导演。你把一段口播的字幕切成镜头，为每个镜头选择视觉配方并填写参数。',
    '你只输出一个 JSON 对象，不要 Markdown 代码块，不要解释，不要在 JSON 前后加任何文字。',
    '你填写的每个参数都必须满足给定的约束，否则整份分镜会被拒绝。',
    '',
    '# 画布',
    `${input.width}x${input.height}（${input.aspect}），${input.fps}fps，语言 ${input.language}。`,
    '',
    '# 可用配方',
    recipeCatalog(input.catalog),
    musicLine,
    '# 输出格式',
    '严格按这个结构输出 JSON：',
    '',
    outputShape(input),
    '',
    rulesBlock(input.fps, input.aspect, input.cliches ?? []),
  ].join('\n');

  const user = `# 任务
${input.brief}

# 本段字幕
总时长约 ${(durationMs / 1000).toFixed(1)} 秒（${Math.round((durationMs / 1000) * input.fps)} 帧），共 ${input.cues.length} 条。

${cueLines}

现在输出 JSON。`;

  return { system, user };
}

/**
 * The rules never vary within one video, so they live in `system` with the
 * catalogue. `fps` is the only interpolation, and it is fixed per project.
 */
function rulesBlock(fps: number, aspect: string, cliches: readonly string[] = []): string {
  // Landscape and portrait do not share a recipe vocabulary. A vertical stack
  // (compare-stack, list-reveal, timeline-dots) is capped by frame height on a
  // 16:9 canvas, so it lands as a narrow column in the middle with half the
  // frame empty. Recipes that read left-to-right fill the same frame.
  const landscape = /^(16:9|21:9|4:3|1:1)$/.test(aspect);
  const wideNote = landscape
    ? `
18. **这是横屏**。横向展开的配方最稳：bar-compare、line-chart、progress-bar、flow-chain、
    icon-row、stack-share。compare-stack、list-reveal、number-count、quote-card 有横屏版式，
    也可以用。别连续三个镜头都是居中卡片——横屏的空旷比竖屏更显眼。`
    : '';
  return `# 规则
1. 镜头必须覆盖整段字幕：第一个从第 0 帧开始，最后一个到总帧数结束，中间不留空洞、不重叠。
2. 镜头时长**不要平均**，按内容给三档（${fps}fps 换算成帧）：
   - 短句、转折、过渡 → 2.0–2.5 秒
   - 陈述、数字、清单 → 3.5–4.0 秒
   - 金句、结论、收尾 → 5.0–6.0 秒
   相邻镜头要拉开差距。连续 5 个镜头都在 3.5 秒左右，整条片子会闷。
3. 每个镜头写 intent，一句话说清观众该记住什么。不要写"展示画面"这种空话。
4. 画面有两种来源，可以同时使用：
   - underlay：真实素材（实拍视频或照片），画满整屏
   - visual：图形配方，叠在素材之上或独占画面
   **整条视频至少 1/3 的镜头要有 underlay。** 全是图形配方 = 幻灯片，观众一眼就看穿。
   用户说"不要人物出镜"时，换成物件、场景、空镜（手、窗、路、钟表、植物），
   不是把素材全部取消。
5. **每个镜头先找主语，再写检索词**。三步：
   ① 写 underlay.subject：这句话里那个**能被拍到的具体东西**，中文，不超过 6 个字。
      如果这句话只有抽象概念（利率、时间、复利、重要性），写 "-"。
   ② 写 underlay.query：英文 2–6 个词，描述**画面里看得见的东西**——物件 + 动作/场景 + 景别或光线。
      - subject 写了 "-" 的镜头，**整条 underlay 都不要写**——没有 subject、没有 query、没有
        confidence。给抽象句子硬凑检索词，只会拿到一张和内容无关的图库图；
        而写一个空的 underlay（只有 confidence）是不合法的分镜，会被校验器拒收。
      - 不要写这句话的**意思**，写这句话对应的**画面**。句子讲"时间不够"，画面可以是
        「桌上一叠翻开的日历，逆光」，不是 "time passing"。
      - 禁用这些词，它们是概念不是画面：${cliches.join("、") || "无"}。
      - 也不要用图库陈词：托腮思考的人、灯泡、握手、拼图、迷宫、发芽延时、日历翻页。
   ③ 写 underlay.confidence，按主语定，不要凭感觉：
      - 主语是一个**具体的东西**（硬币、沙漏、枯树、时钟、跑步的人）→ "high"
      - 主语是**一类场景**、不是一个东西（上班、学习、早起）→ "medium"
      - 主语写了 "-" → 没有 underlay，也就没有 confidence，跳过这一步
   自检：把 query 念出来，想象一张照片。如果这张照片能配上任何一句讲复利的话，
   说明它太泛了，重写。
   反面例子：
   - 句子在讲「退步」，subject 是「枯萎的植物」，query 写 hourglass 就错了——沙漏是时间。
   - 句子在讲「时间不够」，query 写 "calendar pages flipping" 也错了——那是图库对时间的想象，
     不是这句话里发生的事。
   - 句子在讲「每天进步 1%」，query 写 "plant sprout growing time lapse" 还是错的——
     发芽和 1% 没有关系，它只是"成长"这个概念的图库替代品。
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
   - 要在画面上指出某处、圈出重点 → annotation
   - 讲因果传导：原因 → 机制 → 结果 → flow-chain
   - 讲构成占比（钱花在哪、时间用在哪）→ stack-share
9. 有 underlay 的镜头，visual 的 layout 要避开画面中心，用 "tc" 或 "mc"，widthRatio 0.8–0.9。
10. 转场只在**段落转换处**用：给该镜头加 "transitionIn": { "type": "fade", "durationInFrames": 12 }。
    同一段内用硬切。一条 10 个镜头以上的视频应该有 1–3 个 fade，每个镜头都加会变成幻灯片。
11. 同一配方不要连续使用超过 2 次；相邻镜头尽量换配方，保持节奏。
    **同一配方再次使用时，换锚点和配色**：同一个 keyword-punch 放在 "tc"、"ml"、"mc"
    在观众眼里是三种版式。换锚点比换配方便宜，而且不会稀释视觉语言。
12. 布局，按底座分两种：
    - **整屏配方**（chapter-card、big-word-fill、annotation）：anchor 写 "full"。程序会把它们
      铺满整帧，widthRatio 不起作用。annotation 的 x/y/size 是**整帧的百分比**，不是卡片内的。
      这三个自带背景（annotation 是透明的），一条视频里 big-word-fill 最多一次。
    - **纯色卡片**（这一镜没有素材）：锚点只用 "mc"。卡片是画面里唯一的东西，
      靠左或靠右会把另外半屏留空，看起来像没做完；要左右构图就把 widthRatio 提到 0.85 以上。
      也不要用 tc —— 顶部对齐会让中间 70% 全空。
    - **有素材**：锚点按画面空处选，"tc"（空在上方）、"mc"、"ml" 或 "mr"。
    - 任何情况都不要用 bl / bc / br —— 底部 16% 留给字幕。
    - widthRatio 用 0.85–0.95。
13. 参数必须遵守字数限制。超限会导致整份分镜被拒绝，所以宁可缩短文字。
14. 不要输出 beats 字段，也不要输出 beatId —— 只需要 shots。
15. 输出 music.category，从上面「配乐情绪分类」里选一个最贴合整条视频情绪的。选不出就省略 music 字段。
16. 卡片上的字是**关键词**，不是字幕的复读。字幕会把整句念出来，卡片再写同一句就是重复。
    除了 quote-card（它可以是一整句话），其余配方写 2–8 个字、一个数字或一个短语。
    **quote-card 也不要用字幕里那句话**——字幕刚念过一遍。把同一句压缩成更短的金句，
    或者换一句能概括它的话；逐字相同会被 QC 判成 text-echoes-caption。
17. 回复必须是一个完整的、能直接解析的 JSON 对象，不要在 JSON 前后加任何文字。${wideNote}`;
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
export function checkStoryboard(
  value: unknown,
  catalog: ReadonlyMap<string, RecipeSchema>,
  expected?: { width: number; height: number },
): StoryboardCheck {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, errors: ['storyboard must be a JSON object'], warnings: [] };
  }
  const storyboard = value as Storyboard;

  const structural = validateStoryboard(storyboard);
  const errors = [...structural.errors];

  // The canvas is not the model's to choose. It is a request parameter, and a
  // mismatch is not cosmetic: the compiler builds every rect against the
  // storyboard's size, then --replace writes that size onto the timeline, so a
  // 9:16 storyboard quietly turns a 16:9 project portrait.
  if (expected) {
    const meta = storyboard.meta;
    if (meta?.width !== expected.width || meta?.height !== expected.height) {
      errors.push(
        `meta is ${meta?.width}x${meta?.height} but the canvas is ${expected.width}x${expected.height} — copy width/height from the output shape`,
      );
    }
  }
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
