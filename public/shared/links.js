// Booking-platform "providers": each one turns a restaurant's booking page
// into a pre-filled link for a date, time and party size. Links only open
// the platform's own page in your browser; nothing here fetches it.
//
// `verified: true` means the query parameters have been checked against the
// live site. Unverified providers still open the right restaurant page; the
// date and party may just need setting by hand.

export const PROVIDERS = {
  opentable: {
    label: 'OpenTable',
    verified: true,
    match: /(^|\.)opentable\.[a-z.]+$/,
    link(base, { date, time, party }) {
      const u = new URL(base);
      u.searchParams.set('covers', String(party));
      u.searchParams.set('dateTime', `${date}T${time}`);
      return u.toString();
    },
  },
  resy: {
    label: 'Resy',
    verified: false,
    match: /(^|\.)resy\.com$/,
    link(base, { date, party }) {
      const u = new URL(base);
      u.searchParams.set('date', date);
      u.searchParams.set('seats', String(party));
      return u.toString();
    },
  },
  sevenrooms: {
    label: 'SevenRooms',
    verified: false,
    match: /(^|\.)sevenrooms\.com$/,
    link(base, { date, party }) {
      const u = new URL(base);
      u.searchParams.set('date', date);
      u.searchParams.set('party_size', String(party));
      return u.toString();
    },
  },
  tock: {
    label: 'Tock',
    verified: false,
    match: /(^|\.)exploretock\.com$/,
    link(base, { date, time, party }) {
      const u = new URL(base);
      u.searchParams.set('date', date);
      u.searchParams.set('size', String(party));
      u.searchParams.set('time', time);
      return u.toString();
    },
  },
  designmynight: {
    label: 'DesignMyNight',
    verified: false,
    match: /(^|\.)designmynight\.com$/,
    link: (base) => base,
  },
  other: {
    label: 'Restaurant website',
    verified: false,
    match: null,
    link: (base) => base,
  },
};

/**
 * Link to the restaurant on Google Maps, where "Reserve a table" shows
 * Google's own slot picker. Uses the documented Maps URLs format
 * (https://developers.google.com/maps/documentation/urls/get-started).
 * Google doesn't accept a date in the link, so you pick it there.
 */
export function googleMapsLink(restaurant) {
  if (!restaurant?.name) return null;
  const u = new URL('https://www.google.com/maps/search/');
  u.searchParams.set('api', '1');
  u.searchParams.set('query', [restaurant.name, restaurant.address || restaurant.area || restaurant.city].filter(Boolean).join(', '));
  if (restaurant.placeId) u.searchParams.set('query_place_id', restaurant.placeId);
  return u.toString();
}

export function detectPlatform(url) {
  if (!url) return null;
  let host;
  try { host = new URL(url).hostname.toLowerCase(); } catch { return null; }
  for (const [key, p] of Object.entries(PROVIDERS)) if (p.match && p.match.test(host)) return key;
  return 'other';
}

export function providerFor(key) {
  return PROVIDERS[key] || PROVIDERS.other;
}

/** Pre-filled booking link, or null when the restaurant has no booking URL. */
export function bookingLink(restaurant, { date, time, party }) {
  const base = restaurant?.bookingUrl || restaurant?.website;
  if (!base) return null;
  const key = restaurant.bookingUrl ? (restaurant.platform || detectPlatform(base)) : 'other';
  try {
    return providerFor(key).link(base, { date, time, party });
  } catch {
    return base;
  }
}
