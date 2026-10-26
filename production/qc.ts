// Quality control for a storyboard.
//
// Everything here is arithmetic over the IR — no model, no network, no rendering.
// That is deliberate: a check that costs money will not be run on every
// generation, and a check that cannot be reproduced cannot be trusted.
//
// The rules are the ones this pipeline has actually got wrong, in order of how
// often they happened:
//
//   a gap between shots          → a black frame nobody notices until playback
//   one recipe everywhere        → the 15-minute run put keyword-punch on 49%
//   footage on adjacent shots    → no rhythm, and two downloads for one beat
//   the same clip twice          → the same face reappearing
//   five cuts in four seconds    → reads as a stutter, not as pace
//   text one character from the limit → one edit away from a rejection
//
// Severity is a claim about consequence, not about taste:
//
//   error  the video is broken (a gap, an uncovered frame range)
//   warn   it will look wrong to a viewer (dominance, adjacency, bursts)
//   note   worth knowing, no action required (variety, near-limit text)

import type { RecipeSchema } from './recipes/load.ts';
import type { Shot, Storyboard } from './types.ts';

export type QcSeverity = 'error' | 'warn' | 'note';

export interface QcFinding {
  code: string;
  severity: QcSeverity;
  /** Shots the finding points at, in playback order. */
  shotIds: string[];
  message: string;
}

export interface QcStats {
  shots: number;
  durationSec: number;
  avgShotSec: number;
  /** How many shots carry footage. */
  footageShots: number;
  footageRatio: number;
  /** Recipe id → number of shots. */
  recipes: Record<string, number>;
  distinctRecipes: number;
  /** How the model rated the clips it proposed. */
  footageConfidence: Record<'high' | 'medium' | 'low', number>;
  /**
   * Share of proposed clips the model rated high or medium.
   *
   * This is the number that matters for footage: a clip that illustrates the
   * wrong sentence is worse than no clip, and this is the only cheap proxy for
   * "is the picture about the thing being said".
   */
  footageRelevance: number | null;
  /** Shots that carry a fade. */
  transitions: number;
  /** Shots whose sentence named no concrete thing (`subject: "-"`). */
  abstractShots: number;
}

export interface QcReport {
  ok: boolean;
  findings: QcFinding[];
  stats: QcStats;
}

export interface QcOptions {
  /** Recipe schemas, for text-limit checks. Omitted means those checks are skipped. */
  schemas?: ReadonlyMap<string, RecipeSchema>;
  /** Whether captions will be burned in; a bottom anchor then collides with them. */
  captions?: boolean;
  /** A shot shorter than this is a flash. Default 1.2s. */
  minShotSec?: number;
  /** More than this many cuts inside `burstWindowSec` reads as a stutter. Default 4. */
  maxCutsPerWindow?: number;
  burstWindowSec?: number;
  /** One recipe above this share of shots is a look, not a vocabulary. Default 0.45. */
  recipeDominance?: number;
  /** Text within this share of its limit is one edit from a rejection. Default 0.85. */
  textNearLimit?: number;
}

const DEFAULTS = {
  minShotSec: 1.2,
  maxCutsPerWindow: 4,
  burstWindowSec: 6,
  recipeDominance: 0.45,
  textNearLimit: 0.85,
} as const;

function sec(frames: number, fps: number): number {
  return frames / Math.max(1, fps);
}

function ordered(storyboard: Storyboard): Shot[] {
  return [...storyboard.shots].sort((a, b) => a.startFrame - b.startFrame);
}

/** Runs of consecutive shots that share a key. */
function runs<T>(items: readonly T[], key: (item: T) => string): Array<{ key: string; items: T[] }> {
  const out: Array<{ key: string; items: T[] }> = [];
  for (const item of items) {
    const value = key(item);
    const last = out[out.length - 1];
    if (last && last.key === value) last.items.push(item);
    else out.push({ key: value, items: [item] });
  }
  return out;
}

