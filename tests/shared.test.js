import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { zonedToUtc, addMonths, todayIn, shortDateTime, daysBetween } from '../public/shared/tz.js';
import { opensAt, mealWindow, buildSlots, summarise, nextReleases, releasedBetween } from '../public/shared/plan.js';
import { bookingLink, detectPlatform, googleMapsLink } from '../public/shared/links.js';
import { parseIcs, busyIntervals } from '../public/shared/ics.js';
import { slotsToCsv } from '../public/shared/csv.js';
import { normaliseProfile, searchedUrls, extractJson, finalText } from '../src/profile.js';

const fixture = (f) => readFileSync(new URL(`./fixtures/${f}`, import.meta.url), 'utf8');
const research = JSON.parse(fixture('research-response.json'));
const NOW = Date.parse('2026-11-05T11:00:00Z'); // Thu 5 Nov 2026, 11:00 UK
const bouchon = normaliseProfile(extractJson(finalText(research.content)), searchedUrls(research.content),
  { name: 'Bouchon Racine', city: 'London', now: NOW });

test('time zones: GMT and BST', () => {
  assert.equal(new Date(zonedToUtc('2026-11-08', '00:00')).toISOString(), '2026-11-08T00:00:00.000Z');
  assert.equal(new Date(zonedToUtc('2026-06-15', '00:00')).toISOString(), '2026-06-14T23:00:00.000Z');
  assert.equal(todayIn(Date.parse('2026-06-14T23:30:00Z')), '2026-06-15');
  assert.equal(addMonths('2027-01-31', 1), '2027-02-28');
  assert.equal(daysBetween('2026-11-05', '2026-12-05'), 30);
  assert.equal(shortDateTime(Date.parse('2026-11-08T00:00:00Z')), 'Sun 8 Nov, 00:00');
});

test('release dates: rolling and monthly', () => {
  const rolling = { pattern: 'rolling', daysAhead: 30, time: '00:00' };
  assert.equal(new Date(opensAt('2026-12-08', rolling)).toISOString(), '2026-11-08T00:00:00.000Z');
  // across the clocks change: a July date opens at midnight BST in June
  assert.equal(new Date(opensAt('2027-07-15', rolling)).toISOString(), '2027-06-14T23:00:00.000Z');
  const monthly = { pattern: 'monthly', monthsAhead: 2, dayOfMonth: 1, time: '10:00' };
  assert.equal(new Date(opensAt('2027-03-20', monthly)).toISOString(), '2027-01-01T10:00:00.000Z');
  assert.equal(opensAt('2026-12-08', { pattern: 'unknown' }), null);
});

test('meal windows follow opening hours', () => {
  const hours = { value: { tue: [['12:00', '15:00'], ['18:00', '22:00']] }, complete: true };
  assert.deepEqual(mealWindow('dinner', 2, hours), { start: '18:30', end: '21:30', hoursKnown: true });
  assert.deepEqual(mealWindow('lunch', 2, hours), { start: '12:00', end: '14:30', hoursKnown: true });
  assert.equal(mealWindow('breakfast', 2, hours), null);
  assert.equal(mealWindow('dinner', 1, hours), null); // Monday: closed
  const partial = { value: hours.value, complete: false };
  assert.equal(mealWindow('dinner', 1, partial).hoursKnown, false); // unknown, not excluded
  assert.deepEqual(mealWindow('dinner', 2, { value: { tue: [['19:00', '21:00']] }, complete: true }), { start: '19:00', end: '20:30', hoursKnown: true });
});

test('profile from research: real sources kept, fabricated ones dropped', () => {
  assert.equal(bouchon.id, 'bouchon-racine-london');
  assert.equal(bouchon.platform, 'opentable');
  assert.equal(bouchon.bookingUrl, 'https://www.opentable.co.uk/r/bouchon-racine-london');
  assert.deepEqual({ ...bouchon.release }, { pattern: 'rolling', daysAhead: 30, monthsAhead: null, dayOfMonth: null, confidence: 'high', time: '00:00', timeEstimated: true });
  const rt = bouchon.facts.find((f) => f.label === 'Release time');
  assert.equal(rt.confidence, 'estimated'); // the 09:00 claim cited a URL search never returned
  assert.equal(rt.sources.length, 0);
  assert.equal(bouchon.hours.complete, false);
  assert.equal(bouchon.hours.confidence, 'high'); // booking page itself
  assert.equal(bouchon.phone.number, '020 7253 3368');
  assert.equal(bouchon.facts.find((f) => f.label === 'Phone').confidence, 'high'); // two sites
  assert.equal(bouchon.website, null);
});

