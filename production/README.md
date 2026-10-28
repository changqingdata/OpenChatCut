# production/

The production layer: everything this fork adds on top of OpenChatCut. Nothing
here is imported by the upstream app at runtime, and nothing here modifies
upstream files. That separation is what keeps `git rebase upstream/main` cheap.

```
types.ts            Storyboard IR — the only input the pipeline accepts
validate.ts         pre-compile checks; rejects a bad storyboard before it touches a project
layout.ts           anchor + widthRatio → canvas rect → item transform
compile.ts          Storyboard → ProjectDoc (pure, deterministic)
compile.verify.ts   contract test for the above
recipes/            parameterized motion-graphic sources
work/               runtime output per run (gitignored, never committed)
tsconfig.json       standalone type-check config for this directory
```

## Rules

1. **No Node-only code in `src/`.** `src/` is bundled by Vite; `fs`, `path`,
   and `child_process` there break the build. This directory runs through `tsx`
   and is never bundled.
2. **Import upstream modules; never edit them from here.** If a change to
   upstream is unavoidable, record it in `../PATCHES.md`.
3. **Type-only imports.** `import type { ProjectDoc } from '../src/editor/projectTypes.ts'`
   keeps the dependency at compile time. Import from the specific module, not
   from `src/editor/types.ts` — that barrel drags in the React tree.
4. **Compile is pure.** No network, no filesystem, no clock, no randomness.
   Same storyboard in, byte-identical ProjectDoc out.

## Commands

```bash
npx tsx production/compile.verify.ts     # contract test
npx tsc -p production                     # type-check this directory only
```

`npm run lint` covers this directory too, since oxlint scans the repository.

## Status

| Piece | State |
|---|---|
| IR types | done — `solid`, `text`, `mg`, `mg-code` as `visual`; footage as `underlay` |
| Validation | done — frame ranges, beats, intents, layout bounds, unresolved footage |
| Layout | done — anchored placement, **verified against rendered frames**, pinned by a nine-anchor table |
| Compiler | `solid` / `text` / `mg-code` / `mg` (with a registry) |
| Compiler | footage + scrim + graphics on three lanes (V1 / V2 / V3) |
| Recipes | 15, with schema validation and param checking |
| Material | private audio (music, SFX), Pexels, Pixabay |
| Footage density | policy module — ratio, spacing, essentials; retunable without a model call |
| CLI | `occ storyboard`, `occ footage resolve`, `occ compile`, `occ still`, `occ assets`, `occ render` |
| Storyboard generation | done — chapters, repair, footage intent |
| QC | `production/qc.ts` — nine rules, run by `occ qc` and after every generation |

## Three lanes

A shot is not one picture. It is a stack:

```
V3  graphics   recipes and text — always
V2  scrim      a vertical gradient, only over footage
V1  base       footage or a solid card
```

The wash is a gradient rather than a flat block because text does not sit
everywhere: it clusters at the top (overlays) and the bottom (captions), while
the middle is where the picture is actually looked at. Heavy at both edges, light
through the centre — `production/scrim.ts`.

Bottom-anchored recipes are held above the caption band (16% of canvas height) by
`layout.ts`, which the compiler enables whenever captions are on. Without it a
`bc` recipe prints straight over the subtitle.

The wash flattens on a wide canvas (`scrimStopsFor`). The gradient assumes the
type sits at the top and the captions at the bottom, leaving a quiet centre; on
16:9 the graphic is a band across the centre, so the centre *is* the text zone and
has to be washed harder.

## QC

`production/qc.ts` is arithmetic over the IR — no model, no network, no render. A
check that costs money will not be run on every generation, and a check that
cannot be reproduced cannot be trusted.

