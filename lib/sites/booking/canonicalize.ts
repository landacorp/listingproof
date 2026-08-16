/**
 * Canonicalizer for Booking.com property-page URLs.
 *
 * Booking serves the same property under many URL variants:
 *   https://www.booking.com/hotel/fr/<slug>.html
 *   https://www.booking.com/hotel/fr/<slug>.en-gb.html?aid=...&label=...&sid=...#hash
 *   http://m.booking.com/hotel/fr/<slug>.de.html
 *
 * The identity-bearing parts are country code + slug. Everything else
 * (host prefix, locale suffix, query, fragment) is presentation/session noise.
 * The slug is also fossilized history: it is derived from the property name at
 * listing creation and survives renames — which is exactly why Engine A checks
 * it against the displayed name.
 */

export interface CanonicalListing {
  /** Locale-stripped canonical page URL. */
  canonicalUrl: string;
  /** Scheme/host-normalized prefix for CDX `matchType=prefix` queries. */
  cdxPrefix: string;
  /** Two-letter country segment from the path. */
  countryCode: string;
  /** Property slug (lowercased, locale suffix removed). */
  slug: string;
  /** Locale suffix if the input URL carried one (e.g. "en-gb"), else null. */
  locale: string | null;
}

const BOOKING_HOST = /^(?:[a-z0-9-]+\.)*booking\.com$/i;
const HOTEL_PATH = /^\/hotel\/([a-z]{2})\/([^/]+)\.html$/i;
const LOCALE_SUFFIX = /^[a-z]{2}(?:-[a-z]{2})?$/i;

/**
 * Parse any Booking.com property URL into its canonical identity.
 * Returns null for anything that is not a Booking property page.
 */
export function canonicalizeListingUrl(input: string): CanonicalListing | null {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return null;
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  if (!BOOKING_HOST.test(url.hostname)) return null;

  const match = HOTEL_PATH.exec(url.pathname);
  if (!match) return null;

  const countryCode = match[1].toLowerCase();
  let stem = match[2];

  // Strip a trailing ".<locale>" only when it matches the locale shape.
  // Slugs themselves are hyphen/alnum; an unknown dot-suffix stays in the slug
  // (permissive — see DECISIONS.md).
  let locale: string | null = null;
  const lastDot = stem.lastIndexOf('.');
  if (lastDot > 0) {
    const candidate = stem.slice(lastDot + 1);
    if (LOCALE_SUFFIX.test(candidate)) {
      locale = candidate.toLowerCase();
      stem = stem.slice(0, lastDot);
    }
  }

  const slug = stem.toLowerCase();
  if (slug.length === 0) return null;

  return {
    canonicalUrl: `https://www.booking.com/hotel/${countryCode}/${slug}.html`,
    cdxPrefix: `booking.com/hotel/${countryCode}/${slug}`,
    countryCode,
    slug,
    locale,
  };
}
