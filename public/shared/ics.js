// Minimal iCalendar reader for "am I free?" checks against a private
// calendar feed (e.g. Google Calendar's "secret address in iCal format").
// Supports single events, all-day events, TZID times, DURATION, EXDATE,
// RECURRENCE-ID overrides and RRULE (DAILY, WEEKLY+BYDAY, MONTHLY by day
// or nth weekday, YEARLY) with INTERVAL / COUNT / UNTIL.
// Free/transparent and cancelled events never count as busy.

import { LONDON, addDays, addMonths, dowOf, isoOf, zonedToUtc } from './tz.js';

const BYDAY = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };

function unfold(text) {
  return text.replace(/\r\n/g, '\n').replace(/\n[ \t]/g, '').split('\n');
}

function parseLine(line) {
  const colon = line.indexOf(':');
  if (colon < 0) return null;
  const left = line.slice(0, colon);
  const value = line.slice(colon + 1);
  const [name, ...paramParts] = left.split(';');
  const params = {};
  for (const p of paramParts) {
    const [k, v] = p.split('=');
    if (k) params[k.toUpperCase()] = (v || '').replace(/^"|"$/g, '');
  }
  return { name: name.toUpperCase(), params, value };
}

/** Parse an ICS date/date-time into { ms, allDay, date, time, tz }. */
export function parseIcsDate(value, params = {}, defaultTz = LONDON) {
  const v = value.trim();
  const dm = /^(\d{4})(\d{2})(\d{2})$/.exec(v);
  if (dm || params.VALUE === 'DATE') {
    const [, y, m, d] = dm || /^(\d{4})(\d{2})(\d{2})/.exec(v);
    const date = `${y}-${m}-${d}`;
    return { ms: zonedToUtc(date, '00:00', defaultTz), allDay: true, date, time: '00:00', tz: defaultTz };
  }
  const tm = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})?(Z?)$/.exec(v);
  if (!tm) return null;
  const [, y, m, d, hh, mi, , z] = tm;
  const date = `${y}-${m}-${d}`, time = `${hh}:${mi}`;
  if (z) {
    const ms = Date.UTC(+y, +m - 1, +d, +hh, +mi, 0);
    return { ms, allDay: false, date, time, tz: 'UTC' };
  }
  const tz = params.TZID || defaultTz;
  let ms;
  try { ms = zonedToUtc(date, time, tz); } catch { ms = zonedToUtc(date, time, defaultTz); }
  return { ms, allDay: false, date, time, tz };
}

function parseDuration(v) {
  const m = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(v.trim());
  if (!m) return 0;
  const [, sign, w, d, h, mi, s] = m;
  const ms = ((+w || 0) * 7 * 86400 + (+d || 0) * 86400 + (+h || 0) * 3600 + (+mi || 0) * 60 + (+s || 0)) * 1000;
  return sign === '-' ? -ms : ms;
}

function parseRrule(v) {
  const r = {};
  for (const part of v.split(';')) {
    const [k, val] = part.split('=');
    if (k) r[k.toUpperCase()] = val;
  }
  return r;
}

/** Parse VEVENTs from ICS text. */
export function parseIcs(text, defaultTz = LONDON) {
  const events = [];
  let cur = null;
  for (const raw of unfold(text)) {
    if (raw === 'BEGIN:VEVENT') { cur = { exdates: [] }; continue; }
    if (raw === 'END:VEVENT') { if (cur?.start) events.push(cur); cur = null; continue; }
    if (!cur) continue;
    const l = parseLine(raw);
    if (!l) continue;
    switch (l.name) {
      case 'UID': cur.uid = l.value; break;
      case 'SUMMARY': cur.summary = l.value.replace(/\\,/g, ',').replace(/\\;/g, ';').replace(/\\n/gi, ' '); break;
      case 'DTSTART': cur.start = parseIcsDate(l.value, l.params, defaultTz); break;
      case 'DTEND': cur.end = parseIcsDate(l.value, l.params, defaultTz); break;
      case 'DURATION': cur.duration = parseDuration(l.value); break;
      case 'TRANSP': cur.transparent = l.value.trim().toUpperCase() === 'TRANSPARENT'; break;
      case 'STATUS': cur.cancelled = l.value.trim().toUpperCase() === 'CANCELLED'; break;
      case 'RRULE': cur.rrule = parseRrule(l.value); break;
      case 'EXDATE':
        for (const v of l.value.split(',')) {
          const p = parseIcsDate(v, l.params, defaultTz);
          if (p) cur.exdates.push(p.ms);
        }
        break;
      case 'RECURRENCE-ID': cur.recurrenceId = parseIcsDate(l.value, l.params, defaultTz)?.ms; break;
      default: break;
    }
  }
  return events;
}

