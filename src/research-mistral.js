// Researches a restaurant's booking rules with Mistral's built-in web search
// (Conversations API). Mistral reads search results only; this app never
// loads booking-platform pages itself.
//
// Docs: https://docs.mistral.ai/agents/tools/built-in/websearch
// Response: outputs[] with "tool.execution" and "message.output" entries;
// message.output.content is a string or a list of chunks: {type:"text", text}
// and {type:"tool_reference", tool, title, url, source}. Only URLs that come
// back as tool_reference count as sources.

import { normaliseProfile, extractJson } from './profile.js';
import { RESEARCH_PROMPT } from './research.js';

export const MISTRAL_MODEL = 'mistral-medium-latest';
const ENDPOINT = 'https://api.mistral.ai/v1/conversations';

// Mistral returns sources only where it cites them inline, so ask for a
// cited summary before the JSON.
const MISTRAL_EXTRA = `
First write 2–5 short sentences summarising what you found, citing the source of
each fact. Then give the JSON block. Every URL in the JSON must be one you cited.`;

/** Text and cited sources from a Conversations API response. */
export function readMistralOutput(data) {
  const texts = [];
  const sources = new Map();
  for (const entry of data?.outputs || []) {
    if (entry.type !== 'message.output') continue;
    const content = entry.content;
    if (typeof content === 'string') { texts.push(content); continue; }
    for (const chunk of Array.isArray(content) ? content : []) {
      if (chunk.type === 'text' && typeof chunk.text === 'string') texts.push(chunk.text);
      if (chunk.type === 'tool_reference' && typeof chunk.url === 'string' && /^https?:\/\//.test(chunk.url)) {
        sources.set(chunk.url, chunk.title || chunk.source || null);
      }
    }
  }
  return { text: texts.join(''), sources };
}

export async function researchWithMistral({ name, city = 'London', apiKey, model = MISTRAL_MODEL, fetchImpl = fetch, now = Date.now() }) {
  const res = await fetchImpl(ENDPOINT, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      model,
      inputs: [{ role: 'user', content: `${RESEARCH_PROMPT}\n${MISTRAL_EXTRA}\n\nRestaurant: ${name}\nCity: ${city}` }],
      tools: [{ type: 'web_search' }],
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const hint = res.status === 401 ? ' (check MISTRAL_API_KEY)' : res.status === 429 ? ' (rate limit or no credit)' : '';
    throw new Error(`Mistral research failed: ${res.status}${hint} ${body.slice(0, 160)}`.trim());
  }
  const { text, sources } = readMistralOutput(await res.json());
  const json = extractJson(text);
  if (!json) throw new Error('Research returned no usable result.');
  return normaliseProfile(json, sources, { name, city, now });
}
