import templatesJson from '../../assets/templates/openchatcut-templates.json';
import socialShortsJson from '../../assets/templates/social-shorts-templates.json';
import kouboScenesJson from '../../assets/templates/koubo-scenes-templates.json';
import shotsJson from '../../assets/templates/shots-templates.json';
import type { Tpl } from '../types';
import type { TimelineState } from './types';

// The template library + the first-run seed project. Shared by the loader shell
// (fallback when nothing is persisted) and the editor (agent context / library).
// 211 items (openchatcut-templates.json) + vertical screen self-media social-shorts (9:16)
// + Oral broadcast scenes koubo-scenes (background + characters through the window, both horizontal and vertical).
// + 15 shot cards generated from production/recipes — the compiler's own vocabulary.
//   These are `kind: 'card'`: a design box the compiler places on top of footage,
//   not a scene that fills the frame. Generated, never hand-edited
//   (production/catalog/build-templates.mjs --check enforces it).
// The old koubo-dual preview is too rough and has been removed from the shelves. Please do not merge it again - koubo-scenes is a replacement.
export const TEMPLATES = [
  ...(templatesJson as Tpl[]),
  ...(socialShortsJson as Tpl[]),
  ...(kouboScenesJson as Tpl[]),
  ...(shotsJson as Tpl[]),
];

const pick = (name: string): Tpl => TEMPLATES.find((t) => t.name.includes(name)) ?? TEMPLATES[0];
const seedItem = (id: string, tpl: Tpl, startFrame: number) => ({
  id, track: 'V1' as const, startFrame, durationInFrames: tpl.durationInFrames,
  kind: 'motion-graphic' as const, templateId: tpl.id, name: tpl.name,
  code: tpl.code, props: { ...tpl.props }, width: tpl.width, height: tpl.height,
});
const SEED_A = pick('Finance Explainer');
const SEED_B = pick('Dark Tech');

export const INITIAL: TimelineState = {
  fps: 30,
  width: 1920,
  height: 1080,
  items: [
    seedItem('seed_1', SEED_A, 0),
    seedItem('seed_2', SEED_B, SEED_A.durationInFrames),
  ],
  selectedId: null,
};
