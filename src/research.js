// Research step. Mistral (src/research-mistral.js) is the default; this file
// holds the shared prompt, the provider switch, and the optional Claude
// provider (used only if ANTHROPIC_API_KEY is set and MISTRAL_API_KEY isn't).

import Anthropic from '@anthropic-ai/sdk';
import { normaliseProfile, searchedUrls, extractJson, finalText } from './profile.js';

export const RESEARCH_MODEL = 'claude-opus-5-5';

export const RESEARCH_PROMPT = `You research how and when a restaurant releases online table bookings.
Search the web (the restaurant's own site first, then guides, press and listings).
Report only facts stated on pages you found in this search, and cite those exact page URLs.
If a fact is not stated anywhere you found, use null. Never guess or infer a number.
Do not try to read live availability; it is not needed.

Answer with one JSON object in a \`\`\`json block, exactly this shape:
{
  "name": string,
  "area": {"value": string|null, "sources": [url]},
  "website": {"value": url|null, "sources": [url]},
  "platform": {"value": "opentable"|"resy"|"sevenrooms"|"tock"|"designmynight"|"other"|null,
               "booking_url": url|null, "sources": [url]},
  "booking_window": {"pattern": "rolling"|"monthly"|"unknown", "days_ahead": int|null,
                     "months_ahead": int|null, "day_of_month": int|null, "sources": [url]},
  "release_time": {"value": "HH:MM" (UK time) | null, "sources": [url]},
  "service_hours": {"value": {"mon": [["HH:MM","HH:MM"]], ...} | null,
                    "complete": boolean, "sources": [url]},
  "phone": {"number": string|null, "hours": string|null, "note": string|null, "sources": [url]},
  "notes": [string]
}
"rolling" = bookings open a fixed number of days ahead each day. "monthly" = a whole month opens
on a set day (e.g. the 1st, two months ahead). Leave out closed days in service_hours; set
"complete" true only if a source lists the full weekly hours. Notes: at most 3 short tips
about getting a table (e.g. walk-ins, phone line, cancellation list), each from a source.`;

/**
 * Run the research. Returns a normalised profile (see profile.js).
 * `client` can be injected for tests.
 */
export async function researchRestaurant({ name, city = 'London', apiKey, client, now = Date.now() }) {
  const anthropic = client || new Anthropic({ apiKey });
  const messages = [{ role: 'user', content: `Restaurant: ${name}\nCity: ${city}` }];
  let response;
  const content = [];
  for (let turn = 0; turn < 4; turn++) {
    response = await anthropic.beta.messages.create({
      model: RESEARCH_MODEL,
      max_tokens: 16000,
      thinking: { type: 'adaptive' },
      output_config: { effort: 'medium' },
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      system: RESEARCH_PROMPT,
      tools: [{ type: 'web_search_20260209', name: 'web_search', max_uses: 6, user_location: { type: 'approximate', country: 'GB', city } }],
      messages,
    });
    content.push(...response.content);
    if (response.stop_reason !== 'pause_turn') break;
    messages.push({ role: 'assistant', content: response.content });
  }
  if (response.stop_reason === 'refusal') throw new Error('Research was declined by the model.');
  const json = extractJson(finalText(response.content)) || extractJson(finalText(content));
  if (!json) throw new Error('Research returned no usable result.');
  return normaliseProfile(json, searchedUrls(content), { name, city, now });
}

/** Which research provider is configured: Mistral first, then Claude. */
export function researchProvider(env) {
  if (env.MISTRAL_API_KEY) return 'mistral';
  if (env.ANTHROPIC_API_KEY) return 'claude';
  return null;
}

export async function research(env, { name, city, fetchImpl }) {
  const provider = researchProvider(env);
  if (provider === 'mistral') {
    const { researchWithMistral } = await import('./research-mistral.js');
    return researchWithMistral({ name, city, apiKey: env.MISTRAL_API_KEY, model: env.MISTRAL_MODEL || undefined, fetchImpl });
  }
  if (provider === 'claude') return researchRestaurant({ name, city, apiKey: env.ANTHROPIC_API_KEY });
  throw new Error('No research key set.');
}
