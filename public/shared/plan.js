// The planner: turns a restaurant profile plus your choices (meals, days,
// party, date range) into a list of candidate slots, each marked
// bookable now / opens at <time> / release unknown, with a booking link.
// Pure functions: the browser, the Worker and the tests all share this file.

import {
  LONDON, DOW_KEYS, addDays, addMonths, dowOf, eachDate, isoOf, todayIn,
  zonedToUtc, toMinutes, fromMinutes, shortDate,
} from './tz.js';
import { bookingLink, googleMapsLink, providerFor } from './links.js';

export const MEALS = {
  breakfast: { label: 'Breakfast', start: '08:00', end: '10:30' },
  lunch: { label: 'Lunch', start: '12:00', end: '14:30' },
  dinner: { label: 'Dinner', start: '18:30', end: '21:30' },
};
export const MEAL_ORDER = ['breakfast', 'lunch', 'dinner'];

export const DAY_GROUPS = {
  midweek: { label: 'Midweek', sub: 'Mon–Thu', days: [1, 2, 3, 4] },
  weekend: { label: 'Weekend', sub: 'Fri–Sun', days: [5, 6, 0] },
  any: { label: 'Any day', sub: 'All week', days: [0, 1, 2, 3, 4, 5, 6] },
};

/**
 * When bookings for `dateIso` open, as an instant, or null if unknown.
 * rolling: `daysAhead` days before the date, at `time` (London).
 * monthly: on `dayOfMonth` of the month `monthsAhead` before the date's month.
 */
export function opensAt(dateIso, release, tz = LONDON) {
  if (!release) return null;
  const time = release.time || '00:00';
  if (release.pattern === 'rolling' && Number.isInteger(release.daysAhead)) {
    return zonedToUtc(addDays(dateIso, -release.daysAhead), time, tz);
  }
  if (release.pattern === 'monthly' && Number.isInteger(release.monthsAhead)) {
    const [y, m] = dateIso.split('-').map(Number);
    const first = addMonths(isoOf(y, m, 1), -release.monthsAhead);
    const [fy, fm] = first.split('-').map(Number);
    return zonedToUtc(isoOf(fy, fm, release.dayOfMonth || 1), time, tz);
  }
  return null;
}

/**
 * The part of a meal window the restaurant is open for on a weekday.
 * Returns { start, end, hoursKnown } or null when it is definitely closed.
 * hours.complete=false means the listed hours may be partial, so a meal
 * outside them is "unknown" rather than excluded.
 */
export function mealWindow(meal, dow, hours) {
  const m = MEALS[meal];
  if (!m) return null;
  const ws = toMinutes(m.start), we = toMinutes(m.end);
  const open = hours?.value;
  if (!open) return { start: m.start, end: m.end, hoursKnown: false };
  const periods = open[DOW_KEYS[dow]] || [];
  for (const [s, e] of periods) {
    const ps = toMinutes(s);
    let pe = toMinutes(e);
    if (pe <= ps) pe = 24 * 60; // closes after midnight
    const lo = Math.max(ws, ps);
    const hi = Math.min(we, pe - 30); // last booking ~30 min before close
    if (hi > lo) return { start: fromMinutes(lo), end: fromMinutes(hi), hoursKnown: true };
  }
  return hours.complete ? null : { start: m.start, end: m.end, hoursKnown: false };
}

function daysFilter(days) {
  if (Array.isArray(days)) return new Set(days);
  return new Set((DAY_GROUPS[days] || DAY_GROUPS.any).days);
}

function overlap(busy, start, end) {
  return busy.find((b) => b.start < end && b.end > start) || null;
}

/** Build candidate slots. `busy` is a list of {start, end, title} instants. */
export function buildSlots({
  restaurant, meals = ['dinner'], days = 'any', party = 2, from, to,
  now = Date.now(), busy = [], tz = LONDON,
}) {
  const today = todayIn(now, tz);
  const start = from && from > today ? from : today;
  const end = to || addDays(today, 30);
  const allowed = daysFilter(days);
  const chosen = MEAL_ORDER.filter((m) => meals.includes(m));
  const release = restaurant?.release;
  const platform = providerFor(restaurant?.platform).label;
  const googleLink = googleMapsLink(restaurant);
  const noOnline = restaurant?.reservable === false;
  const slots = [];
  for (const date of eachDate(start, end)) {
    const dow = dowOf(date);
    if (!allowed.has(dow)) continue;
    for (const meal of chosen) {
      const win = mealWindow(meal, dow, restaurant?.hours);
      if (!win) continue;
      const winStart = zonedToUtc(date, win.start, tz);
      const winEnd = zonedToUtc(date, win.end, tz);
      if (winEnd <= now) continue;
      const open = opensAt(date, release, tz);
      const status = open == null ? 'unknown' : now >= open ? 'bookable' : 'opens';
      const clash = overlap(busy, winStart, winEnd);
      slots.push({
        date, dow, meal, mealLabel: MEALS[meal].label, party,
        start: win.start, end: win.end, hoursKnown: win.hoursKnown,
        status, opensAt: open, opensEstimated: !!release?.timeEstimated,
        busy: !!clash, busyTitle: clash?.title || null,
        platform, noOnline, googleLink,
        link: noOnline ? null : bookingLink(restaurant, { date, time: win.start, party }),
      });
    }
  }
  return slots;
}

