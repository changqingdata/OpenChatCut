# 分叉方案：从「编辑器遥控器」到「意图编译器」

状态：**P1–P3 已实施**；P4、P5 待做。基线 `2f0a0b93`，备份分支 `snapshot/pre-fork`（本地 + 远端）。

## 进度

| 阶段 | 状态 | 提交 |
|---|---|---|
| P1 核心搬家 | ✅ | `09258bdb` — 7 个模块进 `src/pipeline/`，编译产物逐字节不变 |
| P2 卡片模板 | ✅ | 15 个模板 + `kind: 'card'` + 检查器 `array` 控件 + `templateId` |
| P3 `apply_storyboard` | ✅ | `apply_storyboard` / `get_storyboard`，一次 batch = 一次 undo |
| P4 风格注入 | 待做 | |
| P5 借能力 / 砍重复 | 待做 | |

P3 实施时加了一条原计划没写的：**CLI 编译也把分镜写进工程**（`occ compile --apply`）。两条外壳必须落在同一份文档上，否则「命令行做的片子」在应用里打不开逐镜编辑。

P2 实施时有三处和原计划不同，都是被测试逼出来的：

- **每个参数都要有初值。** 必填参数没有 `default` 时，`props` 里就缺键，组件第一次渲染读到 `undefined`。生成器现在按类型给中性值（数字取 `min`，颜色取白，枚举取首项，数组取空）。
- **`array` 控件是必须的，不是可选。** 没有它，检查器把数组渲染成文本输入，回写的是字符串，组件在渲染时才炸。
- **库里拖出来的卡片要抵消 `fit`。** `ItemLayer` 会先把片段缩放到画布，900×520 的卡会被放大到 1870×1080。`addMotionGraphic` 现在写入 `transform.scale = 1/fit`，和 `transformFromRect` 用的是同一个约定。

前提：不再跟随上游。可以改 `src/`、`server/`、`shared/`，不必再为 `git rebase upstream/main` 让步。

本文回答一个问题：**分叉之后，这套东西应该长成什么样，按什么顺序改。**

配套阅读：`README.md`（这层是什么）、`AGENT-FIRST.md`（为什么这样设计）。

---

## 一、事实基线

先摆数字，后面所有判断都基于它们。

| 项 | 数字 | 说明 |
|---|---|---|
| 我们新增的代码 | 8,359 行 | `production/*.ts` + `production/recipes/load.ts` + `cli/commands/*.ts` |
| 其中真正不可替代的核心 | 2,171 行 | `compile` 581 / `qc` 554 / `generate` 424 / `types` 235 / `captions` 195 / `footage-policy` 182 |
| 15 个配方组件 | 1,337 行 JSX | 参数 175 个，其中 92 个是颜色/字体 |
| 上游模板库 | 235 个 | 215×`1920×1080` + 20×`1080×1920`，全部 90 帧，仅 13 个透明底 → **整屏场景** |
| 上游 MCP 工具 | 124 个 | 要求一个活着的编辑器；含 AI 生成、节拍、安全区、代码 MG |
| 我们的 MCP 工具 | 10 个 | 按对象分：start / catalog / check / apply / revise / still / render / run / qc / config |
| 核心模块的依赖 | 只有类型 + `shared/project-version` | `compile` 已无 fs / 网络 / 时钟 → 可以直接进 `src/` |
| 批量动作的撤销粒度 | 一个 `batch` = 一个历史步 | `reducerHistory.ts:28` 逐条归约后只推一次快照 |

两个结论直接由此得出：

1. **核心可以进 `src/`，不需要重写。** 它已经是纯函数，搬过去就能被应用和 CLI 同时调用。
2. **`apply_storyboard` 能做成一次 undo。** 把「清空 + 建 N 项 + 字幕」打包成一个 `batch`，历史层天然只记一步。

---

## 二、目标形态

```
              ┌── 外壳 A：应用内
              │     分镜面板 · 预览帧 · 一键应用 · undo · 版本历史
核心 ─────────┤
（纯 TS）      └── 外壳 B：无头
                    CLI / MCP · 批量 · CI · 多版本（16:9 + 9:16 同源）
```

核心是四样东西：**分镜类型、编译器、密度策略、QC**。它们关于「计划」，不关于「组件」，也不关于「界面」。

