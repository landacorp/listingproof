/**
 * Airbnb adapter.
 *
 * Airbnb publishes clean schema.org lodging markup, so the JSON-LD reading is
 * delegated wholesale to `readSchemaOrgLodging` and this module only layers on
 * what Airbnb does differently. Three of those differences matter:
 *
 *  - **The URL carries no name.** A listing is `/rooms/1725991277287663886` and
 *    nothing else — no slug, no city, no property type. Booking's slug is a
 *    fossil of the name the property had when it was listed, and Engine A1's
 *    entire premise is comparing that fossil against the displayed name. Here
 *    there is no fossil, so `capabilities.nameBearingUrl` is false and A1 skips
 *    the platform instead of comparing a numeric id against a title and
 *    reporting every honest listing as a mismatch. This is the reason the
 *    capability flag exists at all.
 *  - **One listing has ~50 URLs.** Airbnb runs a country domain per market
 *    (airbnb.co.uk, airbnb.fr, airbnb.com.au, …) and every one of them serves
 *    the same `/rooms/<id>`. Canonicalising all of them onto
 *    `https://www.airbnb.com/rooms/<id>` is what makes a capture taken on
 *    airbnb.fr and a capture taken on airbnb.co.uk compare as one listing
 *    rather than two — and what makes the archive prefix query find both.
 *  - **The rating scale is 5, not Booking's 10.** Without `reviewScoreMax` a
 *    diff putting 4.6 next to Booking's 9.2 would read a rescale as a
 *    collapse in reputation.
 *
 * What Airbnb's server HTML does NOT contain: breadcrumbs, review nodes, a
 * street address (the exact address is withheld until a booking is confirmed),
 * or a country. Those stay empty/undefined rather than being invented — a
 * missing field is GRAY input, and a fabricated one is a false verdict.
 *
 * Page content is attacker-authored: every traversal here is bounded and
 * extraction never throws.
 */
import { readSchemaOrgLodging } from './generic';
import type { CanonicalListing, ExtractOptions, SiteAdapter } from './types';
import type { ListingTerms } from '../terms';
import type { IdentityVector } from '../identity';
import type { PageContext } from '../pagecontext';
import type { ReviewSummary } from '../reviews';

/**
 * Where the content script runs.
 *
 * Chrome match patterns cannot wildcard a TLD (an `airbnb.*` wildcard pattern is
 * rejected by the manifest parser), so ccTLDs have to be enumerated one by one
 * and each one is a host permission the user is asked to trust. The list is
 * therefore the largest markets only, not all ~50 domains: an unexplained host
 * permission costs more in store review and user trust than it buys.
 *
 * `handles()`/`canonicalize()` below are deliberately broader — they accept any
 * `airbnb.<tld>` host. A URL that reaches us from somewhere other than the
 * content script (an archive record, a message from the panel) is then still
 * canonicalised correctly rather than silently unrecognised.
 *
 * Kept in step with `lib/sites/patterns.ts` by `lib/sites/patterns.test.ts`.
 */
