// The emails below are ILLUSTRATIVE, written for these tests. They are not
// copies of real platform emails. The parser is deliberately template-free;
// check real alerts with "Test with a pasted email" on the Alerts screen.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAlertEmail, findDates, findTimes, findParty, findLink, platformOf } from '../src/inbox.js';
import { handleApi, ingestEmail, store } from '../src/worker.js';

const restaurants = [{ id: 'bouchon-racine-london', name: 'Bouchon Racine' }, { id: 'bouchon-london', name: 'Bouchon' }];
const SENT = '2026-11-09T07:42:00Z';
const alertEmail = {
  id: 'msg-1',
  from: 'OpenTable <noreply@opentable.co.uk>',
  subject: 'Good news! A table at Bouchon Racine is available',
  date: SENT,
  text: 'A table for 2 is now available at Bouchon Racine on Wednesday, 25 November at 8:15 PM.\nBook now before someone else does.\n© 2026 OpenTable',
  html: '<a href="https://www.opentable.co.uk/booking/details?rid=1&amp;datetime=2026-11-25T20:15&amp;covers=2">Book now</a>'
    + '<a href="https://www.opentable.co.uk/unsubscribe?x=1">Unsubscribe</a><a href="https://evil.example/opentable">x</a>',
};

test('reads a table-available email', () => {
  const a = parseAlertEmail(alertEmail, restaurants);
  assert.equal(a.kind, 'availability');
  assert.equal(a.platform, 'opentable');
  assert.equal(a.restaurantId, 'bouchon-racine-london'); // longest name wins over "Bouchon"
  assert.deepEqual(a.dates, ['2026-11-25']);
  assert.deepEqual(a.times, ['20:15']);
  assert.equal(a.meal, 'dinner');
  assert.equal(a.party, 2);
  assert.equal(a.link, 'https://www.opentable.co.uk/booking/details?rid=1&datetime=2026-11-25T20:15&covers=2');
});

test('ignores confirmations, other senders and unrelated mail', () => {
  assert.equal(parseAlertEmail({ ...alertEmail, subject: 'Your reservation at Bouchon Racine is confirmed', text: 'Your reservation is confirmed for 25 November at 20:15. Confirmation number 123.' }, restaurants).kind, 'ignored');
  assert.equal(parseAlertEmail({ ...alertEmail, from: 'Bouchon Racine <hello@bouchonracine.example>' }, restaurants).reason, 'Not from a booking platform');
  assert.equal(parseAlertEmail({ ...alertEmail, subject: 'Discover new restaurants near you', text: 'Top picks this week.' }, restaurants).kind, 'ignored');
});

test('unmatched restaurant is kept, not guessed', () => {
  const a = parseAlertEmail({ ...alertEmail, subject: 'A table at Somewhere Else is available', text: 'A table is now available at Somewhere Else on 25 November at 19:00.' }, restaurants);
  assert.equal(a.kind, 'availability');
  assert.equal(a.restaurantId, null);
});

test('dates, times and party in common formats', () => {
  const sent = Date.parse('2026-12-20T09:00:00Z');
  assert.deepEqual(findDates('Tue 5 Jan', sent), ['2027-01-05']); // rolls into next year
  assert.deepEqual(findDates('December 23rd, 2026 and 2026-12-24', sent), ['2026-12-23', '2026-12-24']);
  assert.deepEqual(findDates('tonight', sent), ['2026-12-20']);
  assert.deepEqual(findDates('31 February', sent), []);
  assert.deepEqual(findTimes('at 7pm or 19:30, also 12:00 PM. Ref 2026. Call 0207 253 3368'), ['12:00', '19:00', '19:30']);
  assert.deepEqual(findTimes('8.15 p.m.'), ['20:15']);
  assert.equal(findParty('party of 4'), 4);
  assert.equal(findParty('3 guests'), 3);
  assert.equal(findParty('hold for 15 minutes'), null);
  assert.equal(platformOf('Resy <notify@resy.com>'), 'resy');
  assert.equal(platformOf('x@notresy.com'), null);
  assert.equal(findLink('<a href="https://resy.com/cities/ldn/venues/x?date=2026-12-01">Reserve</a>', 'resy'), 'https://resy.com/cities/ldn/venues/x?date=2026-12-01');
  assert.equal(findLink('<a href="http://resy.com/x">x</a><a href="https://resy.com.evil.example/x">y</a>', 'resy'), null);
});