外壳 A 让它在应用里可见、可改、可撤；外壳 B 让它能进队列、能批量、能没有浏览器。**同一个核心，两份外壳，不是两套系统。**

产品定位：不是生成器（给你一段改不了的视频），不是编辑器（给你一条得自己剪的时间线），是**两者之间的桥**——一句话出初稿，在专业编辑器里精修，随时回到分镜重出。桥的那个物件是分镜。

---

## 三、五个阶段

依赖是线性的：P1 不做，后面全是空中楼阁；P3 不做，P2 只是多了几个能拖的卡片。

### P1 核心搬家（规模 S，风险低）

把纯逻辑从 `production/` 移进 `src/pipeline/`，`production/` 退化成 re-export 的兼容层。

| 移什么 | 去哪 | 注意 |
|---|---|---|
| `compile.ts` / `types.ts` / `validate.ts` / `layout.ts` / `scrim.ts` | `src/pipeline/` | 无 Node 依赖，直接搬 |
| `qc.ts` / `footage-policy.ts` | `src/pipeline/` | `qc` 依赖 `RecipeSchema` 类型，随配方加载器一起调整 |
| `captions.ts` | 先搬，P5 再评估与 `src/captions/` 合并 | 别在这一步改行为 |
| `generate.ts` | **留在 `production/`** | 它要读 `.env.local`、调模型，是外壳的事，不是核心 |

**验收**：`npx tsc -b` 通过；`node production/verify-agent-lane.mjs --full` 24/24；同一份分镜编译出的时间线**逐字节相同**（用 `导演测试` 工程对比 `project show --doc`）。

---

### P2 模板资产化：235 场景 + 15 卡片（规模 M，风险中）

把 15 个配方变成应用里的**一等资产**，但保留它们和上游模板的本质差别。

**目录结构：两个槽位，不是一个大列表。**

```ts
// src/types.ts —— Tpl 加四个可选字段（都是可选的，235 个不用动）
kind?: 'scene' | 'card';        // scene=自己铺满画面，card=等编译器摆放
box?: { width: number; height: number };   // 卡片的设计单位，= 现在的 box
landscapeBox?: { width: number; height: number };
jobs?: string[];                // thing/relation/number/process/quote/attention
sfx?: { category: string; query?: string; volume?: number };
```

```ts
// PropSpec 加一个
maxLength?: number;   // 把现在的 maxChars 落地，235 个模板也能逐步补
```

**为什么是 `card` 而不是把 15 个重写成 1920×1080**：`box` + `anchor` + `landscapeBox` 是编译期概念，上游 `Tpl` 里没有。重写成整屏就等于丢掉「卡片压在素材上、让开 16% 字幕带、横屏换一套排布」——那正是复利那条片子的观感来源。**保留 `box`，给 `Tpl` 加字段，比改 1,337 行 JSX 便宜，也更诚实。**

**生成方式：单向。** `production/recipes/<id>/{index.jsx,schema.json}` 是作者源，脚本生成 `assets/templates/shots-templates.json`，`initial.ts` 里 spread 进去。生成物提交进仓库（应用要打包它），并在 verify 里加一条**哈希比对**：源改了没重新生成 → 测试失败。这样「两份真相」不会走散。

**参数类型映射**（上游 `PropSchemaField` 已支持 6 种，只有一种缺控件）：

| 我们的 | 上游 | 处理 |
|---|---|---|
| `string` / `number` / `color` / `font` | 同名 | 直接映射 |
| `enum` | `select` | 改类型名 + `options` |
| `array` | 无控件 | **补一个列表控件**（约 20 行），否则 6 个配方的列表参数在检查器里改不了 |

**缩略图**：复用 `production/catalog/stills/*.jpg`（6–20KB，全部远低于插件包的 128KB 上限），复制到 `assets/thumbnails/`。

**编译侧补一行**：`templateId: recipe.id`。现在编译产物没有它，检查器查不到 `propSchema`，对每一镜都显示「该模板无可编辑属性」。补上之后，编译出来的镜头在应用里可以直接改参数。

**验收**：库里能看到 15 张卡片（分类是数据可视化 / 信息图 / 金句卡 / 标题卡 / 文字特效，不是「扩展」）；拖一张进 16:9 工程，画面是卡片不是被 `fit` 放大到满屏；对编译产物打开检查器，能看到并改参数；重渲一帧与改造前 **md5 一致**。

