---
name: occ-video
description: 用 OpenChatCut 的确定性管道把「音频 + 字幕 + 一句话主题」做成视频（竖屏 1080x1920 / 横屏 1920x1080，短片或长片）。默认两步：start 出初稿和预览帧 → 看一眼 → render 出片；某一镜不对就 revise 改那一镜。当用户要做视频、口播成片、混剪、批量出片、或想知道某条片子为什么观感不对时使用。
---

# occ-video

这条管道把一个 Storyboard IR（纯数据）编译成时间线再渲染。**分镜是唯一的人工/模型判断点**，编译是纯函数、可复现，QC 是 17 条确定性规则。所以：想改片子，改的是分镜；不要改时间线，也不要改编译结果。

## 一个流程，两个停顿点

```
start ──► 看预览帧 ──► render
             │
             └─ 某一镜不对 ──► revise ──► apply ──► still ──► render
```

- **默认一路到底**：`start` 建工程、读字幕、写分镜、落时间线、出 4 张预览帧；满意就 `render`。
- **想停就停**：预览不对，用 `revise` 改那一镜，`apply` 重新落时间线，`still` 再看一眼。
- **想从零写分镜**：看同目录 `DIRECTOR.md`，那是逐镜控制的完整写法。

不要一上来就手写 8 个镜头的 JSON——除非用户明确要逐镜控制。`start` 已经能给你一个能看的初稿。

所有命令都通过 `run_skill_script` 调用同一个入口 `node scripts/step.mjs`。

## 0. 每次开工先自检

```
node scripts/step.mjs doctor
```

`ok: false` 时按 `checks[].detail` 修，别硬跑。最常见的两条：

- **media-dir 不对** → 素材全 404。默认档案的素材目录是从 `process.cwd()` 推的，所以命令必须在仓库根跑；`OPENCHATCUT_DATA_DIR` 一旦被继承就会把目录指偏。`step.mjs` 已经处理，不要自己绕开。
- **keys 为空** → `--generate` 会失败。要么让用户配 `.env.local`，要么走 `--prompt` / `--from` 让外部模型写分镜（零 API 成本）。

## 1. 一句话出初稿（首选）

音频 + 字幕 + 一句话主题 → **工程 + 分镜 + 时间线 + 预览帧**。不渲成片，因为下一步该由人看一眼。

```
node scripts/step.mjs run --wait 90000 -- start --audio <绝对路径.mp3> --srt <绝对路径.srt> --brief 复利 --name 复利v3 --generate --size 1920x1080 --preview 4
```

返回里：

- `preview` 是四张图（默认 640px，`--preview-width 1080` 看字），路径直接给用户看
- `findings` 是 QC 的判断，`score` 是八列数字
- `storyboard` 是分镜文件，后面 `revise` 改的就是它

满意就 `render`；不满意就 `revise` 改那一镜，别重跑 `start`。

### 不想看，直接出片

```
node scripts/step.mjs run --wait 60000 -- make --audio <绝对路径.mp3> --srt <绝对路径.srt> --brief 复利 --name 复利v3 --generate --size 1920x1080
```

`make` 就是 `start` 去掉预览、加上渲染。用户说"直接给我成片"时用它。

- `--generate` 调配置好的模型；不写它只会打印提示词然后退出。
- **画幅必须显式给**：竖屏 `--size 1080x1920`（默认），横屏 `--size 1920x1080`。
  分镜的每一处锚点都是按这个尺寸算的，给错了整条片子会变形。
- 名字里的空格写 `%20`；路径里有空格也写 `%20`。
- 一条短片约 60–120 秒，长片 7 分钟以上。**有实拍素材时更慢**（要下载几十 MB 的片段），
  8–10 分钟很正常。返回 `status: "running"` 就接 `status latest`：

```
node scripts/step.mjs status latest --wait 90000
```

返回里的 `artifacts` 是成片路径，`project` 是成片落在哪个工程，`tail` 是完整日志。

**`make` 会新建工程，但不会把编辑器切过去。** 所以这一轮里：

- ✅ 把成片路径、工程名、QC 结果报给用户，让他自己打开看。
- ❌ **不要为了看片去调 `target_project`。** 它会导航到另一个工程，而这个聊天是绑在当前工程上的——导航的瞬间这一轮就结束了，你还没说出结论，用户只看到一句"运行失败"。返回里的 `project.note` 也写了这件事。

要亲眼看片，只有一个办法：让用户先打开那个工程，然后你再跑 `qc` / `view_timeline_frames`——它们读的是**当前打开**的工程。

### 用户说"在当前项目里"时

