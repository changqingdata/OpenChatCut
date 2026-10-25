// Minimal SRT reader producing cue-level rows.
//
// The app's own parser (`src/captions/srt.ts`) returns word-level transcript
// entries. A storyboard cares about lines — one cue is one thing said — so this
// keeps the grouping the author wrote instead of re-deriving it.

export interface SrtCue {
  index: number;
  startMs: number;
  endMs: number;
  text: string;
}

function parseTimestamp(value: string): number | null {
  const match = value.trim().match(/^(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})$/);
  if (!match) return null;
  const [, h, m, s, ms] = match;
  return Number(h) * 3600000 + Number(m) * 60000 + Number(s) * 1000 + Number(ms.padEnd(3, '0'));
}

export function parseSrtCues(source: string): SrtCue[] {
  const cues: SrtCue[] = [];
  const blocks = source.replace(/\r\n/g, '\n').trim().split(/\n{2,}/);

  for (const block of blocks) {
    const lines = block.split('\n').map((line) => line.trim()).filter(Boolean);
    if (lines.length < 2) continue;

    // The index line is optional in the wild; find the timing line instead.
    const timingAt = lines.findIndex((line) => line.includes('-->'));
    if (timingAt === -1) continue;

    const [from, to] = lines[timingAt].split('-->');
    const startMs = parseTimestamp(from ?? '');
    const endMs = parseTimestamp(to ?? '');
    if (startMs === null || endMs === null || endMs <= startMs) continue;

    const text = lines.slice(timingAt + 1).join(' ').replace(/<[^>]+>/g, '').trim();
    if (!text) continue;

    cues.push({ index: cues.length + 1, startMs, endMs, text });
  }

  return cues;
}
