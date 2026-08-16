/**
 * Map-area search, phase (b): Booking's search-results dialect — URL
 * construction, body assessment, and the result-card parser.
 *
 * This is the production home of everything the extension knows about
 * `searchresults.html`. The phase (a) probe (`entrypoints/searchprobe/`,
 * `background/searchprobe.ts`, mode-gated, never shipped) merely shares these
 * helpers; it proved 2026-08-14 that the service worker can fetch results
 * where curl gets an Akamai challenge (HTTP 202, ~4 KB stub).
 *
 * Kept under `lib/sites/booking/` because the URL parameters and result-page
 * markers are Booking knowledge (house rule: platform knowledge lives only in
 * `lib/sites/`). The engines and the panel see only `AreaSearchQuery` in and
 * `SearchResultCard` out.
 */

import type { AreaSearchQuery, SearchCategory } from '../../areasearch';
import type { SearchResultCard } from '../types';
import { canonicalizeListingUrl } from './canonicalize';

const SEARCH_RESULTS_BASE = 'https://www.booking.com/searchresults.html';

/** Worker fetches see absolute hrefs; a rendered tab may serve relative ones. */
const BOOKING_ORIGIN = 'https://www.booking.com';

/**
 * Booking's `ht_id` code per neutral category, read from the live filter
 * sidebar of the captured search page (aria-labels "Hotels: 528 properties"
 * etc. beside `value="ht_id=204"` checkboxes — fixtures/live-search,
 * 2026-08-14). A code Booking retires simply filters nothing.
 */
const CATEGORY_HT_IDS: Record<SearchCategory, number> = {
  hotel: 204,
  apartment: 201,
  'holiday-home': 220,
  villa: 213,
  guesthouse: 216,
  bnb: 208,
  hostel: 203,
  resort: 206,
  chalet: 228,
  campground: 214,
};

/**
 * Spell an `AreaSearchQuery` as a `searchresults.html` URL for a coordinate
 * search (`dest_type=latlong`), the route ROADMAP's map-area design names.
 * Parameter names follow Booking's current query schema
 * (`group_adults` / `no_rooms` / `group_children`).
 */
export function buildSearchResultsUrl(query: AreaSearchQuery): string {
  const url = new URL(SEARCH_RESULTS_BASE);
  url.searchParams.set('dest_type', 'latlong');
  url.searchParams.set('latitude', String(query.latitude));
  url.searchParams.set('longitude', String(query.longitude));
  url.searchParams.set('radius', String(query.radiusKm));
  if (query.checkin !== undefined && query.checkout !== undefined) {
    url.searchParams.set('checkin', query.checkin);
    url.searchParams.set('checkout', query.checkout);
  }
  url.searchParams.set('group_adults', String(query.adults));
  url.searchParams.set('no_rooms', String(query.rooms));
  url.searchParams.set('group_children', String(query.children));
  if (query.categories !== undefined && query.categories.length > 0) {
    // Booking's filter grammar: `nflt=ht_id=204;ht_id=201` before URL
    // encoding (the page's own state calls it nflt_url_param_decoded).
    // If Booking ever ignores it, the search degrades to unfiltered —
    // wrong results are impossible, only unfiltered ones.
    url.searchParams.set(
      'nflt',
      query.categories.map((category) => `ht_id=${CATEGORY_HT_IDS[category]}`).join(';'),
    );
  }
  if (query.sortHint === 'price') {
    // Without an order, Booking returns the 25 nearest the centre — a wide
    // box then looks "searched only in the middle". Price order spreads the
    // page across the whole radius (and matches the UI's default sort).
    url.searchParams.set('order', 'price');
  }
  const lang = query.language === undefined ? undefined : BOOKING_LANG_CODES[query.language];
  if (lang !== undefined) url.searchParams.set('lang', lang);
  return url.toString();
}

/**
 * Our language codes → Booking's `lang` values, so the platform's own card
 * text (distances, addresses) arrives in the UI language. Unknown codes send
 * nothing — Booking then uses the session's language, which is what happens
 * today anyway.
 */
const BOOKING_LANG_CODES: Record<string, string> = {
  de: 'de',
  el: 'el',
  es: 'es',
  fr: 'fr',
  it: 'it',
  ja: 'ja',
  ko: 'ko',
  nl: 'nl',
  pl: 'pl',
  pt: 'pt-pt',
  ru: 'ru',
  tr: 'tr',
  uk: 'uk',
  zh: 'zh-cn',
};

