// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  airbnbAdapter,
  extractAirbnbIdentity,
  listingIdFromIdentifier,
  normalizePhotoUrl,
  parseRoomUrl,
} from './airbnb';

// vitest runs with the project root as cwd (import.meta.url is not a file: URL
// under the jsdom environment).
const FIXTURE_DIR = join(process.cwd(), 'fixtures/live-airbnb');
const FIXTURE_TIMEOUT = 30_000; // jsdom parses ~0.6 MB per fixture

function parseHtml(html: string): Document {
  return new DOMParser().parseFromString(html, 'text/html');
}

const fixtureCache = new Map<string, Document>();
function fixture(file: string): Document {
  const cached = fixtureCache.get(file);
  if (cached) return cached;
  const doc = parseHtml(readFileSync(join(FIXTURE_DIR, file), 'utf8'));
  fixtureCache.set(file, doc);
  return doc;
}

const NOW = () => new Date('2026-08-11T12:00:00Z');
const CANONICAL_PHOTO = /^https:\/\/a0\.muscache\.com\/im\/pictures\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jpg$/;

/**
 * Ground truth recorded at capture time (2026-08-11) by parsing each fixture's
 * JSON-LD directly. Frozen with the fixtures; it does not drift with the live
 * site. Airbnb's markup is clean schema.org, so these are the JSON-LD values
 * verbatim rather than anything reconstructed.
 */
interface Expected {
  name: string;
  /**
   * True when `name` is the whole title, so the test can demand equality. The
   * Tokyo listing's title runs past what was recorded, and only its opening is
   * ground truth — a prefix check there, an exact check everywhere else.
   */
  nameIsComplete: boolean;
  listingId: string;
  city: string;
  lat: number;
  lng: number;
  reviewCount: number;
  /** First and last entry of the JSON-LD `image[]`, reduced to their UUIDs. */
  firstPhotoUuid: string;
  lastPhotoUuid: string;
}

const FIXTURES: Record<string, Expected> = {
  'fr-paris-montmartre.en.html': {
    name: 'A/C flat with terrace – sleeps 8 – Montmartre',
    nameIsComplete: true,
    listingId: '1725991277287663886',
    city: 'Paris',
    lat: 48.88367,
    lng: 2.34285,
    reviewCount: 1,
    firstPhotoUuid: '8fdbac5c-614f-4e68-9466-2711305a0ed6',
    lastPhotoUuid: 'b1edfa22-44f6-458b-9b59-6ad8e3822d5b',
  },
  'jp-tokyo2.en.html': {
    name: 'NEW OPEN / 4-minute walk from Minowabashi Station',
    nameIsComplete: false,
    listingId: '1725852994406924663',
    city: 'Taitō-ku',
    lat: 35.7297,
    lng: 139.7947,
    reviewCount: 2,
    firstPhotoUuid: '1404303c-3735-46b1-98ba-79d6c3f98c5f',
    lastPhotoUuid: '5ea19f95-7def-4274-9d30-c2967e5a5541',
  },
  'es-barcelona2.en.html': {
    name: 'New Cozy 1 Bedroom Apartment',
    nameIsComplete: true,
    listingId: '1704906788837184002',
    city: 'Barcelona',
    lat: 41.3728,
    lng: 2.1561,
    reviewCount: 8,
    firstPhotoUuid: 'cf86ba69-405a-456f-a99b-15c3af558bdd',
    lastPhotoUuid: 'ba29988e-54ec-4ff8-919b-4d7e1627bcb7',
  },
};

const FIXTURE_FILES = Object.keys(FIXTURES);

/** Minimal Airbnb-shaped page: JSON-LD plus the og: tags Airbnb emits. */
function roomPage(ld: unknown, meta: Record<string, string> = {}): Document {
  const tags = Object.entries(meta)
    .map(([property, content]) => `<meta property="${property}" content="${content}">`)
    .join('');
  return parseHtml(
    `<!doctype html><html><head>${tags}` +
      `<script type="application/ld+json">${JSON.stringify(ld)}</script>` +
      `</head><body></body></html>`,
  );
}

