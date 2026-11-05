// Time-zone and calendar-date helpers. Dates are 'YYYY-MM-DD' strings;
// instants are epoch milliseconds. Works in browsers, Workers and Node.

export const LONDON = 'Europe/London';
export const DOW_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
export const DOW_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAY_MS = 86400000;

const fmtCache = new Map();
function formatter(tz) {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-GB', {
      timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    fmtCache.set(tz, f);
  }
  return f;
}

/** Wall-clock parts of an instant in a zone. */
export function zonedParts(ms, tz = LONDON) {
  const p = {};
  for (const { type, value } of formatter(tz).formatToParts(new Date(ms))) p[type] = value;
  return { y: +p.year, m: +p.month, d: +p.day, hh: +p.hour % 24, mm: +p.minute, ss: +p.second };
}

function offsetMs(ms, tz) {
  const p = zonedParts(ms, tz);
  return Date.UTC(p.y, p.m - 1, p.d, p.hh, p.mm, p.ss) - Math.floor(ms / 1000) * 1000;
}

/** Instant for a wall-clock time in a zone (handles GMT/BST). */
export function zonedToUtc(dateIso, time = '00:00', tz = LONDON) {
  const [y, m, d] = dateIso.split('-').map(Number);
  const [hh, mm] = time.split(':').map(Number);
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  const off1 = offsetMs(guess, tz);
  let t = guess - off1;
  const off2 = offsetMs(t, tz);
  if (off2 !== off1) t = guess - off2;
  return t;
}

export function isoOf(y, m, d) {
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

export function todayIn(now = Date.now(), tz = LONDON) {
  const p = zonedParts(now, tz);
  return isoOf(p.y, p.m, p.d);
}

export function addDays(dateIso, n) {
  const [y, m, d] = dateIso.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d) + n * DAY_MS);
  return isoOf(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
}

export function addMonths(dateIso, n) {
  const [y, m, d] = dateIso.split('-').map(Number);
  const total = y * 12 + (m - 1) + n;
  const ny = Math.floor(total / 12), nm = (total % 12) + 1;
  const last = new Date(Date.UTC(ny, nm, 0)).getUTCDate();
  return isoOf(ny, nm, Math.min(d, last));
}

export function dowOf(dateIso) {
  const [y, m, d] = dateIso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

export function daysBetween(aIso, bIso) {
  const a = Date.UTC(...aIso.split('-').map((v, i) => (i === 1 ? v - 1 : +v)));
  const b = Date.UTC(...bIso.split('-').map((v, i) => (i === 1 ? v - 1 : +v)));
  return Math.round((b - a) / DAY_MS);
}

export function eachDate(fromIso, toIso) {
  const out = [];
  for (let d = fromIso; d <= toIso; d = addDays(d, 1)) out.push(d);
  return out;
}

/** "Tue 8 Dec" */
export function shortDate(dateIso) {
  const [, m, d] = dateIso.split('-').map(Number);
  return `${DOW_SHORT[dowOf(dateIso)]} ${d} ${MONTHS[m - 1]}`;
}

/** "Sun 8 Nov, 00:00" for an instant, in London time. */
export function shortDateTime(ms, tz = LONDON) {
  const p = zonedParts(ms, tz);
  const iso = isoOf(p.y, p.m, p.d);
  return `${shortDate(iso)}, ${String(p.hh).padStart(2, '0')}:${String(p.mm).padStart(2, '0')}`;
}

export function toMinutes(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

export function fromMinutes(mins) {
  return `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;
}