/**
 * Akamai challenge fingerprints, recorded from a live challenge body captured
 * 2026-08-14 (HTTP 202): a `/__challenge_<token>/.../challenge.js` script and
 * an `id="challenge-container"` mount point. Substring matches, not selectors,
 * so the assessment stays DOM-free and worker-safe.
 */
const CHALLENGE_MARKERS = ['__challenge_', 'challenge-container', 'challenge.js'] as const;

/** The result-card marker on current search pages; `parseSearchResults`'s anchor. */
const PROPERTY_CARD_MARKER = /data-testid="property-card"/g;

/** Anchors into property pages — a drift-resistant fallback signal for "these are results". */
const HOTEL_LINK_MARKER = /href="[^"]*\/hotel\//g;

export interface SearchHtmlAssessment {
  /** Length of the body STRING (UTF-16 code units) — not bytes on the wire. */
  chars: number;
  title: string | null;
  /** Occurrences of the current result-card marker. */
  propertyCards: number;
  /** Anchors into `/hotel/` property pages. */
  hotelLinks: number;
  /** Which challenge fingerprints the body contains. */
  challengeMarkers: string[];
  verdict: 'results' | 'challenge' | 'other';
}

/**
 * Classify a fetched body: a genuine results page, an Akamai challenge, or
 * something else (login wall, error page, empty area…). Deliberately coarse —
 * the caller needs "did we get results?", not a parse. Counts are reported
 * raw so a drifted marker still leaves interpretable evidence (the adapter
 * contract reduces this to the verdict; the probe reads the details).
 */
export function assessSearchHtml(html: string): SearchHtmlAssessment {
  const titleMatch = /<title[^>]*>([^<]*)<\/title>/i.exec(html);
  const title = titleMatch ? titleMatch[1].trim() || null : null;
  const propertyCards = (html.match(PROPERTY_CARD_MARKER) ?? []).length;
  const hotelLinks = (html.match(HOTEL_LINK_MARKER) ?? []).length;
  const challengeMarkers = CHALLENGE_MARKERS.filter((marker) => html.includes(marker));

  // Results win over challenge markers: a real results page could mention
  // "challenge.js" in unrelated inline script, but a challenge stub can never
  // contain a grid of property cards.
  let verdict: SearchHtmlAssessment['verdict'] = 'other';
  if (propertyCards > 0 || hotelLinks >= 5) verdict = 'results';
  else if (challengeMarkers.length > 0) verdict = 'challenge';

  return { chars: html.length, title, propertyCards, hotelLinks, challengeMarkers, verdict };
}

/**
 * Pull score and count out of a review block WITHOUT anchoring on English
 * words — the worker's search fetch rides the user's cookies and
 * Accept-Language, so the markup arrives in whatever language Booking chose
 * for them ("Scored 8.3 … 15 reviews", "Bewertet mit 8,3 … 124 Bewertungen").
 * Locale-neutral rule, pinned by tests: the score is the FIRST number token
 * (decimal comma normalized), the count is the LAST integer token when it is
 * a different token than the score's. A drifted layout yields undefined
 * fields, never a wrong pairing presented as fact.
 */
export function extractReviewNumbers(text: string): { score?: number; count?: number } {
  const tokens = text.match(/\d+(?:[.,]\d+)*/g);
  if (tokens === null || tokens.length === 0) return {};
  const score = Number(tokens[0].replace(',', '.'));
  const result: { score?: number; count?: number } = Number.isFinite(score) ? { score } : {};
  const last = tokens[tokens.length - 1];
  // A count is an integer: plain ("15") or thousands-grouped ("2,847",
  // "2.847"). One or two digits after a single separator is a decimal —
  // that is a score, not a count.
  const isCountShaped = /^\d+$/.test(last) || /^\d{1,3}(?:[.,]\d{3})+$/.test(last);
  if (tokens.length >= 2 && isCountShaped) {
    const count = Number(last.replace(/[.,]/g, ''));
    if (Number.isFinite(count)) result.count = count;
  }
  return result;
}

/** Whitespace-normalized text of the first match, or null. `\s` also eats the NBSP Booking pads prices with. */
function selectText(root: Element, selector: string): string | null {
  const el = root.querySelector(selector);
  if (el === null) return null;
  const text = (el.textContent ?? '').replace(/\s+/g, ' ').trim();
  return text === '' ? null : text;
}

