// Table Planner — Cloudflare Worker. Serves the web app from /public and a
// small JSON API under /api. Read-only towards booking platforms: it never
// loads, books, holds or cancels anything on them.

import { researchRestaurant } from './research.js';
import { searchPlaces, mergePlace, bestMatch } from './places.js';
import { enabledChannels, notify, CHANNELS } from './channels.js';
import { parseIcs, busyIntervals } from '../public/shared/ics.js';
import { releasedBetween, MEALS } from '../public/shared/plan.js';
import { addDays, shortDate, todayIn, zonedToUtc } from '../public/shared/tz.js';
import { providerFor, bookingLink } from '../public/shared/links.js';
import { parseAlertEmail } from './inbox.js';

const RESEARCH_MAX_AGE_MS = 30 * 86400000;
const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
});
const fail = (status, error) => json({ error }, status);

// ---------- storage (KV) ----------
export const store = (kv) => ({
  async profile(id) {
    const p = await kv.get(`r:${id}`, 'json');
    if (!p) return null;
    const o = await kv.get(`o:${id}`, 'json');
    return o ? applyOverride(p, o) : p;
  },
  async saveProfile(p) {
    await kv.put(`r:${p.id}`, JSON.stringify(p));
    const index = (await kv.get('r:index', 'json')) || [];
    const next = [{ id: p.id, name: p.name, area: p.address || p.area || null, checkedAt: p.checkedAt },
      ...index.filter((x) => x.id !== p.id)].slice(0, 50);
    await kv.put('r:index', JSON.stringify(next));
  },
  index: async () => (await kv.get('r:index', 'json')) || [],
  override: (id, o) => kv.put(`o:${id}`, JSON.stringify(o)),
  plans: async () => (await kv.get('plans', 'json')) || [],
  savePlans: (plans) => kv.put('plans', JSON.stringify(plans)),
  log: async () => (await kv.get('alerts:log', 'json')) || [],
  async addLog(entry) {
    const log = (await kv.get('alerts:log', 'json')) || [];
    await kv.put('alerts:log', JSON.stringify([entry, ...log].slice(0, 20)));
  },
  inbox: async () => (await kv.get('inbox', 'json')) || [],
  async addInbox(alert) {
    const list = (await kv.get('inbox', 'json')) || [];
    await kv.put('inbox', JSON.stringify([alert, ...list].slice(0, 50)));
  },
  seenEmail: async (id) => !!(await kv.get(`inbox:seen:${id}`)),
  markEmail: (id) => kv.put(`inbox:seen:${id}`, '1', { expirationTtl: 30 * 86400 }),
  wasSent: async (key) => !!(await kv.get(`sent:${key}`)),
  markSent: (key) => kv.put(`sent:${key}`, '1', { expirationTtl: 400 * 86400 }),
  lastRun: async () => Number(await kv.get('alerts:lastRun')) || null,
  setLastRun: (ms) => kv.put('alerts:lastRun', String(ms)),
});

/** A correction you make in the app wins over research, and survives re-checks. */
export function applyOverride(p, o) {
  const release = { ...p.release, ...o.release, confidence: 'high', timeEstimated: false, corrected: true };
  const facts = p.facts.map((f) => (f.label === 'Booking window' || f.label === 'Release time'
    ? { ...f, value: f.label === 'Release time' ? `${release.time} UK` : describeRelease(release), confidence: 'high', sources: [{ url: null, title: 'Your correction' }] }
    : f));
  return { ...p, release, facts };
}

function describeRelease(r) {
  if (r.pattern === 'rolling') return `${r.daysAhead} days ahead (rolling)`;
  if (r.pattern === 'monthly') return `Opens on day ${r.dayOfMonth || 1} of the month, ${r.monthsAhead} month(s) ahead`;
  return 'Not published';
}

// ---------- calendar ----------
let icsCache = { url: null, at: 0, events: null };
export async function loadBusy(env, fromMs, toMs, fetchImpl = fetch) {
  if (!env.CALENDAR_ICS_URL) return null;
  if (icsCache.url !== env.CALENDAR_ICS_URL || Date.now() - icsCache.at > 5 * 60000) {
    const res = await fetchImpl(env.CALENDAR_ICS_URL);
    if (!res.ok) throw new Error(`Calendar feed returned ${res.status}`);
    icsCache = { url: env.CALENDAR_ICS_URL, at: Date.now(), events: parseIcs(await res.text()) };
  }
  return busyIntervals(icsCache.events, fromMs, toMs);
}