const MINIMAL_LD = {
  '@context': 'https://schema.org',
  '@type': 'VacationRental',
  name: 'Somewhere To Stay',
  latitude: 48.85,
  longitude: 2.35,
  address: { addressLocality: 'Paris' },
};

// ---------------------------------------------------------------------------
// URLs
// ---------------------------------------------------------------------------

const ROOM_ID = '1725991277287663886';
const CANONICAL_URL = `https://www.airbnb.com/rooms/${ROOM_ID}`;
const CDX_PREFIX = `airbnb.com/rooms/${ROOM_ID}`;

describe('canonicalize', () => {
  it.each([
    [
      'a real booking-flow URL with session and search params',
      `https://www.airbnb.com/rooms/${ROOM_ID}?adults=2&check_in=2026-11-27&check_out=2026-12-10&source_impression_id=p3_1754900000_abc#reviews`,
      { listingId: ROOM_ID },
    ],
    ['bare canonical form', CANONICAL_URL, { listingId: ROOM_ID }],
    ['trailing slash', `https://www.airbnb.com/rooms/${ROOM_ID}/`, { listingId: ROOM_ID }],
    ['uppercase host', `https://WWW.AirBnB.com/rooms/${ROOM_ID}`, { listingId: ROOM_ID }],
    ['http scheme and mobile subdomain', `http://m.airbnb.com/rooms/${ROOM_ID}`, { listingId: ROOM_ID }],
    ['an Airbnb Plus path', `https://www.airbnb.com/rooms/plus/${ROOM_ID}`, { listingId: ROOM_ID }],
    // The point of the whole exercise: one listing, many markets, one identity.
    ['a UK country domain', `https://www.airbnb.co.uk/rooms/${ROOM_ID}`, { listingId: ROOM_ID }],
    [
      'a French country domain carrying its locale',
      `https://www.airbnb.fr/rooms/${ROOM_ID}?locale=fr`,
      { listingId: ROOM_ID, locale: 'fr' },
    ],
    [
      'a three-label country domain with a regional locale',
      `https://www.airbnb.com.au/rooms/${ROOM_ID}/?locale=en-AU&adults=1`,
      { listingId: ROOM_ID, locale: 'en-au' },
    ],
    ['an .co.in country domain', `https://www.airbnb.co.in/rooms/${ROOM_ID}`, { listingId: ROOM_ID }],
    ['a bare ccTLD not in the match patterns', `https://www.airbnb.pl/rooms/${ROOM_ID}`, { listingId: ROOM_ID }],
  ])('canonicalizes %s', (_name, input, extra) => {
    const url = new URL(input);
    expect(airbnbAdapter.handles(url)).toBe(true);
    expect(airbnbAdapter.canonicalize(url)).toEqual({
      platform: 'airbnb',
      canonicalUrl: CANONICAL_URL,
      cdxPrefix: CDX_PREFIX,
      ...extra,
    });
  });

  it('gives two country domains of one listing the same identity', () => {
    const fr = airbnbAdapter.canonicalize(new URL(`https://www.airbnb.fr/rooms/${ROOM_ID}?locale=fr`));
    const uk = airbnbAdapter.canonicalize(new URL(`https://www.airbnb.co.uk/rooms/${ROOM_ID}?adults=4`));
    expect(fr?.canonicalUrl).toBe(uk?.canonicalUrl);
    expect(fr?.cdxPrefix).toBe(uk?.cdxPrefix);
  });

  it('reports no slug and no country code, because the URL carries neither', () => {
    // A name-shaped slug is what Engine A1 reads; an absent one must be absent,
    // not an empty string that reads as "the listing is called nothing".
    const listing = airbnbAdapter.canonicalize(new URL(CANONICAL_URL));
    expect(listing?.slug).toBeUndefined();
    // The ccTLD is the visitor's market, not the property's country.
    expect(listing?.countryCode).toBeUndefined();
  });

  it.each([
    // Vanity URLs redirect to a room id we cannot know without the network.
    ['a /h/ vanity path', 'https://www.airbnb.com/h/montmartre-terrace'],
    ['a /h/ vanity path on a country domain', 'https://www.airbnb.fr/h/montmartre-terrace'],
    ['a numeric id with junk appended', `https://www.airbnb.com/rooms/${ROOM_ID}-montmartre`],
    ['a non-numeric room segment', 'https://www.airbnb.com/rooms/abcdef'],
    ['an extra path segment after the id', `https://www.airbnb.com/rooms/${ROOM_ID}/photos`],
    ['the rooms index', 'https://www.airbnb.com/rooms/'],
    ['a search results page', 'https://www.airbnb.com/s/Paris--France/homes?adults=2'],
    ['an experiences page', 'https://www.airbnb.com/experiences/123456'],
    ['the host dashboard', 'https://www.airbnb.com/hosting/listings'],
    // Lookalike hosts must not inherit "this is a genuine listing" treatment.
    ['a lookalike host suffix', `https://www.airbnb.com.phishing.example/rooms/${ROOM_ID}`],
    ['a lookalike host prefix', `https://notairbnb.com/rooms/${ROOM_ID}`],
    ['a hyphenated lookalike host', `https://evil-airbnb.com/rooms/${ROOM_ID}`],
    ['a non-http scheme', `ftp://www.airbnb.com/rooms/${ROOM_ID}`],
  ])('does not handle %s', (_name, input) => {
    const url = new URL(input);
    expect(airbnbAdapter.handles(url)).toBe(false);
    expect(airbnbAdapter.canonicalize(url)).toBeNull();
  });

  it('ignores a locale parameter that is not locale-shaped', () => {
    const out = parseRoomUrl(new URL(`https://www.airbnb.com/rooms/${ROOM_ID}?locale=<script>`));
    expect(out).toEqual({ listingId: ROOM_ID });
  });
});

