/**
 * Booking.com adapter.
 *
 * Booking gets a bespoke adapter rather than riding the generic schema.org one
 * because its JSON-LD is unusually poor and, in one place, actively misleading:
 * `addressLocality` holds the street rather than the town, there is no `geo`
 * node at all, and `@type` is `Hotel` on every property whatever it really is.
 * A generic reader would silently take the street for a city. The real data
 * lives in page scripts (`utag_data`, `b_map_center_*`, `ufi`).
 */
import { canonicalizeListingUrl } from './canonicalize';
import { extractLiveIdentity, normalizePhotoUrl } from './extract';
import { extractPageContext } from './pagecontext';
import { assessSearchHtml, buildSearchResultsUrl, parseSearchResults } from './searchresults';
import { extractBookingTerms } from './terms';
import type { CanonicalListing, ExtractOptions, SiteAdapter } from '../types';
import type { IdentityVector } from '../../identity';
import type { PageContext } from '../../pagecontext';

export const BOOKING_MATCH_PATTERNS = ['*://*.booking.com/hotel/*'] as const;

export const bookingAdapter: SiteAdapter = {
  id: 'booking',
  label: 'Booking.com',
  // Where the search page sends the user to clear Akamai's bot check: one
  // ordinary visit sets the cookies the worker's search fetch rides on.
  homepage: 'https://www.booking.com',
  matchPatterns: BOOKING_MATCH_PATTERNS,

  capabilities: {
    // The slug is derived from the property name at listing creation and
    // survives renames — the fossil Engine A1 reads.
    nameBearingUrl: true,
    // `ufi`, the language-independent town key.
    destinationId: true,
    // "Top attractions" blocks, each with the distance Booking claims.
    nearbyLandmarks: true,
  },

  handles(url: URL): boolean {
    return canonicalizeListingUrl(url.href) !== null;
  },

  canonicalize(url: URL): CanonicalListing | null {
    const parsed = canonicalizeListingUrl(url.href);
    if (!parsed) return null;
    return {
      platform: 'booking',
      canonicalUrl: parsed.canonicalUrl,
      cdxPrefix: parsed.cdxPrefix,
      slug: parsed.slug,
      countryCode: parsed.countryCode,
      ...(parsed.locale === null ? {} : { locale: parsed.locale }),
    };
  },

  extractIdentity(doc: Document, options?: ExtractOptions): IdentityVector | null {
    const vector = extractLiveIdentity(doc, options);
    // Booking scores out of 10; without the scale a diff against a 5-point
    // platform would read a rescale as a reputation collapse.
    return vector && { ...vector, platform: 'booking', reviewScoreMax: 10 };
  },

  extractContext(doc: Document): PageContext {
    return extractPageContext(doc);
  },

  extractTerms(doc: Document) {
    return extractBookingTerms(doc);
  },

  normalizePhotoUrl,

  // Map-area search (phase b): spell the query in Booking's URL dialect and
  // read the result grid. Platform knowledge stays in searchresults.ts.
  buildSearchUrl: buildSearchResultsUrl,
  parseSearchResults,

  // The contract wants only the verdict; the detailed assessment (marker
  // counts, title) stays available to the probe via the module itself.
  assessSearchHtml: (html: string) => assessSearchHtml(html).verdict,
};