| Code | Severity | Fires when |
|---|---|---|
| `frame-gap` | error | a shot leaves frames uncovered — renders as black |
| `rhythm-flat` | warn | 5 consecutive shots within 0.5s of each other |
| `footage-low-confidence` | warn | a shot keeps a clip the model rated `low` |
| `no-transition` | note | 10+ shots and every cut is hard |
| `shot-too-short` | warn | a shot is under 1.2s |
| `cut-burst` | warn | more than 4 cuts inside 6s |
| `recipe-repeat` | warn | 3 consecutive shots share a recipe **and** an anchor |
| `recipe-dominance` | warn | one recipe is over 45% of a 6+ shot video |
| `recipe-variety` | note | fewer than 4 recipes across 8+ shots |
| `footage-adjacent` | warn | two footage shots in a row |
| `footage-duplicate-clip` | warn | the same asset used twice |
| `footage-duplicate-query` | note | the same search used twice |
| `anchor-under-captions` | note | a card asks for a bottom anchor |
| `text-near-limit` | note | a long text field is within 15% of its limit |

Severity is a claim about consequence: `error` means the video is broken, `warn`
means it will look wrong, `note` means worth knowing.

`stats` also reports `footageRelevance` — the share of proposed clips the model
rated high or medium. That is the cheapest proxy for "is the picture about the
thing being said", and the number that decides whether more recipes are worth
writing.

Run on the 15-minute storyboard it reported exactly what a manual review had
found — `keyword-punch` at 49% of 259 shots, three separate runs of three
consecutive repeats, and ten cards anchored under the captions.

```
occ qc --storyboard sb.json [--strict] [--json]
```

## Captions

The subtitle file supplies the words; the local whisper model supplies the
timing. `occ transcribe --audio a.mp3 --out timing.json` runs the same
whisper.cpp build and the same GGML model the app's own transcription uses, and
`occ compile --srt a.srt --timing timing.json` places each character where it was
actually spoken.

The model's *text* is deliberately unused. Its Chinese comes out traditional and
it mishears homophones (复利 → 復律), which is worse than the subtitle the author
already has. So the two halves are never aligned against each other — the cue
keeps its own words and its own boundaries, and only the rhythm inside each cue
comes from the model. Measured against the estimate on the test clip, a
character landed 389ms late: 12 frames of highlight on the wrong syllable.

`make` runs the transcribe step automatically and skips it when no model is on
disk, in which case captions fall back to spreading each cue by character count.

How much of that you can see depends on the caption mode:

| Mode | What the timing changes | Render cost |
|---|---|---|
| `phrase` (default) | when a page appears and disappears | baseline |
| `phrase` + `karaoke-pulse` | which character pulses inside the page | baseline |
| `word` | one character per page, so the timing *is* the caption | ~3× (104 pages instead of 13) |

`--captions-pacing word` on a 25-second clip took the render from 83s to 247s.
That is a real cost, so it stays opt-in rather than the default.

## Long cuts

The music library is a set of songs, not loops: the longest track in a mood is
around 145s, so a fifteen-minute video cannot be scored by one of them, and
repeating a single track would put an audible seam every two minutes.
`assets place --loop` walks the same mood, takes each track once, and chains them
end to end — same mood, different songs. Only the first fades in and only the
last fades out; fading every join would pump the bed once per track.

Render throughput measured at ~36 fps on this machine (60s of 1080x1920 in 50s),
so a 15-minute cut is roughly 13 minutes rather than the hour an early estimate
assumed.

`occ storyboard --generate` runs it automatically and fails on errors;
`make-video.mjs` runs it before the compile so a broken storyboard fails in a
second rather than after a two-minute render.

## Driving it from an agent

The pipeline is a CLI. That is already an interface, but it is one for a shell.
`occ mcp` serves the same commands as MCP tools, so an agent can call them
without building command lines:

```json
{ "mcpServers": { "openchatcut-pipeline": {
    "command": "node", "args": ["cli/occ.mjs", "mcp"] } } }
```

| Tool | Does |
|---|---|
| `pipeline_config` | sources, which keys are set, resolved provider |
| `pipeline_qc` | run the QC rules on a storyboard, no compile |
| `pipeline_run` | the whole chain; `render:false` stops after the timeline |

