// Reads booking-platform alert emails ("a table is now available") that
// your Gmail forwards to the app, and turns them into structured alerts.
//
// Template-agnostic on purpose: it doesn't depend on any one email layout.
// It identifies the platform by sender, the restaurant by matching your
// saved restaurants' names, and pulls dates, times, party size and the
// platform's own booking link from the text. Anything it can't find is
// left empty rather than guessed.

import { LONDON, addDays, isoOf, todayIn } from '../public/shared/tz.js';

const PLATFORM_SENDERS = [
  ['opentable', /(^|[.@])opentable\.[a-z.]+$/],
  ['resy', /(^|[.@])resy\.com$/],
  ['sevenrooms', /(^|[.@])sevenrooms\.com$/],
  ['tock', /(^|[.@])(exploretock|tock)\.com$/],
  ['designmynight', /(^|[.@])designmynight\.com$/],
  ['deliveroo', /(^|[.@])deliveroo\.[a-z.]+$/],
];

const AVAILABLE = /\b(is|are|has|have|just)?\s*(now\s+)?(available|opened up|open(ed)? up|become available|became available|freed up)\b|\bgood news\b|\bavailability alert\b|\bnotify me\b|\byou asked (us )?to (be )?(notified|let you know)\b|\bspot(s)? (opened|available)\b/i;
const OWN_BOOKING = /\b(is confirmed|has been confirmed|confirmation (number|code)|booking reference|has been cancel+ed|we look forward to (seeing|welcoming) you|your (reservation|booking) (is|has been) (confirmed|modified|updated|cancel+ed)|rate your (meal|visit|experience)|leave a review|receipt)\b/i;

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
const MONTH_RE = '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';

export function senderDomain(from) {
  const m = /<([^>]+)>/.exec(from || '') || /([^\s<>]+@[^\s<>]+)/.exec(from || '');
  const addr = (m ? m[1] : from || '').trim().toLowerCase();
  return addr.includes('@') ? addr.split('@').pop() : null;
}

export function platformOf(from) {
  const d = senderDomain(from);
  if (!d) return null;
  for (const [key, re] of PLATFORM_SENDERS) if (re.test(d) || re.test(`@${d}`)) return key;
  return null;
}