/** Totals for the summary strip, plus the next release after `now`. */
export function summarise(slots, { restaurant, now = Date.now(), tz = LONDON, meals = MEAL_ORDER, days = 'any' } = {}) {
  const free = slots.filter((s) => !s.busy);
  const bookable = free.filter((s) => s.status === 'bookable');
  const next = nextReleases(restaurant, { now, tz, meals, days, count: 1 })[0] || null;
  const r = restaurant?.release;
  const window = r?.pattern === 'rolling' ? `${r.daysAhead} days ahead`
    : r?.pattern === 'monthly' ? `opens on day ${r.dayOfMonth || 1}, ${r.monthsAhead} month(s) ahead`
    : 'unknown';
  return { total: slots.length, free: free.length, bookable: bookable.length, window, next };
}

/**
 * The next release moments after `now` for a restaurant and filter,
 * e.g. "Tue 8 Dec opens Sun 8 Nov 00:00". Looks up to `horizon` days out.
 */
export function nextReleases(restaurant, {
  now = Date.now(), tz = LONDON, meals = MEAL_ORDER, days = 'any', count = 3, horizon = 120,
} = {}) {
  const release = restaurant?.release;
  if (!release || release.pattern === 'unknown') return [];
  const today = todayIn(now, tz);
  const allowed = daysFilter(days);
  const out = [];
  for (const date of eachDate(today, addDays(today, horizon))) {
    if (!allowed.has(dowOf(date))) continue;
    if (!meals.some((m) => mealWindow(m, dowOf(date), restaurant.hours))) continue;
    const open = opensAt(date, release, tz);
    if (open != null && open > now) {
      out.push({ date, label: shortDate(date), opensAt: open });
      if (out.length >= count) break;
    }
  }
  return out;
}

/** Slots whose bookings opened in (since, now] — used by release alerts. */
export function releasedBetween(restaurant, { since, now, tz = LONDON, meals, days, party = 2, horizon = 400 }) {
  const release = restaurant?.release;
  if (!release || release.pattern === 'unknown') return [];
  const today = todayIn(now, tz);
  const allowed = daysFilter(days);
  const out = [];
  for (const date of eachDate(today, addDays(today, horizon))) {
    const open = opensAt(date, release, tz);
    if (open == null || open <= since || open > now) continue;
    const dow = dowOf(date);
    if (!allowed.has(dow)) continue;
    for (const meal of MEAL_ORDER.filter((m) => meals.includes(m))) {
      const win = mealWindow(meal, dow, restaurant.hours);
      if (!win) continue;
      out.push({ date, meal, start: win.start, end: win.end, opensAt: open,
        link: bookingLink(restaurant, { date, time: win.start, party }) });
    }
  }
  return out;
}

export const notifyKey = (restaurantId, date, meal) => `${restaurantId}|${date}|${meal}`;

/**
 * The Notify-me checklist: for each wishlist restaurant, the dates in the
 * next `range` days that are already bookable (or whose release rule is
 * unknown), using that restaurant's saved meals/days/party. Busy dates are
 * left out when the entry says "only dates I'm free". Dates that open later
 * are only counted: they join the list after their release night.
 */
export function notifyChecklist(items, { now = Date.now(), busy = [], marks = {}, range = 30, tz = LONDON } = {}) {
  const today = todayIn(now, tz);
  return items.map((w) => {
    const r = w.restaurant;
    const slots = buildSlots({ restaurant: r, meals: w.meals, days: w.days, party: w.party, from: today, to: addDays(today, range), now, busy, tz });
    const usable = slots.filter((s) => !(w.onlyFree && s.busy));
    const rows = usable.filter((s) => s.status !== 'opens' && s.link)
      .map((s) => ({ ...s, key: notifyKey(r.id, s.date, s.meal), set: !!marks[notifyKey(r.id, s.date, s.meal)] }));
    const later = usable.filter((s) => s.status === 'opens');
    return {
      item: w,
      restaurant: r,
      noOnline: r.reservable === false,
      rows,
      done: rows.filter((x) => x.set).length,
      laterCount: later.length,
      nextOpen: later[0]?.opensAt || null,
    };
  });
}
