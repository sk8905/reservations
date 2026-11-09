import { MEALS, MEAL_ORDER, DAY_GROUPS, buildSlots, summarise, nextReleases, notifyChecklist } from './shared/plan.js';
import { addDays, todayIn, shortDate, shortDateTime, DOW_SHORT, dowOf } from './shared/tz.js';
import { providerFor, googleMapsLink } from './shared/links.js';
import { slotsToCsv } from './shared/csv.js';

const app = document.getElementById('app');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ls = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } },
};

const state = {
  token: ls.get('tp.token', ''),
  config: null,
  recent: [],
  restaurant: null,
  query: ls.get('tp.query', { meals: ['dinner'], days: 'midweek', party: 2, range: 30, onlyFree: true }),
  name: '', city: 'London', suggestions: [], selectedPlace: null,
  busy: null, calendar: false, loadingDates: false,
  researching: false, error: null,
  plans: null, log: [], channels: [], inbox: [], preview: null,
  wishlist: null, marks: {}, listBusy: [], adding: false,
  flash: null,
};

async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: { 'Content-Type': 'application/json', 'x-app-token': state.token, ...(opts.headers || {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) { location.hash = '#/token'; throw new Error('Access token required'); }
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

// ---------- screens ----------
function setupScreen() {
  const r = state.restaurant;
  const q = state.query;
  const feats = state.config?.features || {};
  return `
  <div class="head"><span class="eyebrow">Table Planner</span><h1>Find a table</h1></div>
  <div class="stack">
    <form data-form="lookup">
      <div class="label">Restaurant</div>
      <div class="row">
        <label class="field grow"><span class="sr">Restaurant name</span>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true" style="color:var(--ink-3)"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>
          <input name="name" autocomplete="off" placeholder="e.g. Bouchon Racine" value="${esc(state.name || r?.name || '')}" data-input="name">
        </label>
        <label class="field" style="width:110px"><span class="sr">City</span><input name="city" value="${esc(state.city)}" data-input="city"></label>
      </div>
      ${state.suggestions.length ? `<div class="suggest">${state.suggestions.map((p, i) => `
        <button type="button" data-action="pick-place" data-i="${i}">${esc(p.name)}<small>${esc(p.address || '')}</small></button>`).join('')}</div>` : ''}
      <button class="btn secondary small" style="margin-top:8px" ${state.researching ? 'disabled' : ''}>${state.researching ? 'Researching booking rules…' : 'Look up'}</button>
    </form>
    ${state.error ? `<div class="error" role="alert">${esc(state.error)}</div>` : ''}
    ${state.researching ? `<div class="skeleton" style="height:84px"></div><div class="sub">Searching the web for how bookings open. Usually 20–60 seconds; the result is saved, so it's instant next time.</div>` : ''}
    ${!state.researching && !r && state.recent.length ? `<div><div class="label">Recent</div><div class="tags">${state.recent.map((x) => `<button type="button" class="chip" style="min-height:36px;padding:4px 10px" data-action="open-recent" data-id="${esc(x.id)}">${esc(x.name)}</button>`).join('')}</div></div>` : ''}
    ${r && !state.researching ? restaurantCard(r) : ''}
    <div>
      <div class="label">Meals</div>
      <div class="chips3">${MEAL_ORDER.map((m) => `<button type="button" class="chip" aria-pressed="${q.meals.includes(m)}" data-action="meal" data-meal="${m}">${MEALS[m].label}<small>${MEALS[m].start}–${MEALS[m].end}</small></button>`).join('')}</div>
    </div>
    <div>
      <div class="label">Days</div>
      <div class="chips3">${Object.entries(DAY_GROUPS).map(([k, g]) => `<button type="button" class="chip" aria-pressed="${q.days === k}" data-action="days" data-days="${k}">${g.label}<small style="font-family:inherit">${g.sub}</small></button>`).join('')}</div>
    </div>
    <div class="row">
      <div class="card grow row" style="justify-content:space-between;padding:4px 4px 4px 12px">
        <span class="label" style="margin:0">Party</span>
        <span class="stepper"><button type="button" aria-label="Fewer people" data-action="party" data-d="-1">−</button><span>${q.party}</span><button type="button" aria-label="More people" data-action="party" data-d="1">+</button></span>
      </div>
      <label class="card grow row" style="justify-content:space-between;padding:4px 4px 4px 12px">
        <span class="label" style="margin:0">Next</span>
        <select data-input="range">${[14, 30, 60, 90].map((n) => `<option value="${n}" ${q.range === n ? 'selected' : ''}>${n} days</option>`).join('')}</select>
      </label>
    </div>
    <label class="card toggle">
      <span><b style="font-size:14px">Only dates I'm free</b><br><span class="sub">${feats.calendar ? 'Checks your calendar feed' : 'Add a calendar feed to use this (SETUP.md, step B2)'}</span></span>
      <input type="checkbox" data-input="onlyFree" ${q.onlyFree && feats.calendar ? 'checked' : ''} ${feats.calendar ? '' : 'disabled'}>
    </label>
    <a class="btn" href="#/plan" ${r ? '' : 'aria-disabled="true" data-action="need-restaurant"'}>Show my dates</a>
  </div>`;
}

function restaurantCard(r) {
  const p = providerFor(r.platform);
  const rel = r.release;
  const window = rel.pattern === 'rolling' ? `Books ${rel.daysAhead} days ahead` : rel.pattern === 'monthly' ? `Opens day ${rel.dayOfMonth} monthly` : 'Release rule unknown';
  const hours = r.hours?.value ? Object.keys(r.hours.value).map((d) => d[0].toUpperCase() + d.slice(1, 3)) : null;
  return `<div class="card">
    <div class="row" style="justify-content:space-between;align-items:baseline"><b style="font-size:15px">${esc(r.name)}</b><span class="sub">${esc(r.address || r.area || r.city || '')}</span></div>
    <div class="tags">
      <span class="tag blue">${esc(r.platform ? p.label : 'Platform unknown')}</span>
      <span class="tag ${rel.pattern === 'unknown' ? '' : 'go'}">${esc(window)}</span>
      ${r.reservable === true ? '<span class="tag go">Takes bookings online</span>' : r.reservable === false ? '<span class="tag later">No online booking</span>' : ''}
      ${hours ? `<span class="tag">Open ${esc(hours.join(' '))}${r.hours.complete ? '' : ' (partial)'}</span>` : ''}
    </div>
    ${onList(r.id) ? '<div class="sub" style="margin-top:6px;color:var(--go-ink);font-weight:600">✓ On my list</div>'
      : `<button type="button" class="btn small secondary" style="margin-top:8px" data-action="add-to-list">＋ Add to my list</button>`}
    <div class="row" style="justify-content:space-between;margin-top:6px">
      <a href="#/restaurant" style="font-size:13px;font-weight:600;text-decoration:none">How we know this →</a>
      <a href="${esc(googleMapsLink(r))}" target="_blank" rel="noopener noreferrer" style="font-size:13px;font-weight:600;text-decoration:none">See on Google</a>
    </div>
  </div>`;
}

function planScreen() {
  const r = state.restaurant;
  if (!r) return `<div class="head"><h1>Your dates</h1></div><div class="card">Pick a restaurant first. <a href="#/">Find a table</a></div>`;
  const q = state.query;
  const now = Date.now();
  const today = todayIn(now);
  const to = addDays(today, q.range);
  if (state.loadingDates) return `<div class="head"><h1>${esc(r.name)}</h1></div>${'<div class="skeleton" style="height:52px;margin-bottom:6px"></div>'.repeat(6)}`;
  let slots = buildSlots({ restaurant: r, meals: q.meals, days: q.days, party: q.party, from: today, to, now, busy: state.busy || [] });
  const hiddenBusy = q.onlyFree && state.calendar ? slots.filter((s) => s.busy).length : 0;
  state.lastSlots = slots;
  const sum = summarise(slots, { restaurant: r, now, meals: q.meals, days: q.days });
  const soon = nextReleases(r, { now, meals: q.meals, days: q.days, count: 3 }).filter((x) => x.date > to);
  const weeks = new Map();
  for (const s of slots) {
    const monday = addDays(s.date, -((dowOf(s.date) + 6) % 7));
    if (!weeks.has(monday)) weeks.set(monday, []);
    weeks.get(monday).push(s);
  }
  const mealsTxt = q.meals.map((m) => MEALS[m].label).join(' + ');
  return `
  <div class="head">
    <a class="back" href="#/">‹ Edit search</a>
    <h1>${esc(r.name)}</h1>
    <span class="sub">${esc(mealsTxt)} · ${DAY_GROUPS[q.days].label} · ${q.party} ${q.party === 1 ? 'person' : 'people'} · ${shortDate(today).slice(4)} – ${shortDate(to).slice(4)}</span>
    <div class="stats">
      <div class="stat"><b>${sum.total}</b><span>slots</span></div>
      <div class="stat go"><b>${state.calendar ? sum.free : '—'}</b><span>${state.calendar ? "you're free" : 'no calendar'}</span></div>
      <div class="stat blue"><b>${sum.bookable}</b><span>${state.calendar ? 'free &amp; bookable' : 'bookable now'}</span></div>
    </div>
    <span class="sub" style="margin-top:4px">Booking window: ${esc(sum.window)}${r.release.timeEstimated && r.release.pattern !== 'unknown' ? ' · release time estimated' : ''}${sum.next ? ` · next release ${esc(shortDateTime(sum.next.opensAt))} (for ${esc(sum.next.label)})` : ''}</span>
  </div>
  ${slots.some(alertFor) ? `<div class="card" style="margin-top:6px;border:2px solid var(--alert);color:var(--alert-ink);font-size:13px;font-weight:600">⚡ ${slots.filter(alertFor).length} table alert${slots.filter(alertFor).length > 1 ? 's' : ''} from your inbox in the last 24 hours. Book fast: they go quickly.</div>` : ''}
  ${slots.length ? [...weeks].map(([monday, list]) => `
    <div class="section">Week of ${esc(shortDate(monday).slice(4))}</div>
    ${list.map(slotRow).join('')}`).join('') : `<div class="card">No ${esc(mealsTxt.toLowerCase())} slots in this range${r.hours?.complete ? ' — the restaurant is closed then' : ''}.</div>`}
  ${soon.length ? `<div class="section">Opening next</div><div class="list">${soon.map((x) => `
    <div><span class="mono" style="width:92px;font-weight:600">${esc(x.label)}</span><span class="grow" style="color:var(--later-ink)">opens ${esc(shortDateTime(x.opensAt))}</span></div>`).join('')}</div>` : ''}
  ${r.phone ? `<div class="card row" style="margin-top:8px"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2"/></svg>
    <span class="grow sub" style="color:var(--ink-2)">Full online? ${esc([r.phone.hours, r.phone.note].filter(Boolean).join(' · ') || 'Try calling.')}</span>
    <a href="tel:${esc(r.phone.number.replace(/[^\d+]/g, ''))}" style="font-weight:600;text-decoration:none">Call</a></div>` : ''}
  ${hiddenBusy ? `<div class="sub" style="margin-top:6px">${hiddenBusy} slot${hiddenBusy > 1 ? 's' : ''} greyed out: you're busy then.</div>` : ''}
  ${state.flash ? `<div class="card" style="margin-top:8px;color:var(--go-ink)">${esc(state.flash)}</div>` : ''}
  <div class="btn-row" style="margin-top:10px">
    <button class="btn small" data-action="watch">Alert me</button>
    <button class="btn small secondary" data-action="csv">Download CSV</button>
  </div>
  <p class="notice" style="margin-top:10px">${r.reservable === false ? 'Google lists no online reservations for this restaurant.' : `Check opens ${esc(providerFor(r.platform).label)} with the date and party filled in; live times are shown there.`} The map pin opens Google Maps, where "Reserve a table" may show more times (pick the date there). This app never books or holds tables.</p>`;
}

const ALERT_FRESH_MS = 24 * 3600000;
function alertFor(s) {
  return state.inbox.find((a) => a.kind === 'availability' && a.restaurantId === state.restaurant?.id
    && a.dates.includes(s.date) && (!a.meal || a.meal === s.meal)
    && Date.now() - Date.parse(a.receivedAt) < ALERT_FRESH_MS);
}
function ago(iso) {
  const mins = Math.round((Date.now() - Date.parse(iso)) / 60000);
  return mins < 60 ? `${Math.max(1, mins)} min ago` : `${Math.round(mins / 60)} h ago`;
}
const PLATFORM_NAMES = { opentable: 'OpenTable', resy: 'Resy', sevenrooms: 'SevenRooms', tock: 'Tock', designmynight: 'DesignMyNight', deliveroo: 'Deliveroo' };

function slotRow(s) {
  const [, , dd] = s.date.split('-');
  let cls = s.status, title, sub, cta = 'Check';
  const hit = alertFor(s);
  if (hit && !(s.busy && state.query.onlyFree)) {
    return `<div class="slot alert">
    <div class="day"><small>${DOW_SHORT[s.dow]}</small><b>${Number(dd)}</b></div>
    <div class="what"><b>⚡ Table ${hit.times.length ? 'at ' + esc(hit.times.join(', ')) : 'free'}${hit.party ? ' for ' + hit.party : ''}</b><span>${esc(PLATFORM_NAMES[hit.platform] || 'Platform')} alert · ${esc(ago(hit.receivedAt))}</span></div>
    ${s.googleLink ? `<a class="g-btn" href="${esc(s.googleLink)}" target="_blank" rel="noopener noreferrer" aria-label="See on Google Maps"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 21s-7-6.2-7-11.5A7 7 0 0 1 19 9.5C19 14.8 12 21 12 21z"/><circle cx="12" cy="9.5" r="2.5"/></svg></a>` : ''}
    <a class="go-btn" href="${esc(hit.link || s.link || '#')}" target="_blank" rel="noopener noreferrer">Book</a>
  </div>`;
  }
  if (s.busy && state.query.onlyFree) {
    cls = 'busy'; title = "You're busy"; sub = `Calendar: ${s.busyTitle || 'event'}`; cta = 'Link';
  } else if (s.noOnline) {
    cls = 'unknown'; title = 'No online booking';
    sub = `${s.mealLabel} ${s.start}–${s.end} · call or walk in`;
  } else if (s.status === 'bookable') {
    title = state.query.meals.length > 1 ? `${s.mealLabel} · bookable now` : 'Bookable now';
    sub = `Live times ${s.start}–${s.end}`;
  } else if (s.status === 'opens') {
    title = `Opens ${shortDateTime(s.opensAt)}${s.opensEstimated ? '*' : ''}`;
    sub = `${s.mealLabel} ${s.start}–${s.end}${s.opensEstimated ? ' · *time estimated' : ''}`;
    cta = 'Link';
  } else {
    title = 'Release date unknown';
    sub = `${s.mealLabel} ${s.start}–${s.end} · check the page`;
  }
  if (!s.hoursKnown) sub += ' · hours unconfirmed';
  return `<div class="slot ${cls}">
    <div class="day"><small>${DOW_SHORT[s.dow]}</small><b>${Number(dd)}</b></div>
    <div class="what"><b>${esc(title)}</b><span>${esc(sub)}</span></div>
    ${s.googleLink ? `<a class="g-btn" href="${esc(s.googleLink)}" target="_blank" rel="noopener noreferrer" aria-label="See ${esc(state.restaurant.name)} on Google Maps" title="See on Google Maps"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 21s-7-6.2-7-11.5A7 7 0 0 1 19 9.5C19 14.8 12 21 12 21z"/><circle cx="12" cy="9.5" r="2.5"/></svg></a>` : ''}
    ${s.link ? `<a class="go-btn" href="${esc(s.link)}" target="_blank" rel="noopener noreferrer">${cta}</a>` : ''}
  </div>`;
}

function restaurantScreen() {
  const r = state.restaurant;
  if (!r) return `<div class="head"><h1>How bookings open</h1></div><div class="card">Pick a restaurant first. <a href="#/">Find a table</a></div>`;
  const rel = r.release;
  const rule = rel.pattern === 'rolling' ? `Rolling · ${rel.daysAhead} days ahead · ${rel.time} UK`
    : rel.pattern === 'monthly' ? `Monthly · day ${rel.dayOfMonth}, ${rel.monthsAhead} month(s) ahead · ${rel.time} UK` : 'Not published';
  const conf = { high: 'High', medium: 'Medium', estimated: 'Estimated' };
  return `
  <div class="head">
    <a class="back" href="#/plan">‹ Back</a>
    <h1>How bookings open</h1>
    <span class="sub">${esc(r.name)} · ${rel.corrected ? 'corrected by you' : 'researched automatically from the web'}</span>
  </div>
  <div class="stack" style="gap:8px">
    <div class="hero"><span class="eyebrow">Rule in use</span><b>${esc(rule)}</b>
      <span>${rel.pattern === 'unknown' ? 'No source states it, so dates show "check the page".' : rel.timeEstimated ? 'The release time is estimated: no source states it.' : 'Every part of this rule has a source.'}</span></div>
    ${r.facts.map((f) => `<div class="fact">
      <div class="top"><span>${esc(f.label)}</span><span class="badge ${f.confidence}">${conf[f.confidence]}</span></div>
      <div class="val">${esc(f.value)}</div>
      <div class="src">${f.sources.length ? 'Source: ' + f.sources.map((s) => s.url ? `<a href="${esc(s.url)}" target="_blank" rel="noopener noreferrer">${esc(s.title || s.url)}</a>` : esc(s.title)).join(' · ') : 'No source found'}</div>
    </div>`).join('')}
    ${r.notes?.length ? `<div class="fact"><div class="top"><span>Tips</span></div>${r.notes.map((n) => `<div class="sub" style="margin-top:3px">• ${esc(n)}</div>`).join('')}</div>` : ''}
    <div class="notice">Checked ${esc(new Date(r.checkedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }))} · re-checked monthly</div>
    <div class="btn-row">
      <button class="btn small secondary" data-action="recheck" ${state.researching ? 'disabled' : ''}>${state.researching ? 'Checking…' : 'Re-check now'}</button>
      <button class="btn small secondary" data-action="show-correct">Correct it</button>
    </div>
    ${state.correcting ? `<form class="correct card" data-form="correct">
      <label>Pattern<select name="pattern"><option value="rolling" ${rel.pattern !== 'monthly' ? 'selected' : ''}>Rolling (N days ahead)</option><option value="monthly" ${rel.pattern === 'monthly' ? 'selected' : ''}>Monthly</option></select></label>
      <label>Release time (UK)<input name="time" type="time" value="${esc(rel.time || '00:00')}"></label>
      <label>Days ahead (rolling)<input name="daysAhead" type="number" min="1" max="400" value="${rel.daysAhead ?? 30}"></label>
      <label>Day of month / months ahead<span class="row"><input name="dayOfMonth" type="number" min="1" max="28" value="${rel.dayOfMonth ?? 1}" style="width:50%"><input name="monthsAhead" type="number" min="0" max="12" value="${rel.monthsAhead ?? 1}" style="width:50%"></span></label>
      <button class="btn small" style="grid-column:1/-1">Save correction</button>
    </form>` : ''}
    ${state.error ? `<div class="error" role="alert">${esc(state.error)}</div>` : ''}
  </div>`;
}

function alertsScreen() {
  if (!state.plans) return `<div class="head"><h1>Alerts</h1></div><div class="skeleton" style="height:120px"></div>`;
  const now = Date.now();
  const upcoming = state.plans.flatMap((p) => p.restaurant ? nextReleases(p.restaurant, { now, meals: p.meals, days: p.days, count: 3 })
    .map((x) => ({ ...x, name: p.restaurant.name })) : []).sort((a, b) => a.opensAt - b.opensAt).slice(0, 5);
  const ch = state.config?.channels || [];
  const latest = state.log[0];
  return `
  <div class="head"><span class="eyebrow">Table Planner</span><h1>Alerts</h1></div>
  <div class="stack" style="gap:8px">
    ${latest ? `<div class="section" style="margin-top:0">Latest</div><div class="alert-card">
      <div class="meta"><b>${esc(latest.title)}</b><span>${esc(shortDateTime(latest.at))}</span></div>
      <div style="font-size:14px;font-weight:600;margin:4px 0 8px;white-space:pre-line">${esc(latest.lines.join('\n'))}</div>
      ${latest.url ? `<a class="btn small" style="background:var(--alert)" href="${esc(latest.url)}" target="_blank" rel="noopener noreferrer">Open booking page</a>` : ''}
    </div>` : ''}
    <div class="section">Watching</div>
    ${state.plans.length ? `<div class="list">${state.plans.map((p) => `<div>
      <span class="grow"><b>${esc(p.restaurant?.name || p.restaurantId)}</b><br><span class="sub">${esc(p.meals.map((m) => MEALS[m].label).join(' + '))} · ${DAY_GROUPS[p.days].label} · ${p.party} people${p.onlyFree ? ' · free dates only' : ''}</span></span>
      <button class="chip" style="min-height:36px;padding:0 10px;font-size:13px" data-action="unwatch" data-id="${esc(p.id)}">Stop</button></div>`).join('')}</div>`
      : `<div class="card sub">Nothing yet. On your dates, tap <b>Alert me</b>.</div>`}
    ${upcoming.length ? `<div class="section">Release nights</div><div class="list">${upcoming.map((x) => `<div>
      <span class="mono" style="width:100px;font-weight:600">${esc(shortDateTime(x.opensAt).split(', ')[0])}</span>
      <span class="grow">${esc(shortDateTime(x.opensAt).split(', ')[1])} · ${esc(x.name)}: ${esc(x.label)} opens</span></div>`).join('')}</div>` : ''}
    <div class="section">Inbox alerts</div>
    ${inboxSection()}
    <div class="section">Send alerts by</div>
    <div class="list">${ch.map((c) => `<div><span class="grow">${esc(c.label)}</span><span class="tag ${c.enabled ? 'go' : ''}">${c.enabled ? 'On' : 'Not set up'}</span></div>`).join('')}</div>
    <button class="btn small secondary" data-action="test-alert" ${ch.some((c) => c.enabled) ? '' : 'disabled'}>Send a test alert</button>
    ${state.flash ? `<div class="card" style="color:var(--go-ink)">${esc(state.flash)}</div>` : ''}
    ${state.error ? `<div class="error" role="alert">${esc(state.error)}</div>` : ''}
    <p class="notice"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true" style="flex-shrink:0;margin-top:2px"><path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z"/></svg>
      Alerts go out just after each release (checked hourly). Read-only: never books, holds or cancels, and never signs in to a booking site.</p>
  </div>`;
}

function inboxSection() {
  const recent = state.inbox.slice(0, 5);
  const last = state.inbox[0];
  const p = state.preview;
  return `<div class="card stack" style="gap:8px">
    <div class="row" style="justify-content:space-between"><b style="font-size:14px">Gmail forwarding</b>
      <span class="tag ${last ? 'go' : ''}">${last ? `Last email ${esc(ago(last.receivedAt))}` : 'Not set up yet'}</span></div>
    <div class="sub">Set <b>Notify me</b> on OpenTable or Resy for the dates you want. When their "table available" email arrives, a small script in your Gmail passes it here: you get a ⚡ on that date and a push if you're free. Only booking-platform emails are read.</div>
    <ol class="sub" style="margin:0;padding-left:18px;color:var(--ink-2)">
      <li>Tap <b>Copy script</b> (your address and token are filled in).</li>
      <li>Open <a href="https://script.google.com/home/projects/create" target="_blank" rel="noopener noreferrer">script.google.com → New project</a>, select all, paste.</li>
      <li>Choose <b>setup</b> in the function menu, press <b>Run</b>, and allow access.</li>
    </ol>
    <button class="btn small secondary" data-action="copy-script">Copy script</button>
  </div>
  ${recent.length ? `<div class="list">${recent.map((a) => `<div><span class="grow"><b>${esc(a.kind === 'availability' ? (a.restaurantName || 'Unmatched restaurant') : 'Ignored')}</b><br>
    <span class="sub">${esc(a.kind === 'availability' ? [a.dates.map((d) => shortDate(d)).join(', ') || 'no date found', a.times.join(', '), a.party ? `${a.party} people` : ''].filter(Boolean).join(' · ') : a.reason)} · ${esc(ago(a.receivedAt))}</span></span></div>`).join('')}</div>` : ''}
  <details class="card"><summary style="font-size:14px;font-weight:600;cursor:pointer">Test with a pasted email</summary>
    <form class="stack" data-form="preview" style="gap:6px;margin-top:8px">
      <label class="sub">From<input class="txt" name="from" value="OpenTable &lt;noreply@opentable.co.uk&gt;"></label>
      <label class="sub">Subject<input class="txt" name="subject" placeholder="Paste the subject"></label>
      <label class="sub">Email text<textarea class="txt" name="body" rows="5" placeholder="Paste the email body"></textarea></label>
      <button class="btn small secondary">Check what the app reads</button>
    </form>
    ${p ? `<div class="sub" style="margin-top:8px;color:var(--ink-2)">${p.kind === 'availability'
      ? `Read as a <b>table alert</b>: ${esc(p.restaurantName || 'restaurant not matched (look it up first)')} · ${esc(p.dates.map((d) => shortDate(d)).join(', ') || 'no date found')} · ${esc(p.times.join(', ') || 'no time found')} · ${p.party ? `${p.party} people` : 'party not found'}${p.link ? ' · booking link found' : ''}`
      : `Ignored: ${esc(p.reason)}`}</div>` : ''}
  </details>`;
}

const onList = (id) => !!state.wishlist?.some((w) => w.restaurantId === id);
const prefsText = (w) => `${w.meals.map((m) => MEALS[m].label).join(' + ')} · ${DAY_GROUPS[w.days].label} · ${w.party} ${w.party === 1 ? 'person' : 'people'}${w.onlyFree ? ' · free dates only' : ''}`;

function checklist() {
  return notifyChecklist(state.wishlist || [], { busy: state.listBusy, marks: state.marks });
}

function listScreen() {
  if (!state.wishlist) return `<div class="head"><h1>My list</h1></div><div class="skeleton" style="height:120px"></div>`;
  const groups = checklist();
  const total = groups.reduce((n, g) => n + g.rows.length, 0);
  const done = groups.reduce((n, g) => n + g.done, 0);
  return `
  <div class="head"><span class="eyebrow">Table Planner</span><h1>My list</h1>
    <span class="sub">Restaurants you want to visit. Each is re-checked monthly, and you get a reminder on its release nights.</span></div>
  <div class="stack" style="gap:8px">
    <form class="row" data-form="list-add">
      <label class="field grow"><span class="sr">Restaurant name</span><input name="name" placeholder="Add a restaurant" autocomplete="off"></label>
      <button class="btn small" style="width:auto;padding:0 16px" ${state.adding ? 'disabled' : ''}>${state.adding ? 'Adding…' : 'Add'}</button>
    </form>
    ${state.adding ? '<div class="skeleton" style="height:64px"></div><div class="sub">Researching booking rules: 20–60 seconds.</div>' : ''}
    ${state.error ? `<div class="error" role="alert">${esc(state.error)}</div>` : ''}
    ${total ? `<a class="card" href="#/notify" style="text-decoration:none;color:inherit;display:block">
      <div class="row" style="justify-content:space-between"><b style="font-size:14px">Notify-me checklist</b><span class="sub">${done} of ${total} set →</span></div>
      <div class="progress" aria-hidden="true"><span style="width:${total ? Math.round((done / total) * 100) : 0}%"></span></div>
    </a>` : ''}
    ${groups.length ? groups.map((g) => {
      const r = g.restaurant, rel = r.release;
      const next = nextReleases(r, { meals: g.item.meals, days: g.item.days, count: 1 })[0];
      return `<div class="card">
        <div class="row" style="justify-content:space-between;align-items:baseline"><b style="font-size:15px">${esc(r.name)}</b><span class="sub">${esc(r.platform ? providerFor(r.platform).label : 'Platform unknown')}</span></div>
        <div class="sub" style="margin-top:2px">${esc(prefsText(g.item))}</div>
        <div class="tags">
          ${g.noOnline ? '<span class="tag later">No online booking: call</span>' : `<span class="tag go">${g.rows.length} date${g.rows.length === 1 ? '' : 's'} to watch</span>`}
          ${rel.pattern === 'rolling' ? `<span class="tag">${rel.daysAhead} days ahead</span>` : rel.pattern === 'monthly' ? `<span class="tag">Monthly release</span>` : '<span class="tag">Release rule unknown</span>'}
          ${next ? `<span class="tag later">Next release ${esc(shortDateTime(next.opensAt))}</span>` : ''}
        </div>
        <div class="row" style="gap:6px;margin-top:8px">
          <button type="button" class="btn small" data-action="open-planner" data-id="${esc(r.id)}">Dates</button>
          <button type="button" class="btn small secondary" data-action="use-find-settings" data-id="${esc(r.id)}" title="Use the meals, days and party currently set on Find">Use Find settings</button>
          <button type="button" class="btn small secondary" style="width:auto;padding:0 12px" data-action="remove-from-list" data-id="${esc(r.id)}" aria-label="Remove ${esc(r.name)}">✕</button>
        </div>
      </div>`;
    }).join('') : '<div class="card sub">Your list is empty. Add a restaurant above, or tap <b>＋ Add to my list</b> on Find.</div>'}
    ${state.flash ? `<div class="card" style="color:var(--go-ink)">${esc(state.flash)}</div>` : ''}
  </div>`;
}

function notifyScreen() {
  if (!state.wishlist) return `<div class="head"><h1>Notify-me checklist</h1></div><div class="skeleton" style="height:160px"></div>`;
  const groups = checklist();
  const fresh = (rid, date, meal) => state.inbox.find((a) => a.kind === 'availability' && a.restaurantId === rid && a.dates.includes(date) && (!a.meal || a.meal === meal));
  return `
  <div class="head"><a class="back" href="#/list">‹ My list</a><h1>Notify-me checklist</h1>
    <span class="sub">For each date: tap <b>Open</b>, then tap <b>Notify me</b> on OpenTable (or <b>Notify</b> on Resy), come back and tick it. When a table frees up, the platform emails you${state.inbox.length ? ' and it appears here as ⚡' : ''}.</span></div>
  ${groups.length ? groups.map((g) => `
    <div class="section">${esc(g.restaurant.name)} · ${g.done} of ${g.rows.length} set</div>
    <div class="list">
      ${g.noOnline ? `<div class="sub">No online booking listed. ${g.restaurant.phone ? `Call ${esc(g.restaurant.phone.number)}.` : 'Call or walk in.'}</div>`
        : g.rows.length ? g.rows.map((s) => {
          const hit = fresh(g.restaurant.id, s.date, s.meal);
          return `<div class="check-row ${s.set ? 'done' : ''}">
            <label><input type="checkbox" data-input="notify" data-key="${esc(s.key)}" ${s.set ? 'checked' : ''}>
              <span class="grow"><span class="when mono" style="font-weight:600">${esc(shortDate(s.date))}</span>
              <span class="sub"> · ${esc(s.mealLabel)} ${esc(s.start)}${hit ? ` · <b style="color:var(--alert-ink)">⚡ ${esc(hit.times.join(', ') || 'table free')}</b>` : ''}</span></span></label>
            <a class="open" href="${esc(hit?.link || s.link)}" target="_blank" rel="noopener noreferrer">${hit ? 'Book' : 'Open'}</a>
          </div>`;
        }).join('') : '<div class="sub">No bookable dates in the next 30 days that fit.</div>'}
    </div>
    ${g.laterCount ? `<div class="sub" style="margin:4px 2px 0">${g.laterCount} more date${g.laterCount === 1 ? '' : 's'} open later, the first on ${esc(shortDateTime(g.nextOpen))}. You'll get a reminder that night.</div>` : ''}
  `).join('') : '<div class="card sub">Add restaurants to <a href="#/list">My list</a> first.</div>'}
  <p class="notice" style="margin-top:12px">The app never taps Notify me for you: booking sites don't allow automated access, so each one is one tap by you.</p>`;
}

function tokenScreen() {
  const c = state.config;
  return `<div class="head"><span class="eyebrow">Table Planner</span><h1>Access token</h1></div>
  <form class="stack" data-form="token">
    <div class="sub">${c && !c.tokenConfigured ? 'The app has no APP_TOKEN yet. In Cloudflare: table-planner → Settings → Variables and Secrets → Add → Type: Secret, name APP_TOKEN (see SETUP.md).' : 'Enter the APP_TOKEN you set when deploying. It is stored on this device only.'}</div>
    <label class="field"><span class="sr">Token</span><input name="token" type="password" autocomplete="current-password" value=""></label>
    <button class="btn">Save</button>
  </form>`;
}

// ---------- render / routing ----------
function route() { return (location.hash.replace(/^#\/?/, '') || 'setup').split('?')[0]; }

function render() {
  const r = route();
  const screens = { setup: setupScreen, plan: planScreen, restaurant: restaurantScreen, alerts: alertsScreen, list: listScreen, notify: notifyScreen, token: tokenScreen };
  app.innerHTML = (screens[r] || setupScreen)();
  for (const a of document.querySelectorAll('.tabs a')) {
    const tab = a.dataset.tab;
    const current = tab === r || (tab === 'plan' && r === 'restaurant') || (tab === 'list' && r === 'notify');
    if (current) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  }
}

async function onRoute() {
  state.error = null; state.flash = null;
  const r = route();
  render();
  window.scrollTo(0, 0);
  if (r === 'plan' && state.restaurant) { await loadInbox(); await loadBusy(); }
  if (r === 'alerts') await loadPlans();
  if (r === 'list' || r === 'notify') { await Promise.all([loadWishlist(), loadInbox(), loadListBusy()]); render(); }
}

async function loadWishlist() {
  try { const d = await api('/api/wishlist'); state.wishlist = d.items; state.marks = d.notify; } catch (e) { state.wishlist = state.wishlist || []; state.error = e.message; }
}

async function loadListBusy() {
  if (!state.config?.features?.calendar) { state.listBusy = []; return; }
  try { const t = todayIn(); state.listBusy = (await api(`/api/busy?from=${t}&to=${addDays(t, 31)}`)).busy; } catch { state.listBusy = []; }
}

async function addToList(restaurantId) {
  const q = state.query;
  await api('/api/wishlist', { method: 'POST', body: { restaurantId, meals: q.meals, days: q.days, party: q.party, onlyFree: q.onlyFree && !!state.config?.features?.calendar } });
  await loadWishlist();
}

async function loadBusy() {
  const feats = state.config?.features || {};
  if (!feats.calendar) { state.busy = []; state.calendar = false; render(); return; }
  state.loadingDates = true; render();
  try {
    const today = todayIn();
    const data = await api(`/api/busy?from=${today}&to=${addDays(today, state.query.range)}`);
    state.busy = data.busy; state.calendar = data.calendar;
  } catch (e) { state.busy = []; state.calendar = false; state.flash = `Calendar not checked: ${e.message}`; }
  state.loadingDates = false; render();
}

async function loadInbox() {
  try { state.inbox = (await api('/api/inbox')).alerts; } catch { state.inbox = []; }
}

async function loadPlans() {
  try {
    const [data] = await Promise.all([api('/api/plans'), loadInbox()]);
    state.plans = data.plans; state.log = data.log;
  } catch (e) { state.plans = []; state.error = e.message; }
  render();
}

function saveQuery() { ls.set('tp.query', state.query); }
function setRestaurant(r) { state.restaurant = r; ls.set('tp.restaurant', r.id); }

async function research(name, force = false) {
  state.researching = true; state.error = null; state.suggestions = []; render();
  try {
    const data = await api('/api/research', { method: 'POST', body: { name, city: state.city, force, place: state.selectedPlace } });
    setRestaurant(data.restaurant);
    state.name = '';
    state.recent = (await api('/api/restaurants')).restaurants;
  } catch (e) { state.error = e.message; }
  state.researching = false; state.selectedPlace = null; render();
}

let suggestTimer;
app.addEventListener('input', (e) => {
  const k = e.target.dataset.input;
  if (!k) return;
  if (k === 'name') {
    state.name = e.target.value;
    state.selectedPlace = null;
    if (!state.config?.features?.places) return;
    clearTimeout(suggestTimer);
    suggestTimer = setTimeout(async () => {
      if (state.name.trim().length < 3) { state.suggestions = []; return render(); }
      try { state.suggestions = (await api(`/api/search?q=${encodeURIComponent(state.name)}&city=${encodeURIComponent(state.city)}`)).results; } catch { state.suggestions = []; }
      const pos = e.target.selectionStart; render();
      const input = app.querySelector('[data-input="name"]'); input?.focus(); input?.setSelectionRange(pos, pos);
    }, 450);
  }
  if (k === 'city') state.city = e.target.value;
});

app.addEventListener('change', (e) => {
  const k = e.target.dataset.input;
  if (k === 'range') { state.query.range = Number(e.target.value); saveQuery(); }
  if (k === 'onlyFree') { state.query.onlyFree = e.target.checked; saveQuery(); }
  if (k === 'notify') {
    const key = e.target.dataset.key, set = e.target.checked;
    if (set) state.marks[key] = new Date().toISOString(); else delete state.marks[key];
    render();
    api('/api/notify', { method: 'PUT', body: { key, set } }).then((d) => { state.marks = d.notify; }).catch((err) => { state.error = err.message; render(); });
  }
});

app.addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target.dataset.form;
  const data = Object.fromEntries(new FormData(e.target));
  if (f === 'lookup' && data.name.trim()) research(data.name.trim());
  if (f === 'list-add' && data.name.trim()) {
    state.adding = true; state.error = null; state.flash = null; render();
    try {
      const res = await api('/api/research', { method: 'POST', body: { name: data.name.trim(), city: state.city } });
      await addToList(res.restaurant.id);
      state.flash = `Added ${res.restaurant.name}, using your Find settings (${prefsText(state.wishlist.find((w) => w.restaurantId === res.restaurant.id))}).`;
    } catch (err) { state.error = err.message; }
    state.adding = false; return render();
  }
  if (f === 'token') {
    state.token = data.token.trim(); ls.set('tp.token', state.token);
    await boot(); location.hash = '#/';
  }
  if (f === 'preview') {
    try {
      state.preview = (await api('/api/inbox/preview', { method: 'POST', body: { from: data.from, subject: data.subject, date: new Date().toISOString(), text: data.body, html: data.body } })).alert;
    } catch (err) { state.error = err.message; }
    return render();
  }
  if (f === 'correct') {
    try {
      const res = await api(`/api/restaurants/${state.restaurant.id}/release`, { method: 'PUT', body: data });
      setRestaurant(res.restaurant); state.correcting = false;
    } catch (err) { state.error = err.message; }
    render();
  }
});

app.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  const a = el.dataset.action;
  const q = state.query;
  if (a === 'need-restaurant') { e.preventDefault(); state.error = 'Look up a restaurant first.'; return render(); }
  if (a === 'meal') {
    const m = el.dataset.meal;
    q.meals = q.meals.includes(m) ? q.meals.filter((x) => x !== m) : [...q.meals, m];
    if (!q.meals.length) q.meals = [m];
  }
  if (a === 'days') q.days = el.dataset.days;
  if (a === 'party') q.party = Math.min(20, Math.max(1, q.party + Number(el.dataset.d)));
  if (['meal', 'days', 'party'].includes(a)) { saveQuery(); return render(); }
  if (a === 'pick-place') {
    const p = state.suggestions[Number(el.dataset.i)];
    state.selectedPlace = p; state.name = p.name;
    return research(p.name);
  }
  if (a === 'open-recent') {
    try { setRestaurant((await api(`/api/restaurants/${el.dataset.id}`)).restaurant); } catch (err) { state.error = err.message; }
    return render();
  }
  if (a === 'add-to-list') {
    try { await addToList(state.restaurant.id); } catch (err) { state.error = err.message; }
    return render();
  }
  if (a === 'remove-from-list') {
    await api(`/api/wishlist/${el.dataset.id}`, { method: 'DELETE' }).catch(() => {});
    await loadWishlist(); return render();
  }
  if (a === 'use-find-settings') {
    try { await addToList(el.dataset.id); state.flash = 'Updated to your current Find settings.'; } catch (err) { state.error = err.message; }
    return render();
  }
  if (a === 'open-planner') {
    const w = state.wishlist.find((x) => x.restaurantId === el.dataset.id);
    if (w) { setRestaurant(w.restaurant); Object.assign(q, { meals: w.meals, days: w.days, party: w.party }); saveQuery(); }
    location.hash = '#/plan'; return;
  }
  if (a === 'recheck') { await research(state.restaurant.name, true); return; }
  if (a === 'show-correct') { state.correcting = !state.correcting; return render(); }
  if (a === 'csv') {
    const blob = new Blob([slotsToCsv(state.lastSlots || [])], { type: 'text/csv' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `${state.restaurant.id}-${todayIn()}.csv`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
    return;
  }
  if (a === 'watch') {
    try {
      const res = await api('/api/plans', { method: 'POST', body: { restaurantId: state.restaurant.id, meals: q.meals, days: q.days, party: q.party, onlyFree: q.onlyFree && state.calendar } });
      const on = (state.config?.channels || []).some((c) => c.enabled);
      state.flash = res.existing ? 'Already watching these dates.' : `Watching. ${on ? "You'll get an alert when each new date opens." : 'Set up an alert channel to receive alerts (see Alerts).'}`;
    } catch (err) { state.flash = err.message; }
    return render();
  }
  if (a === 'unwatch') {
    await api(`/api/plans/${el.dataset.id}`, { method: 'DELETE' }).catch(() => {});
    return loadPlans();
  }
  if (a === 'copy-script') {
    try {
      const src = await (await fetch('/gmail-forwarder.gs')).text();
      await navigator.clipboard.writeText(src.replace('__APP_URL__', location.origin).replace('__APP_TOKEN__', state.token));
      state.flash = 'Script copied, with your address and token filled in. Paste it into script.google.com (steps above).';
    } catch { state.flash = 'Copy failed. Open /gmail-forwarder.gs and fill in the two values by hand.'; }
    return render();
  }
  if (a === 'test-alert') {
    try {
      const res = await api('/api/alerts/test', { method: 'POST' });
      state.flash = res.results.map((x) => `${x.channel}: ${x.ok ? 'sent' : x.error}`).join(' · ') || 'No channel set up.';
    } catch (err) { state.error = err.message; }
    return render();
  }
});

async function boot() {
  try {
    state.config = await (await fetch('/api/config', { headers: { 'x-app-token': state.token } })).json();
  } catch { state.config = null; }
  if (!state.config?.authorised) { location.hash = '#/token'; render(); return; }
  try {
    state.recent = (await api('/api/restaurants')).restaurants;
    const last = ls.get('tp.restaurant', null);
    if (last && !state.restaurant) state.restaurant = (await api(`/api/restaurants/${last}`)).restaurant;
    await loadWishlist();
  } catch { /* first run */ }
  if (!state.config.features.calendar) state.query.onlyFree = false;
}

window.addEventListener('hashchange', onRoute);
boot().then(onRoute);