/**
 * Property coordinates ride in the page's embedded state as
 * `…"latitude":48.85,"longitude":2.35},"pageName":"<slug>"…` — one triple
 * per result, slug identical to the card URL's `/hotel/<cc>/<slug>.html`
 * basename (verified against both live-search fixtures, 25/25 each). A raw
 * regex over script text is deliberate: parsing megabytes of Apollo state
 * JSON to reach three fields would couple us to far more markup than this
 * one shape, and a miss only costs a marker, never a card.
 */
const COORDS_PATTERN =
  /"latitude":(-?\d+(?:\.\d+)?),"longitude":(-?\d+(?:\.\d+)?)\},"pageName":"([^"]+)"/g;

function extractCoordsBySlug(doc: Document): Map<string, { lat: number; lng: number }> {
  const coords = new Map<string, { lat: number; lng: number }>();
  for (const script of doc.querySelectorAll('script')) {
    const text = script.textContent;
    if (text === null || !text.includes('"pageName"')) continue;
    for (const match of text.matchAll(COORDS_PATTERN)) {
      const lat = Number(match[1]);
      const lng = Number(match[2]);
      if (Number.isFinite(lat) && Number.isFinite(lng)) coords.set(match[3], { lat, lng });
    }
  }
  return coords;
}

/** The `/hotel/<cc>/<slug>.html` basename, or null for other shapes. */
function slugOfCanonicalUrl(canonicalUrl: string): string | null {
  const match = /\/hotel\/[a-z]{2}\/([^/]+)\.html$/i.exec(canonicalUrl);
  return match === null ? null : match[1];
}

/**
 * Read result cards out of a search-results document (worker-fetched HTML
 * through DOMParser, or a captured live-tab DOM — the markup is the same).
 * Facts only, partial by design: a card missing its name or link is skipped,
 * never invented; every other field is optional (about a quarter of live
 * cards have no review block at all). `url` keeps the tracking params as
 * served; `canonicalUrl` is set only when the adapter's canonicalizer
 * recognizes the link as a property page.
 */
export function parseSearchResults(doc: Document): SearchResultCard[] {
  const cards: SearchResultCard[] = [];
  const coordsBySlug = extractCoordsBySlug(doc);
  for (const cardEl of doc.querySelectorAll('[data-testid="property-card"]')) {
    const name = selectText(cardEl, '[data-testid="title"]');
    const href = cardEl.querySelector('[data-testid="title-link"]')?.getAttribute('href');
    if (name === null || href === undefined || href === null) continue;
    let url: string;
    try {
      url = new URL(href, BOOKING_ORIGIN).toString();
    } catch {
      continue;
    }

    const card: SearchResultCard = { name, url };

    const canonical = canonicalizeListingUrl(url);
    if (canonical !== null) {
      card.canonicalUrl = canonical.canonicalUrl;
      const slug = slugOfCanonicalUrl(canonical.canonicalUrl);
      const coords = slug === null ? undefined : coordsBySlug.get(slug);
      if (coords !== undefined) {
        card.latitude = coords.lat;
        card.longitude = coords.lng;
      }
    }

    const priceText = selectText(cardEl, '[data-testid="price-and-discounted-price"]');
    if (priceText !== null) card.priceText = priceText;

    // The score block reads like "Scored 8.3 8.3Very Good 15 reviews"; the
    // link-wrapped variant contains the plain one, so try the link first.
    const review =
      cardEl.querySelector('[data-testid="review-score-link"]') ??
      cardEl.querySelector('[data-testid="review-score"]');
    if (review !== null) {
      const numbers = extractReviewNumbers(review.textContent ?? '');
      if (numbers.score !== undefined) card.reviewScore = numbers.score;
      if (numbers.count !== undefined) card.reviewCount = numbers.count;
    }

    const address =
      selectText(cardEl, '[data-testid="address-link"]') ??
      selectText(cardEl, '[data-testid="address"]');
    if (address !== null) card.address = address;

    const distanceText = selectText(cardEl, '[data-testid="distance"]');
    if (distanceText !== null) card.distanceText = distanceText;

    const thumbnailUrl = cardEl.querySelector('[data-testid="image"]')?.getAttribute('src');
    if (thumbnailUrl !== undefined && thumbnailUrl !== null && thumbnailUrl !== '') {
      card.thumbnailUrl = thumbnailUrl;
    }

    cards.push(card);
  }
  return cards;
}