// ---------------------------------------------------------------------------
// photos
// ---------------------------------------------------------------------------

describe('normalizePhotoUrl', () => {
  const UUID = 'cf86ba69-405a-456f-a99b-15c3af558bdd';
  const CANONICAL = `https://a0.muscache.com/im/pictures/${UUID}.jpg`;

  it.each([
    [
      'a hosting photo with resize and quality params',
      `https://a0.muscache.com/im/pictures/hosting/Hosting-1704906788837184002/original/${UUID}.jpeg?im_w=720&width=720&quality=70`,
    ],
    [
      'the same asset served as webp from another edge host',
      `https://a1.muscache.com/im/pictures/hosting/Hosting-1704906788837184002/original/${UUID}.webp`,
    ],
    ['a prohost-api upload path', `https://a0.muscache.com/im/pictures/prohost-api/Hosting-U3RheTo0/original/${UUID}.jpeg`],
    ['the legacy flat form', `https://a0.muscache.com/im/pictures/${UUID}.jpg`],
    ['the older host path without /im/', `https://a0.muscache.com/pictures/${UUID}.jpg`],
    ['a protocol-relative source', `//a0.muscache.com/im/pictures/${UUID}.jpg`],
    // Archive captures rewrite the URL but the asset is the same asset.
    [
      'a wayback-rewritten source',
      `https://web.archive.org/web/20260101120000im_/https://a0.muscache.com/im/pictures/hosting/Hosting-1/original/${UUID}.jpeg`,
    ],
    ['an uppercase UUID', `https://a0.muscache.com/im/pictures/${UUID.toUpperCase()}.JPEG`],
  ])('reduces %s to the asset identity', (_name, input) => {
    expect(normalizePhotoUrl(input)).toBe(CANONICAL);
  });

  it.each([
    // Present on every Airbnb page: left in, it would be a photo that every
    // listing on the platform "shares".
    [
      'the site favicon',
      'https://a0.muscache.com/im/pictures/AirbnbPlatformAssets/AirbnbPlatformAssets-Favicons/original/d1fcc0b3-865f-485a-b28b-43ca0bf7c891.png?im_w=240',
    ],
    [
      'a platform UI asset under the lowercase directory',
      'https://a0.muscache.com/im/pictures/airbnb-platform-assets/AirbnbPlatformAssets-UserProfile/original/5347d650-16de-4f5a-a38e-700000000000.png',
    ],
    ['a host avatar', 'https://a0.muscache.com/im/pictures/user/User/original/5347d650-16de-4f5a-a38e-700000000000.jpeg'],
    ['a flat host avatar', 'https://a0.muscache.com/im/pictures/user/5347d650-16de-4f5a-a38e-700000000000.jpg'],
    ['a portrait asset', 'https://a0.muscache.com/im/Portrait/Avatars/original/5347d650-16de-4f5a-a38e-700000000000.jpg'],
    ['a video', `https://a0.muscache.com/videos/${UUID}.mp4`],
    ['a picture with a non-UUID filename', 'https://a0.muscache.com/im/pictures/hosting/logo.jpg'],
    ['another CDN entirely', `https://cf.bstatic.com/xdata/images/hotel/${UUID}.jpg`],
    ['a lookalike host', `https://a0.muscache.com.evil.example/im/pictures/${UUID}.jpg`],
    // The CDN name as a path segment on somebody else's host: an asset that is
    // not Airbnb's must not come back wearing an Airbnb asset identity.
    ['the CDN name used as a path on another host', `https://evil.example/muscache.com/im/pictures/${UUID}.jpg`],
    ['the CDN name in a query parameter', `https://evil.example/?src=muscache.com/im/pictures/${UUID}.jpg`],
    ['an empty string', ''],
    ['an absurdly long URL', `https://a0.muscache.com/im/pictures/${'a'.repeat(4000)}/${UUID}.jpg`],
  ])('rejects %s', (_name, input) => {
    expect(normalizePhotoUrl(input)).toBeNull();
  });

  it('is the adapter method as well as the export', () => {
    expect(airbnbAdapter.normalizePhotoUrl(`https://a0.muscache.com/im/pictures/${UUID}.jpg`)).toBe(CANONICAL);
  });
});