`--name` 永远指向**一个工程名**，它不知道用户在编辑器里打开的是哪一个。所以别自己编名字——先 `read_project` 拿 `projectId`，再用 `--into`：

```
read_project                    → { projectId: "2cbebbac-…", timelines: [{ width, height, itemCount }] }
node scripts/step.mjs run --wait 60000 -- make --into 2cbebbac-… --audio … --srt … --brief 复利 --generate
```

`--into` 收工程 id 也收工程名。`read_project` 只给 id，所以直接用 id 最省事。

`--into` 与 `--name` 的区别：

| | `--name 名字` | `--into 名字或id` |
|---|---|---|
| 工程不存在 | 新建 | **报错**（要新建就用 `--name`） |
| 工程已有片段 | 直接覆盖（重跑幂等） | **报错**，除非加 `--replace-project` |
| 画布尺寸 | 用 `--size` | **用工程自己的**，`--size` 被忽略 |

画布尺寸这条最要紧：分镜是按尺寸算锚点和字幕安全区的，9:16 的分镜写进 16:9 的工程，画面全错。

`--into` 报"已有 N 个片段"时，**先问用户要不要清空重做**，得到同意再加 `--replace-project`。别自己加。

写完之后**不用切工程**——那就是用户正开着的工程。但必须提醒他 **先 Ctrl+R 刷新，再动时间线**：

编辑器把文档放在内存里，不监听磁盘。不刷新的话时间线还是空的，而且这时用户只要改一下，内存里的旧文档就会把管道刚写的东西盖掉。

## 2. 分步主线（需要精细控制时）

工作目录固定是 `production/work/<工程名>/`，下面用 `w/` 代指。

**① 生成分镜**

```
node scripts/step.mjs run -- storyboard --srt <字幕文件> --brief <一句话主题> --generate --out w/storyboard.json
```

`--brief` 决定**内容走向**：讲什么、给谁看、什么调子。把用户的话原样传下去，最多补一句语气。

- 画幅用 `--size` 表达，不要写进 brief。
- 镜头数由时长和节奏决定，不要写"8 个镜头"。
- **不要写"纯图形""不要人物出镜"这类话。** 写了模型会把素材全部关掉，成片变成 PPT。
  想避开人脸就说"用物件、场景、空镜"，这样素材还在。

brief 写得越细，模型越没有余地；而"画面怎么给"正是它该自己决定的部分。

**② 落素材**（可选，纯图形片子跳过）

```
node scripts/step.mjs run -- footage resolve <工程名> --storyboard w/storyboard.json --out w/storyboard.footage.json
```

素材密度是算术不是判断：`targetRatio 0.34`、`minGapShots 1`、`minFrames 36`。它只接受「主体明确且 confidence 不是 low」的镜头，抽象镜头会被自动排除。跑完看 `attributions.json` 里的 `subject` 是否符合你的理解——不符合就是模型命名错了，回去改 brief。

**③ 编译进时间线**

```
node scripts/step.mjs run -- compile <工程名> --storyboard w/storyboard.footage.json --replace --apply --json
```

`--replace` 会清空时间线，**音频和音乐要在最后一次 compile 之后再放**。

**④ 回看，再出片**

```
node scripts/step.mjs run -- still <工程名> --out <绝对路径>/stills --frames 15,120,240
node scripts/step.mjs run -- render <工程名> --out <绝对路径>/final.mp4
```

静帧是唯一可靠的验收手段：配方位置、字幕压字、素材发黑、渐变层过重，全部只能看出来，读代码看不出来。

注意这说的是**用户**的眼睛。`still` 只把 jpg 写到磁盘，你自己看不见它们；你要看画面只有 `view_timeline_frames` 一条路，而它读的是当前打开的工程（见第 1 节那条禁止项）。所以默认做法是：`qc` 干净就交付，把静帧目录一并给用户，他打开就能看。

## 2. 硬规则（违反会静默出错，不报错）

1. **参数里的空格写成 `%20`。** 调用方按空白切分命令，写 `--brief 复利 的力量` 会被切成两个参数。路径不用加引号——引号会被当字面量，`step.mjs` 会剥掉，但别依赖它。
2. **不要手改 `storyboard.json`——要改就用 `occ revise`。** 生成的分镜带 `.lock.json` 记录哈希，`compile`/`qc`/`check` 发现哈希不符会直接拒绝（`storyboard-edited`）。`revise` 会应用你的编辑、重新校验、重新加锁，这才是改分镜的正路；`--allow-edited` 只用于「手写的分镜被误加了锁」。绕过校验器的手改会让 QC 形同虚设——这是整条管道唯一的红线。
3. **`--out` 一律绝对路径。** 相对路径会让 AAC 编码延迟探测失败，报成"音频错误"。
4. **长任务不要等。** 每次调用最多 120 秒，15 分钟长片渲染约 7 分钟。`run` 会在 `--wait`（默认 45 秒）内没跑完时返回 `status: "running"`，接着调：
   ```
   node scripts/step.mjs status latest --wait 90000
   ```
   即使调用被超时杀掉，`status latest` 也能接上——运行记录落在磁盘上。
