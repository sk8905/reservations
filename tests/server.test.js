import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { handleApi, runAlerts, store } from '../src/worker.js';
import { researchRestaurant, RESEARCH_MODEL } from '../src/research.js';
import { normaliseProfile, searchedUrls, extractJson, finalText } from '../src/profile.js';
import { mapPlace, periodsToHours, mergePlace, bestMatch } from '../src/places.js';
import { notify } from '../src/channels.js';

const fixture = (f) => readFileSync(new URL(`./fixtures/${f}`, import.meta.url), 'utf8');
const research = JSON.parse(fixture('research-response.json'));
const NOW = Date.parse('2026-11-05T11:00:00Z');
const bouchon = () => normaliseProfile(extractJson(finalText(research.content)), searchedUrls(research.content),
  { name: 'Bouchon Racine', city: 'London', now: Date.now() });

class FakeKV {
  constructor() { this.m = new Map(); }
  async get(k, type) { const v = this.m.get(k); return v == null ? null : type === 'json' ? JSON.parse(v) : v; }
  async put(k, v) { this.m.set(k, v); }
}
const env = (extra = {}) => ({ PLANNER: new FakeKV(), APP_TOKEN: 'secret-token', ANTHROPIC_API_KEY: 'sk-test', ...extra });
const req = (path, { method = 'GET', body, token = 'secret-token' } = {}) => new Request(`https://app.test${path}`, {
  method, headers: { 'x-app-token': token, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
});

test('API requires the access token', async () => {
  const e = env();
  assert.equal((await handleApi(req('/api/restaurants', { token: 'wrong' }), e)).status, 401);
  const cfg = await (await handleApi(req('/api/config', { token: 'wrong' }), e)).json();
  assert.equal(cfg.authorised, false);
  assert.equal(cfg.features, null);
  assert.equal((await handleApi(req('/api/restaurants'), { PLANNER: new FakeKV() })).status, 503); // no APP_TOKEN set
});

test('research is cached and corrections survive', async () => {
  const e = env();
  let calls = 0;
  const deps = { research: async () => { calls++; return bouchon(); } };
  const first = await (await handleApi(req('/api/research', { method: 'POST', body: { name: 'Bouchon Racine' } }), e, deps)).json();
  assert.equal(first.cached, false);
  assert.equal(first.restaurant.release.daysAhead, 30);
  const again = await (await handleApi(req('/api/research', { method: 'POST', body: { name: 'bouchon racine' } }), e, deps)).json();
  assert.equal(again.cached, true);
  assert.equal(calls, 1);
  const fixed = await (await handleApi(req('/api/restaurants/bouchon-racine-london/release', { method: 'PUT', body: { pattern: 'rolling', daysAhead: 31, time: '09:00' } }), e)).json();
  assert.equal(fixed.restaurant.release.daysAhead, 31);
  assert.equal(fixed.restaurant.release.time, '09:00');
  assert.equal(fixed.restaurant.release.corrected, true);
  await handleApi(req('/api/research', { method: 'POST', body: { name: 'Bouchon Racine', force: true } }), e, deps);
  const after = await (await handleApi(req('/api/restaurants/bouchon-racine-london'), e)).json();
  assert.equal(calls, 2);
  assert.equal(after.restaurant.release.daysAhead, 31); // your correction still wins
});

test('plans: add, dedupe, remove', async () => {
  const e = env();
  await store(e.PLANNER).saveProfile(bouchon());
  const body = { restaurantId: 'bouchon-racine-london', meals: ['dinner', 'bogus'], days: 'midweek', party: 2 };
  const a = await (await handleApi(req('/api/plans', { method: 'POST', body }), e)).json();
  assert.deepEqual(a.plan.meals, ['dinner']);
  const b = await (await handleApi(req('/api/plans', { method: 'POST', body }), e)).json();
  assert.equal(b.existing, true);
  const list = await (await handleApi(req('/api/plans'), e)).json();
  assert.equal(list.plans.length, 1);
  assert.equal(list.plans[0].restaurant.name, 'Bouchon Racine');
  await handleApi(req(`/api/plans/${a.plan.id}`, { method: 'DELETE' }), e);
  assert.equal((await (await handleApi(req('/api/plans'), e)).json()).plans.length, 0);
  assert.equal((await handleApi(req('/api/plans', { method: 'POST', body: { restaurantId: 'nope', meals: ['dinner'] } }), e)).status, 404);
});

test('busy endpoint reads the calendar feed', async () => {
  const e = env({ CALENDAR_ICS_URL: 'https://calendar.test/private.ics' });
  const fetchStub = async (url) => (String(url).startsWith('https://calendar.test') ? new Response(fixture('calendar.ics')) : new Response('', { status: 404 }));
  const data = await (await handleApi(req('/api/busy?from=2026-11-12&to=2026-11-12'), e, { fetch: fetchStub })).json();
  assert.equal(data.calendar, true);
  assert.deepEqual(data.busy.map((b) => b.title), ['Board dinner']);
});

test('release alert fires once, just after midnight', async () => {
  const e = env({ NTFY_TOPIC: 'my-tables' });
  const s = store(e.PLANNER);
  const r = bouchon();
  r.hours.complete = true;
  await s.saveProfile(r);
  await s.savePlans([{ id: 'p1', restaurantId: r.id, meals: ['dinner'], days: 'midweek', party: 2, onlyFree: false }]);
  const sent = [];
  const fetchStub = async (url, init) => { sent.push({ url: String(url), init }); return new Response('ok'); };
  await s.setLastRun(Date.parse('2026-11-07T23:01:00Z'));
  const out = await runAlerts(e, { now: Date.parse('2026-11-08T00:01:00Z'), fetchImpl: fetchStub });
  assert.equal(out.length, 1);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].url, 'https://ntfy.sh/my-tables');
  assert.equal(sent[0].init.headers.Title, 'Bookings open: Bouchon Racine');
  assert.match(sent[0].init.body, /Tue 8 Dec · Dinner 18:30–21:30 · 2 people/);
  assert.equal(sent[0].init.headers.Click, 'https://www.opentable.co.uk/r/bouchon-racine-london?covers=2&dateTime=2026-12-08T18%3A30');
  // a second run in the same hour sends nothing new
  await s.setLastRun(Date.parse('2026-11-07T23:01:00Z'));
  await runAlerts(e, { now: Date.parse('2026-11-08T00:30:00Z'), fetchImpl: fetchStub });
  assert.equal(sent.length, 1);
  // a Sunday release (weekend date) does not match a midweek plan
  await runAlerts(e, { now: Date.parse('2026-11-11T00:01:00Z'), fetchImpl: fetchStub });
  assert.equal(sent.length, 1);
  assert.equal((await s.log()).length, 1);
});

