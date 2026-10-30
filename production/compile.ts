// Moved to `src/pipeline/compile.ts`.
//
// Kept as a re-export so paths named in README / SKILL.md / older scripts keep
// resolving. New code should import from `src/pipeline/compile.ts` directly —
// this file exists for compatibility, not as a second implementation.
export * from '../src/pipeline/compile.ts';
