// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { analyzeFirstPass } from './pipeline';
import { adapterForDocument, adapterForUrl } from '../lib/sites/registry';
import type { Geocoder, GeocodeResult } from '../lib/geocoder';

/**
 * The generalisation acceptance test: the same engines, scorer and panel must
 * work on a second platform whose markup and URLs have nothing in common with
 * the first.
 *
 * Airbnb is the useful second case precisely because it breaks Booking's
 * assumptions — opaque `/rooms/<id>` URLs with no name to fossilise, clean
 * schema.org markup with top-level coordinates, a 5-point rating scale, and no
 * landmark list. If the abstraction is real, none of the engines needed to know
 * any of that.
 */

const AIRBNB_DIR = join(process.cwd(), 'fixtures/live-airbnb');

interface Expected {
  file: string;
  url: string;
  name: string;
  city: string;
  lat: number;
  lng: number;
  listingId: string;
}

/** Measured from the captured pages, not from what the code returns. */
const FIXTURES: Expected[] = [
  {
    file: 'fr-paris-montmartre.en.html',
    url: 'https://www.airbnb.com/rooms/1725991277287663886',
    name: 'A/C flat with terrace – sleeps 8 – Montmartre',
    city: 'Paris',
    lat: 48.88367,
    lng: 2.34285,
    listingId: '1725991277287663886',
  },
  {
    file: 'jp-tokyo2.en.html',
    url: 'https://www.airbnb.com/rooms/1725852994406924663',
    name: 'NEW OPEN',
    city: 'Taitō-ku',
    lat: 35.7297,
    lng: 139.7947,
    listingId: '1725852994406924663',
  },
  {
    file: 'es-barcelona2.en.html',
    url: 'https://www.airbnb.com/rooms/1704906788837184002',
    name: 'New Cozy 1 Bedroom Apartment',
    city: 'Barcelona',
    lat: 41.3728,
    lng: 2.1561,
    listingId: '1704906788837184002',
  },
  {
    file: 'it-roma-1.html',
    url: 'https://www.airbnb.com/rooms/1736387261430847289',
    name: 'Claire de Lune',
    city: 'Rome',
    lat: 41.8974,
    lng: 12.4724,
    listingId: '1736387261430847289',
  },
  {
    file: 'it-roma-2.html',
    url: 'https://www.airbnb.com/rooms/1600030586695407460',
    name: "Historic apartment in Campo de' Fi",
    city: 'Rome',
    lat: 41.8969,
    lng: 12.4705,
    listingId: '1600030586695407460',
  },
  {
    file: 'br-rio-1.html',
    url: 'https://www.airbnb.com/rooms/1715357532731129387',
    name: 'IPA Apartment',
    city: 'Rio de Janeiro',
    lat: -22.9855,
    lng: -43.2076,
    listingId: '1715357532731129387',
  },
  {
    file: 'br-rio-2.html',
    url: 'https://www.airbnb.com/rooms/1581922106059514513',
    name: 'Copacabana Suite',
    city: 'Rio de Janeiro',
    lat: -22.9707,
    lng: -43.1854,
    listingId: '1581922106059514513',
  },
];

function parse(file: string): Document {
  return new DOMParser().parseFromString(readFileSync(join(AIRBNB_DIR, file), 'utf8'), 'text/html');
}

function agreeableGeocoder(at: { lat: number; lng: number }): Geocoder {
  return {
    async geocode(query: string): Promise<GeocodeResult | null> {
      return { ...at, displayName: query };
    },
  };
}

describe('the registry routes a page to the right adapter', () => {
  it.each(FIXTURES.map((f) => [f.file, f] as const))('%s is claimed by airbnb', (_f, fixture) => {
    expect(adapterForUrl(fixture.url)?.id).toBe('airbnb');
    expect(adapterForDocument(fixture.url, parse(fixture.file))?.id).toBe('airbnb');
  });

  it('routes a Booking URL to the booking adapter', () => {
    expect(adapterForUrl('https://www.booking.com/hotel/fr/x.en-gb.html')?.id).toBe('booking');
  });

  it('claims nothing for a page that is not a listing at all', () => {
    const doc = new DOMParser().parseFromString('<h1>A blog post</h1>', 'text/html');
    expect(adapterForDocument('https://example.com/blog', doc)).toBeUndefined();
  });

  it('falls back to the generic adapter for an unknown site with lodging markup', () => {
    const doc = new DOMParser().parseFromString(
      `<script type="application/ld+json">
        {"@context":"https://schema.org","@type":"Hotel","name":"Pension Example",
         "address":{"addressLocality":"Graz","addressCountry":"AT"},
         "geo":{"latitude":47.0707,"longitude":15.4395}}
       </script>`,
      'text/html',
    );
    const adapter = adapterForDocument('https://pension-example.at/zimmer/12', doc);
    expect(adapter?.id).toBe('generic');
    const identity = adapter!.extractIdentity(doc)!;
    expect(identity.name).toBe('Pension Example');
    expect(identity.city).toBe('Graz');
    expect(identity.lat).toBeCloseTo(47.0707, 4);
  });
});

