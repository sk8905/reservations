// Turns the research model's JSON into a restaurant profile the planner can
// use, and decides how far to trust each fact.
//
// Anti-fabrication rules:
//  - a fact counts only if it cites a URL that web search actually returned
//    in this run; anything else is dropped to null
//  - confidence: high = the restaurant's own site / booking page, or two
//    independent sites agree; medium = one site; estimated = no source
//    (only the release time falls back to a default, 00:00, and says so)

import { detectPlatform, providerFor } from '../public/shared/links.js';

const PLATFORMS = new Set(['opentable', 'resy', 'sevenrooms', 'tock', 'designmynight', 'other']);
const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

export function slugify(s) {
  return String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80);
}

function host(url) {
  try { return new URL(url).hostname.replace(/^www\./, '').toLowerCase(); } catch { return null; }
}

/** Pull the first JSON object out of model text (fenced or bare). */
export function extractJson(text) {
  if (!text) return null;
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const candidates = fenced ? [fenced[1], text] : [text];
  for (const c of candidates) {
    const start = c.indexOf('{');
    const end = c.lastIndexOf('}');
    if (start < 0 || end <= start) continue;
    try { return JSON.parse(c.slice(start, end + 1)); } catch { /* try next */ }
  }
  return null;
}

/** Every URL the web search tool returned, plus any cited in text blocks. */
export function searchedUrls(content = []) {
  const urls = new Map();
  for (const block of content) {
    if (block.type === 'web_search_tool_result' && Array.isArray(block.content)) {
      for (const r of block.content) if (r.url) urls.set(r.url, r.title || host(r.url));
    }
    if (block.type === 'text' && Array.isArray(block.citations)) {
      for (const c of block.citations) if (c.url) urls.set(c.url, c.title || host(c.url));
    }
  }
  return urls;
}

function finalText(content = []) {
  return content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
}

function keepSources(list, allowed) {
  const out = [];
  const seen = new Set();
  for (const u of Array.isArray(list) ? list : []) {
    if (typeof u !== 'string' || !allowed.has(u) || seen.has(u)) continue;
    seen.add(u);
    out.push({ url: u, title: allowed.get(u) || host(u) });
  }
  return out;
}

function confidence(sources, officialHosts) {
  if (!sources.length) return 'estimated';
  const hosts = new Set(sources.map((s) => host(s.url)).filter(Boolean));
  if ([...hosts].some((h) => officialHosts.has(h))) return 'high';
  return hosts.size >= 2 ? 'high' : 'medium';
}

function cleanHours(v) {
  if (!v || typeof v !== 'object') return null;
  const out = {};
  let any = false;
  for (const d of DAYS) {
    const periods = Array.isArray(v[d]) ? v[d] : [];
    const ok = periods.filter((p) => Array.isArray(p) && HHMM.test(p[0]) && HHMM.test(p[1]));
    if (ok.length) { out[d] = ok.map(([a, b]) => [a, b]); any = true; }
  }
  return any ? out : null;
}

const int = (v, lo, hi) => (Number.isInteger(v) && v >= lo && v <= hi ? v : null);

/**
 * Build the stored profile from the model's JSON and the searched URLs.
 * `allowed` is a Map url -> title from searchedUrls().
 */
