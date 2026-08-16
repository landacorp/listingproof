/**
 * Where the content script runs, and which hosts the extension may fetch.
 *
 * This list is duplicated from the adapters on purpose. `wxt.config.ts` runs at
 * build time in Node and must not import adapter modules, which are written
 * against the DOM; and Chrome needs these patterns as literals in the manifest
 * anyway. `lib/sites/patterns.test.ts` asserts the two stay in step, so the
 * duplication cannot drift silently.
 *
 * Adding a platform means adding its adapter, adding its pattern here, and
 * letting the test confirm they agree.
 */

/** Pages the content script is injected into. */
export const LISTING_MATCH_PATTERNS = [
  '*://*.booking.com/hotel/*',
  '*://*.airbnb.com/rooms/*',
  '*://*.airbnb.co.uk/rooms/*',
  '*://*.airbnb.ca/rooms/*',
  '*://*.airbnb.com.au/rooms/*',
  '*://*.airbnb.co.in/rooms/*',
  '*://*.airbnb.fr/rooms/*',
  '*://*.airbnb.de/rooms/*',
  '*://*.airbnb.es/rooms/*',
  '*://*.airbnb.it/rooms/*',
] as const;

/**
 * Booking search-results pages, fetched by the service worker for the
 * map-area search page (one page of results per explicit user search; the
 * phase (a) probe shares the grant). Ships in the production manifest since
 * phase (b). It lives here rather than inline in `wxt.config.ts` so every
 * platform host string stays in this one file.
 */
export const BOOKING_SEARCH_RESULTS_PATTERN = '*://*.booking.com/searchresults*';