test('alerts skip dates you are busy when asked', async () => {
  const e = env({ NTFY_TOPIC: 't', CALENDAR_ICS_URL: 'https://calendar.test/b.ics' });
  const s = store(e.PLANNER);
  const r = bouchon(); r.hours.complete = true;
  await s.saveProfile(r);
  await s.savePlans([{ id: 'p2', restaurantId: r.id, meals: ['dinner'], days: 'midweek', party: 2, onlyFree: true }]);
  const ics = 'BEGIN:VCALENDAR\nBEGIN:VEVENT\nUID:x\nSUMMARY:Busy\nDTSTART;TZID=Europe/London:20261208T190000\nDTEND;TZID=Europe/London:20261208T220000\nEND:VEVENT\nEND:VCALENDAR\n';
  const sent = [];
  const fetchStub = async (url, init) => { if (String(url).includes('calendar.test')) return new Response(ics); sent.push(init); return new Response('ok'); };
  await s.setLastRun(Date.parse('2026-11-07T23:01:00Z'));
  await runAlerts(e, { now: Date.parse('2026-11-08T00:01:00Z'), fetchImpl: fetchStub });
  assert.equal(sent.length, 0);
});

test('channels: failures are reported, not thrown', async () => {
  const results = await notify({ NTFY_TOPIC: 'a', ALERT_WEBHOOK_URL: 'https://hook.test/x' }, { title: 'T', body: 'B', url: null },
    async (url) => new Response('', { status: String(url).includes('hook') ? 500 : 200 }));
  assert.deepEqual(results, [{ channel: 'push', ok: true }, { channel: 'webhook', ok: false, error: 'Webhook 500' }]);
});