describe('Airbnb extraction on real captured pages', () => {
  it.each(FIXTURES.map((f) => [f.file, f] as const))('%s', (_f, fixture) => {
    const adapter = adapterForUrl(fixture.url)!;
    const identity = adapter.extractIdentity(parse(fixture.file))!;

    expect(identity).not.toBeNull();
    expect(identity.platform).toBe('airbnb');
    expect(identity.name).toContain(fixture.name);
    expect(identity.city).toBe(fixture.city);
    expect(identity.lat).toBeCloseTo(fixture.lat, 4);
    expect(identity.lng).toBeCloseTo(fixture.lng, 4);
    // The rating scale must travel with the score, or a cross-platform diff
    // reads Airbnb's 5 against Booking's 10 as a collapse in reputation.
    expect(identity.reviewScoreMax).toBe(5);
    expect(identity.photoUrls.length).toBeGreaterThan(0);
  }, 30_000);

  it('canonicalises country domains and query strings to one URL', () => {
    const adapter = adapterForUrl('https://www.airbnb.com/rooms/123')!;
    const forms = [
      'https://www.airbnb.com/rooms/123',
      'https://www.airbnb.co.uk/rooms/123?adults=2&check_in=2026-01-01',
      'https://www.airbnb.fr/rooms/123/',
      'https://airbnb.com/rooms/123#photos',
    ];
    const canonical = forms.map((u) => adapterForUrl(u)?.canonicalize(new URL(u))?.canonicalUrl);
    // Two captures of one listing from two country domains must compare equal,
    // or Engine B diffs a listing against itself and calls it a change.
    expect(new Set(canonical).size, `got ${JSON.stringify(canonical)}`).toBe(1);
    expect(adapter.canonicalize(new URL(forms[1]))?.listingId).toBe('123');
  });
});

describe('Airbnb terms: the free parking nobody can promise', () => {
  it('flags "Free street parking" on the Rome fixture — the exact case in the wild', () => {
    const fixture = FIXTURES.find((f) => f.file === 'it-roma-2.html')!;
    const adapter = adapterForUrl(fixture.url)!;
    const terms = adapter.extractTerms?.(parse(fixture.file));
    expect(terms?.parking).toEqual({
      advertisedFree: true,
      kind: 'public',
      quote: 'Free street parking',
    });
  }, 30_000);

  it('stays silent on paid-only parking rather than inventing a free claim', () => {
    const fixture = FIXTURES.find((f) => f.file === 'es-barcelona2.en.html')!;
    const adapter = adapterForUrl(fixture.url)!;
    const terms = adapter.extractTerms?.(parse(fixture.file));
    expect(terms?.parking?.advertisedFree).toBe(false);
  }, 30_000);
});

describe('a generic page is actually analysed, not silently passed', () => {
  const GENERIC_URL = 'https://pension-example.at/zimmer/12';
  const genericDoc = (): Document =>
    new DOMParser().parseFromString(
      `<script type="application/ld+json">
        {"@context":"https://schema.org","@type":"Hotel","name":"Pension Example",
         "address":{"addressLocality":"Graz"},
         "geo":{"latitude":47.0707,"longitude":15.4395}}
       </script>`,
      'text/html',
    );

  /**
   * Regression test for a false GREEN.
   *
   * The worker used to re-resolve the adapter from the URL alone, and no
   * adapter owns a generic URL — so `canonical` came back null, Engine A
   * skipped its `if (canonical)` block, and the listing scored a confident
   * GREEN with nothing checked. The generic adapter is what makes "any listing
   * site" true, so that turned the headline feature into a rubber stamp. The
   * canonical identity now travels in the message from the content script,
   * which is the only place that knows which adapter claimed the page.
   */
  /** Enough landmarks for A2 to speak at all (A2_MIN_GEOCODED_POIS). */
  const GRAZ_LANDMARKS = [
    { name: 'Uhrturm', statedDistanceKm: 0.3 },
    { name: 'Schlossberg', statedDistanceKm: 0.4 },
    { name: 'Kunsthaus Graz', statedDistanceKm: 0.6 },
  ];

  it('runs Engine A instead of scoring an unchecked GREEN', async () => {
    const doc = genericDoc();
    const adapter = adapterForDocument(GENERIC_URL, doc)!;
    const identity = adapter.extractIdentity(doc)!;
    const geocoded: string[] = [];

    const { result, scoring } = await analyzeFirstPass(
      {
        type: 'LISTING_DETECTED',
        vector: identity,
        url: GENERIC_URL,
        canonical: adapter.canonicalize(new URL(GENERIC_URL)) ?? undefined,
        context: { ...adapter.extractContext(doc), pois: GRAZ_LANDMARKS },
      },
      {
        geocoder: {
          async geocode(query: string): Promise<GeocodeResult | null> {
            geocoded.push(query);
            return { lat: 47.0707, lng: 15.4395, displayName: query };
          },
        },
      },
    );

    // The engine ran on the page's own claims, and the score carries a coverage
    // report rather than an empty confidence.
    expect(geocoded, 'Engine A never geocoded anything').not.toHaveLength(0);
    expect(scoring.inputs?.poiCount).toBe(GRAZ_LANDMARKS.length);
    expect(result.verdict).toBeDefined();
  }, 30_000);

  it('catches a relocated generic listing through Engine A2', async () => {
    // The proof that the generic path is load-bearing rather than decorative:
    // the page keeps Graz's neighbourhood copy while sitting in Barcelona, and
    // A2 has to say so on a site no adapter was ever written for.
    const doc = genericDoc();
    const adapter = adapterForDocument(GENERIC_URL, doc)!;
    const live = { ...adapter.extractIdentity(doc)!, lat: 41.3728, lng: 2.1561 };

    const { result } = await analyzeFirstPass(
      {
        type: 'LISTING_DETECTED',
        vector: live,
        url: GENERIC_URL,
        canonical: adapter.canonicalize(new URL(GENERIC_URL)) ?? undefined,
        context: { ...adapter.extractContext(doc), pois: GRAZ_LANDMARKS },
      },
      {
        // Every landmark really is in Graz — 1300 km from where the listing says
        // it is, against the few hundred metres the page claims.
        geocoder: agreeableGeocoder({ lat: 47.0707, lng: 15.4395 }),
      },
    );

    expect(result.signals.map((s) => s.id)).toContain('A2');
    expect(result.verdict).toBe('RED');
  }, 30_000);
});