// ---------- alerts ----------
export async function runAlerts(env, { now = Date.now(), fetchImpl = fetch } = {}) {
  const s = store(env.PLANNER);
  const last = await s.lastRun();
  const since = Math.max(last ?? now - 3600000, now - 6 * 3600000);
  const plans = await s.plans();
  const sent = [];
  for (const plan of plans) {
    if (plan.until && todayIn(now) > plan.until) continue;
    const r = await s.profile(plan.restaurantId);
    if (!r) continue;
    let released = releasedBetween(r, { since, now, meals: plan.meals, days: plan.days, party: plan.party });
    if (plan.onlyFree && released.length) {
      const busy = await loadBusy(env, now, zonedToUtc(addDays(todayIn(now), 401)), fetchImpl).catch(() => null);
      if (busy) released = released.filter((x) => !busy.some((b) => b.start < zonedToUtc(x.date, x.end) && b.end > zonedToUtc(x.date, x.start)));
    }
    const fresh = [];
    for (const x of released) {
      const key = `${plan.id}:${x.date}:${x.meal}`;
      if (!(await s.wasSent(key))) fresh.push({ ...x, key });
    }
    if (!fresh.length) continue;
    const lines = fresh.map((x) => `${shortDate(x.date)} · ${MEALS[x.meal].label} ${x.start}–${x.end} · ${plan.party} people`);
    const msg = {
      title: `Bookings open: ${r.name}`,
      body: `Now bookable on ${providerFor(r.platform).label}:\n${lines.join('\n')}`,
      url: fresh[0].link,
    };
    const results = await notify(env, msg, fetchImpl);
    if (results.some((x) => x.ok) || !results.length) {
      for (const x of fresh) await s.markSent(x.key);
    }
    const entry = { at: now, kind: 'release', restaurantId: r.id, title: msg.title, lines, url: msg.url, results };
    await s.addLog(entry);
    sent.push(entry);
  }
  await s.setLastRun(now);
  return sent;
}

// ---------- inbox alerts ----------
function cleanEmail(b) {
  const str = (v, n) => (typeof v === 'string' ? v.slice(0, n) : '');
  return { id: str(b.id, 200), from: str(b.from, 300), subject: str(b.subject, 500), date: str(b.date, 40), text: str(b.text, 30000), html: str(b.html, 150000) };
}

/** Parse a forwarded email, store it, and push an alert if you're free. */
export async function ingestEmail(env, raw, { fetchImpl = fetch, now = Date.now() } = {}) {
  const s = store(env.PLANNER);
  const email = cleanEmail(raw);
  if (email.id && (await s.seenEmail(email.id))) return { duplicate: true };
  const alert = parseAlertEmail(email, await s.index());
  if (email.id) await s.markEmail(email.id);
  await s.addInbox(alert);
  if (alert.kind !== 'availability' || !alert.restaurantId) return { alert };
  const r = await s.profile(alert.restaurantId);
  const today = todayIn(now);
  const dates = alert.dates.filter((d) => d >= today);
  if (!r || !dates.length) return { alert };
  if (!alert.link) alert.link = bookingLink(r, { date: dates[0], time: alert.times[0] || '19:00', party: alert.party || 2 });
  const time = alert.times[0];
  const busy = await loadBusy(env, zonedToUtc(dates[0]), zonedToUtc(addDays(dates.at(-1), 1)), fetchImpl).catch(() => null);
  const clash = (d) => busy?.find((b) => (time
    ? b.start < zonedToUtc(d, time) + 2 * 3600000 && b.end > zonedToUtc(d, time)
    : b.start < zonedToUtc(addDays(d, 1)) && b.end > zonedToUtc(d, '18:00')));
  const free = dates.filter((d) => !clash(d));
  const label = providerFor(alert.platform === 'deliveroo' ? 'other' : alert.platform).label;
  const lines = dates.map((d) => `${shortDate(d)} · ${alert.times.join(', ') || 'time in email'} · ${alert.party ? `${alert.party} people` : 'party in email'}${clash(d) ? ` · clash: ${clash(d).title}` : ''}`);
  const msg = {
    title: `Table free: ${r.name}`,
    body: `${alert.platform === 'deliveroo' ? 'Deliveroo' : label} alert:\n${lines.join('\n')}${busy && free.length ? "\nYou're free then." : ''}`,
    url: alert.link,
  };
  // Busy on every date mentioned: keep the alert in the app, skip the push.
  const results = busy && !free.length ? [] : await notify(env, msg, fetchImpl);
  const entry = { at: now, kind: 'inbox', restaurantId: r.id, title: msg.title, lines, url: msg.url, results, pushed: results.length > 0 };
  await s.addLog(entry);
  return { alert, notified: entry };
}