function eventLength(ev) {
  if (ev.end) return ev.end.ms - ev.start.ms;
  if (ev.duration) return ev.duration;
  return ev.start.allDay ? 86400000 : 0;
}

function nthWeekday(y, m, dow, n) {
  if (n > 0) {
    const first = dowOf(isoOf(y, m, 1));
    const day = 1 + ((dow - first + 7) % 7) + (n - 1) * 7;
    const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
    return day <= last ? isoOf(y, m, day) : null;
  }
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const lastDow = dowOf(isoOf(y, m, lastDay));
  const day = lastDay - ((lastDow - dow + 7) % 7) + (n + 1) * 7;
  return day >= 1 ? isoOf(y, m, day) : null;
}

/** Local start dates for a recurring event, in order, up to `untilMs`. */
function occurrenceDates(ev, untilMs) {
  const r = ev.rrule;
  const freq = r.FREQ;
  const interval = Math.max(1, +r.INTERVAL || 1);
  const count = r.COUNT ? +r.COUNT : Infinity;
  const until = r.UNTIL ? parseIcsDate(r.UNTIL, {}, ev.start.tz === 'UTC' ? 'UTC' : ev.start.tz).ms : Infinity;
  const tz = ev.start.tz;
  const time = ev.start.time;
  // Work in the event's own wall-clock zone so 19:00 stays 19:00 across DST.
  const startLocal = ev.start.date;
  const out = [];
  const push = (date) => {
    const ms = tz === 'UTC' ? Date.parse(`${date}T${time}:00Z`) : zonedToUtc(date, time, tz);
    if (ms < ev.start.ms) return true;
    if (ms > until || ms > untilMs || out.length >= count) return false;
    out.push(ms);
    return true;
  };
  const byday = (r.BYDAY || '').split(',').filter(Boolean);
  let guard = 0;
  if (freq === 'DAILY') {
    for (let d = startLocal; guard++ < 5000; d = addDays(d, interval)) if (!push(d)) break;
  } else if (freq === 'WEEKLY') {
    const days = byday.length ? byday.map((b) => BYDAY[b.slice(-2)]).sort() : [dowOf(startLocal)];
    let weekStart = addDays(startLocal, -dowOf(startLocal));
    outer: for (; guard++ < 2000; weekStart = addDays(weekStart, 7 * interval)) {
      for (const dw of days) if (!push(addDays(weekStart, dw))) break outer;
    }
  } else if (freq === 'MONTHLY') {
    const [sy, sm, sd] = startLocal.split('-').map(Number);
    const rules = byday.map((b) => ({ n: parseInt(b, 10) || 1, dow: BYDAY[b.slice(-2)] }));
    outer: for (let i = 0; guard++ < 1000; i += interval) {
      const first = addMonths(isoOf(sy, sm, 1), i);
      const [y, m] = first.split('-').map(Number);
      const dates = rules.length
        ? rules.map((x) => nthWeekday(y, m, x.dow, x.n)).filter(Boolean).sort()
        : [(r.BYMONTHDAY ? +r.BYMONTHDAY : sd) <= new Date(Date.UTC(y, m, 0)).getUTCDate()
          ? isoOf(y, m, r.BYMONTHDAY ? +r.BYMONTHDAY : sd) : null].filter(Boolean);
      for (const d of dates) if (!push(d)) break outer;
    }
  } else if (freq === 'YEARLY') {
    for (let i = 0; guard++ < 200; i += interval) if (!push(addMonths(startLocal, 12 * i))) break;
  } else {
    push(startLocal);
  }
  return out;
}

/**
 * Busy intervals overlapping [fromMs, toMs]: [{ start, end, title }].
 */
export function busyIntervals(events, fromMs, toMs) {
  const overridden = new Map();
  for (const ev of events) {
    if (ev.recurrenceId != null && ev.uid) {
      if (!overridden.has(ev.uid)) overridden.set(ev.uid, new Set());
      overridden.get(ev.uid).add(ev.recurrenceId);
    }
  }
  const out = [];
  for (const ev of events) {
    const len = eventLength(ev);
    const starts = ev.rrule && ev.recurrenceId == null ? occurrenceDates(ev, toMs) : [ev.start.ms];
    const skip = new Set([...(ev.exdates || []), ...(ev.rrule ? overridden.get(ev.uid) || [] : [])]);
    if (ev.transparent || ev.cancelled) continue;
    for (const s of starts) {
      if (skip.has(s)) continue;
      const e = s + len;
      if (e > fromMs && s < toMs) out.push({ start: s, end: e, title: ev.summary || 'Busy' });
    }
  }
  return out.sort((a, b) => a.start - b.start);
}