test('research request: model, web search tool, fallbacks, pause_turn resume', async () => {
  const requests = [];
  const client = { beta: { messages: { create: async (params) => {
    requests.push(structuredClone(params));
    if (requests.length === 1) return { stop_reason: 'pause_turn', content: research.content.slice(0, 2) };
    return { stop_reason: 'end_turn', content: research.content.slice(2) };
  } } } };
  const p = await researchRestaurant({ name: 'Bouchon Racine', city: 'London', client, now: NOW });
  assert.equal(requests.length, 2);
  assert.equal(requests[0].model, RESEARCH_MODEL);
  assert.equal(requests[0].tools[0].type, 'web_search_20260209');
  assert.equal(requests[0].fallbacks, 'default');
  assert.deepEqual(requests[0].betas, ['server-side-fallback-2026-07-01']);
  assert.equal(requests[1].messages.at(-1).role, 'assistant'); // resumed, no extra user turn
  // sources from the first (paused) turn still count
  assert.equal(p.release.confidence, 'high');
  assert.equal(p.platform, 'opentable');
});

test('research: a refusal is an error, not a guess', async () => {
  const client = { beta: { messages: { create: async () => ({ stop_reason: 'refusal', content: [] }) } } };
  await assert.rejects(researchRestaurant({ name: 'X', client }), /declined/);
});

test('Google Places mapping and merge', () => {
  const place = mapPlace(JSON.parse(fixture('places-search.json')).places[0]);
  assert.equal(place.name, 'Test Bistro');
  assert.deepEqual(place.hours, { tue: [['12:00', '15:00'], ['18:00', '23:00']], sat: [['18:30', '01:00']] });
  assert.equal(periodsToHours([]), null);
  const merged = mergePlace({ ...bouchon(), hours: null }, place);
  assert.equal(merged.hours.complete, true);
  assert.equal(merged.hours.source, 'google');
});

test('Places: booking flag carried onto the profile', () => {
  const place = mapPlace(JSON.parse(fixture('places-search.json')).places[0]);
  const yes = mergePlace(bouchon(), place);
  assert.equal(yes.reservable, true);
  assert.equal(yes.placeId, 'ChIJ-test-place-id');
  assert.equal(yes.facts.find((f) => f.label === 'Online booking').value, 'Takes reservations (Google)');
  const no = mergePlace(bouchon(), { ...place, reservable: false });
  assert.equal(no.reservable, false);
  assert.ok(no.facts.filter((f) => f.label === 'Online booking').length === 1);
  const unknown = mergePlace(bouchon(), { ...place, reservable: null });
  assert.equal(unknown.reservable, undefined);
});

test('Places: only a clear name match is used', () => {
  const results = [{ name: 'Racine Bar' }, { name: 'Bouchon Racine' }];
  assert.equal(bestMatch('bouchon racine', results).name, 'Bouchon Racine');
  assert.equal(bestMatch('Bouchon Racine', [{ name: 'Bouchon' }]).name, 'Bouchon'); // prefix
  assert.equal(bestMatch('Bouchon Racine', [{ name: 'Le Petit Bouchon' }]), null);
  assert.equal(bestMatch('', results), null);
});

test('research looks the restaurant up on Google automatically', async () => {
  const e = env({ GOOGLE_PLACES_API_KEY: 'g-test' });
  const places = { places: [{ id: 'ChIJ-br', displayName: { text: 'Bouchon Racine' }, formattedAddress: '66 Cowcross St, London', reservable: true }] };
  const fetchStub = async (url) => (String(url).includes('places.googleapis.com') ? Response.json(places) : new Response('', { status: 404 }));
  const res = await (await handleApi(req('/api/research', { method: 'POST', body: { name: 'Bouchon Racine' } }), e,
    { fetch: fetchStub, research: async () => bouchon() })).json();
  assert.equal(res.restaurant.placeId, 'ChIJ-br');
  assert.equal(res.restaurant.reservable, true);
});
