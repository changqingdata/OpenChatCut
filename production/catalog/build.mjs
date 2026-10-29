// Build the reference stills the catalog points at.
//
// `occ catalog` can describe a recipe in words, but words do not tell an agent
// whether a layout wants three characters or twelve. One frame per recipe does,
// and it is the difference between an agent that picks from all fifteen and one
// that keeps reaching for the three it happens to remember.
//
//   node production/catalog/build.mjs [1920x1080] [960]
//
// Output: production/catalog/stills/<recipe>.jpg, committed with the repo so a
// fresh clone has them without rendering anything.
import { execSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

const SIZE = process.argv[2] ?? '1920x1080';
const WIDTH = Number(process.argv[3] ?? 960);
const WORK = 'production/work/.catalog';
const OUT = 'production/catalog/stills';
const PROJECT = '配方目录';

function run(command) {
  return execSync(command, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
}

mkdirSync(WORK, { recursive: true });
mkdirSync(OUT, { recursive: true });

// 1. One shot per recipe. gallery.mjs writes the storyboard to stdout and the
//    id=recipe map to stderr, so stdout can go straight to a file.
run(`node production/recipes/gallery.mjs ${SIZE} > ${WORK}/storyboard.json`);
const storyboard = JSON.parse(readFileSync(`${WORK}/storyboard.json`, 'utf8'));
console.log(`${storyboard.shots.length} recipes · ${SIZE}`);

// 2. A scratch project. Reused when it exists so repeated builds do not pile up
//    projects in the library.
try {
  run(`npx tsx cli/main.ts project show "${PROJECT}" --json`);
} catch {
  run(`npx tsx cli/main.ts project new "${PROJECT}" --size ${SIZE} --fps 30`);
}

// 3. Compile without captions: the stills are about the recipe, and a caption
//    band would hide the bottom third of every layout.
run(`npx tsx cli/main.ts compile "${PROJECT}" --storyboard ${WORK}/storyboard.json --timeline tl-main --replace --apply --no-captions --json`);

// 4. Midpoint of each shot — the frame where the animation has landed and the
//    layout is at its most legible.
const frames = storyboard.shots.map((shot) => Math.round((shot.startFrame + shot.endFrame) / 2));
rmSync(`${WORK}/stills`, { recursive: true, force: true });
run(`npx tsx cli/main.ts still "${PROJECT}" --out ${WORK}/stills --frames ${frames.join(',')} --width ${WIDTH} --json`);

// 5. Rename frame-000123.jpg → <recipe>.jpg. The frame number is the only key
//    the still command returns, and it is unique per shot by construction.
let written = 0;
const index = [];
for (const [i, shot] of storyboard.shots.entries()) {
  const frame = frames[i];
  const from = `${WORK}/stills/frame-${String(frame).padStart(6, '0')}.jpg`;
  if (!existsSync(from)) {
    console.error(`missing still for ${shot.id} (frame ${frame})`);
    continue;
  }
  const recipe = shot.visual.recipe;
  copyFileSync(from, `${OUT}/${recipe}.jpg`);
  index.push({ recipe, frame, file: `${OUT}/${recipe}.jpg` });
  written += 1;
}

writeFileSync(`${WORK}/index.json`, `${JSON.stringify(index, null, 2)}\n`, 'utf8');
console.log(`${written} stills → ${OUT} @ ${WIDTH}px wide`);
