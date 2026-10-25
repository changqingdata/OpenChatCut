import { readFile } from 'node:fs/promises';
const env = {};
for (const line of (await readFile('.env.local', 'utf8')).split('\n')) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m) env[m[1]] = m[2].trim();
}
const provider = env.LLM_PROVIDER || 'anthropic';
const base = env.LLM_ANTHROPIC_BASE_URL;
const model = env.LLM_ANTHROPIC_MODEL;
const key = env.LLM_ANTHROPIC_API_KEY;
console.log('provider:', provider, '| model:', model, '| base:', base, '| key:', key ? key.slice(0,6)+'…' : '(none)');
try {
  const res = await fetch(base + '/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model, max_tokens: 64, messages: [{ role: 'user', content: '只回两个字符：OK' }] }),
  });
  console.log('status:', res.status);
  const text = await res.text();
  console.log('body:', text.slice(0, 400));
} catch (e) {
  console.log('FAIL:', e.message);
}