export function normaliseProfile(json, allowed, { name, city, now = Date.now() } = {}) {
  const j = json || {};
  const facts = [];
  const add = (label, value, sources, conf) => facts.push({ label, value, sources, confidence: conf });

  const websiteSrc = keepSources(j.website?.sources, allowed);
  const website = websiteSrc.length && typeof j.website?.value === 'string' ? j.website.value : null;

  const platSrc = keepSources(j.platform?.sources, allowed);
  let bookingUrl = platSrc.length && typeof j.platform?.booking_url === 'string' ? j.platform.booking_url : null;
  let platform = bookingUrl ? detectPlatform(bookingUrl) : null;
  if (!platform && platSrc.length && PLATFORMS.has(j.platform?.value)) platform = j.platform.value;
  if (bookingUrl && !/^https:\/\//.test(bookingUrl)) { bookingUrl = null; platform = null; }

  const official = new Set([host(website), host(bookingUrl)].filter(Boolean));
  const conf = (s) => confidence(s, official);

  if (platform) add('Platform', providerFor(platform).label, platSrc, conf(platSrc));
  if (website) add('Website', website, websiteSrc, conf(websiteSrc));

  // Booking window
  const bw = j.booking_window || {};
  const bwSrc = keepSources(bw.sources, allowed);
  let release = { pattern: 'unknown', daysAhead: null, monthsAhead: null, dayOfMonth: null };
  if (bwSrc.length && bw.pattern === 'rolling' && int(bw.days_ahead, 1, 400)) {
    release = { pattern: 'rolling', daysAhead: bw.days_ahead, monthsAhead: null, dayOfMonth: null };
    add('Booking window', `${bw.days_ahead} days ahead (rolling)`, bwSrc, conf(bwSrc));
  } else if (bwSrc.length && bw.pattern === 'monthly' && int(bw.months_ahead, 0, 12) != null) {
    const dom = int(bw.day_of_month, 1, 28) || 1;
    release = { pattern: 'monthly', daysAhead: null, monthsAhead: bw.months_ahead, dayOfMonth: dom };
    add('Booking window', `Opens on day ${dom} of the month, ${bw.months_ahead} month(s) ahead`, bwSrc, conf(bwSrc));
  } else {
    add('Booking window', 'Not published', [], 'estimated');
  }
  release.confidence = facts[facts.length - 1].confidence;

  // Release time
  const rtSrc = keepSources(j.release_time?.sources, allowed);
  if (rtSrc.length && HHMM.test(j.release_time?.value || '')) {
    release.time = j.release_time.value;
    release.timeEstimated = false;
    add('Release time', `${release.time} UK`, rtSrc, conf(rtSrc));
  } else {
    release.time = '00:00';
    release.timeEstimated = true;
    add('Release time', '00:00 UK (usual default; not published)', [], 'estimated');
  }

  // Service hours
  const shSrc = keepSources(j.service_hours?.sources, allowed);
  const hoursValue = shSrc.length ? cleanHours(j.service_hours?.value) : null;
  const hours = hoursValue
    ? { value: hoursValue, complete: j.service_hours?.complete === true, confidence: conf(shSrc), source: 'research' }
    : null;
  if (hours) add('Opening hours', describeHours(hoursValue) + (hours.complete ? '' : ' (may be partial)'), shSrc, hours.confidence);

  // Phone line
  const ph = j.phone || {};
  const phSrc = keepSources(ph.sources, allowed);
  const phone = phSrc.length && typeof ph.number === 'string'
    ? { number: ph.number, hours: typeof ph.hours === 'string' ? ph.hours : null, note: typeof ph.note === 'string' ? ph.note : null }
    : null;
  if (phone) add('Phone', [phone.number, phone.hours, phone.note].filter(Boolean).join(' · '), phSrc, conf(phSrc));

  const areaSrc = keepSources(j.area?.sources, allowed);
  const area = areaSrc.length && typeof j.area?.value === 'string' ? j.area.value : null;

  return {
    id: slugify(`${j.name || name} ${city || ''}`),
    name: typeof j.name === 'string' && j.name ? j.name : name,
    city: city || null,
    area,
    website,
    platform,
    bookingUrl,
    release,
    hours,
    phone,
    facts,
    notes: Array.isArray(j.notes) ? j.notes.filter((n) => typeof n === 'string').slice(0, 5) : [],
    checkedAt: new Date(now).toISOString(),
  };
}

export function describeHours(value) {
  const label = { mon: 'Mon', tue: 'Tue', wed: 'Wed', thu: 'Thu', fri: 'Fri', sat: 'Sat', sun: 'Sun' };
  const groups = [];
  for (const d of DAYS) {
    const key = JSON.stringify(value[d] || null);
    const last = groups[groups.length - 1];
    if (last && last.key === key) last.days.push(d);
    else groups.push({ key, days: [d] });
  }
  return groups.filter((g) => g.key !== 'null').map((g) => {
    const days = g.days.length > 1 ? `${label[g.days[0]]}–${label[g.days.at(-1)]}` : label[g.days[0]];
    return `${days} ${JSON.parse(g.key).map(([a, b]) => `${a}–${b}`).join(', ')}`;
  }).join('; ');
}

export { finalText };
