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
| — | — | *none* | The production layer is currently additive only. |

`git log --oneline main..dev` is empty: no local commits exist yet.

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