function recipeOf(shot: Shot): string {
  const visual = shot.visual;
  if (!visual) return 'footage-only';
  if (visual.kind === 'mg') return visual.recipe;
  return visual.kind;
}

function hasFootage(shot: Shot): boolean {
  return Boolean(shot.underlay?.query) && shot.underlay?.selected !== false;
}

/**
 * What the viewer actually sees as "a layout".
 *
 * A recipe is only half of it: `keyword-punch` at the top, hanging left, and
 * centred are three different pictures built from one recipe. Counting repeats by
 * recipe alone declared those a repeat and pushed the model to invent new recipes
 * instead of varying the one it had — which is the cheaper way to look different.
 */
function lookOf(shot: Shot): string {
  return `${recipeOf(shot)}@${anchorOf(shot)}`;
}

function anchorOf(shot: Shot): string {
  const visual = shot.visual;
  if (!visual) return 'none';
  if (!('layout' in visual)) return 'none';
  return visual.layout.anchor;
}

export function runQc(storyboard: Storyboard, options: QcOptions = {}): QcReport {
  const cfg = { ...DEFAULTS, ...options };
  const fps = storyboard.meta?.fps || 30;
  const shots = ordered(storyboard);
  const findings: QcFinding[] = [];

  // --- coverage ------------------------------------------------------------

  // A hole in the timeline renders as a black frame. It is the one defect that is
  // invisible in a storyboard review and obvious in playback, so it is an error.
  let previousEnd = 0;
  for (const shot of shots) {
    if (shot.startFrame > previousEnd) {
      findings.push({
        code: 'frame-gap',
        severity: 'error',
        shotIds: [shot.id],
        message: `${shot.id} starts at frame ${shot.startFrame}, leaving frames ${previousEnd}–${shot.startFrame - 1} empty`,
      });
    }
    previousEnd = Math.max(previousEnd, shot.endFrame);
  }

  // --- pacing --------------------------------------------------------------

  for (const shot of shots) {
    const seconds = sec(shot.endFrame - shot.startFrame, fps);
    if (seconds < cfg.minShotSec) {
      findings.push({
        code: 'shot-too-short',
        severity: 'warn',
        shotIds: [shot.id],
        message: `${shot.id} runs ${seconds.toFixed(2)}s — under ${cfg.minShotSec}s a shot reads as a flash`,
      });
    }
  }

  // A burst is several cuts inside a short window: legal per shot, stuttering in
  // sequence. Counting starts inside a sliding window is the cheapest way to see
  // it without pretending to know what the cut feels like.
  const windowFrames = cfg.burstWindowSec * fps;
  for (let i = 0; i < shots.length; i += 1) {
    const start = shots[i]!.startFrame;
    const inside = shots.filter((shot) => shot.startFrame >= start && shot.startFrame < start + windowFrames);
    if (inside.length > cfg.maxCutsPerWindow) {
      findings.push({
        code: 'cut-burst',
        severity: 'warn',
        shotIds: inside.map((shot) => shot.id),
        message: `${inside.length} cuts inside ${cfg.burstWindowSec}s starting at ${shots[i]!.id}`,
      });
      break;
    }
  }

  // Five cuts in a row of nearly the same length read as a metronome. Shot
  // length is the cheapest rhythm tool there is, and the easiest to leave flat.
  const WINDOW = 5;
  const FLAT_SPREAD_SEC = 0.5;
  for (let i = 0; i + WINDOW <= shots.length; i += 1) {
    const slice = shots.slice(i, i + WINDOW);
    const durations = slice.map((shot) => sec(shot.endFrame - shot.startFrame, fps));
    const spread = Math.max(...durations) - Math.min(...durations);
    if (spread < FLAT_SPREAD_SEC) {
      findings.push({
        code: 'rhythm-flat',
        severity: 'warn',
        shotIds: slice.map((shot) => shot.id),
        message: `${WINDOW} shots from ${slice[0]!.id} run ${durations[0]!.toFixed(1)}s ±${spread.toFixed(2)}s — the pacing is a metronome`,
      });
      break;
    }
  }

  const transitions = shots.filter((shot) => shot.transitionIn && shot.transitionIn.type !== 'none').length;
  if (shots.length >= 10 && transitions === 0) {
    findings.push({
      code: 'no-transition',
      severity: 'note',
      shotIds: [],
      message: `${shots.length} shots, every cut hard — a fade at section changes gives the eye somewhere to rest`,
    });
  }

  // --- vocabulary ----------------------------------------------------------

  const histogram: Record<string, number> = {};
  for (const shot of shots) {
    const recipe = recipeOf(shot);
    histogram[recipe] = (histogram[recipe] ?? 0) + 1;
  }
  const distinctRecipes = Object.keys(histogram).length;

  const repeatRuns = runs(shots, lookOf).filter((run) => run.items.length >= 3 && !run.key.startsWith('footage-only'));
  for (const run of repeatRuns) {
    findings.push({
      code: 'recipe-repeat',
      severity: 'warn',
      shotIds: run.items.map((shot) => shot.id),
      message: `${run.items.length} consecutive shots look the same (${run.key}) — change the anchor, not just the recipe`,
    });
  }

  if (shots.length >= 6) {
    for (const [recipe, count] of Object.entries(histogram)) {
      const share = count / shots.length;
      if (share > cfg.recipeDominance) {
        findings.push({
          code: 'recipe-dominance',
          severity: 'warn',
          shotIds: shots.filter((shot) => recipeOf(shot) === recipe).map((shot) => shot.id),
          message: `"${recipe}" is ${Math.round(share * 100)}% of ${shots.length} shots — one look, not a vocabulary`,
        });
      }
    }
  }

  if (shots.length >= 8 && distinctRecipes < 4) {
    findings.push({
      code: 'recipe-variety',
      severity: 'note',
      shotIds: [],
      message: `${distinctRecipes} distinct recipes across ${shots.length} shots — a longer video will feel repetitive`,
    });
  }

  // --- footage -------------------------------------------------------------

  for (let i = 1; i < shots.length; i += 1) {
    if (hasFootage(shots[i - 1]!) && hasFootage(shots[i]!)) {
      findings.push({
        code: 'footage-adjacent',
        severity: 'warn',
        shotIds: [shots[i - 1]!.id, shots[i]!.id],
        message: `${shots[i - 1]!.id} and ${shots[i]!.id} both use footage — no card between them breaks the rhythm`,
      });
    }
  }

  // The model named no subject but still rated the clip above `low`. One of the
  // two answers is wrong, and the pair is only useful if it agrees.
  for (const shot of shots) {
    const underlay = shot.underlay;
    if (underlay?.subject?.trim() === '-' && underlay.confidence && underlay.confidence !== 'low') {
      findings.push({
        code: 'footage-subject-mismatch',
        severity: 'warn',
        shotIds: [shot.id],
        message: `${shot.id} names no concrete subject but rates its clip "${underlay.confidence}"`,
      });
    }
  }

  for (const shot of shots) {
    if (hasFootage(shot) && shot.underlay?.confidence === 'low') {
      findings.push({
        code: 'footage-low-confidence',
        severity: 'warn',
        shotIds: [shot.id],
        message: `${shot.id} keeps a clip the model rated low — a card would read better than a wrong picture`,
      });
    }
  }

  const seenClips = new Map<string, string>();
  const seenQueries = new Map<string, string>();
  for (const shot of shots) {
    const underlay = shot.underlay;
    if (!underlay || underlay.selected === false) continue;
    if (underlay.assetId) {
      const first = seenClips.get(underlay.assetId);
      if (first) {
        findings.push({
          code: 'footage-duplicate-clip',
          severity: 'warn',
          shotIds: [first, shot.id],
          message: `${shot.id} reuses the clip from ${first} — the same footage twice is noticed`,
        });
      } else seenClips.set(underlay.assetId, shot.id);
    }
    const query = underlay.query?.trim().toLowerCase();
    if (query) {
      const first = seenQueries.get(query);
      if (first) {
        findings.push({
          code: 'footage-duplicate-query',
          severity: 'note',
          shotIds: [first, shot.id],
          message: `${shot.id} repeats the search "${underlay.query}" from ${first}`,
        });
      } else seenQueries.set(query, shot.id);
    }
  }

  // --- layout --------------------------------------------------------------

  // A card asking for a bottom anchor collides with the subtitle; the compiler
  // centres it anyway, so this is a note rather than a defect.
  if (cfg.captions) {
    const colliding = shots.filter((shot) => {
      if (hasFootage(shot)) return false;
      const anchor = anchorOf(shot);
      return anchor.startsWith('b');
    });
    if (colliding.length) {
      findings.push({
        code: 'anchor-under-captions',
        severity: 'note',
        shotIds: colliding.map((shot) => shot.id),
        message: `${colliding.length} card(s) ask for a bottom anchor — the compiler centres them above the captions`,
      });
    }
  }

  // --- text ----------------------------------------------------------------

  if (options.schemas) {
    for (const shot of shots) {
      const visual = shot.visual;
      if (visual?.kind !== 'mg') continue;
      const schema = options.schemas.get(visual.recipe);
      if (!schema) continue;
      const params = visual.params ?? {};
      for (const [key, spec] of Object.entries(schema.params)) {
        const value = params[key];
        // Only long fields are worth flagging: a 2-character limit on a
        // full-frame word is a design constraint that the shot is meant to hit,
        // not a text that has grown too big for its box.
        if (typeof value !== 'string' || !spec.maxChars || spec.maxChars < 8) continue;
        const used = Array.from(value).length / spec.maxChars;
        if (used >= cfg.textNearLimit && used <= 1) {
          findings.push({
            code: 'text-near-limit',
            severity: 'note',
            shotIds: [shot.id],
            message: `${shot.id}.${key} is ${Array.from(value).length}/${spec.maxChars} characters — one edit from a rejection`,
          });
        }
      }
    }
  }

  // --- summary -------------------------------------------------------------

  const durationFrames = shots.reduce((end, shot) => Math.max(end, shot.endFrame), 0);
  const footageShots = shots.filter(hasFootage).length;

  const confidence: Record<'high' | 'medium' | 'low', number> = { high: 0, medium: 0, low: 0 };
  for (const shot of shots) {
    const rated = shot.underlay?.confidence;
    if (rated && shot.underlay?.query?.trim()) confidence[rated] += 1;
  }
  const ratedTotal = confidence.high + confidence.medium + confidence.low;
  const stats: QcStats = {
    shots: shots.length,
    durationSec: Number(sec(durationFrames, fps).toFixed(2)),
    avgShotSec: shots.length ? Number((sec(durationFrames, fps) / shots.length).toFixed(2)) : 0,
    footageShots,
    footageRatio: shots.length ? Number((footageShots / shots.length).toFixed(2)) : 0,
    recipes: histogram,
    distinctRecipes,
    footageConfidence: confidence,
    footageRelevance: ratedTotal ? Number(((confidence.high + confidence.medium) / ratedTotal).toFixed(2)) : null,
    transitions,
    abstractShots: shots.filter((shot) => shot.underlay?.subject?.trim() === '-').length,
  };

  return {
    ok: !findings.some((finding) => finding.severity === 'error'),
    findings,
    stats,
  };
}

/** One line per finding, for a terminal. */
export function formatFindings(report: QcReport): string[] {
  const order: Record<QcSeverity, number> = { error: 0, warn: 1, note: 2 };
  return [...report.findings]
    .sort((a, b) => order[a.severity] - order[b.severity])
    .map((finding) => `${finding.severity.toUpperCase().padEnd(5)} ${finding.code}: ${finding.message}`);
}
