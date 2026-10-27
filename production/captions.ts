// Builds the caption overlay from subtitle cues.
//
// The app's caption system reads `CaptionsData.words` — word-level entries with
// millisecond timings — and paginates them itself. Subtitles only give cue-level
// timings, so the words have to be derived: split the line, then place each unit
// inside its cue.
//
// Two ways to place them, and the difference is visible:
//
//   measured   `SpeechTiming` from the local whisper model says when each
//              syllable was actually spoken, so a fast clause followed by a
//              pause gets the pause where it belongs.
//   estimated  no timing available: spread the cue's duration across its units
//              in proportion to their length. Good enough for phrase pacing,
//              where the whole line shows at once.
//
// The model is never asked for the text — see transcribe.ts for why.

import type { CaptionsData, CaptionMotionPreset, CaptionTemplate, CaptionPacing, CaptionWordOverride } from '../src/captions/types.ts';
import type { TranscriptWord } from '../src/transcript/types.ts';
import type { SpeechTiming } from './transcribe.ts';
import type { SrtCue } from './srt.ts';

const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/;

/**
 * Split one cue into word units.
 *
 * CJK gets one entry per character: the language has no spaces, and character
 * granularity is what makes the highlight land on the syllable being spoken.
 * Latin runs split on whitespace. Punctuation stays attached to the piece it
 * follows so it never renders alone.
 */
export function splitCueText(text: string): string[] {
  const units: string[] = [];
  let latin = '';

  const flushLatin = () => {
    if (latin.trim()) units.push(latin.trim());
    latin = '';
  };

  for (const char of text) {
    if (CJK.test(char)) {
      flushLatin();
      units.push(char);
    } else if (/\s/.test(char)) {
      flushLatin();
    } else if (/[，。、！？；：""''（）《》…—,.!?;:]/.test(char)) {
      // Attach trailing punctuation to the previous unit.
      if (latin) {
        latin += char;
        flushLatin();
      } else if (units.length) {
        units[units.length - 1] += char;
      }
    } else {
      latin += char;
    }
  }
  flushLatin();

  return units.length ? units : [text.trim()].filter(Boolean);
}

/** Spread each cue's duration across its units, weighted by unit length. */
function estimatedBoundaries(cue: SrtCue, units: readonly string[]): number[] {
  const weights = units.map((unit) => Math.max(1, [...unit].length));
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  const span = cue.endMs - cue.startMs;
  const bounds = [cue.startMs];
  let cursor = cue.startMs;
  for (let index = 0; index < units.length - 1; index += 1) {
    cursor += (weights[index]! / total) * span;
    bounds.push(Math.round(cursor));
  }
  bounds.push(cue.endMs);
  return bounds;
}

/**
 * Boundaries from measured speech, or null when the model heard nothing inside
 * this cue.
 *
 * The tokens are treated as a speech-density function rather than a character
 * list: unit k of n lands where the cue's speech is k/n through. That keeps the
 * placement right when the model's token count differs from the line's character
 * count — which it always does, because it merges and splits differently — and it
 * puts highlights on spoken syllables instead of in the gaps between them.
 */
function measuredBoundaries(cue: SrtCue, count: number, timing: SpeechTiming | undefined): number[] | null {
  if (!timing?.tokens.length || count < 1) return null;
  const spans = timing.tokens
    .filter((token) => token.end > cue.startMs && token.start < cue.endMs)
    .map((token) => ({ start: Math.max(token.start, cue.startMs), end: Math.min(token.end, cue.endMs) }))
    .filter((span) => span.end > span.start)
    .sort((a, b) => a.start - b.start);
  if (!spans.length) return null;

  const total = spans.reduce((sum, span) => sum + (span.end - span.start), 0);
  if (total <= 0) return null;

  // One measured unit per unit: take the boundaries verbatim. For Chinese this
  // is the normal case — whisper emits a token per character — and it puts every
  // highlight exactly on its syllable. A character followed by a pause keeps its
  // highlight through the pause, which is what karaoke does.
  if (spans.length === count) {
    return [cue.startMs, ...spans.slice(1).map((span) => Math.round(span.start)), cue.endMs];
  }

  const timeAt = (fraction: number): number => {
    const target = fraction * total;
    let accumulated = 0;
    for (const span of spans) {
      const length = span.end - span.start;
      if (accumulated + length >= target) return span.start + (target - accumulated);
      accumulated += length;
    }
    return spans[spans.length - 1]!.end;
  };

  const bounds = [cue.startMs];
  for (let index = 1; index < count; index += 1) bounds.push(Math.round(timeAt(index / count)));
  bounds.push(cue.endMs);
  // A model that produced overlapping tokens can still yield a decreasing
  // boundary; the caption engine expects a walkable timeline.
  for (let index = 1; index < bounds.length; index += 1) {
    if (bounds[index]! < bounds[index - 1]!) bounds[index] = bounds[index - 1]!;
  }
  return bounds;
}

export function wordsFromCues(cues: readonly SrtCue[], timing?: SpeechTiming): TranscriptWord[] {
  const words: TranscriptWord[] = [];
  let index = 0;

  for (const cue of cues) {
    const units = splitCueText(cue.text);
    if (!units.length) continue;
    const bounds = measuredBoundaries(cue, units.length, timing) ?? estimatedBoundaries(cue, units);

    units.forEach((text, position) => {
      const start = bounds[position]!;
      const end = Math.max(bounds[position + 1]!, start + 1);
      words.push({ id: `w${index}`, text, start, end });
      index += 1;
    });
  }

  return words;
}

export interface CaptionOptions {
  template?: CaptionTemplate;
  motion?: CaptionMotionPreset;
  pacing?: CaptionPacing;
  enabled?: boolean;
  /** Measured speech from `occ transcribe`; without it the timing is estimated. */
  timing?: SpeechTiming;
}

/**
 * Caption overlay for a timeline whose voiceover starts at frame 0.
 *
 * `deyi-card` is the default because it is the one built-in template drawn in
 * Smiley Sans — the same face the recipes use, so captions and graphics read as
 * one design rather than two.
 *
 * Pagination needs help: the caption engine groups words by its own length
 * heuristics and knows nothing about where a subtitle line ended, so three cues
 * would run together into one page. Marking the first word of every cue with
 * `forceBreak` restores the line breaks the subtitles already had.
 */
export function buildCaptions(cues: readonly SrtCue[], options: CaptionOptions = {}): CaptionsData {
  const words = wordsFromCues(cues, options.timing);
  const wordOverrides: Record<number, CaptionWordOverride> = {};

  let cursor = 0;
  for (const cue of cues) {
    const count = splitCueText(cue.text).length;
    if (!count) continue;
    if (cursor > 0) wordOverrides[cursor] = { forceBreak: true };
    cursor += count;
  }

  return {
    enabled: options.enabled ?? true,
    template: options.template ?? 'deyi-card',
    pacing: options.pacing ?? 'phrase',
    motionPreset: options.motion ?? 'fade-up',
    words,
    offsetFrames: 0,
    ...(Object.keys(wordOverrides).length ? { wordOverrides } : {}),
  };
}
