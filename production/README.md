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
| IR types | done — `solid`, `text`, `mg`, `mg-code`, `asset` declared |
| Validation | done — frame ranges, beats, intents, layout bounds |
| Layout | done — anchored placement, pinned by tests, **visual result unverified** |
| Compiler | `solid` / `text` / `mg-code` / `mg` (with a registry) |
| Compiler | `asset` not implemented — needs pool resolution |
| Recipes | directory exists, no recipes yet |
| Storyboard generation | not started |
| QC | not started |

The layout maths is pinned by unit tests but has not been checked against a real
rendered frame. Confirm it with a still from `occ render` before building the
recipe library on top of it — if the convention is wrong, every recipe inherits
the error.
