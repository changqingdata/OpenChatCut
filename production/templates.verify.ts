// The generated catalog must be loadable by the app, not just parseable by Node.
//
// `shots-templates.json` is a build artifact (production/catalog/build-templates.mjs).
// Three things can go wrong between a recipe directory and the library:
//
//   1. the code survives JSON but not the sandbox — one forbidden token and the
//      template only fails when someone drags it in;
//   2. the propSchema and the props disagree, so the inspector edits a key the
//      component never reads;
//   3. the thumbnail path points at a file that was never copied.
//
// All three are checked here, by actually compiling every template through the
// same `prepareTemplate` the renderer uses.
import { existsSync, readFileSync } from 'node:fs';
import { strict as assert } from 'node:assert';
import { prepareTemplate } from '../src/template-host.ts';

const ROOT = 'E:/Anacondapj/OpenChatCut';
const templates = JSON.parse(readFileSync(`${ROOT}/assets/templates/shots-templates.json`, 'utf8'));

assert.ok(Array.isArray(templates) && templates.length === 15, `expected 15 templates, got ${templates.length}`);

const ids = new Set();
for (const template of templates) {
  assert.ok(!ids.has(template.id), `duplicate id ${template.id}`);
  ids.add(template.id);

  assert.ok(template.code.includes('=>'), `${template.id}: code is not a component`);
  assert.ok(template.width > 0 && template.height > 0, `${template.id}: no design box`);
  assert.ok(['card', 'scene'].includes(template.kind), `${template.id}: kind must be card or scene`);
  if (template.kind === 'card') {
    assert.equal(template.box?.width, template.width, `${template.id}: box must equal width`);
    assert.equal(template.box?.height, template.height, `${template.id}: box must equal height`);
    // A landscape box that is not actually wider than the portrait one would
    // silently do nothing: the compiler only uses it when canvasW > canvasH, and
    // a narrow "landscape" box then gets height-capped like the original.
    if (template.landscapeBox) {
      assert.ok(
        template.landscapeBox.width > template.landscapeBox.height,
        `${template.id}: landscapeBox must be landscape (${template.landscapeBox.width}×${template.landscapeBox.height})`,
      );
      assert.ok(
        template.landscapeBox.width > template.width,
        `${template.id}: landscapeBox must be wider than the card box`,
      );
    }
  } else {
    // A scene owns the canvas, so it must be canvas-sized and carry no card box.
    // A 900×900 "scene" letterboxes to a square on a 16:9 timeline.
    assert.equal(template.box, undefined, `${template.id}: a scene has no card box`);
    assert.ok(
      (template.width === 1920 && template.height === 1080) || (template.width === 1080 && template.height === 1920),
      `${template.id}: a scene must be a canvas, got ${template.width}x${template.height}`,
    );
  }
  assert.ok(Array.isArray(template.jobs) && template.jobs.length > 0, `${template.id}: no jobs — QC cannot judge it`);

  // Every declared control must address a real key, and every default must be
  // reachable from the inspector. A param with no default is legal (it is
  // optional and starts empty) — what is not legal is a control whose value the
  // component never reads, or a default nobody can edit.
  for (const spec of template.propSchema) {
    assert.ok(
      spec.key in template.props,
      `${template.id}: propSchema key "${spec.key}" has no value in props`,
    );
  }
  for (const key of Object.keys(template.props)) {
    assert.ok(
      template.propSchema.some((spec) => spec.key === key),
      `${template.id}: prop "${key}" has a default but no control`,
    );
  }

  assert.ok(template.thumb?.startsWith('/thumbnails/'), `${template.id}: thumb must be a /thumbnails path`);
  assert.ok(
    existsSync(`${ROOT}/assets${template.thumb}`),
    `${template.id}: thumbnail missing at assets${template.thumb} — rerun build-templates.mjs`,
  );

  // The real test: Babel + the sandbox blocklist, on the JSON-escaped code.
  const component = await prepareTemplate(template.code);
  assert.equal(typeof component, 'function', `${template.id}: sandbox did not produce a component`);
}

console.log(`templates.verify: ${templates.length} templates compile in the sandbox, thumbs present, schema aligned`);