---

### P3 `apply_storyboard`：分镜成为应用里的一等操作（规模 M，风险中）

**这是整个改造的关键证明。** 过了这一步，后面的都是加法；过不了，说明编译产物和 `AtomicAction` 的模型对不上——那要早发现。

**存储决策（改过一次，理由在下面）：分镜内联进工程文档，不存路径。**

```ts
// ProjectDoc 新增，走 src/persist/migrations/
storyboard?: StoryboardDoc;          // 8 镜实测 7.7KB
storyboardAppliedHash?: string;      // 应用的是哪一版
```

一开始我建议「文件是源，项目存引用」。改主意的原因有两条，都很硬：

- **工程必须自包含。** 路径在本机成立，换台机器、发给别人就断；而这个应用的工程本来就是可携带的。
- **撤销白送。** 历史层是对整个 `ProjectDoc` 做快照（`reducerHistory.ts`），分镜在文档里，改一镜就是一步 undo，不用为分镜另造一套历史。

文件仍是**交换格式**：`occ start` / `storyboard` 写文件，`apply` 把它推进文档；`occ storyboard export` 从文档导回文件。两个消费者，一份真相。

**工具实现**：

```ts
apply_storyboard(project, storyboard)
  → 一个 batch：
      [清空目标轨（或 replace）]
      + add × N（motion-graphic / video / solid）
      + addAsset × M
      + captions
  → label: "Apply storyboard"
```

**验收**：应用一次 → 时间线 25 项与 `make-video` 一致；**一次 undo 回到应用前**；版本历史只多一条；检查器可改任一镜的参数；再 `apply` 一次结果相同（幂等）。

---

### P4 风格统一：`designStyle` → 模板 props（规模 S，风险低）

92 个样式参数（63 color + 29 font）命名高度统一：`bg` 15/15、`bodyFont` 15/15、`ink`/`accent`/`muted`/`displayFont` 各 14/15。所以映射只要 6 条：

| `designStyle` 角色 | 模板 prop |
|---|---|
| `background` | `bg` |
| `text` | `ink` |
| `accent` | `accent` |
| `secondary` / `text secondary` | `muted` |
| `heading` 字体 | `displayFont` |
| `body` 字体 | `bodyFont` |

**优先级**：`schema 默认 < designStyle 注入 < 镜头自己的 params`。

- 库里单独拖一张卡片 → 有默认值，能看；
- 编译时 → 跟着品牌走；
- 导演较真 → 逐镜覆盖仍然有效。

只注入模板**声明过**的键（`propSchema` 里有的才给），所以 235 个上游模板不会被打上不存在的 prop。`styleGuide`（那段散文：spring 阻尼、错峰帧数）**继续留给模型**，运行时读不了它，也不该读。

顺带把 `scrim.ts` 的底色也接到 `designStyle.background`，否则「克制、深色」仍然只有一半被执行。

**验收**：同一份分镜，两个不同 `designStyle` 的工程各渲一帧 → 配色/字体不同，版式与时间线完全相同；换回原风格 → 与改造前一致。

---

### P5 借能力 + 砍重复（规模 L，风险中，可分批）

分叉最大的收益在这一阶段：**把上游那 124 个工具里我们用不上的，变成用得上的。**

**借三样（都已核实存在）：**

| 能力 | 工具 | 接到哪 |
|---|---|---|
| AI 生成镜头 | `submit_image` / `submit_video` | 素材层多一个 provider。现在 `confidence: low` 的抽象镜头只能退回纯图形，以后可以生成；Pexels 找不到合适画面时也有兜底 |
| 节拍 | `detect_beats` / `sync_cuts_to_music` | 音乐段落切换点对齐节拍。镜头切点仍由字幕定（那是口播片的铁律），对齐的是**音乐**，不是镜头 |
| 响度 | `normalize_loudness` | 替掉手写的 A1 音量，人声标准化交给它 |
| 安全区（可选） | `place_graphics_in_safe_zone` | 需要人物分割。编译期不知道画面里有没有人，所以只能用在 apply 之后的**一次校正**，不是编译的一部分 |