// ---------------------------------------------------------------------------
// identity, from the live fixtures
// ---------------------------------------------------------------------------

describe('extractIdentity on live Airbnb pages', () => {
  it.each(FIXTURE_FILES)(
    'reads the identity claimed by %s',
    (file) => {
      const expected = FIXTURES[file];
      const vector = airbnbAdapter.extractIdentity(fixture(file), { now: NOW });
      expect(vector).not.toBeNull();
      expect(vector!.platform).toBe('airbnb');
      if (expected.nameIsComplete) {
        expect(vector!.name).toBe(expected.name);
      } else {
        expect(vector!.name.startsWith(expected.name)).toBe(true);
      }
      expect(vector!.listingId).toBe(expected.listingId);
      expect(vector!.city).toBe(expected.city);
      expect(vector!.lat).toBeCloseTo(expected.lat, 5);
      expect(vector!.lng).toBeCloseTo(expected.lng, 5);
      expect(vector!.reviewScore).toBe(5);
      expect(vector!.reviewCount).toBe(expected.reviewCount);
      // 5, never 10: a diff putting this next to a Booking score must not read
      // the change of scale as a collapse in reputation.
      expect(vector!.reviewScoreMax).toBe(5);
      expect(vector!.propertyType).toBe('VacationRental');
      expect(vector!.capturedAt).toBe('2026-08-11T12:00:00.000Z');
      expect(vector!.source).toEqual({ kind: 'live' });
    },
    FIXTURE_TIMEOUT,
  );

  it.each(FIXTURE_FILES)(
    'reduces the gallery of %s to stable asset identities',
    (file) => {
      const expected = FIXTURES[file];
      const vector = airbnbAdapter.extractIdentity(fixture(file), { now: NOW })!;
      // The JSON-LD gallery is 8 photos and og:image repeats the first of them,
      // so the deduped result is 8 — not 9, and not one entry per <img> on the
      // page (avatars and UI icons live on the same CDN).
      expect(vector.photoUrls).toHaveLength(8);
      expect(new Set(vector.photoUrls).size).toBe(8);
      for (const url of vector.photoUrls) expect(url).toMatch(CANONICAL_PHOTO);
      // Both ends of the gallery, in JSON-LD order: the whole list is present
      // and in the page's own order, not a prefix that happens to start right.
      expect(vector.photoUrls[0]).toBe(
        `https://a0.muscache.com/im/pictures/${expected.firstPhotoUuid}.jpg`,
      );
      expect(vector.photoUrls[7]).toBe(
        `https://a0.muscache.com/im/pictures/${expected.lastPhotoUuid}.jpg`,
      );
    },
    FIXTURE_TIMEOUT,
  );

  it(
    'leaves the street address empty rather than inventing one',
    () => {
      // Airbnb withholds the street until a booking is confirmed. Empty means
      // "not published"; the coordinates carry the location claim.
      const vector = airbnbAdapter.extractIdentity(fixture(FIXTURE_FILES[0]), { now: NOW })!;
      expect(vector.address).toBe('');
      expect(vector.country).toBeUndefined();
      expect(vector.destinationId).toBeUndefined();
    },
    FIXTURE_TIMEOUT,
  );

  it(
    'takes the numeric room id, not the base64 identifier',
    () => {
      const vector = airbnbAdapter.extractIdentity(fixture(FIXTURE_FILES[0]), { now: NOW })!;
      // The generic reader would hand back the raw `identifier`; that value
      // would never match the id the URL, the canonical listing and the archive
      // prefix all key on.
      expect(vector.listingId).toBe(ROOM_ID);
      expect(vector.listingId).toBe(
        airbnbAdapter.canonicalize(new URL(CANONICAL_URL))?.listingId,
      );
    },
    FIXTURE_TIMEOUT,
  );
});

