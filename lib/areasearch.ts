/**
 * Map-area search: the platform-neutral query contract.
 *
 * The search page turns a drawn circle into an `AreaSearchQuery`; the worker
 * validates it and hands it to a site adapter's `buildSearchUrl` — the worker
 * never accepts a URL from a page, so the search fetch cannot be used as a
 * fetch-anything proxy (ROADMAP P1's rule for any URL a page supplies).
 *
 * Deliberately platform-free: latitude/longitude/radius/dates/occupancy are
 * how a human describes an area stay, not how any one site spells its query
 * string. Platform spelling lives in `lib/sites/<site>/searchresults.ts`.
 */

/**
 * Accommodation categories a user can filter a search to, in OUR neutral
 * vocabulary — each site adapter maps these to its own filter dialect (for
 * Booking: `ht_id` codes read from the live filter sidebar). Neutral so the
 * page and the message protocol never learn a platform's numbering.
 */
export const SEARCH_CATEGORIES = [
  'hotel',
  'apartment',
  'holiday-home',
  'villa',
  'guesthouse',
  'bnb',
  'hostel',
  'resort',
  'chalet',
  'campground',
] as const;

export type SearchCategory = (typeof SEARCH_CATEGORIES)[number];

export interface AreaSearchQuery {
  latitude: number;
  longitude: number;
  /** Search radius in km around the point. */
  radiusKm: number;
  /** ISO `YYYY-MM-DD`; both or neither. Dated searches carry live rate cards. */
  checkin?: string;
  checkout?: string;
  adults: number;
  rooms: number;
  children: number;
  /** Restrict to these categories; absent = every type. Never empty when present. */
  categories?: SearchCategory[];
  /**
   * Ask the platform to order the page by price. Without it platforms tend
   * to return the results NEAREST the centre — 25 proximity-sorted cards
   * cover a fraction of a wide box, which reads as "it only searched the
   * middle". Price order spreads one page across the whole radius.
   */
  sortHint?: 'price';
  /**
   * UI language code (ours, from lib/i18n/languages.ts) so the platform can
   * localize its own card text — distances, addresses. '' never appears
   * here; an English UI simply omits the field.
   */
  language?: string;
}

/**
 * A circle drawn on the map: a centre in degrees and a radius in km.
 *
 * The same three numbers the query carries, deliberately. The page used to
 * draw a RECTANGLE and this module converted it to centre + half-diagonal,
 * so the area actually searched was never the area drawn — the circle bulged
 * past the edges of the box, and results the user had no reason to expect
 * arrived from outside it. The platform's search is natively a centre and a
 * radius, so the drawn shape is one too: what you see is what is queried.
 */
export interface SearchCircle {
  latitude: number;
  longitude: number;
  radiusKm: number;
}

/**
 * Bounds keep a hostile or buggy page from asking the worker to search the
 * planet. The radius cap matches the interactive promise in ROADMAP ("volume
 * should stay interactive"): one search covers a town, not a country.
 */
export const MAX_RADIUS_KM = 60;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Generous occupancy bounds any lodging platform's own forms fit inside. */
const MAX_ADULTS = 30;
const MAX_ROOMS = 30;
const MAX_CHILDREN = 10;

function isFiniteIn(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
}

function isCount(value: unknown, min: number, max: number): value is number {
  return isFiniteIn(value, min, max) && Number.isInteger(value as number);
}

/**
 * Validate an untrusted query (it crosses the message boundary). Returns the
 * typed query or null — never throws, and never "repairs" values: a query
 * that is out of bounds is refused, not clamped, so a bug upstream surfaces
 * instead of silently searching somewhere else.
 */