test('profile: nothing usable becomes unknown, not guessed', () => {
  const p = normaliseProfile({ name: 'X', booking_window: { pattern: 'rolling', days_ahead: 30, sources: ['https://nowhere.example/'] } }, new Map(), { name: 'X' });
  assert.equal(p.release.pattern, 'unknown');
  assert.equal(p.platform, null);
  assert.equal(extractJson('no json here'), null);
  assert.deepEqual(extractJson('text {"a":1} more'), { a: 1 });
});

test('slots: Bouchon Racine, midweek dinner for 2, next 30 days', () => {
  const slots = buildSlots({ restaurant: bouchon, meals: ['dinner'], days: 'midweek', party: 2, from: '2026-11-05', to: '2026-12-05', now: NOW });
  const dates = slots.map((s) => s.date);
  assert.equal(dates[0], '2026-11-05'); // tonight is still ahead
  assert.ok(dates.includes('2026-11-09')); // Monday: hours partial, so shown as unconfirmed
  assert.equal(slots.find((s) => s.date === '2026-11-09').hoursKnown, false);
  assert.ok(!dates.includes('2026-11-06')); // Friday is not midweek
  assert.equal(slots.length, 17);
  assert.ok(slots.every((s) => s.status === 'bookable'));
  const tue = slots.find((s) => s.date === '2026-11-10');
  assert.equal(tue.link, 'https://www.opentable.co.uk/r/bouchon-racine-london?covers=2&dateTime=2026-11-10T18%3A30');
  assert.equal(tue.start, '18:30');
});

test('slots beyond the window open later; summary reports next release', () => {
  const r = { ...bouchon, hours: { ...bouchon.hours, complete: true } };
  const slots = buildSlots({ restaurant: r, meals: ['dinner'], days: 'midweek', party: 2, from: '2026-12-01', to: '2026-12-10', now: NOW });
  assert.deepEqual(slots.map((s) => `${s.date}:${s.status}`), [
    '2026-12-01:bookable', '2026-12-02:bookable', '2026-12-03:bookable',
    '2026-12-08:opens', '2026-12-09:opens', '2026-12-10:opens']);
  assert.equal(new Date(slots[3].opensAt).toISOString(), '2026-11-08T00:00:00.000Z');
  const sum = summarise(slots, { restaurant: r, now: NOW });
  assert.equal(sum.window, '30 days ahead');
  assert.equal(sum.next.date, '2026-12-08'); // closed Sun/Mon, so Tue 8 Dec (opens Sun 8 Nov)
  const midweek = nextReleases(r, { now: NOW, meals: ['dinner'], days: 'midweek', count: 3 });
  assert.deepEqual(midweek.map((x) => x.label), ['Tue 8 Dec', 'Wed 9 Dec', 'Thu 10 Dec']);
});

test('release alerts: what opened in the last hour', () => {
  const r = { ...bouchon, hours: { ...bouchon.hours, complete: true } };
  const since = Date.parse('2026-11-07T23:01:00Z'), now = Date.parse('2026-11-08T00:01:00Z');
  const got = releasedBetween(r, { since, now, meals: ['dinner'], days: 'midweek', party: 2 });
  assert.deepEqual(got.map((x) => `${x.date}:${x.meal}`), ['2026-12-08:dinner']);
  assert.deepEqual(releasedBetween(r, { since, now, meals: ['dinner'], days: 'weekend', party: 2 }), []);
});

test('booking links per platform', () => {
  assert.equal(detectPlatform('https://www.opentable.co.uk/r/x'), 'opentable');
  assert.equal(detectPlatform('https://resy.com/cities/ldn/venues/x'), 'resy');
  assert.equal(detectPlatform('https://www.exploretock.com/x'), 'tock');
  assert.equal(detectPlatform('https://example.org/'), 'other');
  assert.equal(bookingLink({ platform: 'resy', bookingUrl: 'https://resy.com/cities/ldn/venues/x' }, { date: '2026-12-08', time: '19:00', party: 4 }),
    'https://resy.com/cities/ldn/venues/x?date=2026-12-08&seats=4');
  assert.equal(bookingLink({ website: 'https://example.org/' }, { date: '2026-12-08', time: '19:00', party: 2 }), 'https://example.org/');
  assert.equal(bookingLink({}, { date: '2026-12-08', time: '19:00', party: 2 }), null);
});