describe('the engines work unchanged on the second platform', () => {
  it.each(FIXTURES.map((f) => [f.file, f] as const))(
    '%s reaches a verdict without a false accusation',
    async (_f, fixture) => {
      const doc = parse(fixture.file);
      const adapter = adapterForUrl(fixture.url)!;
      const identity = adapter.extractIdentity(doc)!;

      const { result } = await analyzeFirstPass(
        {
          type: 'LISTING_DETECTED',
          vector: identity,
          url: fixture.url,
          context: adapter.extractContext(doc),
        },
        { geocoder: agreeableGeocoder({ lat: identity.lat!, lng: identity.lng! }) },
      );

      expect(result.verdict).not.toBe('RED');
      // A1 must stay silent: these URLs carry no name, so there is no fossil to
      // compare and inventing one would flag every honest Airbnb listing.
      expect(result.signals.map((s) => s.id)).not.toContain('A1');
    },
    30_000,
  );

  it('no real Airbnb listing is accused — the false-positive budget', async () => {
    // Same standard the Booking corpus is held to in acceptance.test.ts: a
    // fraud warning on a legitimate business is the failure that matters most,
    // so the budget across the whole corpus is zero.
    const verdicts = await Promise.all(
      FIXTURES.map(async (fixture) => {
        const doc = parse(fixture.file);
        const adapter = adapterForUrl(fixture.url)!;
        const identity = adapter.extractIdentity(doc)!;
        const { result } = await analyzeFirstPass(
          {
            type: 'LISTING_DETECTED',
            vector: identity,
            url: fixture.url,
            canonical: adapter.canonicalize(new URL(fixture.url)) ?? undefined,
            context: adapter.extractContext(doc),
          },
          { geocoder: agreeableGeocoder({ lat: identity.lat!, lng: identity.lng! }) },
        );
        return { file: fixture.file, verdict: result.verdict };
      }),
    );
    const reds = verdicts.filter((v) => v.verdict === 'RED');
    expect(reds, `flagged: ${JSON.stringify(reds)}`).toHaveLength(0);
  }, 120_000);

  it('a relocated Airbnb listing is caught by geography, not by its URL', async () => {
    // The platform changes; the detection does not. A1 cannot speak here —
    // `/rooms/<id>` carries no name — so this is A2 alone, on a page whose
    // markup has nothing in common with Booking's.
    const doc = parse(FIXTURES[0].file);
    const adapter = adapterForUrl(FIXTURES[0].url)!;
    const live = adapter.extractIdentity(doc)!;

    const { result } = await analyzeFirstPass(
      {
        type: 'LISTING_DETECTED',
        vector: live,
        url: FIXTURES[0].url,
        canonical: adapter.canonicalize(new URL(FIXTURES[0].url)) ?? undefined,
        context: {
          ...adapter.extractContext(doc),
          // The listing keeps the previous property's neighbourhood copy: it
          // still claims Montmartre is around the corner.
          pois: [
            { name: 'Sacré-Cœur', statedDistanceKm: 0.5 },
            { name: 'Moulin Rouge', statedDistanceKm: 0.7 },
            { name: 'Place du Tertre', statedDistanceKm: 0.3 },
          ],
        },
      },
      // …while every one of them geocodes to Barcelona, 1000 km from the
      // coordinates the page publishes for itself.
      { geocoder: agreeableGeocoder({ lat: 41.3728, lng: 2.1561 }) },
    );

    expect(result.signals.map((s) => s.id)).toContain('A2');
    expect(result.verdict).toBe('RED');
    expect(result.signals.map((s) => s.id)).not.toContain('A1');
  }, 30_000);
});