// ---------- API ----------
function authorised(request, env) {
  const got = request.headers.get('x-app-token') || '';
  const want = env.APP_TOKEN || '';
  if (!want || got.length !== want.length) return false;
  let diff = 0;
  for (let i = 0; i < want.length; i++) diff |= got.charCodeAt(i) ^ want.charCodeAt(i);
  return diff === 0;
}

const DAY_GROUP_KEYS = new Set(['midweek', 'weekend', 'any']);
function cleanPlan(b) {
  const meals = (Array.isArray(b.meals) ? b.meals : []).filter((m) => MEALS[m]);
  if (!b.restaurantId || !meals.length) return null;
  return {
    restaurantId: String(b.restaurantId),
    meals,
    days: DAY_GROUP_KEYS.has(b.days) ? b.days : 'any',
    party: Math.min(20, Math.max(1, parseInt(b.party, 10) || 2)),
    onlyFree: !!b.onlyFree,
    until: /^\d{4}-\d{2}-\d{2}$/.test(b.until || '') ? b.until : null,
  };
}

export async function handleApi(request, env, deps = {}) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/$/, '');
  const method = request.method;
  const fetchImpl = deps.fetch || fetch;
  const research = deps.research || researchRestaurant;
  const s = store(env.PLANNER);

  if (path === '/api/config' && method === 'GET') {
    const ok = authorised(request, env);
    return json({
      authorised: ok,
      tokenConfigured: !!env.APP_TOKEN,
      features: ok ? {
        places: !!env.GOOGLE_PLACES_API_KEY,
        research: !!env.ANTHROPIC_API_KEY,
        calendar: !!env.CALENDAR_ICS_URL,
      } : null,
      channels: ok ? CHANNELS.map((c) => ({ name: c.name, label: c.label, enabled: c.enabled(env) })) : null,
    });
  }
  if (!env.APP_TOKEN) return fail(503, 'Set the APP_TOKEN secret to use the app.');
  if (!authorised(request, env)) return fail(401, 'Access token required.');

  try {
    if (path === '/api/search' && method === 'GET') {
      const q = (url.searchParams.get('q') || '').trim();
      if (!q) return json({ results: [] });
      if (!env.GOOGLE_PLACES_API_KEY) return json({ results: [], places: false });
      const results = await searchPlaces(q, { apiKey: env.GOOGLE_PLACES_API_KEY, city: url.searchParams.get('city') || 'London', fetchImpl });
      return json({ results, places: true });
    }

    if (path === '/api/restaurants' && method === 'GET') return json({ restaurants: await s.index() });

    let m = /^\/api\/restaurants\/([a-z0-9-]+)$/.exec(path);
    if (m && method === 'GET') {
      const p = await s.profile(m[1]);
      return p ? json({ restaurant: p }) : fail(404, 'Not found');
    }

    m = /^\/api\/restaurants\/([a-z0-9-]+)\/release$/.exec(path);
    if (m && method === 'PUT') {
      const b = await request.json();
      const pattern = ['rolling', 'monthly'].includes(b.pattern) ? b.pattern : null;
      const time = /^([01]\d|2[0-3]):[0-5]\d$/.test(b.time || '') ? b.time : '00:00';
      if (!pattern) return fail(400, 'pattern must be rolling or monthly');
      const o = { release: pattern === 'rolling'
        ? { pattern, daysAhead: Math.min(400, Math.max(1, parseInt(b.daysAhead, 10) || 30)), monthsAhead: null, dayOfMonth: null, time }
        : { pattern, daysAhead: null, monthsAhead: Math.min(12, Math.max(0, parseInt(b.monthsAhead, 10) || 1)), dayOfMonth: Math.min(28, Math.max(1, parseInt(b.dayOfMonth, 10) || 1)), time } };
      await s.override(m[1], o);
      return json({ restaurant: await s.profile(m[1]) });
    }

    if (path === '/api/research' && method === 'POST') {
      const b = await request.json();
      const name = String(b.name || '').trim().slice(0, 120);
      const city = String(b.city || 'London').trim().slice(0, 60);
      if (!name) return fail(400, 'name required');
      const index = await s.index();
      const known = index.find((x) => x.name.toLowerCase() === name.toLowerCase());
      if (known && !b.force) {
        const p = await s.profile(known.id);
        if (p && Date.now() - Date.parse(p.checkedAt) < RESEARCH_MAX_AGE_MS) return json({ restaurant: p, cached: true });
      }
      if (!env.ANTHROPIC_API_KEY) return fail(503, 'Research needs the ANTHROPIC_API_KEY secret.');
      let profile = await research({ name, city, apiKey: env.ANTHROPIC_API_KEY });
      let place = b.place || null;
      if (!place && env.GOOGLE_PLACES_API_KEY) {
        const results = await searchPlaces(name, { apiKey: env.GOOGLE_PLACES_API_KEY, city, fetchImpl }).catch(() => []);
        place = bestMatch(name, results);
      }
      if (place) profile = mergePlace(profile, place);
      await s.saveProfile(profile);
      return json({ restaurant: await s.profile(profile.id), cached: false });
    }

    if (path === '/api/busy' && method === 'GET') {
      const from = url.searchParams.get('from'), to = url.searchParams.get('to');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(from || '') || !/^\d{4}-\d{2}-\d{2}$/.test(to || '')) return fail(400, 'from/to required');
      const busy = await loadBusy(env, zonedToUtc(from), zonedToUtc(addDays(to, 1)), fetchImpl);
      return json({ calendar: busy !== null, busy: busy || [] });
    }

    if (path === '/api/plans' && method === 'GET') {
      const plans = await s.plans();
      const withR = await Promise.all(plans.map(async (p) => ({ ...p, restaurant: await s.profile(p.restaurantId) })));
      return json({ plans: withR, log: await s.log(), channels: enabledChannels(env).map((c) => c.name) });
    }
    if (path === '/api/plans' && method === 'POST') {
      const plan = cleanPlan(await request.json());
      if (!plan) return fail(400, 'restaurantId and at least one meal required');
      if (!(await s.profile(plan.restaurantId))) return fail(404, 'Unknown restaurant');
      const plans = await s.plans();
      const same = plans.find((p) => p.restaurantId === plan.restaurantId && p.days === plan.days
        && p.party === plan.party && p.meals.join() === plan.meals.join());
      if (same) return json({ plan: same, existing: true });
      const saved = { ...plan, id: crypto.randomUUID().slice(0, 8), createdAt: new Date().toISOString() };
      await s.savePlans([...plans, saved]);
      return json({ plan: saved });
    }
    m = /^\/api\/plans\/([a-z0-9-]+)$/.exec(path);
    if (m && method === 'DELETE') {
      await s.savePlans((await s.plans()).filter((p) => p.id !== m[1]));
      return json({ ok: true });
    }

    if (path === '/api/inbox' && method === 'POST') {
      return json(await ingestEmail(env, await request.json(), { fetchImpl }));
    }
    if (path === '/api/inbox/preview' && method === 'POST') {
      return json({ alert: parseAlertEmail(cleanEmail(await request.json()), await s.index()) });
    }
    if (path === '/api/inbox' && method === 'GET') {
      return json({ alerts: await s.inbox() });
    }

    if (path === '/api/alerts/test' && method === 'POST') {
      const results = await notify(env, { title: 'Table Planner test', body: 'Alerts are working.', url: null }, fetchImpl);
      return json({ results });
    }

    return fail(404, 'Not found');
  } catch (e) {
    return fail(502, e.message || 'Something went wrong');
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) return handleApi(request, env);
    return env.ASSETS.fetch(request);
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runAlerts(env, { now: event.scheduledTime || Date.now() }));
  },
};