test('calendar feed: busy times', () => {
  const events = parseIcs(fixture('calendar.ics'));
  const busy = busyIntervals(events, Date.parse('2026-11-01T00:00:00Z'), Date.parse('2027-01-31T00:00:00Z'));
  const fmt = (b) => `${new Date(b.start).toISOString().slice(0, 16)} ${b.title}`;
  const list = busy.map(fmt);
  assert.ok(list.includes('2026-11-12T19:00 Board dinner'));
  assert.ok(list.includes('2026-11-18T17:30 Flight, LHR'));
  assert.ok(list.includes('2026-11-26T00:00 Away'));
  assert.ok(!list.some((x) => x.includes('birthday'))); // marked free
  assert.ok(!list.some((x) => x.includes('Cancelled')));
  const choir = list.filter((x) => x.endsWith(' Choir'));
  assert.ok(choir.includes('2026-11-04T19:00 Choir'));
  assert.ok(!choir.includes('2026-11-11T19:00 Choir')); // EXDATE
  assert.ok(!choir.includes('2026-11-25T19:00 Choir')); // moved
  assert.ok(list.includes('2026-11-25T12:00 Choir (moved)'));
  assert.ok(choir.includes('2026-12-30T19:00 Choir'));
  const club = list.filter((x) => x.endsWith('Book club'));
  assert.deepEqual(club, ['2026-11-03T18:30 Book club', '2026-12-01T18:30 Book club', '2027-01-05T18:30 Book club']);
});

test('slots marked busy from the calendar', () => {
  const busy = busyIntervals(parseIcs(fixture('calendar.ics')), NOW, Date.parse('2026-12-06T00:00:00Z'));
  const slots = buildSlots({ restaurant: bouchon, meals: ['dinner'], days: 'midweek', party: 2, from: '2026-11-05', to: '2026-12-05', now: NOW, busy });
  const busyDates = slots.filter((s) => s.busy).map((s) => s.date);
  assert.deepEqual(busyDates, ['2026-11-12', '2026-11-18', '2026-11-26', '2026-12-01', '2026-12-02']);
  assert.equal(slots.find((s) => s.date === '2026-11-12').busyTitle, 'Board dinner');
});

test('CSV export', () => {
  const slots = buildSlots({ restaurant: bouchon, meals: ['dinner'], days: 'midweek', party: 2, from: '2026-11-10', to: '2026-11-10', now: NOW });
  const csv = slotsToCsv(slots).trim().split('\r\n');
  assert.equal(csv[0], 'Date,Day,Meal,Time window,Party,Status,Opens at (UK),Platform,Direct booking link,Google Maps,Calendar');
  assert.equal(csv[1], '2026-11-10,Tue,Dinner,18:30–21:30,2,Bookable now,"Sun 11 Oct, 00:00 (est.)",OpenTable,https://www.opentable.co.uk/r/bouchon-racine-london?covers=2&dateTime=2026-11-10T18%3A30,https://www.google.com/maps/search/?api=1&query=Bouchon+Racine%2C+Farringdon%2C+London,Free');
});

test('Google Maps link: by place id when known, else by name and area', () => {
  assert.equal(googleMapsLink({ name: 'Bouchon Racine', area: 'Farringdon, London' }),
    'https://www.google.com/maps/search/?api=1&query=Bouchon+Racine%2C+Farringdon%2C+London');
  assert.equal(googleMapsLink({ name: 'Test Bistro', address: '1 Example Street, London', placeId: 'ChIJ-x' }),
    'https://www.google.com/maps/search/?api=1&query=Test+Bistro%2C+1+Example+Street%2C+London&query_place_id=ChIJ-x');
  assert.equal(googleMapsLink(null), null);
  const slot = buildSlots({ restaurant: bouchon, meals: ['dinner'], days: 'any', from: '2026-11-10', to: '2026-11-10', now: NOW })[0];
  assert.equal(slot.googleLink, googleMapsLink(bouchon));
});

test('no online booking: slots keep the Google link but drop the booking link', () => {
  const r = { ...bouchon, reservable: false };
  const [slot] = buildSlots({ restaurant: r, meals: ['dinner'], days: 'any', from: '2026-11-10', to: '2026-11-10', now: NOW });
  assert.equal(slot.noOnline, true);
  assert.equal(slot.link, null);
  assert.ok(slot.googleLink);
  assert.match(slotsToCsv([slot]), /No online booking/);
});
