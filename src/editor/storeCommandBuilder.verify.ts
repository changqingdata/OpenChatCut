import assert from 'node:assert/strict';
import { CURRENT_PROJECT_VERSION } from '../../shared/project-version';
import { historyReduce } from './reduce';
import { buildCommands } from './storeCommandBuilder';
import type { ProjectDoc } from './types';

function project(kind: 'audio' | 'video'): ProjectDoc {
  return {
    version: CURRENT_PROJECT_VERSION,
    activeTimelineId: 'timeline',
    assets: [],
    mediaFolders: [],
    timelines: [{
      id: 'timeline', name: 'test', order: 0,
      fps: 30, width: 1920, height: 1080, items: [], selectedId: null,
      tracks: { existing: { kind } }, trackOrder: ['existing'],
    }],
  };
}

for (const overwrite of [false, true]) {
  for (const kind of ['audio', 'video'] as const) {
    const initial = project(kind === 'audio' ? 'video' : 'audio');
    let history = { past: [] as ProjectDoc[], present: initial, future: [] as ProjectDoc[] };
    const commands = buildCommands((action) => { history = historyReduce(history, action); }, () => history.present);
    if (kind === 'audio') {
      commands.addAudio({ id: 'sound', name: 'sound', category: 'voice', src: '/media/uploads/sound.mp3', durationInFrames: 30 }, { overwrite });
      assert.equal(history.present.assets.length, 1, 'audio preparation retains its asset');
    } else {
      commands.addMotionGraphic({
        id: 'graphic', name: 'graphic', category: 'test', code: 'return null;', props: {}, fps: 30, propSchema: [], thumb: null,
        width: 1920, height: 1080, durationInFrames: 30,
      }, { overwrite });
    }
    const timeline = history.present.timelines[0];
    assert.equal(timeline.items.length, 1);
    const track = timeline.items[0].track;
    assert.equal(timeline.tracks?.[track]?.kind, kind, 'new clip references a real track');
    assert.deepEqual(timeline.trackOrder?.map((id) => timeline.tracks?.[id]?.kind), ['video', 'audio'],
      'overwrite must use the normal reducer track order');
    assert.equal(history.past.length, 1, 'preparation and placement are one undo step');
    assert.deepEqual(historyReduce(history, { type: 'undo' }).present, initial);
  }
}
console.log('storeCommandBuilder.verify: overwrite and normal placement retain tracks, order, assets, and single-step undo');

// A card is a design unit, not a scene. The layer fits every clip to the canvas
// before its own transform applies, so a 900×520 card dropped in unscaled would
// render at ~1870×1080. `addMotionGraphic` must cancel that fit — and a scene
// must not, or a 1920×1080 template would be scaled to 0.56 for no reason.
{
  let history = { past: [] as ProjectDoc[], present: project('video'), future: [] as ProjectDoc[] };
  const commands = buildCommands((action) => { history = historyReduce(history, action); }, () => history.present);
  const tpl = {
    id: 'card', name: 'card', category: 'test', code: 'return null;', props: {}, fps: 30, propSchema: [], thumb: null,
    width: 900, height: 520, durationInFrames: 90, kind: 'card' as const,
  };
  commands.addMotionGraphic(tpl, {});
  const card = history.present.timelines[0]!.items[0]!;
  const fitted = Math.min(1920 / 900, 1080 / 520);
  assert.ok(card.transform, 'a card carries a transform that cancels the canvas fit');
  assert.ok(Math.abs((card.transform!.scale ?? 0) * fitted - 1) < 0.002,
    `card renders at its design size (scale ${card.transform!.scale} × fit ${fitted.toFixed(3)})`);

  let scenes = { past: [] as ProjectDoc[], present: project('video'), future: [] as ProjectDoc[] };
  const sceneCommands = buildCommands((action) => { scenes = historyReduce(scenes, action); }, () => scenes.present);
  sceneCommands.addMotionGraphic({ ...tpl, id: 'scene', kind: 'scene', width: 1920, height: 1080 }, {});
  const scene = scenes.present.timelines[0]!.items[0]!;
  assert.equal(scene.transform, undefined, 'a scene fills the canvas and needs no transform');
  console.log('storeCommandBuilder.verify: cards cancel the canvas fit, scenes keep it');
}
