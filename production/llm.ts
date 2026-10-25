// Minimal LLM client for the production pipeline.
//
// Deliberately not the agent runtime: storyboard generation is a single
// request/response, and depending on the run executor would drag the whole
// session machinery into a CLI command. Reads the same `.env.local` the app
// uses, so one key configuration serves both.
import { readFile } from 'node:fs/promises';

export interface LlmConfig {
  provider: string;
  protocol: 'anthropic' | 'openai-chat';
  baseUrl: string;
  model: string;
  apiKey: string;
}

function parseEnv(source: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of source.split('\n')) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (!match) continue;
    env[match[1]!] = match[2]!.trim().replace(/^["']|["']$/g, '');
  }
  return env;
}

/**
 * Resolve the configured provider. Returns null when no key is set — callers
 * should fall back to emitting the prompt instead of failing.
 */
export async function readLlmConfig(envPath = '.env.local'): Promise<LlmConfig | null> {
  let source: string;
  try {
    source = await readFile(envPath, 'utf8');
  } catch {
    return null;
  }
  const env = parseEnv(source);
  const provider = (env.LLM_PROVIDER || 'anthropic').toLowerCase();
  const upper = provider.toUpperCase();

  const baseUrl = env[`LLM_${upper}_BASE_URL`] || '';
  const model = env[`LLM_${upper}_MODEL`] || '';
  const apiKey = env[`LLM_${upper}_API_KEY`] || '';
  if (!apiKey || !model) return null;

  // Anthropic speaks its own messages API; everything else here is
  // OpenAI-compatible chat completions.
  const protocol = provider === 'anthropic' ? 'anthropic' : 'openai-chat';
  const fallbackBase = protocol === 'anthropic' ? 'https://api.anthropic.com/v1' : 'https://api.openai.com/v1';
  return { provider, protocol, baseUrl: baseUrl || fallbackBase, model, apiKey };
}

export interface CompletionRequest {
  system: string;
  user: string;
  maxTokens?: number;
  temperature?: number;
}

export async function completeText(config: LlmConfig, request: CompletionRequest): Promise<string> {
  const maxTokens = request.maxTokens ?? 8000;

  if (config.protocol === 'anthropic') {
    const res = await fetch(`${config.baseUrl.replace(/\/$/, '')}/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': config.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: config.model,
        max_tokens: maxTokens,
        system: request.system,
        messages: [{ role: 'user', content: request.user }],
      }),
    });
    const body = await res.text();
    if (!res.ok) throw new Error(`LLM ${res.status}: ${body.slice(0, 300)}`);
    const parsed = JSON.parse(body) as { content?: Array<{ type: string; text?: string }> };
    return (parsed.content ?? []).filter((part) => part.type === 'text').map((part) => part.text ?? '').join('');
  }

  const res = await fetch(`${config.baseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${config.apiKey}` },
    body: JSON.stringify({
      model: config.model,
      max_tokens: maxTokens,
      temperature: request.temperature ?? 0.7,
      messages: [
        { role: 'system', content: request.system },
        { role: 'user', content: request.user },
      ],
    }),
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`LLM ${res.status}: ${body.slice(0, 300)}`);
  const parsed = JSON.parse(body) as { choices?: Array<{ message?: { content?: string } }> };
  return parsed.choices?.[0]?.message?.content ?? '';
}