export const AIRBNB_MATCH_PATTERNS = [
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

// ---------------------------------------------------------------------------
// bounds — every value below comes from a hostile page or a hostile URL
// ---------------------------------------------------------------------------

/** Normalized photo identities kept on the vector. */
const PHOTO_CAP = 60;
/** Raw image entries considered before normalization. */
const IMAGE_CANDIDATE_CAP = 200;
/** Longest photo URL considered; beyond this it is not a real asset URL. */
const PHOTO_URL_MAX_CHARS = 2048;
/** Path segments walked in a photo URL. */
const PHOTO_SEGMENT_CAP = 24;
/** Longest URL string read out of the document when hunting for the listing id. */
const URL_MAX_CHARS = 2048;
/** Longest `identifier` we will try to base64-decode. */
const IDENTIFIER_MAX_CHARS = 256;

/**
 * Any `airbnb.<tld>` or `airbnb.<sld>.<cc>` host, with any subdomain.
 *
 * The TLD part is `[a-z]{2,4}` plus an optional two-letter second level, not
 * `[a-z.]+`: a permissive character class containing a dot would accept
 * `www.airbnb.com.phishing.example`, handing a lookalike host the extension's
 * "this is a genuine listing page" treatment.
 */
const AIRBNB_HOST = /^(?:[a-z0-9-]+\.)*airbnb\.[a-z]{2,4}(?:\.[a-z]{2})?$/i;

/**
 * `/rooms/<numeric id>`, with the optional `plus/` segment Airbnb Plus pages
 * carry and an optional trailing slash. Nothing else is accepted: `/h/<slug>`
 * vanity URLs redirect to a room id we cannot know without following the
 * redirect, and a guessed id is worse than no id — it would make the archive
 * comparison silently compare two different properties. By the time the page
 * has loaded the address bar shows the real `/rooms/<id>`, so nothing is lost.
 */
const ROOM_PATH = /^\/rooms\/(?:plus\/)?(\d{1,25})\/?$/;

/** Locale shapes Airbnb puts in `?locale=`: `fr`, `fr-FR`, `zh-CN`. */
const LOCALE = /^[a-z]{2}(?:-[a-z]{2})?$/i;

/** `identifier` is base64 of the GraphQL node id: `DemandStayListing:<id>`. */
const DEMAND_STAY_LISTING = /^DemandStayListing:(\d{1,25})$/;

// ---------------------------------------------------------------------------
// URL canonicalization
// ---------------------------------------------------------------------------

/**
 * Parse any Airbnb room URL into the parts that identify it: the numeric id,
 * and the locale the visitor happened to be browsing in.
 *
 * Everything else — country domain, `?check_in`, `?adults`, `?source_impression_id`,
 * the fragment — is presentation and session noise. Returns null for anything
 * that is not a room page.
 */
export function parseRoomUrl(url: URL): { listingId: string; locale?: string } | null {
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  if (!AIRBNB_HOST.test(url.hostname)) return null;

  const match = ROOM_PATH.exec(url.pathname);
  if (!match) return null;

  const rawLocale = url.searchParams.get('locale');
  const locale = rawLocale !== null && LOCALE.test(rawLocale) ? rawLocale.toLowerCase() : undefined;
  return locale === undefined ? { listingId: match[1] } : { listingId: match[1], locale };
}

function canonicalize(url: URL): CanonicalListing | null {
  const parsed = parseRoomUrl(url);
  if (!parsed) return null;
  return {
    platform: 'airbnb',
    // Every country domain collapses to one identity here. Two captures of the
    // same listing from two markets must not read as two listings.
    canonicalUrl: `https://www.airbnb.com/rooms/${parsed.listingId}`,
    // Scheme-less and www-less, matching how CDX canonicalises hosts, so a
    // `matchType=prefix` query finds captures made under any country domain.
    cdxPrefix: `airbnb.com/rooms/${parsed.listingId}`,
    listingId: parsed.listingId,
    // No `slug`: the URL carries no name. No `countryCode`: the ccTLD is the
    // market the visitor browsed from, not where the property is — reporting it
    // as the property's country would be a fabricated location claim.
    ...(parsed.locale === undefined ? {} : { locale: parsed.locale }),
  };
}

// ---------------------------------------------------------------------------
// photos
// ---------------------------------------------------------------------------

/**
 * Path segments that mean "this picture is not a listing photo": host avatars
 * and Airbnb's own UI assets. They live under the same `/im/pictures/` prefix
 * as real gallery photos and have UUID filenames just like them, so shape alone
 * cannot separate them. The favicon in particular appears on every Airbnb page
 * — left in, it would be a photo every listing on the platform "shares", which
 * is exactly the signal a duplicate-gallery check is looking for.
 */
function isNonListingSegment(segment: string): boolean {
  const s = segment.toLowerCase();
  return (
    s === 'user' || s === 'users' || s === 'profile' || s === 'profiles' ||
    s === 'portrait' || s === 'portraits' || s === 'avatar' || s === 'avatars' ||
    s.startsWith('airbnbplatformassets') || s.startsWith('airbnb-platform-assets')
  );
}

/**
 * `muscache.com` **at a host position** — preceded by `//` (a scheme, or a
 * protocol-relative source) or standing at the start of the string — followed
 * by its path.
 *
 * Anchoring matters: a bare "contains `muscache.com/`" test also accepts
 * `https://evil.example/muscache.com/im/pictures/<uuid>.jpg`, where the CDN
 * name is a path segment on somebody else's host. That URL is not an Airbnb
 * asset, and handing it back a genuine-looking asset identity is exactly the
 * "return null for anything that is not a listing photo" case. The subdomain
 * chain is `[a-z0-9-]+` per label rather than `[a-z.]+` so
 * `a0.muscache.com.evil.example` cannot pass either.
 */
const MUSCACHE_URL = /(?:^|\/\/)(?:[a-z0-9-]+\.)*muscache\.com\/([^?#"'\s\\]*)/i;
const PHOTO_UUID = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\.(?:jpe?g|png|webp|avif|gif))?$/i;

/**
 * Canonical identity of an Airbnb photo URL.
 *
 * The stable identity is the UUID of the asset. Host (`a0`/`a1`.muscache.com),
 * the `hosting/Hosting-<listingId>/original/` prefix, the file extension
 * (`.jpeg` live, `.webp` when the CDN negotiates) and the resize/quality query
 * (`?im_w=720&width=1440`) are all delivery details that differ between two
 * sources of the same picture, and a gallery comparison that treated them as
 * part of the identity would find zero overlap between a live page and its own
 * archive snapshot.
 *
 * Matched against the raw string rather than a parsed `URL` on purpose: archive
 * captures serve photos under a rewritten prefix
 * (`web.archive.org/web/<ts>/https://a0.muscache.com/…`), and the asset is the
 * same asset. Anything that is not a listing photo — a different CDN, a video,
 * a host avatar, a platform icon — returns null.
 */
export function normalizePhotoUrl(input: string): string | null {
  if (input.length === 0 || input.length > PHOTO_URL_MAX_CHARS) return null;

  const match = MUSCACHE_URL.exec(input);
  if (!match) return null;

  const segments = match[1].split('/').filter((s) => s.length > 0);
  if (segments.length === 0 || segments.length > PHOTO_SEGMENT_CAP) return null;

  // Gallery photos live under `/im/pictures/…` or the older `/pictures/…`.
  // `/im/Portrait/`, `/videos/`, `/airbnb/` are other things entirely.
  const isPictures = segments[0] === 'pictures' || (segments[0] === 'im' && segments[1] === 'pictures');
  if (!isPictures) return null;
  for (const segment of segments) {
    if (isNonListingSegment(segment)) return null;
  }

  const uuid = PHOTO_UUID.exec(segments[segments.length - 1]);
  return uuid ? `https://a0.muscache.com/im/pictures/${uuid[1].toLowerCase()}.jpg` : null;
}

// ---------------------------------------------------------------------------
// identity
// ---------------------------------------------------------------------------

function metaContent(doc: Document, property: string): string | undefined {
  const value = doc.querySelector(`meta[property="${property}"]`)?.getAttribute('content');
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

function listingIdFromUrlish(candidate: string | undefined): string | undefined {
  if (candidate === undefined || candidate.length > URL_MAX_CHARS) return undefined;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return undefined; // relative or malformed (`about:blank` parses but has no host)
  }
  return parseRoomUrl(url)?.listingId;
}

/**
 * The numeric id hidden inside JSON-LD `identifier`, which is base64 of
 * `DemandStayListing:<id>`. A cross-check and a last resort, never a throw:
 * `atob` rejects malformed base64, and the markup is attacker-authored.
 */
export function listingIdFromIdentifier(identifier: string | undefined): string | undefined {
  if (identifier === undefined || identifier.length > IDENTIFIER_MAX_CHARS) return undefined;
  if (typeof atob !== 'function') return undefined;
  let decoded: string;
  try {
    decoded = atob(identifier);
  } catch {
    return undefined;
  }
  return DEMAND_STAY_LISTING.exec(decoded)?.[1];
}

/**
 * The listing's own id.
 *
 * `doc.URL` first because it is the one value on this list the browser supplies
 * rather than the page: `og:url`, the canonical link and `identifier` are all
 * markup a hijacker controls, and a forged listing id is not cosmetic — the
 * diff withdraws the whole archive comparison when the two sides' ids disagree,
 * so a page that lies about its own id would switch off the checks against it.
 * Outside a browsing context (`about:blank` under DOMParser, an archive body
 * parsed offline) the page's own declarations are all there is, and there the
 * snapshot is fixed in time and cannot be re-forged after the fact.
 */
function listingIdFromDocument(doc: Document, identifier: string | undefined): string | undefined {
  return (
    listingIdFromUrlish(doc.URL) ??
    listingIdFromUrlish(metaContent(doc, 'og:url')) ??
    listingIdFromUrlish(doc.querySelector('link[rel="canonical"]')?.getAttribute('href') ?? undefined) ??
    listingIdFromIdentifier(identifier)
  );
}

function collectPhotoUrls(doc: Document, images: readonly string[]): string[] {
  const seen = new Set<string>();
  const urls: string[] = [];
  const add = (candidate: string | undefined): void => {
    if (candidate === undefined || urls.length >= PHOTO_CAP) return;
    const normalized = normalizePhotoUrl(candidate);
    if (normalized !== null && !seen.has(normalized)) {
      seen.add(normalized);
      urls.push(normalized);
    }
  };
  // Indexed loop, never `...spread`: spreading an attacker-sized array throws
  // RangeError before any length check downstream can run.
  for (let i = 0; i < images.length && i < IMAGE_CANDIDATE_CAP && urls.length < PHOTO_CAP; i++) {
    add(images[i]);
  }
  // `og:image` is the hero shot and is normally already in `image[]`; it is read
  // as a fallback for the day the JSON-LD gallery is absent.
  add(metaContent(doc, 'og:image'));
  return urls;
}

export function extractAirbnbIdentity(doc: Document, options: ExtractOptions = {}): IdentityVector | null {
  const lodging = readSchemaOrgLodging(doc);
  if (lodging === undefined) return null;

  // A room page always names the property. Without a name there is nothing to
  // compare, and claiming an identity we could not read would be worse than
  // reporting none.
  const name = lodging.name;
  if (name === undefined || name === '') return null;

  const vector: IdentityVector = {
    platform: 'airbnb',
    name,
    // Airbnb withholds the street until a booking is confirmed, so there is no
    // street address to read on a public page. Empty means "not published",
    // and the coordinates carry the location claim instead.
    address: lodging.streetAddress ?? '',
    photoUrls: collectPhotoUrls(doc, lodging.images),
    capturedAt: (options.now?.() ?? new Date()).toISOString(),
    source: { kind: 'live' },
  };

  // The numeric room id, not the base64 `identifier` the generic reader picks
  // up: the numeric id is what the URL, the archive prefix and the canonical
  // listing all key on, so the same listing must not carry two different ids
  // depending on which side read it.
  //
  // Deliberately NOT falling back to the raw `identifier` string when it will
  // not decode. The live side reads its id from the address bar and always has
  // the numeric form, so an undecodable identifier on the archived side would
  // give the two sides ids in different namespaces — and B.listingId reads
  // "ids differ" as "these are probably two unrelated listings" and withdraws
  // the whole archive comparison. A missing id costs one GRAY row; a
  // non-comparable one discards every other rule.
  const listingId = listingIdFromDocument(doc, lodging.listingId);
  if (listingId !== undefined) vector.listingId = listingId;

  if (lodging.city !== undefined) vector.city = lodging.city;
  if (lodging.country !== undefined) vector.country = lodging.country;
  if (lodging.lat !== undefined) vector.lat = lodging.lat;
  if (lodging.lng !== undefined) vector.lng = lodging.lng;
  if (lodging.reviewCount !== undefined) vector.reviewCount = lodging.reviewCount;
  // Stated, not inferred. The generic reader has to guess the scale from the
  // score, and a listing with a single 5-star review is indistinguishable from
  // a 10-point platform's 5.0 by that rule alone.
  vector.reviewScoreMax = 5;
  // A score is only kept when it is possible on that scale. Airbnb cannot serve
  // 9.6 out of 5; markup that claims it is either broken or forged, and storing
  // it beside `reviewScoreMax: 5` would normalise to 1.9 — a score comparison
  // reading a nonsense number as a spectacular reputation. Out of range is
  // unknown (GRAY), not a confident value.
  if (lodging.reviewScore !== undefined && lodging.reviewScore >= 0 && lodging.reviewScore <= 5) {
    vector.reviewScore = lodging.reviewScore;
  }
  if (lodging.propertyType !== undefined) vector.propertyType = lodging.propertyType;

  return vector;
}

// ---------------------------------------------------------------------------
// page context
// ---------------------------------------------------------------------------

/**
 * Airbnb's server HTML carries the description and nothing else this shape
 * wants: there are no breadcrumbs, no landmark list with claimed distances, and
 * no review nodes — reviews are fetched client-side after hydration. Those
 * arrive empty rather than being scraped out of hydration blobs, which is a
 * later contributor's job and needs its own fixtures to be honest.
 *
 * The emptiness is DECLARED, not merely produced. `availability: 'not-in-page'`
 * is the difference between "Airbnb does not publish individual reviews on the
 * listing page" and "nobody has reviewed this property" — and the second
 * sentence would be a fabrication on every one of the corpus's seven listings,
 * which carry aggregates of 1 to 8 reviews with zero `Review` nodes between
 * them. The aggregate travels in `summary` for exactly that reason: it lets a
 * consumer show what the page does claim while saying we could see none of it.
 *
 * The description is taken only from JSON-LD. `meta[name=description]` looks
 * tempting and is not usable: Airbnb prefixes it with the current date
 * ("Aug 11, 2026 · Entire rental unit · …"), so two captures of an unchanged
 * listing would differ every day.
 */
function extractContext(doc: Document): PageContext {
  const lodging = readSchemaOrgLodging(doc);

  // Normalized to the contract's 0-10 from Airbnb's stated 5, so a panel row
  // never puts a 4.9 next to Booking's 9.2 as if the two were comparable.
  const summary: ReviewSummary = {};
  if (lodging?.reviewScore !== undefined && lodging.reviewScore >= 0 && lodging.reviewScore <= 5) {
    summary.score = lodging.reviewScore * 2;
  }
  if (lodging?.reviewCount !== undefined) summary.total = lodging.reviewCount;
  const hasSummary = summary.score !== undefined || summary.total !== undefined;

  return {
    breadcrumbs: [],
    pois: [],
    reviews: [],
    reviewSet: {
      availability: 'not-in-page',
      items: [],
      ...(hasSummary ? { summary } : {}),
    },
    ...(lodging?.description === undefined ? {} : { description: lodging.description }),
  };
}

// ---------------------------------------------------------------------------
// the adapter
// ---------------------------------------------------------------------------

export const airbnbAdapter: SiteAdapter = {
  id: 'airbnb',
  label: 'Airbnb',
  matchPatterns: AIRBNB_MATCH_PATTERNS,

  capabilities: {
    // `/rooms/1725991277287663886` — an opaque id, no name anywhere in the URL.
    // Engine A1 (URL slug vs displayed name) has nothing to read and skips the
    // platform; declaring true here would have it compare a number against a
    // property title and call every honest Airbnb listing a mismatch.
    nameBearingUrl: false,
    // No public, language-independent town key. `addressLocality` is the town's
    // name in the page's own language, which is what `destinationId` exists to
    // avoid comparing.
    destinationId: false,
    // No "what's nearby" list with claimed distances in the server HTML.
    nearbyLandmarks: false,
  },

  handles(url: URL): boolean {
    return parseRoomUrl(url) !== null;
  },

  canonicalize,
  extractIdentity: extractAirbnbIdentity,
  extractContext,
  /**
   * Airbnb's amenity taxonomy names the parking cases directly: "Free parking
   * on premises" versus "Free street parking" — the latter being exactly the
   * free parking nobody can promise. Amenity strings are served in the page
   * language; this reads the English forms and reports unknown otherwise,
   * which the panel states as "could not check" rather than passing.
   * Cancellation and payment are not in the server HTML (and Airbnb payment is
   * on-platform, so a bank-transfer demand cannot appear in a listing).
   */
  extractTerms(doc: Document): ListingTerms {
    const text = doc.body?.textContent ?? '';
    const freeStreet = /Free street parking/i.test(text);
    const freePrivate = /Free (?:parking on premises|carport|residential garage|driveway parking)/i.test(text);
    const paidOnly = /Paid parking/i.test(text) && !freeStreet && !freePrivate;

    if (!freeStreet && !freePrivate && !paidOnly) return {};
    if (freePrivate) return { parking: { advertisedFree: true, kind: 'private' } };
    if (freeStreet) {
      return {
        parking: {
          advertisedFree: true,
          kind: 'public',
          quote: 'Free street parking',
        },
      };
    }
    return { parking: { advertisedFree: false } };
  },

  normalizePhotoUrl,
};
