// The app-side contract: a storyboard becomes ONE undoable batch.
//
// The CLI can compile a storyboard into a whole project because it owns the
// project. The app cannot — there is an open document with other timelines, a
// media pool and a history stack. So this checks the three things that make the
// app path real:
//
//   1. the actions the planner emits are accepted by the reducer (not just
//      shaped like actions);
//   2. the whole apply is a single history step, so one undo returns the project
//      to exactly what it was;
//   3. the storyboard itself lands in the document, with the hash that says which
//      version is on the timeline.
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';

import { CURRENT_PROJECT_VERSION } from '../shared/project-version.ts';
import { historyReduce } from '../src/editor/reduce.ts';
import type { History } from '../src/editor/reducerHistory.ts';
import type { ProjectDoc, Timeline } from '../src/editor/types.ts';
import type { Tpl } from '../src/types.ts';
import { planApplyStoryboard, storyboardHash } from '../src/pipeline/storyboard-apply.ts';
import type { Storyboard } from '../src/pipeline/types.ts';

const ROOT = 'E:/Anacondapj/OpenChatCut';
const templates = JSON.parse(readFileSync(`${ROOT}/assets/templates/shots-templates.json`, 'utf8')) as Tpl[];

function timeline(overrides: Partial<Timeline> = {}): Timeline {
  return {
    id: 'tl-main',
    name: 'main',
    order: 0,
    fps: 30,
    width: 1920,
    height: 1080,
    items: [],
    selectedId: null,
    tracks: { V1: { kind: 'video' }, A1: { kind: 'audio' } },
    trackOrder: ['V1', 'A1'],
    ...overrides,
  };
}

function project(overrides: Partial<Timeline> = {}): ProjectDoc {
  const tl = timeline(overrides);
  return {
    version: CURRENT_PROJECT_VERSION,
    assets: [],
    mediaFolders: [],
    timelines: [tl],
    activeTimelineId: tl.id,
  };
}

const storyboard: Storyboard = {
  version: 1,
  meta: {
    title: 'apply test', runId: 'apply-verify', aspect: '16:9',
    width: 1920, height: 1080, fps: 30, language: 'zh',
  },
  shots: [
    {
      id: 'S01',
      startFrame: 0,
      endFrame: 90,
      job: 'number',
      intent: 'one number',
      narration: { text: '第一句话。', startMs: 0, endMs: 3000 },
      visual: { kind: 'mg', recipe: 'number-count', params: { value: 37, unit: '%' }, layout: { anchor: 'mc', widthRatio: 0.85 } },
      background: '#0B0B0C',
    },
    {
      id: 'S02',
      startFrame: 90,
      endFrame: 180,
      job: 'quote',
      intent: 'one quote',
      narration: { text: '第二句话。', startMs: 3000, endMs: 6000 },
      visual: { kind: 'mg', recipe: 'quote-card', params: { text: '坚持', tail: '时间会给出答案' }, layout: { anchor: 'mc', widthRatio: 0.85 } },
      background: '#0B0B0C',
    },
  ],
};

// --- 1. plan → actions the reducer accepts --------------------------------

const before = project();
const plan = planApplyStoryboard({ doc: before, storyboard, templates });

// Two shots, two lanes each: a base plate on V1 and the graphic on V3.
assert.equal(plan.items, 4, `two shots compile to four items, got ${plan.items}`);
assert.equal(plan.actions[0]!.type, 'clear', 'a replace starts by clearing');
assert.deepEqual(plan.tracks.reused, ['V1'], 'V1 is reused because its kind matches');
assert.deepEqual(plan.tracks.created, ['V3'], 'V3 does not exist yet, so it is created');
assert.ok(plan.actions.some((action) => action.type === 'setCaptions'), 'captions are part of the same batch');
const applied = plan.actions.find((action) => action.type === 'storyboard.set');
assert.ok(applied && applied.type === 'storyboard.set', 'the storyboard travels with the batch');
assert.equal(applied.appliedHash, plan.hash, 'the hash on the document is the one that was planned');

// --- 2. one batch = one undo ----------------------------------------------

let history: History = { past: [], present: before, future: [] };
history = historyReduce(history, { type: 'batch', label: 'Apply storyboard', actions: plan.actions });

assert.equal(history.past.length, 1, 'the whole apply is a single history step');
const after = history.present;
const afterTimeline = after.timelines[0]!;
assert.equal(afterTimeline.items.length, 4, 'both lanes of both shots landed');
const graphics = afterTimeline.items.filter((item) => item.kind === 'motion-graphic');
assert.equal(graphics.length, 2, 'one graphic per shot');
assert.equal(graphics[0]!.templateId, 'number-count', 'items name their template');
assert.ok((afterTimeline.captions?.words.length ?? 0) >= 6, 'captions were built from the narration');
assert.deepEqual(
  afterTimeline.trackOrder,
  ['V3', 'V1', 'A1'],
  'the graphics lane sits above the base plate it draws on',
);
assert.equal(after.storyboard?.shots.length, 2, 'the storyboard is stored on the project');
assert.equal(after.storyboardAppliedHash, plan.hash, 'and marked as applied');

const undone = historyReduce(history, { type: 'undo' }).present;
assert.deepEqual(undone, before, 'one undo returns the project to exactly its previous state');

// --- 3. a project with its own track ids gets lanes created ---------------

const foreign = project({ tracks: { 'track-video': { kind: 'video' }, 'track-audio': { kind: 'audio' } }, trackOrder: ['track-video', 'track-audio'] });
const foreignPlan = planApplyStoryboard({ doc: foreign, storyboard, templates });
assert.deepEqual(foreignPlan.tracks.created, ['V1', 'V3'], 'unknown lanes are created, not dropped');
// A new video lane is inserted at the top, and they are created back to front so
// the compiler's stack survives: V3 (graphics) above V1 (base plate).
assert.deepEqual(
  foreignPlan.actions.filter((action) => action.type === 'track.create').map((action) => action.track.id),
  ['V1', 'V3'],
  'lanes are created bottom-up so the stack is not inverted',
);
assert.equal(foreignPlan.tracks.reused.length, 0, 'nothing matches, so nothing is reused');

let foreignHistory: History = { past: [], present: foreign, future: [] };
foreignHistory = historyReduce(foreignHistory, { type: 'batch', label: 'Apply storyboard', actions: foreignPlan.actions });
assert.equal(foreignHistory.present.timelines[0]!.items.length, 4, 'items survive on a project with different track ids');
assert.deepEqual(
  foreignHistory.present.timelines[0]!.trackOrder,
  ['V3', 'V1', 'track-video', 'track-audio'],
  'the storyboard stack sits above the tracks the project already had',
);

// --- 4. the hash identifies the version, so a re-apply is detectable ------

assert.equal(storyboardHash(storyboard), plan.hash, 'the hash is stable');
const edited: Storyboard = {
  ...storyboard,
  shots: storyboard.shots.map((shot, index) => (index === 0
    ? { ...shot, visual: { ...shot.visual, params: { value: 38 } } }
    : shot)),
};
assert.notEqual(storyboardHash(edited), plan.hash, 'a changed shot changes the hash');

// Re-applying the same board twice must not double the timeline.
let twice: History = { past: [], present: after, future: [] };
twice = historyReduce(twice, { type: 'batch', label: 'Apply storyboard', actions: planApplyStoryboard({ doc: after, storyboard, templates }).actions });
assert.equal(twice.present.timelines[0]!.items.length, 4, 'applying twice replaces instead of appending');

console.log('storyboard-apply.verify: one batch, one undo, tracks created on demand, hash tracks the version');
