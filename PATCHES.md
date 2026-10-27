# PATCHES

Every modification to a file that belongs to upstream. Nothing else belongs
here — new files under `production/` are not patches.

Purpose: `git rebase upstream/main` can only conflict on these files. Keeping the
list short and each entry small is what makes following upstream sustainable.

**Rule:** if this list grows past ~10 entries, the seam design has failed.
Refactor the change into new files instead of widening the patch surface.

## Current

| # | File | Change | Why |
|---|---|---|---|
| 1 | `cli/router.ts` | import + two `case` arms (`still`, `compile`) | register the production CLI commands |
| 2 | `cli/main.ts` | three lines in the usage text | keep `occ --help` truthful |
| 3 | `cli/router.ts` | import + `storyboard` / `assets` case arms | register the production commands |
| 4 | `cli/main.ts` | usage lines for `storyboard`, `assets`, `footage` | keep `occ --help` truthful |
| 5 | `cli/router.ts` | `footage` case arm | register `occ footage` |
| 6 | `cli/commands/compile.ts` | seed the over-footage colour | legibility rule, applied before compile |
| 7 | `cli/router.ts` | `qc` case arm | register `occ qc` |
| 8 | `cli/errors.ts` | error detail (code/step/cause/hint) | a supervisor needs structure, not prose |
| 9 | `cli/main.ts` | structured failure printing | same |
| 10 | `cli/router.ts` | `config` case arm | register `occ config` |
| 11 | `cli/router.ts` | `mcp` case arm | register `occ mcp` |
| 12 | `.gitignore` | two lines: `production/work/`, skill `config.json` | rendered mp4s and per-machine paths must never be committed |
| 13 | `server/skills-files.ts` | build skill file keys with `/` instead of `join()` | `isSafeRelativePath` rejects backslashes, so on Windows every skill with a subdirectory failed `load_skill` outright |

Everything else lives in new files: `production/**`, and one file per command
under `cli/commands/`.

`git log --oneline main..dev` shows the production commits; the two files above
are the only upstream files they touch.

## How to record a patch

When an upstream file must change, add a row and keep the change minimal:

| # | File | Change | Why |
|---|---|---|---|
| 1 | `src/agent/tools.ts` | add one entry to `EXECUTOR_GROUPS` | register the production tool group |

Keep each patch as its own commit, with a subject starting `seam:`. That way
`git log --oneline main..dev` reads as a list of seams, and a rebase conflict is
always confined to one commit.

```bash
git commit -m "seam: register production tools in EXECUTOR_GROUPS"
```

## Anti-patterns

| Tempting change | Why it is a trap |
|---|---|
| Adding a field to `ProjectDoc` | Forces a version bump and a migration; every upstream schema change becomes your problem. Use a sidecar file. |
| Adding a required field to `TimelineItem` | Breaks every reader, including upstream's own tooling. |
| Editing `src/editor/timelineTypes.ts` | The most-churned type file in the repo; conflicts guaranteed. |
| Modifying `package.json` scripts for local convenience | Pure noise in the diff; use a shell alias or a script under `production/`. |
| Widening the headless tool subset | That whitelist is security-reviewed upstream. Contribute the tool upstream instead. |