**砍重复（候选，逐个评估再删）：**

| 候选 | 上游等价物 | 判断 |
|---|---|---|
| `production/captions.ts`（195 行） | `src/captions/captionPages.ts` | 大概率可删，先对齐行为再删 |
| CLI 的 `compile` / `apply` / `revise` / `still` / `render` | `src/pipeline` + 上游渲染 | 保留命令，实现改成薄壳，**不再有第二套逻辑** |
| `production/generate.ts` | 上游没有等价物 | **不删**。它是「一句话」的入口 |

**验收**：CLI 与 MCP 全部走 `src/pipeline`；`production/` 里不再有任何「自己实现一遍」的编译器；一条片子能用上 AI 生成镜头；`verify-agent-lane.mjs` 全绿。

---

## 四、三个已经定下的决策

| 决策 | 选择 | 理由 |
|---|---|---|
| 分镜存哪 | **内联进 `ProjectDoc`**，文件只做交换格式 | 工程自包含 + 撤销白送（历史层已快照整个文档） |
| 模板是资产还是代码 | **模板 JSON 是产物，`recipes/` 是作者源**；配方不进素材池 | 配方是设计语言，不是素材。用户能在库里看见缩略图和参数说明，但不能编辑组件。等某条被证明通用，再「提升」为素材 |
| CLI 的去留 | **保留，降级成无头客户端** | 批量出片（服务端 / CI / 一天 50 条）是这套架构真正的护城河，而那 124 个工具要求活着的浏览器 |

---

## 五、明确的非目标

写下来是为了防止以后反复讨论：

- **不追上游。** 不 rebase，不 cherry-pick，不为了「将来可能合并」而保留兼容层。
- **不做生成器。** 不追求「一句话出大片」，追求「一句话出可改的初稿」。
- **不把 15 个配方重写成整屏。** 它们是卡片槽位，不是残缺的场景。
- **不给 235 个模板补 `jobs`。** 只补我们实际会用的那些；缺省 = 未知，QC 不判（未知 ≠ 不匹配），这条写进文档。
- **不做时间线级的手工编辑能力。** 上游已经有 124 个工具做这件事，我们不需要第二套。

---

## 六、风险与回滚

| 风险 | 触发信号 | 处理 |
|---|---|---|
| 核心搬家引入行为差异 | 编译产物字节不同 | P1 只搬不改；差异出现就回滚 `production/` 的 re-export |
| 卡片在库里被 `fit` 放大 | 拖进工程后卡片铺满画面 | 已确认机制（`fit=contain`，`min(1920/900,1080/520)=2.08`）；用 `kind:'card'` 让摆放层跳过 `fit` |
| 双份真相（源与生成物走散） | 改了 `index.jsx` 忘了生成 | verify 加哈希比对，失败即报错 |
| 迁移写坏工程 | 老工程打不开 | `migrateProjectDoc` 已有机制；`storyboard` 字段可选，缺失即老文档 |
| P3 证明失败 | `batch` 与编译产物模型对不上 | 早做早发现；最坏情况退化成「逐条 add」，仍能撤销，只是历史变多步 |

**回滚点**：每个阶段一个 commit，`snapshot/pre-fork` 是总退路。

---

## 七、顺序与验收总表

| 阶段 | 做什么 | 规模 | 验收 |
|---|---|---|---|
| P1 | 核心进 `src/pipeline/` | S | 类型检查通过 · 24/24 · 编译产物逐字节相同 |
| P2 | 15 个变卡片模板 | M | 库可见可拖 · 检查器可改 · 重渲 md5 一致 |
| P3 | `apply_storyboard` + 内联分镜 | M | 25 项 · 一次 undo · 幂等 |
| P4 | 风格注入 props | S | 两风格两帧 · 版式不变 |
| P5 | 借能力 + 砍重复 | L | 一条片子用上 AI 生成 · `production/` 无第二套编译器 |

P1 与 P2 可以并行（互不依赖）；P3 依赖 P1；P4 依赖 P2；P5 最后。

**先做 P1+P2 的切片**，跑通「库里能看见、编译不变、检查器能改」三条，再决定 P3 的存储形态要不要调整。理由是：P1/P2 是可逆的，P3 一旦把分镜写进文档，就成了新的事实标准。
