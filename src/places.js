// Optional Google Places (New) lookup: restaurant search suggestions and
// opening hours. Only used when GOOGLE_PLACES_API_KEY is set.

import { googleMapsLink } from '../public/shared/links.js';

const FIELDS = [
  'places.id', 'places.displayName', 'places.formattedAddress', 'places.websiteUri',
  'places.regularOpeningHours', 'places.nationalPhoneNumber', 'places.reservable',
  'places.servesBreakfast', 'places.servesLunch', 'places.servesDinner',
].join(',');

const DAY = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const pad = (n) => String(n ?? 0).padStart(2, '0');

/** Places `regularOpeningHours.periods` -> { mon: [["12:00","15:00"], ...] } */
export function periodsToHours(periods) {
  if (!Array.isArray(periods) || !periods.length) return null;
  const out = {};
  for (const p of periods) {
    if (!p.open) continue;
    const day = DAY[p.open.day];
    const start = `${pad(p.open.hour)}:${pad(p.open.minute)}`;
    const end = p.close ? `${pad(p.close.hour)}:${pad(p.close.minute)}` : '23:59';
    (out[day] ||= []).push([start, end]);
  }
  for (const d of Object.keys(out)) out[d].sort((a, b) => a[0].localeCompare(b[0]));
  return Object.keys(out).length ? out : null;
}

export function mapPlace(p) {
  return {
    placeId: p.id,
    name: p.displayName?.text || '',
    address: p.formattedAddress || null,
    website: p.websiteUri || null,
    phone: p.nationalPhoneNumber || null,
    reservable: p.reservable ?? null,
    serves: { breakfast: p.servesBreakfast ?? null, lunch: p.servesLunch ?? null, dinner: p.servesDinner ?? null },
    hours: periodsToHours(p.regularOpeningHours?.periods),
  };
}

export async function searchPlaces(query, { apiKey, city = 'London', fetchImpl = fetch } = {}) {
  const res = await fetchImpl('https://places.googleapis.com/v1/places:searchText', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': apiKey, 'X-Goog-FieldMask': FIELDS },
    body: JSON.stringify({ textQuery: `${query} restaurant ${city}`, regionCode: 'GB', maxResultCount: 5 }),
  });
  if (!res.ok) throw new Error(`Places search failed (${res.status})`);
  const data = await res.json();
  return (data.places || []).map(mapPlace);
}

/**
 * Fill gaps in a researched profile from a Places result: full weekly
 * opening hours (Google lists every day, so they count as complete).
 */
export function mergePlace(profile, place) {
  if (!place) return profile;
  const out = { ...profile, placeId: place.placeId, address: place.address || profile.area };
  if (place.reservable != null) {
    out.reservable = place.reservable;
    out.facts = [...(out.facts || profile.facts).filter((f) => f.label !== 'Online booking'), {
      label: 'Online booking', value: place.reservable ? 'Takes reservations (Google)' : 'No reservations listed on Google: call or walk in',
      confidence: 'high', sources: [{ url: googleMapsLink(out), title: 'Google Maps' }],
    }];
  }
  if (!profile.website && place.website) out.website = place.website;
  if (place.hours && (!profile.hours || profile.hours.confidence !== 'high')) {
    out.hours = { value: place.hours, complete: true, confidence: 'high', source: 'google' };
    out.facts = [...(out.facts || profile.facts).filter((f) => f.label !== 'Opening hours'), {
      label: 'Opening hours', value: 'From Google Maps', confidence: 'high',
      sources: [{ url: googleMapsLink(out), title: 'Google Maps' }],
    }];
  }
  return out;
}

const norm = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();

/** The search result that is clearly the named restaurant, or null. */
export function bestMatch(name, results) {
  const want = norm(name);
  if (!want) return null;
  return (results || []).find((p) => {
    const got = norm(p.name);
    return got && (got === want || got.startsWith(want) || want.startsWith(got));
  }) || null;
}