class FakeKV {
  constructor() { this.m = new Map(); }
  async get(k, type) { const v = this.m.get(k); return v == null ? null : type === 'json' ? JSON.parse(v) : v; }
  async put(k, v) { this.m.set(k, v); }
}
async function setup(extra = {}) {
  const env = { PLANNER: new FakeKV(), APP_TOKEN: 't', NTFY_TOPIC: 'tables', ...extra };
  await store(env.PLANNER).saveProfile({ id: 'bouchon-racine-london', name: 'Bouchon Racine', platform: 'opentable',
    bookingUrl: 'https://www.opentable.co.uk/r/bouchon-racine-london', release: { pattern: 'rolling', daysAhead: 30, time: '00:00' }, facts: [], checkedAt: SENT });
  return env;
}
const NOW = Date.parse(SENT);

test('inbox: alert stored, pushed once, duplicates ignored', async () => {
  const env = await setup();
  const sent = [];
  const fetchStub = async (url, init) => { sent.push({ url: String(url), init }); return new Response('ok'); };
  const out = await ingestEmail(env, alertEmail, { fetchImpl: fetchStub, now: NOW });
  assert.equal(out.alert.restaurantId, 'bouchon-racine-london');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].init.headers.Title, 'Table free: Bouchon Racine');
  assert.match(sent[0].init.body, /Wed 25 Nov · 20:15 · 2 people/);
  assert.equal(sent[0].init.headers.Click, 'https://www.opentable.co.uk/booking/details?rid=1&datetime=2026-11-25T20:15&covers=2');
  assert.equal((await ingestEmail(env, alertEmail, { fetchImpl: fetchStub, now: NOW })).duplicate, true);
  assert.equal(sent.length, 1);
  const list = await (await handleApi(new Request('https://x/api/inbox', { headers: { 'x-app-token': 't' } }), env)).json();
  assert.equal(list.alerts.length, 1);
  assert.equal((await store(env.PLANNER).log())[0].kind, 'inbox');
});

test('inbox: no push when you are busy that evening', async () => {
  const env = await setup({ CALENDAR_ICS_URL: 'https://calendar.test/c.ics' });
  const ics = 'BEGIN:VCALENDAR\nBEGIN:VEVENT\nUID:a\nSUMMARY:Theatre\nDTSTART;TZID=Europe/London:20261125T193000\nDTEND;TZID=Europe/London:20261125T223000\nEND:VEVENT\nEND:VCALENDAR\n';
  const pushes = [];
  const fetchStub = async (url, init) => (String(url).includes('calendar.test') ? new Response(ics) : (pushes.push(init), new Response('ok')));
  const out = await ingestEmail(env, { ...alertEmail, id: 'msg-2' }, { fetchImpl: fetchStub, now: NOW });
  assert.equal(pushes.length, 0);
  assert.equal(out.notified.pushed, false);
  assert.match(out.notified.lines[0], /clash: Theatre/);
});

test('inbox: preview parses without storing; token required', async () => {
  const env = await setup();
  const req = (path, token = 't') => new Request(`https://x${path}`, { method: 'POST', headers: { 'x-app-token': token, 'Content-Type': 'application/json' }, body: JSON.stringify(alertEmail) });
  const p = await (await handleApi(req('/api/inbox/preview'), env)).json();
  assert.equal(p.alert.kind, 'availability');
  assert.deepEqual(await store(env.PLANNER).inbox(), []);
  assert.equal((await handleApi(req('/api/inbox', 'wrong'), env)).status, 401);
});