export function htmlToText(html) {
  return String(html || '')
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>|<\/(p|div|tr|li|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#39;|&rsquo;/g, "'").replace(/&quot;/g, '"')
    .replace(/[ \t]+/g, ' ');
}

const norm = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();

/** The saved restaurant whose name appears in the email (longest wins). */
export function matchRestaurant(text, restaurants) {
  const hay = ` ${norm(text)} `;
  let best = null;
  for (const r of restaurants || []) {
    const n = norm(r.name);
    if (n.length >= 3 && hay.includes(` ${n} `) && (!best || n.length > norm(best.name).length)) best = r;
  }
  return best;
}

/** Calendar dates mentioned in the text, resolved against the email's date. */
export function findDates(text, sentMs, tz = LONDON) {
  const today = todayIn(sentMs, tz);
  const [ty] = today.split('-').map(Number);
  const out = new Set();
  const resolve = (d, m, y) => {
    if (!(m >= 1 && m <= 12 && d >= 1 && d <= 31)) return;
    if (d > new Date(Date.UTC(y || ty, m, 0)).getUTCDate()) return;
    let iso = isoOf(y || ty, m, d);
    if (!y && iso < addDays(today, -1)) iso = isoOf(ty + 1, m, d);
    if (iso >= addDays(today, -1) && iso <= addDays(today, 400)) out.add(iso);
  };
  const t = text.replace(/\s+/g, ' ');
  for (const m of t.matchAll(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?(?: of)? ${MONTH_RE}\\.?(?:,? (\\d{4}))?\\b`, 'gi'))) {
    resolve(+m[1], MONTHS[m[2].toLowerCase().slice(0, 4)] || MONTHS[m[2].toLowerCase().slice(0, 3)], m[3] ? +m[3] : null);
  }
  for (const m of t.matchAll(new RegExp(`\\b${MONTH_RE}\\.? (\\d{1,2})(?:st|nd|rd|th)?\\b(?:,? (\\d{4}))?`, 'gi'))) {
    resolve(+m[2], MONTHS[m[1].toLowerCase().slice(0, 4)] || MONTHS[m[1].toLowerCase().slice(0, 3)], m[3] ? +m[3] : null);
  }
  for (const m of t.matchAll(/\b(20\d{2})-(\d{2})-(\d{2})\b/g)) resolve(+m[3], +m[2], +m[1]);
  if (/\b(today|tonight)\b/i.test(t)) out.add(today);
  if (/\btomorrow\b/i.test(t)) out.add(addDays(today, 1));
  return [...out].sort();
}

/** Times like 20:15, 8:15 PM, 8pm → "HH:MM", within dining hours. */
export function findTimes(text) {
  const out = new Set();
  const add = (h, m, ap) => {
    let hh = +h;
    if (ap) { const pm = /p/i.test(ap); if (hh === 12) hh = pm ? 12 : 0; else if (pm) hh += 12; }
    if (hh >= 7 && hh <= 23 && +m < 60) out.add(`${String(hh).padStart(2, '0')}:${String(m).padStart(2, '0')}`);
  };
  for (const m of text.matchAll(/\b([01]?\d|2[0-3])[:.]([0-5]\d)\s*([ap]\.?m\.?)?(?![\d:])/gi)) add(m[1], m[2], m[3]);
  for (const m of text.matchAll(/\b(1[0-2]|[1-9])\s*([ap]\.?m\.?)(?![a-z])/gi)) add(m[1], 0, m[2]);
  return [...out].sort();
}

export function findParty(text) {
  const m = /\b(?:party of|table for|for a party of)\s+(\d{1,2})\b/i.exec(text)
    || /\b(\d{1,2})\s+(?:people|guests|diners|covers|persons|ppl)\b/i.exec(text)
    || /\bfor (\d{1,2})\b(?! (?:minutes|hours|days|nights|weeks|months))/i.exec(text);
  const n = m ? +m[1] : null;
  return n && n >= 1 && n <= 20 ? n : null;
}

/** The platform's own booking link from the email HTML, if it's on that platform's domain. */
export function findLink(html, platform) {
  const re = PLATFORM_SENDERS.find(([k]) => k === platform)?.[1];
  if (!re) return null;
  const links = [];
  for (const m of String(html || '').matchAll(/href\s*=\s*["']([^"']+)["']/gi)) {
    const href = m[1].replace(/&amp;/g, '&').trim();
    let u;
    try { u = new URL(href); } catch { continue; }
    if (u.protocol !== 'https:' || !re.test(u.hostname.toLowerCase())) continue;
    if (/unsubscribe|preferences|privacy|terms|help|facebook|instagram|twitter|app-?store|play\.google/i.test(href)) continue;
    links.push(u.toString());
  }
  return links.find((l) => /book|reserv|\/r\/|venues|restaurant|availability|slot/i.test(l)) || links[0] || null;
}

export function mealForTime(hhmm) {
  if (!hhmm) return null;
  const h = +hhmm.slice(0, 2);
  return h < 11 ? 'breakfast' : h < 16 ? 'lunch' : 'dinner';
}

/**
 * Parse one forwarded email. `restaurants` = your saved restaurants
 * [{ id, name }]. Returns kind 'availability' or 'ignored' (with a reason).
 */
export function parseAlertEmail(email, restaurants = []) {
  const sentMs = Date.parse(email.date) || Date.now();
  const platform = platformOf(email.from);
  const text = [email.subject, email.text || htmlToText(email.html)].filter(Boolean).join('\n');
  const base = { id: String(email.id || ''), receivedAt: new Date(sentMs).toISOString(), platform, subject: String(email.subject || '').slice(0, 200) };
  if (!platform) return { ...base, kind: 'ignored', reason: 'Not from a booking platform' };
  if (OWN_BOOKING.test(text) && !/\bnotify\b|availability alert/i.test(email.subject || '')) {
    return { ...base, kind: 'ignored', reason: 'Looks like a booking confirmation, change or receipt' };
  }
  if (!AVAILABLE.test(text)) return { ...base, kind: 'ignored', reason: 'No "table available" wording found' };
  const r = matchRestaurant(text, restaurants);
  const times = findTimes(text);
  return {
    ...base,
    kind: 'availability',
    restaurantId: r?.id || null,
    restaurantName: r?.name || null,
    dates: findDates(text, sentMs),
    times,
    meal: mealForTime(times[0]),
    party: findParty(text),
    link: findLink(email.html, platform),
  };
}