export function validateAreaSearchQuery(value: unknown): AreaSearchQuery | null {
  if (typeof value !== 'object' || value === null) return null;
  const query = value as Record<string, unknown>;
  if (!isFiniteIn(query.latitude, -90, 90)) return null;
  if (!isFiniteIn(query.longitude, -180, 180)) return null;
  if (!isFiniteIn(query.radiusKm, 0.05, MAX_RADIUS_KM)) return null;
  if (!isCount(query.adults, 1, MAX_ADULTS)) return null;
  if (!isCount(query.rooms, 1, MAX_ROOMS)) return null;
  if (!isCount(query.children, 0, MAX_CHILDREN)) return null;

  const hasCheckin = query.checkin !== undefined;
  const hasCheckout = query.checkout !== undefined;
  if (hasCheckin !== hasCheckout) return null;
  if (hasCheckin) {
    if (typeof query.checkin !== 'string' || !ISO_DATE.test(query.checkin)) return null;
    if (typeof query.checkout !== 'string' || !ISO_DATE.test(query.checkout)) return null;
    if (query.checkin >= query.checkout) return null;
  }

  if (query.sortHint !== undefined && query.sortHint !== 'price') return null;
  if (query.language !== undefined) {
    if (typeof query.language !== 'string' || !/^[a-z]{2}(-[a-z]{2})?$/.test(query.language)) {
      return null;
    }
  }

  // Categories: refuse anything outside the vocabulary (never repair), drop
  // duplicates, and treat an empty selection as "no filter" rather than
  // carrying a meaningless [] across the message boundary.
  let categories: SearchCategory[] | undefined;
  if (query.categories !== undefined) {
    if (!Array.isArray(query.categories)) return null;
    const seen: SearchCategory[] = [];
    for (const value of query.categories) {
      if (typeof value !== 'string') return null;
      if (!(SEARCH_CATEGORIES as readonly string[]).includes(value)) return null;
      if (!seen.includes(value as SearchCategory)) seen.push(value as SearchCategory);
    }
    if (seen.length > 0) categories = seen;
  }

  return {
    latitude: query.latitude,
    longitude: query.longitude,
    radiusKm: query.radiusKm,
    ...(hasCheckin ? { checkin: query.checkin as string, checkout: query.checkout as string } : {}),
    adults: query.adults,
    rooms: query.rooms,
    children: query.children,
    ...(categories !== undefined ? { categories } : {}),
    ...(query.sortHint !== undefined ? { sortHint: query.sortHint } : {}),
    ...(query.language !== undefined ? { language: query.language } : {}),
  };
}

/**
 * Everything a query carries besides the shape itself — the form's answers.
 * Name kept from the bounding-box era so the one caller's import did not have
 * to churn alongside the geometry change; nothing about the fields is bbox-
 * specific.
 */
export interface BboxToQueryOptions {
  checkin?: string;
  checkout?: string;
  adults?: number;
  rooms?: number;
  children?: number;
  categories?: SearchCategory[];
  sortHint?: 'price';
  language?: string;
}

/** The smallest radius a drag can produce: a hair's drag still searches a
 * neighbourhood rather than a doorstep. Inherited unchanged from the drawn
 * rectangle this replaced. */
const MIN_RADIUS_KM = 0.5;

/**
 * Turn a drawn circle into a query. The centre and radius pass through
 * untouched — that is the whole point of drawing a circle — except for two
 * bounds the drag itself cannot enforce:
 *
 *  - a radius below MIN_RADIUS_KM is raised to it, so a twitch of the mouse
 *    searches a neighbourhood instead of returning nothing;
 *  - a radius past MAX_RADIUS_KM is clamped to it. Unlike the rectangle era,
 *    this clamp is not a surprise sprung after the search: the page clamps
 *    the DRAWN circle at the cap too and labels it, so the user sees the
 *    limit while dragging (`entrypoints/search/main.ts`). This clamp is the
 *    backstop for a query that reached here some other way.
 *
 * A radius of zero or less is a click, not a circle, and is refused rather
 * than inflated to the floor — the floor rescues a small drag, it does not
 * invent an area nobody drew. Everything else (coordinate range, occupancy,
 * dates, categories) is refused by `validateAreaSearchQuery`, never repaired.
 */
export function circleToQuery(
  circle: SearchCircle,
  options: BboxToQueryOptions = {},
): AreaSearchQuery | null {
  const { latitude, longitude, radiusKm: drawnKm } = circle;
  for (const value of [latitude, longitude, drawnKm]) {
    if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  }
  if (drawnKm <= 0) return null;
  const radiusKm = Math.min(Math.max(drawnKm, MIN_RADIUS_KM), MAX_RADIUS_KM);

  const query: AreaSearchQuery = {
    latitude,
    longitude,
    radiusKm,
    adults: options.adults ?? 2,
    rooms: options.rooms ?? 1,
    children: options.children ?? 0,
    ...(options.checkin !== undefined && options.checkout !== undefined
      ? { checkin: options.checkin, checkout: options.checkout }
      : {}),
    ...(options.categories !== undefined && options.categories.length > 0
      ? { categories: options.categories }
      : {}),
    ...(options.sortHint !== undefined ? { sortHint: options.sortHint } : {}),
    ...(options.language !== undefined && options.language !== ''
      ? { language: options.language }
      : {}),
  };
  return validateAreaSearchQuery(query);
}
