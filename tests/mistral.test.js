// The Mistral response below is ILLUSTRATIVE: built from the field names in
// Mistral's web-search docs (outputs → message.output → content chunks of
// type "text" and "tool_reference"), not captured from a live call. The
// facts and URLs are the real Bouchon Racine findings from 2026-11-05.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readMistralOutput, researchWithMistral, MISTRAL_MODEL } from '../src/research-mistral.js';
import { researchProvider } from '../src/research.js';
import { urlKey } from '../src/profile.js';
import { handleApi } from '../src/worker.js';

const json = {
  name: 'Bouchon Racine',
  area: { value: 'Farringdon, London', sources: ['https://travelsort.com/bouchon-racine-london-review'] },
  website: { value: null, sources: [] },
  platform: { value: 'opentable', booking_url: 'https://www.opentable.co.uk/r/bouchon-racine-london', sources: ['https://www.opentable.co.uk/r/bouchon-racine-london?utm_source=x'] },
  booking_window: { pattern: 'rolling', days_ahead: 30, months_ahead: null, day_of_month: null, sources: ['https://travelsort.com/bouchon-racine-london-review/', 'https://mapstr.com/place/cE0kbi0WwY'] },
  release_time: { value: '09:00', sources: ['https://made-up.example/'] },
  service_hours: { value: null, complete: false, sources: [] },
  phone: { number: null, hours: null, note: null, sources: [] },
  notes: [],
};
const response = {
  conversation_id: 'conv_1',
  outputs: [
    { object: 'entry', type: 'tool.execution', name: 'web_search', id: 't1' },
    { object: 'entry', type: 'message.output', role: 'assistant', model: 'mistral-medium-latest', id: 'm1', content: [
      { type: 'text', text: 'Bookings open 30 days ahead' },
      { type: 'tool_reference', tool: 'web_search', title: 'Bouchon Racine London Review', url: 'https://travelsort.com/bouchon-racine-london-review/', source: 'brave' },
      { type: 'tool_reference', tool: 'web_search', title: 'mapstr place model', url: 'https://mapstr.com/place/cE0kbi0WwY', source: 'brave' },
      { type: 'text', text: ' and it uses OpenTable' },
      { type: 'tool_reference', tool: 'web_search', title: 'bouchon racine london', url: 'https://www.opentable.co.uk/r/bouchon-racine-london', source: 'brave' },
      { type: 'text', text: '.\n\n```json\n' + JSON.stringify(json, null, 1).slice(0, 200) },
      { type: 'text', text: JSON.stringify(json, null, 1).slice(200) + '\n```' },
    ] },
  ],
};

test('Mistral output: text joined, cited URLs collected', () => {
  const { text, sources } = readMistralOutput(response);
  assert.match(text, /^Bookings open 30 days ahead and it uses OpenTable\./);
  assert.deepEqual([...sources.keys()], ['https://travelsort.com/bouchon-racine-london-review/', 'https://mapstr.com/place/cE0kbi0WwY', 'https://www.opentable.co.uk/r/bouchon-racine-london']);
  assert.equal(readMistralOutput({ outputs: [{ type: 'message.output', content: 'plain' }] }).text, 'plain');
});

test('URL matching ignores trailing slash, tracking params and www', () => {
  assert.equal(urlKey('https://www.a.com/x/?utm_source=y#z'), urlKey('https://a.com/x'));
  assert.notEqual(urlKey('https://a.com/x?id=1'), urlKey('https://a.com/x?id=2'));
});

test('Mistral research: request shape and validated profile', async () => {
  let sent;
  const fetchStub = async (url, init) => { sent = { url, init: { ...init, body: JSON.parse(init.body) } }; return Response.json(response); };
  const p = await researchWithMistral({ name: 'Bouchon Racine', apiKey: 'm-key', fetchImpl: fetchStub, now: Date.parse('2026-11-09T10:00:00Z') });
  assert.equal(sent.url, 'https://api.mistral.ai/v1/conversations');
  assert.equal(sent.init.headers.Authorization, 'Bearer m-key');
  assert.equal(sent.init.body.model, MISTRAL_MODEL);
  assert.deepEqual(sent.init.body.tools, [{ type: 'web_search' }]);
  assert.match(sent.init.body.inputs[0].content, /Restaurant: Bouchon Racine/);
  assert.equal(p.release.daysAhead, 30);
  assert.equal(p.release.confidence, 'high');
  assert.equal(p.platform, 'opentable');
  assert.equal(p.facts.find((f) => f.label === 'Platform').sources.length, 1); // matched despite ?utm_
  assert.equal(p.release.timeEstimated, true); // 09:00 cited a page search never returned
});

test('Mistral research: clear errors', async () => {
  await assert.rejects(researchWithMistral({ name: 'X', apiKey: 'bad', fetchImpl: async () => new Response('{"message":"Unauthorized"}', { status: 401 }) }), /401 \(check MISTRAL_API_KEY\)/);
  await assert.rejects(researchWithMistral({ name: 'X', apiKey: 'k', fetchImpl: async () => Response.json({ outputs: [] }) }), /no usable result/);
});

test('provider choice: Mistral first, Claude only as fallback', async () => {
  assert.equal(researchProvider({ MISTRAL_API_KEY: 'm', ANTHROPIC_API_KEY: 'a' }), 'mistral');
  assert.equal(researchProvider({ ANTHROPIC_API_KEY: 'a' }), 'claude');
  assert.equal(researchProvider({}), null);
  const kv = { m: new Map(), async get(k, t) { const v = this.m.get(k); return v == null ? null : t === 'json' ? JSON.parse(v) : v; }, async put(k, v) { this.m.set(k, v); } };
  const env = { PLANNER: kv, APP_TOKEN: 't', MISTRAL_API_KEY: 'm-key' };
  const req = new Request('https://x/api/research', { method: 'POST', headers: { 'x-app-token': 't', 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Bouchon Racine' }) });
  const out = await (await handleApi(req, env, { fetch: async () => Response.json(response) })).json();
  assert.equal(out.restaurant.platform, 'opentable');
  const noKey = await handleApi(new Request('https://x/api/research', { method: 'POST', headers: { 'x-app-token': 't' }, body: '{"name":"Y"}' }), { PLANNER: kv, APP_TOKEN: 't' });
  assert.equal(noKey.status, 503);
  assert.match((await noKey.json()).error, /MISTRAL_API_KEY/);
});