It is a thin adapter, not a second implementation: each tool shells out to the
same `occ` command a person would type and returns its JSON. A change in the CLI
reaches every client without touching `cli/mcp.ts`. Shelling out is also what
keeps stdout clean — MCP uses it for the protocol, so nothing in-process may
print there.

Deliberately three tools. A supervisor needs to look, to check, and to run;
anything finer-grained would invite an agent to re-implement the pipeline one
call at a time, which is the thing the fixed order exists to prevent.

### The second lane: a skill for the built-in agent

MCP is for *other* agents. The app's own agent already has `run_skill_script`,
which runs a whitelisted binary inside an installed skill directory on this
machine — so the same pipeline is also shipped as a skill.

```bash
node production/skill/install.mjs          # copy + configure into ~/.openchatcut/skills/occ-video
node production/skill/install.mjs --check  # report drift
```

Three layers, with one invariant each:

| Layer | Lives in | Knows about |
|---|---|---|
| core | `production/*.ts`, `cli/` | video, not the environment |
| host | `production/skill-host/` | the environment, not video |
| binding | `production/skill/occ-video/` | neither — SKILL.md, config, and a bootstrap |

The installed skill directory holds only what the agent reads (`SKILL.md`) plus
a six-line bootstrap that imports the host layer from the repository. All the
logic stays in git: versioned, diffable, and checkable with
`node production/skill-host/step.verify.mjs` in about a second, with no model
and no browser.

`run_skill_script` imposes four things the pipeline would otherwise trip over:

| The tool | What the pipeline needs |
|---|---|
| starts in the skill dir | the repo root — the default profile derives its media directory from `process.cwd()` |
| splits the command on whitespace | one token per value, so a space is written `%20` and quotes arrive literally |
| kills the call at 120s | a 15-minute render takes ~7 minutes |
| passes no useful env | `OPENCHATCUT_DATA_DIR` must stay unset |

So `step.mjs run` always detaches and writes a run record, and the agent polls
`step.mjs status latest`. It also builds `cli-dist/occ.mjs` on first use, which
turns a 6.3s `tsx` start-up into ~0.4s per step.

One rule is enforced in code rather than prose: a generated storyboard gets a
`.lock.json` hash, and `compile` refuses a storyboard whose hash changed
(`storyboard-edited`). Hand-editing a generated storyboard would bypass the
validator and QC — that is the single boundary worth a hard failure.

`SKILL.md` is the agent-facing playbook; keep it a playbook, not documentation.

## Configuration

Keys come from three places, merged lowest to highest:

```
.env.local              the checkout's dev file
<profile>/settings.env  the app's settings panel
process.env             the shell
```

Empty values never override a non-empty one. `occ config` prints the sources and
which keys are set (names only, never values) plus the resolved provider.

One thing worth knowing: **in the default profile the app's keystore *is*
`.env.local`** — `runtimeProfile().keystorePath` resolves to `resolve(cwd,
'.env.local')`, so the settings panel and the pipeline have always shared a file.
The separate `settings.env` only exists for an isolated dev profile, and the
pipeline now reads that one too. Before this, an isolated run could configure a
provider in the UI and have `occ storyboard --generate` still report "no key".

## Failures

A message is written for a human reading a terminal. That is not enough for
anything that has to *act* on a failure, so every `CliError` also carries:

| Field | Purpose |
|---|---|
| `code` | stable kebab-case identifier — branch on this, never on the message |
| `step` | which stage failed, filled from the subcommand when the error omits it |
| `cause` | what actually went wrong, which is often not where it surfaced |
| `hint` | the next thing to try |

`cause` exists because the expensive failures surface somewhere else. A relative
`--out` made the AAC encoder-delay probe fail, and the error said "audio" — three
rounds of debugging for a path problem. `occ render` now refuses a relative path
up front with `out-not-absolute`.

