// Builds the caption overlay from subtitle cues.
//
// The app's caption system reads `CaptionsData.words` — word-level entries with
// millisecond timings — and paginates them itself. Subtitles only give cue-level
// timings, so the words have to be derived: split the line, then spread the
// cue's duration across the pieces in proportion to their length.
//
// That is an approximation, and it shows if a cue is long and unevenly paced.
// It is good enough for phrase pacing, where the whole line shows at once and
// the per-word timing only drives the karaoke highlight.

import type { CaptionsData, CaptionMotionPreset, CaptionTemplate, CaptionPacing, CaptionWordOverride } from '../src/captions/types.ts';
import type { TranscriptWord } from '../src/transcript/types.ts';
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
export function wordsFromCues(cues: readonly SrtCue[]): TranscriptWord[] {
  const words: TranscriptWord[] = [];
  let index = 0;

  for (const cue of cues) {
    const units = splitCueText(cue.text);
    if (!units.length) continue;

    const weights = units.map((unit) => Math.max(1, [...unit].length));
    const total = weights.reduce((sum, weight) => sum + weight, 0);
    const span = cue.endMs - cue.startMs;

    let cursor = cue.startMs;
    units.forEach((text, position) => {
      const share = (weights[position]! / total) * span;
      const end = position === units.length - 1 ? cue.endMs : Math.round(cursor + share);
      words.push({ id: `w${index}`, text, start: Math.round(cursor), end });
      cursor = end;
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
  const words = wordsFromCues(cues);
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