5. **不要自己设 `OPENCHATCUT_DATA_DIR` / 不要 `cd` 到别处。** `step.mjs` 已经锁定工作目录和环境。
6. **不要在出片的那一轮调 `target_project`。** 它是唯一会让"运行成功"变成"运行失败"的工具：导航到别的工程会立刻结束当前这一轮，结论永远说不出来。

## 3. QC 报错怎么处理

`compile` 输出里带 QC 结果。规则分三级：

- `error`（`frame-gap`）：帧不连续，**必须**修，片子会卡帧。
- `warn`：`shot-too-short`（<24 帧）、`cut-burst`（连续快切）、`recipe-repeat`（同一配方+同一锚点重复）、`recipe-dominance`（单个配方 >45%）、`footage-low-confidence`、`footage-scarce`（不到 20% 的镜头有素材，成片会像幻灯片）、`footage-adjacent`、`footage-duplicate-clip`、`transition-overuse`（淡入超过 3 个或 40%）、`job-mismatch`（镜头要的画面类型，配方画不了）、`rhythm-flat`、`solid-offcentre`。这些是观感问题，值得修。
- `note`：`recipe-variety`、`anchor-under-captions`、`text-near-limit`、`text-echoes-caption`（卡片复读字幕）、`footage-duplicate-query`。知道就行。

**修法两条，按你走哪条路选**：

- 监工路径：把 QC 的具体抱怨写进 `--brief` 重跑第①步。例如"上一版 recipe-repeat 了，换用不同配方，且不要连续三个镜头都用中间锚点"。
- 导演路径：用 `occ revise` 直接改那几镜（换配方、改锚点、改文字），改完 `check` 再看。**不要手动删镜头**——删完节奏和字幕对位就散了，`revise` 的 `retime` 会替你维持覆盖。

## 4. 命令速查

| 目的 | 命令（`run --` 之后） |
| --- | --- |
| 查环境 | `doctor`（不需要 `run`） |
| **一句话出初稿** | `start --audio a.mp3 --srt a.srt --brief 主题 --name 工程名 --generate` |
| 一句话直接出片 | `make --audio a.mp3 --srt a.srt --brief 主题 --name 工程名 --generate` |
| 只到时间线不出片 | `make … --no-render` |
| 有哪些工程 | `run -- project list --json` |
| 新建工程 | `run -- project new <名字> --size 1920x1080` |
| 管道能画什么 | `run -- catalog --json`（配方 + 能力 + 参考帧 + 音乐类目） |
| 单个配方详情 | `run -- catalog --recipe compare-stack` |
| 三合一检查 | `run -- check --storyboard w/sb.json --json`（校验 + QC + 分数） |
| 分镜落到时间线 | `run -- apply <工程名> --storyboard w/sb.json --audio a.mp3 --srt a.srt --replace` |
| 改分镜 | `run -- revise w/sb.json --ops ops.json` |
| 只出提示词不调模型 | `run -- storyboard --srt f.srt --brief … --prompt --json`（提示词打到 stdout，`tail` 里是完整 `{cues,system,user}`） |
| 用外部模型的分镜 | `run -- storyboard --srt f.srt --brief … --from w/reply.json --out w/sb.json` |
| 单查 QC | `run -- qc --storyboard w/sb.json --json` |
| 放音乐 | `run -- assets place <工程名> --role music --category <类目> --min-duration <秒>` |
| 逐字字幕（更贵） | `make … --captions-pacing word --captions-motion karaoke-pulse`（渲染约 3 倍慢） |
| 单跑语音时间 | `run -- transcribe --audio a.mp3 --out w/timing.json --json` |
| 历史运行 | `runs`（不需要 `run`） |

## 5. 一句话流程

```
doctor → start --generate → 看预览 → render
```

要改某一镜：`revise → apply → still`。要从零写分镜：`catalog → 写 → check → apply → still`（见 `DIRECTOR.md`）。

任何一步失败，先读 `tail` 里的结构化错误（`{code, step, cause, hint}`），`hint` 通常就是修法。
