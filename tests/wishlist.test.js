import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { handleApi, runAlerts, refreshStale, store } from '../src/worker.js';
import { notifyChecklist, notifyKey } from '../public/shared/plan.js';
import { normaliseProfile, searchedUrls, extractJson, finalText } from '../src/profile.js';

const research = JSON.parse(readFileSync(new URL('./fixtures/research-response.json', import.meta.url), 'utf8'));
const NOW = Date.parse('2026-11-05T11:00:00Z');
const bouchon = (now = NOW) => {
  const p = normaliseProfile(extractJson(finalText(research.content)), searchedUrls(research.content), { name: 'Bouchon Racine', city: 'London', now });
  p.hours.complete = true; // closed Sun/Mon for these tests
  return p;
};
class FakeKV {
  constructor() { this.m = new Map(); }
  async get(k, type) { const v = this.m.get(k); return v == null ? null : type === 'json' ? JSON.parse(v) : v; }
  async put(k, v) { this.m.set(k, v); }
}
const req = (path, method = 'GET', body) => new Request(`https://x${path}`, { method, headers: { 'x-app-token': 't', 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
async function setup(extra = {}) {
  const env = { PLANNER: new FakeKV(), APP_TOKEN: 't', ...extra };
  await store(env.PLANNER).saveProfile(bouchon());
  return env;
}

test('wishlist: add, update settings, remove', async () => {
  const env = await setup();
  const add = await (await handleApi(req('/api/wishlist', 'POST', { restaurantId: 'bouchon-racine-london', meals: ['dinner'], days: 'midweek', party: 2 }), env)).json();
  assert.equal(add.item.days, 'midweek');
  await handleApi(req('/api/wishlist', 'POST', { restaurantId: 'bouchon-racine-london', meals: ['lunch', 'dinner'], days: 'any', party: 4 }), env);
  const list = await (await handleApi(req('/api/wishlist'), env)).json();
  assert.equal(list.items.length, 1); // updated in place, not duplicated
  assert.deepEqual([list.items[0].days, list.items[0].party, list.items[0].restaurant.name], ['any', 4, 'Bouchon Racine']);
  assert.equal((await handleApi(req('/api/wishlist', 'POST', { restaurantId: 'nope' }), env)).status, 404);
  await handleApi(req('/api/wishlist/bouchon-racine-london', 'DELETE'), env);
  assert.equal((await (await handleApi(req('/api/wishlist'), env)).json()).items.length, 0);
});

test('notify ticks are saved and validated', async () => {
  const env = await setup();
  const key = notifyKey('bouchon-racine-london', '2099-01-06', 'dinner');
  const on = await (await handleApi(req('/api/notify', 'PUT', { key, set: true }), env)).json();
  assert.ok(on.notify[key]);
  const off = await (await handleApi(req('/api/notify', 'PUT', { key, set: false }), env)).json();
  assert.equal(off.notify[key], undefined);
  assert.equal((await handleApi(req('/api/notify', 'PUT', { key: '<script>', set: true }), env)).status, 400);
});

test('checklist: bookable dates to watch, later dates counted, busy skipped', () => {
  const r = bouchon();
  const item = { restaurantId: r.id, meals: ['dinner'], days: 'midweek', party: 2, onlyFree: true, restaurant: r };
  const busy = [{ start: Date.parse('2026-11-12T19:00:00Z'), end: Date.parse('2026-11-12T22:00:00Z'), title: 'Board dinner' }];
  const marks = { [notifyKey(r.id, '2026-11-10', 'dinner')]: '2026-11-05T10:00:00Z' };
  const [g] = notifyChecklist([item], { now: NOW, busy, marks });
  const dates = g.rows.map((x) => x.date);
  assert.equal(dates[0], '2026-11-05');
  assert.ok(!dates.includes('2026-11-12')); // busy
  assert.ok(!dates.includes('2026-11-09')); // Monday: closed
  assert.equal(g.rows.length, 12); // 13 Tue–Thu dates minus the busy one
  assert.equal(g.done, 1);
  assert.match(g.rows.find((x) => x.date === '2026-11-10').link, /covers=2&dateTime=2026-11-10T18%3A30/);
  assert.equal(g.laterCount, 0); // 30-day range = the booking window
  const [noOnline] = notifyChecklist([{ ...item, restaurant: { ...r, reservable: false } }], { now: NOW });
  assert.equal(noOnline.noOnline, true);
  assert.equal(noOnline.rows.length, 0);
});

test('wishlist restaurants get release-night reminders', async () => {
  const env = await setup({ NTFY_TOPIC: 'tables' });
  await store(env.PLANNER).saveWishlist([{ restaurantId: 'bouchon-racine-london', meals: ['dinner'], days: 'midweek', party: 2, onlyFree: false }]);
  const sent = [];
  await store(env.PLANNER).setLastRun(Date.parse('2026-11-07T23:01:00Z'));
  await runAlerts(env, { now: Date.parse('2026-11-08T00:01:00Z'), fetchImpl: async (u, init) => (sent.push(init), new Response('ok')) });
  assert.equal(sent.length, 1);
  assert.match(sent[0].body, /Tue 8 Dec · Dinner/);
  assert.match(sent[0].body, /Notify me/);
});

test('monthly re-check refreshes the stalest wishlist restaurant only', async () => {
  const env = await setup();
  const s = store(env.PLANNER);
  await s.saveWishlist([{ restaurantId: 'bouchon-racine-london', meals: ['dinner'], days: 'any', party: 2 }]);
  let calls = 0;
  const fake = async () => { calls++; return bouchon(Date.parse('2026-12-20T00:00:00Z')); };
  assert.equal(await refreshStale(env, { now: Date.parse('2026-11-20T00:00:00Z'), research: fake }), null); // still fresh
  const out = await refreshStale(env, { now: Date.parse('2026-12-20T00:00:00Z'), research: fake });
  assert.equal(calls, 1);
  assert.equal(out.checkedAt, '2026-12-20T00:00:00.000Z');
  assert.equal(await refreshStale({ PLANNER: env.PLANNER }, { now: Date.parse('2027-03-01T00:00:00Z') }), null); // no research key
});