describe('extractContext on live Airbnb pages', () => {
  it(
    'returns the description and nothing it cannot honestly claim',
    () => {
      const context = airbnbAdapter.extractContext(fixture('fr-paris-montmartre.en.html'));
      expect(context.description?.startsWith('📌 Checkmyguest offers you a superb')).toBe(true);
      // The server HTML has no breadcrumb trail, no landmark list and no review
      // nodes. Empty is the honest answer; fabricated structure would be scored.
      expect(context.breadcrumbs).toEqual([]);
      expect(context.pois).toEqual([]);
      expect(context.reviews).toEqual([]);
    },
    FIXTURE_TIMEOUT,
  );

  it.each(FIXTURE_FILES)(
    'declares that %s publishes no individual reviews, rather than implying it has none',
    (file) => {
      const reviewSet = airbnbAdapter.extractContext(fixture(file)).reviewSet!;

      // The distinction this whole field exists for. Airbnb fetches reviews
      // client-side, so the page HTML carries zero `Review` nodes on all seven
      // captures — while every one of them publishes an aggregate. Reporting a
      // bare empty list would read as "nobody has reviewed this property",
      // which is false on every one of them.
      expect(reviewSet.availability).toBe('not-in-page');
      expect(reviewSet.items).toEqual([]);
      // 5 of 5 as published, 10 of 10 as the contract carries it, so no panel
      // row can put an Airbnb 4.9 beside a Booking 9.2 as if they matched.
      expect(reviewSet.summary).toEqual({ score: 10, total: FIXTURES[file].reviewCount });
    },
    FIXTURE_TIMEOUT,
  );

  it(
    'leaves the description undefined when the listing publishes none',
    () => {
      // Barcelona's JSON-LD carries no `description`. meta[name=description]
      // exists but is date-prefixed ("Aug 11, 2026 · Entire rental unit"), so
      // using it would make an unchanged listing differ from itself every day.
      const context = airbnbAdapter.extractContext(fixture('es-barcelona2.en.html'));
      expect(context.description).toBeUndefined();
    },
    FIXTURE_TIMEOUT,
  );
});

