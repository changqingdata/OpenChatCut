import { readFile } from 'node:fs/promises';
import { parseSrtCues } from './production/srt.ts';
import { buildStoryboardPrompt, checkStoryboard, extractJson, planChunks } from './production/generate.ts';
import { loadRecipeRegistry } from './production/recipes/load.ts';
import { completeText, readLlmConfig } from './production/llm.ts';

const cues = parseSrtCues(await readFile('E:/Anacondapj/ChangqingCut/test/测试/长视频测试.srt','utf8'));
const chunk = planChunks(cues, 90)[0]!;
console.log('chunk cues:', chunk.length);
const { schemas } = await loadRecipeRegistry('production/recipes');
const p = buildStoryboardPrompt({ cues: chunk, brief:'系统思维课程', width:1080, height:1920, fps:30, aspect:'9:16', language:'zh', catalog: schemas });
const cfg = await readLlmConfig();
const t0 = Date.now();
const reply = await completeText(cfg!, { system: p.system, user: p.user, maxTokens: 32000 });
console.log(`${((Date.now()-t0)/1000).toFixed(0)}s | chars=${reply.length}`);
try {
  const sb = extractJson(reply);
  const r = checkStoryboard(sb, schemas);
  console.log('ok:', r.ok, '| shots:', (sb as any).shots?.length);
  if (!r.ok) for (const e of r.errors.slice(0, 6)) console.log('  -', e);
} catch (e) {
  console.log('parse FAIL:', (e as Error).message.slice(0,120));
  console.log('tail:', JSON.stringify(reply.slice(-150)));
}