With `--json`, failures print the envelope on **stderr** (stdout stays clean for
the success payload):

```json
{ "ok": false, "error": {
    "code": "timeline-exists", "step": "compile",
    "message": "timeline tl-main already exists …",
    "hint": "add --replace; it rewrites the whole timeline, so audio and music have to be re-added after it" } }
```

Exit codes are unchanged: 1 for a failure, 2 for a usage error. Codes currently
in use: `out-not-absolute`, `timeline-exists`, `params-invalid`, `qc-blocking`,
`qc-warnings`, `footage-none-resolved`, `llm-not-configured`,
`asset-import-failed`, `nothing-to-place`, `frames-required`.

## Canvas shapes

Portrait and landscape both work, with three rules that differ:

| | Portrait 1080×1920 | Landscape 1920×1080 |
|---|---|---|
| recipe width | `widthRatio × width` | capped by the height left after the caption band |
| wash | gradient, mid 0.24 | flatter, mid 0.42 |
| footage search | `9:16` | `16:9`, derived from the canvas |

`widthRatio` is a share of the width, which breaks on 16:9: 0.85 of 1920 is 1632px
and a 900×520 recipe at that width is 943px tall — taller than the 811 the frame
leaves. The cap keeps the box inside both side margins; on portrait it never
binds.

Graphics always go to V3 rather than V2. If the scrim shared V2 with them the
two would fight for one lane, and a shot that gained footage later would silently
move its recipe to a different track.

`Shot.underlay` carries footage; `Shot.visual` carries graphics. Either can be
absent — footage alone is a legitimate transition shot, and graphics alone is the
card the first eight recipes were built for.

### Recipes have two design boxes

A recipe's box is its design unit: the layout is authored at that size and the
compiler scales the whole box onto the canvas. That works while the box and the
canvas have roughly the same shape. It stops working the moment they don't — a
vertical stack authored at 960×820 gets height-capped to ~950px on 16:9, so it
sits as a column with half the frame empty, and no amount of scaling fixes the
arrangement inside it.

So a recipe can declare a second box:

```json
"box": { "width": 960, "height": 820 },
"landscapeBox": { "width": 1500, "height": 560 }
```

The compiler picks by canvas orientation and passes `props.landscape = true` so
the component knows which arrangement to draw. Four recipes use it — the ones
whose portrait form is a vertical stack:

| recipe | portrait | landscape |
|---|---|---|
| `compare-stack` | top block over bottom, horizontal rule | two columns, vertical rule |
| `list-reveal` | numbered rows | numbered columns |
| `number-count` | label / number / note, centred | number left, words beside it |
| `quote-card` | left-aligned, wraps | centred, fitted to two lines |

`fullFrame` is the other end of the same idea: `big-word-fill`, `chapter-card`
and `annotation` own the whole picture, so they get the canvas itself and lay
themselves out from `item.width`.

The rest are already horizontal at any aspect (`bar-compare`, `line-chart`,
`progress-bar`, `flow-chain`, `icon-row`, `stack-share`, `timeline-dots`) or
compose fine centred (`keyword-punch`).

To see all of them at once:

```bash
node production/recipes/gallery.mjs 1920x1080 > /tmp/gallery.json
```

It emits a storyboard with one shot per recipe; compile it into a scratch
project and render. `occ still` is 480px wide on purpose (the agent's vision
budget), so a real render is the honest review copy.

## The layout maths was confirmed by rendering `bl` and `tr` placements and checking
the box edges land at the expected pixel positions. Two corrections came out of
that pass:

- A motion-graphic's natural box is auto-fitted to the canvas width before the
  item transform applies, so `scale` is measured against the **fitted** width.
  Measuring against the raw box scaled full-width boxes twice.
- Edge anchors clamp to the safe inset on the anchored side, so a box wider than
  the canvas minus two insets falls back to the left inset instead of overflowing.