// ---------------------------------------------------------------------------
// the identifier cross-check
// ---------------------------------------------------------------------------

describe('listingIdFromIdentifier', () => {
  it('decodes the GraphQL node id Airbnb publishes', () => {
    // base64("DemandStayListing:1725991277287663886")
    expect(listingIdFromIdentifier('RGVtYW5kU3RheUxpc3Rpbmc6MTcyNTk5MTI3NzI4NzY2Mzg4Ng==')).toBe(ROOM_ID);
  });

  it.each([
    ['malformed base64', '!!!not base64!!!'],
    ['base64 of an unrelated string', btoa('SomethingElse:12345')],
    ['base64 of the right prefix with a non-numeric id', btoa('DemandStayListing:abc')],
    ['an empty string', ''],
    ['an absurdly long value', 'A'.repeat(5000)],
    ['nothing at all', undefined],
  ])('returns undefined for %s and never throws', (_name, input) => {
    expect(listingIdFromIdentifier(input)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// hostile and degraded input
// ---------------------------------------------------------------------------

describe('hostile and degraded input', () => {
  it('returns null for a page with no lodging markup', () => {
    expect(extractAirbnbIdentity(parseHtml('<!doctype html><html><body>hi</body></html>'))).toBeNull();
  });

  it('returns null rather than throwing on unparseable JSON-LD', () => {
    const doc = parseHtml(
      '<!doctype html><script type="application/ld+json">{"@type": "VacationRental",</script>',
    );
    expect(() => extractAirbnbIdentity(doc)).not.toThrow();
    expect(extractAirbnbIdentity(doc)).toBeNull();
  });

  it('returns null when the markup names no property', () => {
    const doc = roomPage({ '@context': 'https://schema.org', '@type': 'VacationRental', latitude: 48.85 });
    expect(extractAirbnbIdentity(doc)).toBeNull();
  });

  it('keeps empty-string numbers missing instead of turning them into zero', () => {
    // A missing coordinate that became 0,0 would put the property on null
    // island; a missing review count that became 0 would read as "brand new".
    const doc = roomPage({
      '@context': 'https://schema.org',
      '@type': 'VacationRental',
      name: 'Somewhere To Stay',
      latitude: '',
      longitude: '',
      aggregateRating: { '@type': 'AggregateRating', ratingValue: '', ratingCount: '' },
    });
    const vector = extractAirbnbIdentity(doc, { now: NOW })!;
    expect(vector.lat).toBeUndefined();
    expect(vector.lng).toBeUndefined();
    expect(vector.reviewCount).toBeUndefined();
    expect(vector.reviewScore).toBeUndefined();
    // The scale is a property of the platform, not of this listing's rating.
    expect(vector.reviewScoreMax).toBe(5);
  });

  it('reads the listing id from og:url when the document has no browsing context', () => {
    const doc = roomPage(MINIMAL_LD, { 'og:url': `https://www.airbnb.co.uk/rooms/${ROOM_ID}?locale=en` });
    expect(extractAirbnbIdentity(doc, { now: NOW })!.listingId).toBe(ROOM_ID);
  });

  it('falls back to the identifier when the page declares no URL', () => {
    const doc = roomPage({ ...MINIMAL_LD, identifier: 'RGVtYW5kU3RheUxpc3Rpbmc6MTcyNTk5MTI3NzI4NzY2Mzg4Ng==' });
    expect(extractAirbnbIdentity(doc, { now: NOW })!.listingId).toBe(ROOM_ID);
  });

  it('reads the id of an archived capture whose og:url the archive rewrote', () => {
    // The real archive path. Wayback rewrites every URL in the body, so og:url
    // arrives pointing at web.archive.org and the document is parsed in the
    // offscreen page, whose doc.URL is the extension's own. The identifier is
    // then the only surviving source, and it has to match what the live side
    // read from the address bar or B.listingId withdraws the comparison.
    const doc = roomPage(
      { ...MINIMAL_LD, identifier: 'RGVtYW5kU3RheUxpc3Rpbmc6MTcyNTk5MTI3NzI4NzY2Mzg4Ng==' },
      { 'og:url': `https://web.archive.org/web/20260101120000/https://www.airbnb.com/rooms/${ROOM_ID}` },
    );
    expect(extractAirbnbIdentity(doc, { now: NOW })!.listingId).toBe(ROOM_ID);
  });

  it('leaves the id missing rather than falling back to an identifier it cannot decode', () => {
    // An id in a foreign namespace is worse than none: the live side always has
    // the numeric room id from the address bar, so a raw base64 blob here would
    // read as "the two captures are different listings" and withdraw every
    // other comparison. Undefined is GRAY; disagreeing is a false conclusion.
    const doc = roomPage({ ...MINIMAL_LD, identifier: btoa('SomethingElse:12345') });
    expect(extractAirbnbIdentity(doc, { now: NOW })!.listingId).toBeUndefined();
  });

  it('drops a review score that is impossible on a 5-point scale', () => {
    // Airbnb cannot serve 9.6 out of 5. Kept beside reviewScoreMax 5 it would
    // normalise to 1.9 and read as a reputation no platform can award.
    const doc = roomPage({
      ...MINIMAL_LD,
      aggregateRating: { '@type': 'AggregateRating', ratingValue: 9.6, ratingCount: 120 },
    });
    const vector = extractAirbnbIdentity(doc, { now: NOW })!;
    expect(vector.reviewScore).toBeUndefined();
    expect(vector.reviewScoreMax).toBe(5);
    // The count is a plain tally and survives; only the out-of-scale score goes.
    expect(vector.reviewCount).toBe(120);
  });

  it('keeps a score that is in range, including the ends of the scale', () => {
    for (const ratingValue of [0, 4.87, 5]) {
      const doc = roomPage({
        ...MINIMAL_LD,
        aggregateRating: { '@type': 'AggregateRating', ratingValue, ratingCount: 3 },
      });
      expect(extractAirbnbIdentity(doc, { now: NOW })!.reviewScore).toBe(ratingValue);
    }
  });

  it('falls back to og:image when the markup publishes no gallery', () => {
    const doc = roomPage(MINIMAL_LD, {
      'og:image': `https://a0.muscache.com/im/pictures/hosting/Hosting-${ROOM_ID}/original/cf86ba69-405a-456f-a99b-15c3af558bdd.jpeg?im_w=720`,
    });
    expect(extractAirbnbIdentity(doc, { now: NOW })!.photoUrls).toEqual([
      'https://a0.muscache.com/im/pictures/cf86ba69-405a-456f-a99b-15c3af558bdd.jpg',
    ]);
  });

  it('prefers the browser-supplied document URL over a forged og:url', () => {
    // og:url is markup a hijacker controls. A forged listing id is not
    // cosmetic: the diff withdraws the whole archive comparison when the two
    // sides' ids disagree, so a page that lies about its id would switch off
    // the checks against its own history.
    const doc = roomPage(MINIMAL_LD, { 'og:url': 'https://www.airbnb.com/rooms/999999999' });
    Object.defineProperty(doc, 'URL', { value: CANONICAL_URL, configurable: true });
    expect(extractAirbnbIdentity(doc, { now: NOW })!.listingId).toBe(ROOM_ID);
  });

  it('ignores an og:url pointing at a non-Airbnb host', () => {
    const doc = roomPage(MINIMAL_LD, { 'og:url': 'https://evil.example/rooms/999999999' });
    expect(extractAirbnbIdentity(doc, { now: NOW })!.listingId).toBeUndefined();
  });

  it('keeps a hostile gallery bounded and free of non-listing assets', () => {
    const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
    const images = [
      'https://a0.muscache.com/im/pictures/user/User/original/11111111-1111-4111-8111-111111111111.jpeg',
      'javascript:alert(1)',
      ...Array.from({ length: 500 }, (_, i) => `https://a0.muscache.com/im/pictures/${uuid(i)}.jpg`),
    ];
    const doc = roomPage({ ...MINIMAL_LD, image: images });
    const vector = extractAirbnbIdentity(doc, { now: NOW })!;
    // Exactly the cap, not "something under it": 500 distinct photos are on
    // offer, so a smaller number would mean entries were being dropped for some
    // other reason and a larger one that the bound is not holding.
    expect(vector.photoUrls).toHaveLength(60);
    expect(new Set(vector.photoUrls).size).toBe(60);
    for (const url of vector.photoUrls) expect(url).toMatch(CANONICAL_PHOTO);
  });

  it('extractContext never throws on a document with no markup at all', () => {
    const doc = parseHtml('<!doctype html><html><body></body></html>');
    expect(airbnbAdapter.extractContext(doc)).toEqual({
      breadcrumbs: [],
      pois: [],
      reviews: [],
      // No aggregate to report either — `summary` is omitted rather than
      // carrying a zero score for a property nobody has rated.
      reviewSet: { availability: 'not-in-page', items: [] },
    });
  });

  it('withholds an aggregate score Airbnb could not have published', () => {
    // 9.6 out of 5 is broken or forged markup. Doubling it to a 19.2 on the
    // contract's 0-10 scale would be a spectacular reputation invented from
    // nonsense, so the score is dropped while the count survives.
    const doc = roomPage({ ...MINIMAL_LD, aggregateRating: { ratingValue: 9.6, ratingCount: 120 } });
    expect(airbnbAdapter.extractContext(doc).reviewSet!.summary).toEqual({ total: 120 });
  });
});

// ---------------------------------------------------------------------------
// the contract the engines read
// ---------------------------------------------------------------------------

describe('capabilities', () => {
  it('declares that Airbnb URLs carry no name', () => {
    // `/rooms/1725991277287663886` has no slug to compare against the displayed
    // name, so Engine A1 must skip the platform rather than compare a number
    // against a title and call every honest listing a mismatch.
    expect(airbnbAdapter.capabilities.nameBearingUrl).toBe(false);
    expect(airbnbAdapter.capabilities.destinationId).toBe(false);
    expect(airbnbAdapter.capabilities.nearbyLandmarks).toBe(false);
  });

  it('scopes every match pattern to room pages on an Airbnb host', () => {
    expect(airbnbAdapter.matchPatterns.length).toBeGreaterThan(0);
    for (const pattern of airbnbAdapter.matchPatterns) {
      expect(pattern).toMatch(/^\*:\/\/\*\.airbnb\.[a-z.]+\/rooms\/\*$/);
    }
    // Every declared pattern must be a URL the adapter actually handles;
    // a pattern nobody claims is an unexplained host permission.
    for (const pattern of airbnbAdapter.matchPatterns) {
      const host = pattern.replace('*://*.', 'www.').replace('/rooms/*', '');
      expect(airbnbAdapter.handles(new URL(`https://${host}/rooms/${ROOM_ID}`))).toBe(true);
    }
  });

  it('identifies itself for evidence provenance', () => {
    expect(airbnbAdapter.id).toBe('airbnb');
    expect(airbnbAdapter.label).toBe('Airbnb');
  });
});
