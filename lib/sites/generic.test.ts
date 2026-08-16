// @vitest-environment jsdom
/**
 * The generic adapter is the only extractor that runs against markup nobody has
 * inspected, so these documents are built by hand to cover every shape standard
 * lodging markup takes in the wild — and every shape a hostile page can take.
 *
 * No fixtures here on purpose: fixtures pin one platform's quirks, and the
 * whole point of this adapter is the shapes it has never seen.
 */
import { describe, expect, it } from 'vitest';
import { genericAdapter, normalizePhotoUrl, readSchemaOrgLodging } from './generic';

const NOW = () => new Date('2026-08-11T12:00:00Z');

function docFrom(html: string): Document {
  return new DOMParser().parseFromString(html, 'text/html');
}

/** A document whose head carries the given JSON-LD blocks plus optional meta. */
function ldDoc(blocks: unknown[], head = ''): Document {
  const scripts = blocks
    .map((b) => `<script type="application/ld+json">${typeof b === 'string' ? b : JSON.stringify(b)}</script>`)
    .join('');
  return docFrom(`<!doctype html><html><head>${head}${scripts}</head><body></body></html>`);
}

/** The minimum that makes a node count as lodging. */
function hotel(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { '@context': 'https://schema.org', '@type': 'Hotel', name: 'Hotel Bellevue', ...extra };
}

// ---------------------------------------------------------------------------
// readSchemaOrgLodging — accepted types and nesting
// ---------------------------------------------------------------------------

describe('readSchemaOrgLodging: which nodes count as lodging', () => {
  it.each([
    'Hotel', 'Hostel', 'Motel', 'Resort', 'BedAndBreakfast', 'Apartment',
    'House', 'VacationRental', 'LodgingBusiness', 'Campground', 'Accommodation',
    'SingleFamilyResidence',
  ])('accepts @type %s and reports it as the property type', (type) => {
    const lodging = readSchemaOrgLodging(ldDoc([hotel({ '@type': type })]));
    expect(lodging?.name).toBe('Hotel Bellevue');
    expect(lodging?.propertyType).toBe(type);
  });

  it('ignores nodes that are not lodging', () => {
    expect(readSchemaOrgLodging(ldDoc([{ '@type': 'Restaurant', name: 'Chez Nous' }]))).toBeUndefined();
    expect(readSchemaOrgLodging(ldDoc([{ '@type': 'Organization', name: 'Acme' }]))).toBeUndefined();
  });

  it('accepts @type as an array of strings', () => {
    const lodging = readSchemaOrgLodging(ldDoc([hotel({ '@type': ['Product', 'VacationRental'] })]));
    expect(lodging?.propertyType).toBe('VacationRental');
  });

  it('finds a lodging node inside @graph', () => {
    const doc = ldDoc([{
      '@context': 'https://schema.org',
      '@graph': [
        { '@type': 'WebSite', name: 'Somewhere.example' },
        { '@type': 'BreadcrumbList', itemListElement: [] },
        hotel({ name: 'Graph Guesthouse' }),
      ],
    }]);
    expect(readSchemaOrgLodging(doc)?.name).toBe('Graph Guesthouse');
  });

  it('finds a lodging node inside a nested @graph', () => {
    const doc = ldDoc([{ '@graph': [{ '@graph': [hotel({ name: 'Nested Inn' })] }] }]);
    expect(readSchemaOrgLodging(doc)?.name).toBe('Nested Inn');
  });

  it('reads a top-level array of nodes', () => {
    const doc = ldDoc([[{ '@type': 'Organization', name: 'Acme' }, hotel({ name: 'Array Inn' })]]);
    expect(readSchemaOrgLodging(doc)?.name).toBe('Array Inn');
  });

  it('skips a malformed block and still reads a later valid one', () => {
    const doc = ldDoc(['{ this is not json', '', hotel({ name: 'Survivor Lodge' })]);
    expect(readSchemaOrgLodging(doc)?.name).toBe('Survivor Lodge');
  });

  it.each([
    ['truncated JSON', '{"@type":"Hotel","name":'],
    ['a bare string', '"just a string"'],
    ['null', 'null'],
    ['a number', '42'],
    ['an empty array', '[]'],
  ])('never throws on %s', (_label, body) => {
    expect(() => readSchemaOrgLodging(ldDoc([body]))).not.toThrow();
    expect(readSchemaOrgLodging(ldDoc([body]))).toBeUndefined();
  });

  it('returns undefined when the page has no markup at all', () => {
    expect(readSchemaOrgLodging(docFrom('<!doctype html><html><body>hi</body></html>'))).toBeUndefined();
  });

  it('reads the first lodging node when a page carries several', () => {
    // Which node wins is load-bearing: an annexe, a sister property or a
    // "you may also like" node must not become the page's identity.
    expect(readSchemaOrgLodging(ldDoc([hotel({ name: 'The Property' }), hotel({ name: 'The Annexe' })]))?.name)
      .toBe('The Property');
    expect(readSchemaOrgLodging(ldDoc([[hotel({ name: 'First In Array' }), hotel({ name: 'Second' })]]))?.name)
      .toBe('First In Array');
  });

  it('does not take a property listed inside an ItemList as the page identity', () => {
    // Search results and "similar properties" rails publish lodging nodes for
    // OTHER properties. Reading one would hand Engine B a stranger's identity
    // and call the difference a hijack, so nested item lists are not walked.
    const doc = ldDoc([{
      '@type': 'ItemList',
      itemListElement: [{ '@type': 'ListItem', position: 1, item: hotel({ name: 'Nearby Rival' }) }],
    }]);
    expect(readSchemaOrgLodging(doc)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// coordinates
// ---------------------------------------------------------------------------

describe('readSchemaOrgLodging: coordinates', () => {
  it('reads nested geo, the schema.org norm', () => {
    const lodging = readSchemaOrgLodging(ldDoc([hotel({ geo: { '@type': 'GeoCoordinates', latitude: 48.8584, longitude: 2.2945 } })]));
    expect(lodging).toMatchObject({ lat: 48.8584, lng: 2.2945 });
  });

  it('reads top-level latitude/longitude, which some platforms emit instead', () => {
    const lodging = readSchemaOrgLodging(ldDoc([hotel({ latitude: 37.7749, longitude: -122.4194 })]));
    expect(lodging).toMatchObject({ lat: 37.7749, lng: -122.4194 });
  });

  it('accepts string coordinates in either position', () => {
    expect(readSchemaOrgLodging(ldDoc([hotel({ geo: { latitude: '48.8584', longitude: '2.2945' } })])))
      .toMatchObject({ lat: 48.8584, lng: 2.2945 });
    expect(readSchemaOrgLodging(ldDoc([hotel({ latitude: '-33.8688', longitude: '151.2093' })])))
      .toMatchObject({ lat: -33.8688, lng: 151.2093 });
  });

  it('prefers nested geo over top-level when a page carries both', () => {
    const doc = ldDoc([hotel({ geo: { latitude: 1, longitude: 2 }, latitude: 50, longitude: 60 })]);
    expect(readSchemaOrgLodging(doc)).toMatchObject({ lat: 1, lng: 2 });
  });

  it('falls back to top-level coordinates when nested geo carries nothing usable', () => {
    for (const node of [
      hotel({ geo: { latitude: '', longitude: '' }, latitude: 51.5, longitude: -0.12 }),
      hotel({ geo: 'somewhere', latitude: 51.5, longitude: -0.12 }),
      hotel({ geo: [{ latitude: 1, longitude: 2 }], latitude: 51.5, longitude: -0.12 }),
    ]) {
      expect(readSchemaOrgLodging(ldDoc([node]))).toMatchObject({ lat: 51.5, lng: -0.12 });
    }
  });

  it('leaves coordinates undefined rather than placing the property at null island', () => {
    // Number('') is 0. A missing coordinate must stay GRAY, not become (0,0).
    for (const node of [
      hotel({ geo: { latitude: '', longitude: '' } }),
      hotel({ latitude: '  ', longitude: '  ' }),
      hotel({ geo: { latitude: 'north', longitude: 'east' } }),
      hotel({ geo: { latitude: 48.85 } }),
      hotel({}),
    ]) {
      const lodging = readSchemaOrgLodging(ldDoc([node]));
      expect(lodging?.lat).toBeUndefined();
      expect(lodging?.lng).toBeUndefined();
    }
  });

  it('rejects out-of-range coordinates', () => {
    const lodging = readSchemaOrgLodging(ldDoc([hotel({ geo: { latitude: 91, longitude: 200 } })]));
    expect(lodging?.lat).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// ratings
// ---------------------------------------------------------------------------

describe('readSchemaOrgLodging: ratings', () => {
  it('reads reviewCount', () => {
    const doc = ldDoc([hotel({ aggregateRating: { ratingValue: 8.6, reviewCount: 1842, bestRating: 10 } })]);
    expect(readSchemaOrgLodging(doc)).toMatchObject({ reviewScore: 8.6, reviewCount: 1842, reviewScoreMax: 10 });
  });

  it('reads ratingCount when the platform uses that name instead', () => {
    const doc = ldDoc([hotel({ aggregateRating: { ratingValue: '4.83', ratingCount: 214 } })]);
    expect(readSchemaOrgLodging(doc)).toMatchObject({ reviewScore: 4.83, reviewCount: 214 });
  });

  it('trusts bestRating when present, even when it contradicts the guess', () => {
    const doc = ldDoc([hotel({ aggregateRating: { ratingValue: 4.4, bestRating: '10' } })]);
    expect(readSchemaOrgLodging(doc)?.reviewScoreMax).toBe(10);
  });

  it('accepts a scale that is neither 5 nor 10 when the page states one', () => {
    const doc = ldDoc([hotel({ aggregateRating: { ratingValue: 92, bestRating: 100 } })]);
    expect(readSchemaOrgLodging(doc)?.reviewScoreMax).toBe(100);
  });

  it.each<[string, unknown, number]>([
    ['a scale below its own score', 1, 5],
    ['zero', 0, 5],
    ['a negative scale', -5, 5],
    ['a non-numeric scale', 'five', 5],
  ])('ignores %s and infers instead', (_label, bestRating, expected) => {
    // A bestRating under the score is a broken field, not a scale: taking
    // `{ratingValue: 4.8, bestRating: 1}` literally normalises the score to
    // 4.8x its own maximum, which reads as a reputation that cannot exist.
    const doc = ldDoc([hotel({ aggregateRating: { ratingValue: 4.8, bestRating } })]);
    expect(readSchemaOrgLodging(doc)?.reviewScoreMax).toBe(expected);
  });

  it('keeps a bestRating that exactly equals the score', () => {
    const doc = ldDoc([hotel({ aggregateRating: { ratingValue: 5, bestRating: 5 } })]);
    expect(readSchemaOrgLodging(doc)?.reviewScoreMax).toBe(5);
  });

  // Without bestRating the scale is a guess: a 5-point platform never emits 7.3.
  // It only affects presentation — the diff normalises by this before comparing.
  it.each<[number, number]>([
    [4.83, 5],
    [5, 5],
    [5.1, 10],
    [8.6, 10],
  ])('infers ratingValue %s as a scale out of %s when bestRating is absent', (ratingValue, expected) => {
    const doc = ldDoc([hotel({ aggregateRating: { ratingValue } })]);
    expect(readSchemaOrgLodging(doc)?.reviewScoreMax).toBe(expected);
  });

  it('leaves the scale undefined when there is no score to infer it from', () => {
    const doc = ldDoc([hotel({ aggregateRating: { reviewCount: 12 } })]);
    expect(readSchemaOrgLodging(doc)?.reviewScoreMax).toBeUndefined();
  });

  it('never turns a missing or nonsense review count into zero', () => {
    for (const rating of [{}, { reviewCount: '' }, { reviewCount: 'many' }, { reviewCount: -3 }, { reviewCount: 4.5 }]) {
      expect(readSchemaOrgLodging(ldDoc([hotel({ aggregateRating: rating })]))?.reviewCount).toBeUndefined();
    }
  });

  it('survives aggregateRating being a string or an array', () => {
    expect(readSchemaOrgLodging(ldDoc([hotel({ aggregateRating: 'excellent' })]))?.reviewScore).toBeUndefined();
    expect(readSchemaOrgLodging(ldDoc([hotel({ aggregateRating: [1, 2] })]))?.reviewScore).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// address
// ---------------------------------------------------------------------------

describe('readSchemaOrgLodging: address', () => {
  it('reads a PostalAddress, where addressLocality really is the city', () => {
    const doc = ldDoc([hotel({
      address: {
        '@type': 'PostalAddress',
        streetAddress: '12 Rue Desaix',
        addressLocality: 'Paris',
        addressRegion: 'Île-de-France',
        addressCountry: 'FR',
      },
    })]);
    expect(readSchemaOrgLodging(doc)).toMatchObject({ streetAddress: '12 Rue Desaix', city: 'Paris', country: 'FR' });
  });

  it('reads addressCountry when it is a Country node rather than a string', () => {
    const doc = ldDoc([hotel({ address: { streetAddress: 'X', addressCountry: { '@type': 'Country', name: 'France' } } })]);
    expect(readSchemaOrgLodging(doc)?.country).toBe('France');
  });

  it('takes a bare string address as the street line and claims no city', () => {
    const doc = ldDoc([hotel({ address: '12 Rue Desaix, 75015 Paris, France' })]);
    const lodging = readSchemaOrgLodging(doc);
    expect(lodging?.streetAddress).toBe('12 Rue Desaix, 75015 Paris, France');
    expect(lodging?.city).toBeUndefined();
    expect(lodging?.country).toBeUndefined();
  });

  it('leaves every address field undefined when address is missing or empty', () => {
    for (const node of [hotel({}), hotel({ address: '' }), hotel({ address: { streetAddress: '   ' } }), hotel({ address: 42 })]) {
      const lodging = readSchemaOrgLodging(ldDoc([node]));
      expect(lodging?.streetAddress).toBeUndefined();
      expect(lodging?.city).toBeUndefined();
    }
  });

  it('collapses whitespace and bounds a hostile address', () => {
    const doc = ldDoc([hotel({ address: { streetAddress: `  12   Rue\n\nDesaix ${'x'.repeat(5000)}` } })]);
    const street = readSchemaOrgLodging(doc)?.streetAddress ?? '';
    expect(street.startsWith('12 Rue Desaix ')).toBe(true);
    expect(street.length).toBeLessThanOrEqual(300);
  });
});

// ---------------------------------------------------------------------------
// images
// ---------------------------------------------------------------------------

describe('readSchemaOrgLodging: images', () => {
  it('reads image as a single string', () => {
    expect(readSchemaOrgLodging(ldDoc([hotel({ image: 'https://cdn.example/a.jpg' })]))?.images)
      .toEqual(['https://cdn.example/a.jpg']);
  });

  it('reads image as an array of strings', () => {
    const doc = ldDoc([hotel({ image: ['https://cdn.example/a.jpg', 'https://cdn.example/b.jpg'] })]);
    expect(readSchemaOrgLodging(doc)?.images).toEqual(['https://cdn.example/a.jpg', 'https://cdn.example/b.jpg']);
  });

  it('reads image as an array of ImageObject', () => {
    const doc = ldDoc([hotel({
      image: [
        { '@type': 'ImageObject', url: 'https://cdn.example/a.jpg' },
        { '@type': 'ImageObject', contentUrl: 'https://cdn.example/b.jpg' },
        { '@type': 'ImageObject' },
      ],
    })]);
    expect(readSchemaOrgLodging(doc)?.images).toEqual(['https://cdn.example/a.jpg', 'https://cdn.example/b.jpg']);
  });

  it('reads image as a single ImageObject', () => {
    const doc = ldDoc([hotel({ image: { '@type': 'ImageObject', url: 'https://cdn.example/a.jpg' } })]);
    expect(readSchemaOrgLodging(doc)?.images).toEqual(['https://cdn.example/a.jpg']);
  });

  it('bounds an attacker-sized image array without throwing, keeping a prefix in order', () => {
    const image = Array.from({ length: 20_000 }, (_, i) => `https://cdn.example/${i}.jpg`);
    let lodging: ReturnType<typeof readSchemaOrgLodging>;
    expect(() => { lodging = readSchemaOrgLodging(ldDoc([hotel({ image })])); }).not.toThrow();
    const images = lodging!.images;
    expect(images.length).toBeGreaterThan(0);
    expect(images.length).toBeLessThanOrEqual(200);
    // What survives is the document-order prefix, not an arbitrary sample: the
    // first images are the gallery's own order, which is what a later capture
    // of the same listing will also see.
    expect(images[0]).toBe('https://cdn.example/0.jpg');
    expect(images[images.length - 1]).toBe(`https://cdn.example/${images.length - 1}.jpg`);
  });

  it('answers an empty list when there are no images', () => {
    expect(readSchemaOrgLodging(ldDoc([hotel({})]))?.images).toEqual([]);
    expect(readSchemaOrgLodging(ldDoc([hotel({ image: 17 })]))?.images).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// listing id and hostile structure
// ---------------------------------------------------------------------------

describe('readSchemaOrgLodging: listing id and bounds', () => {
  it.each<[string, Record<string, unknown>, string]>([
    ['identifier as a string', { identifier: 'LX-4471' }, 'LX-4471'],
    ['identifier as a number', { identifier: 4471 }, '4471'],
    ['identifier as a PropertyValue', { identifier: { '@type': 'PropertyValue', value: '4471' } }, '4471'],
    ['sku', { sku: 'SKU-9' }, 'SKU-9'],
    ['productID', { productID: 'P-9' }, 'P-9'],
  ])('reads %s', (_label, extra, expected) => {
    expect(readSchemaOrgLodging(ldDoc([hotel(extra)]))?.listingId).toBe(expected);
  });

  it('never takes @id as the listing id', () => {
    // @id is the page URL on most sites, so an archived capture under a locale
    // path would read as a different listing and withdraw the whole comparison.
    const doc = ldDoc([hotel({ '@id': 'https://somewhere.example/en/stay/4471#lodging' })]);
    expect(readSchemaOrgLodging(doc)?.listingId).toBeUndefined();
  });

  it('bounds a huge @graph without throwing or hanging', () => {
    const filler = Array.from({ length: 5000 }, (_, i) => ({ '@type': 'ListItem', position: i }));
    expect(() => readSchemaOrgLodging(ldDoc([{ '@graph': filler }]))).not.toThrow();
    // The lodging node inside the walked prefix is still found.
    expect(readSchemaOrgLodging(ldDoc([{ '@graph': [hotel({ name: 'Front Lodge' }), ...filler] }]))?.name)
      .toBe('Front Lodge');
  });

  it('collapses and bounds a hostile name and description', () => {
    const doc = ldDoc([hotel({ name: `  Grand\n\tHotel ${'n'.repeat(5000)}`, description: 'd'.repeat(20_000) })]);
    const lodging = readSchemaOrgLodging(doc);
    expect(lodging?.name?.startsWith('Grand Hotel n')).toBe(true);
    expect(lodging?.name?.length).toBeLessThanOrEqual(200);
    expect(lodging?.description?.length).toBe(4000);
  });
});

// ---------------------------------------------------------------------------
// hostile input, across the whole surface
// ---------------------------------------------------------------------------

describe('hostile documents', () => {
  const HOSTILE: ReadonlyArray<readonly [string, unknown]> = [
    ['a node whose fields are all the wrong type', {
      '@type': 'Hotel', name: { evil: true }, description: [1, 2], address: ['x'],
      geo: 42, aggregateRating: { ratingValue: {}, reviewCount: [] }, image: [[['a']]],
      identifier: { value: {} },
    }],
    ['@type as a huge array', { '@type': Array.from({ length: 5000 }, (_, i) => `T${i}`), name: 'x' }],
    ['a node claiming lodging late in a huge @type array', {
      '@type': [...Array.from({ length: 5000 }, (_, i) => `T${i}`), 'Hotel'], name: 'Buried Type',
    }],
    ['a deeply nested array', `${'['.repeat(50_000)}${']'.repeat(50_000)}`],
    ['a JSON scalar soup', '{"@type":{"0":"Hotel"},"name":null,"image":{"url":{"url":"x"}}}'],
    ['an @graph that is not an array', { '@graph': { '@type': 'Hotel', name: 'x' } }],
  ];

  it.each(HOSTILE)('never throws anywhere on %s', (_label, block) => {
    const doc = ldDoc([block], '<meta property="og:title" content="x"><meta property="og:image" content="y">');
    expect(() => readSchemaOrgLodging(doc)).not.toThrow();
    expect(() => genericAdapter.extractIdentity(doc, { now: NOW })).not.toThrow();
    expect(() => genericAdapter.extractContext(doc)).not.toThrow();
  });

  it('fabricates nothing out of a node whose fields are all the wrong type', () => {
    const doc = ldDoc([{
      '@type': 'Hotel', name: { evil: true }, address: ['x'], geo: 42,
      aggregateRating: { ratingValue: {}, reviewCount: [] },
    }]);
    const lodging = readSchemaOrgLodging(doc);
    // The node is recognised as lodging, and every unreadable field stays GRAY.
    expect(lodging).toEqual({ images: [], propertyType: 'Hotel' });
    // With no name from either source there is nothing to claim.
    expect(genericAdapter.extractIdentity(doc, { now: NOW })).toBeNull();
  });

  it('stops after a bounded number of JSON-LD blocks', () => {
    // The bound is asserted rather than timed: a page burying its lodging node
    // behind 45 decoy blocks is not a page we walk to the end of. Real pages
    // publish a handful.
    const decoys = Array.from({ length: 45 }, (_, i) => ({ '@type': 'WebSite', name: `decoy ${i}` }));
    expect(readSchemaOrgLodging(ldDoc([...decoys, hotel({ name: 'Too Far Back' })]))).toBeUndefined();
    expect(readSchemaOrgLodging(ldDoc([hotel({ name: 'Up Front' }), ...decoys]))?.name).toBe('Up Front');
  });

  it('ignores a script that only looks like JSON-LD', () => {
    const doc = docFrom(
      '<!doctype html><html><head>' +
      '<script type="application/json">{"@type":"Hotel","name":"Wrong Type Attr"}</script>' +
      '<script>{"@type":"Hotel","name":"Inline JS"}</script>' +
      '</head><body></body></html>',
    );
    expect(readSchemaOrgLodging(doc)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// adapter surface
// ---------------------------------------------------------------------------

describe('genericAdapter: declared surface', () => {
  it('claims no capability it cannot back up', () => {
    expect(genericAdapter.id).toBe('generic');
    expect(genericAdapter.label).toBe('This page');
    expect(genericAdapter.capabilities).toEqual({
      nameBearingUrl: false,
      destinationId: false,
      nearbyLandmarks: false,
    });
  });

  it('registers no match patterns, so it never widens host permissions', () => {
    expect(genericAdapter.matchPatterns).toEqual([]);
  });

  it('never claims a page from its URL alone', () => {
    for (const url of ['https://somewhere.example/stay/4471', 'https://www.booking.com/hotel/fr/x.html']) {
      expect(genericAdapter.handles(new URL(url))).toBe(false);
    }
  });
});

describe('genericAdapter.canonicalize', () => {
  it.each<[string, string, { canonicalUrl: string; cdxPrefix: string }]>([
    [
      'strips query and fragment',
      'https://Somewhere.Example/stay/4471?utm_source=ads&sid=abc#photos',
      { canonicalUrl: 'https://somewhere.example/stay/4471', cdxPrefix: 'somewhere.example/stay/4471' },
    ],
    [
      'drops a trailing slash',
      'https://somewhere.example/stay/4471/',
      { canonicalUrl: 'https://somewhere.example/stay/4471', cdxPrefix: 'somewhere.example/stay/4471' },
    ],
    [
      'lowercases the host but preserves path case',
      'https://WWW.Somewhere.EXAMPLE/Stay/Casa-Blanca',
      { canonicalUrl: 'https://www.somewhere.example/Stay/Casa-Blanca', cdxPrefix: 'www.somewhere.example/Stay/Casa-Blanca' },
    ],
    [
      'keeps a non-default port',
      'http://localhost:8080/stay/1?x=1',
      { canonicalUrl: 'http://localhost:8080/stay/1', cdxPrefix: 'localhost:8080/stay/1' },
    ],
    [
      'reduces a bare host to the host itself',
      'https://somewhere.example/',
      { canonicalUrl: 'https://somewhere.example', cdxPrefix: 'somewhere.example' },
    ],
  ])('%s', (_label, input, expected) => {
    expect(genericAdapter.canonicalize(new URL(input))).toEqual({ platform: 'generic', ...expected });
  });

  it('declines non-http(s) URLs', () => {
    for (const url of ['file:///tmp/page.html', 'chrome-extension://abc/panel.html', 'data:text/html,x']) {
      expect(genericAdapter.canonicalize(new URL(url))).toBeNull();
    }
  });

  it('invents neither a slug nor a country code', () => {
    const canonical = genericAdapter.canonicalize(new URL('https://somewhere.example/fr/stay/casa-blanca'));
    expect(canonical?.slug).toBeUndefined();
    expect(canonical?.countryCode).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// extractIdentity
// ---------------------------------------------------------------------------

describe('genericAdapter.extractIdentity', () => {
  it('reads a complete listing off standard markup', () => {
    const doc = ldDoc(
      [hotel({
        name: 'Casa Blanca',
        identifier: '4471',
        description: 'A quiet flat.',
        address: { '@type': 'PostalAddress', streetAddress: '12 Rue Desaix', addressLocality: 'Paris', addressCountry: 'FR' },
        geo: { latitude: '48.8584', longitude: '2.2945' },
        aggregateRating: { ratingValue: 4.83, ratingCount: 214 },
        image: ['https://cdn.example/a.jpg?w=1200', 'https://cdn.example/b.jpg'],
        '@type': 'VacationRental',
      })],
      '<meta property="og:image" content="https://cdn.example/hero.jpg#top">',
    );

    expect(genericAdapter.extractIdentity(doc, { now: NOW })).toEqual({
      platform: 'generic',
      listingId: '4471',
      name: 'Casa Blanca',
      address: '12 Rue Desaix',
      city: 'Paris',
      country: 'FR',
      lat: 48.8584,
      lng: 2.2945,
      reviewCount: 214,
      reviewScore: 4.83,
      reviewScoreMax: 5,
      propertyType: 'VacationRental',
      photoUrls: [
        'https://cdn.example/a.jpg',
        'https://cdn.example/b.jpg',
        'https://cdn.example/hero.jpg',
      ],
      capturedAt: '2026-08-11T12:00:00.000Z',
      source: { kind: 'live' },
    });
  });

  it('falls back to og:title and og:image when only Open Graph is present', () => {
    const doc = docFrom(
      '<!doctype html><html><head>' +
      '<meta property="og:title" content="Casa Blanca">' +
      '<meta property="og:image" content="https://cdn.example/hero.jpg">' +
      '</head><body></body></html>',
    );
    const vector = genericAdapter.extractIdentity(doc, { now: NOW });
    expect(vector).toMatchObject({
      platform: 'generic',
      name: 'Casa Blanca',
      address: '',
      photoUrls: ['https://cdn.example/hero.jpg'],
    });
    // Everything the page did not say stays unknown rather than becoming a value.
    expect(vector?.city).toBeUndefined();
    expect(vector?.lat).toBeUndefined();
    expect(vector?.reviewCount).toBeUndefined();
  });

  it('reads Open Graph tags spelled with name= as well as property=', () => {
    // `property=` is correct and `name=` is what a large minority of CMSs emit;
    // on a page with no other hero image, reading only the correct spelling
    // loses the signal entirely.
    const doc = docFrom(
      '<!doctype html><html><head>' +
      '<meta name="og:title" content="Casa Blanca">' +
      '<meta name="og:image" content="https://cdn.example/hero.jpg">' +
      '</head><body></body></html>',
    );
    expect(genericAdapter.extractIdentity(doc, { now: NOW })).toMatchObject({
      name: 'Casa Blanca',
      photoUrls: ['https://cdn.example/hero.jpg'],
    });
  });

  it('falls back to og:title when the lodging node has no name, keeping the rest of it', () => {
    const doc = ldDoc(
      [{ '@context': 'https://schema.org', '@type': 'Hotel', address: { addressLocality: 'Paris' } }],
      '<meta property="og:title" content="Casa Blanca">',
    );
    const vector = genericAdapter.extractIdentity(doc, { now: NOW });
    expect(vector?.name).toBe('Casa Blanca');
    expect(vector?.city).toBe('Paris');
  });

  it('prefers the marked-up name over og:title', () => {
    const doc = ldDoc([hotel({ name: 'Casa Blanca' })], '<meta property="og:title" content="Casa Blanca — book now | Somewhere">');
    expect(genericAdapter.extractIdentity(doc, { now: NOW })?.name).toBe('Casa Blanca');
  });

  it('returns null when there is neither lodging markup nor og:title', () => {
    expect(genericAdapter.extractIdentity(docFrom('<!doctype html><html><body>hello</body></html>'))).toBeNull();
    expect(genericAdapter.extractIdentity(ldDoc([{ '@type': 'Restaurant', name: 'Chez Nous' }]))).toBeNull();
    expect(genericAdapter.extractIdentity(ldDoc(['{broken']))).toBeNull();
  });

  it('returns null when the markup carries no usable name', () => {
    // A vector with an empty name cannot be diffed; declining is honest.
    expect(genericAdapter.extractIdentity(ldDoc([hotel({ name: '   ' })]))).toBeNull();
  });

  it('drops photo URLs that are not images and de-duplicates the rest', () => {
    const doc = ldDoc([hotel({
      image: [
        'https://cdn.example/a.jpg?w=100',
        'https://cdn.example/a.jpg?w=2000',
        'https://cdn.example/tracker',
        '/relative/a.jpg',
        'data:image/png;base64,AAAA',
      ],
    })]);
    expect(genericAdapter.extractIdentity(doc, { now: NOW })?.photoUrls).toEqual(['https://cdn.example/a.jpg']);
  });

  it('bounds the gallery under a hostile image array', () => {
    const image = Array.from({ length: 20_000 }, (_, i) => `https://cdn.example/${i}.jpg`);
    const vector = genericAdapter.extractIdentity(ldDoc([hotel({ image })]), { now: NOW });
    expect(vector!.photoUrls.length).toBeLessThanOrEqual(60);
  });

  it('stamps capturedAt from the injected clock', () => {
    const vector = genericAdapter.extractIdentity(ldDoc([hotel({})]), { now: NOW });
    expect(vector?.capturedAt).toBe('2026-08-11T12:00:00.000Z');
    expect(vector?.source).toEqual({ kind: 'live' });
  });
});

// ---------------------------------------------------------------------------
// extractContext
// ---------------------------------------------------------------------------

describe('genericAdapter.extractContext', () => {
  it('reads the description and a BreadcrumbList', () => {
    const doc = ldDoc([
      hotel({ description: '  A quiet flat\n near the park. ' }),
      {
        '@type': 'BreadcrumbList',
        itemListElement: [
          { '@type': 'ListItem', position: 1, item: { '@id': 'https://x.example/fr', name: 'France' } },
          { '@type': 'ListItem', position: 2, item: { name: 'Paris' } },
          { '@type': 'ListItem', position: 3, name: '15th arrondissement' },
          { '@type': 'ListItem', position: 4 },
        ],
      },
    ]);
    expect(genericAdapter.extractContext(doc)).toEqual({
      breadcrumbs: ['France', 'Paris', '15th arrondissement'],
      pois: [],
      reviews: [],
      reviewSet: { availability: 'in-page', items: [] },
      description: 'A quiet flat near the park.',
    });
  });

  it('invents no landmarks, reviews or breadcrumbs when the page publishes none', () => {
    expect(genericAdapter.extractContext(ldDoc([hotel({})]))).toEqual({
      breadcrumbs: [],
      pois: [],
      reviews: [],
      // `in-page` because this adapter DOES read schema.org `Review` nodes.
      // Empty means this page published none where the standard puts them.
      reviewSet: { availability: 'in-page', items: [] },
    });
  });

  it('reads the label from the ListItem when item is a bare URL', () => {
    // The documented shape: the label lives on the ListItem and `item` is a
    // link. Reading `item` first would make the trail a list of URLs, and
    // Engine A3 geocodes the second-to-last crumb — a URL there buys nothing
    // and spends a rate-limited geocoder call.
    const doc = ldDoc([{
      '@type': 'BreadcrumbList',
      itemListElement: [
        { '@type': 'ListItem', position: 1, name: 'France', item: 'https://x.example/fr' },
        { '@type': 'ListItem', position: 2, name: 'Paris', item: 'https://x.example/fr/paris' },
      ],
    }]);
    expect(genericAdapter.extractContext(doc).breadcrumbs).toEqual(['France', 'Paris']);
  });

  it('never lets a URL become a breadcrumb', () => {
    const doc = ldDoc([{
      '@type': 'BreadcrumbList',
      itemListElement: [
        { '@type': 'ListItem', position: 1, item: 'https://x.example/fr' },
        { '@type': 'ListItem', position: 2, item: '//x.example/fr/paris' },
        { '@type': 'ListItem', position: 3, item: { '@id': 'https://x.example/fr/paris/15' } },
        { '@type': 'ListItem', position: 4, name: 'https://x.example/named-with-a-url' },
        'https://x.example/bare',
        { '@type': 'ListItem', position: 4, item: { name: 'Paris' } },
      ],
    }]);
    expect(genericAdapter.extractContext(doc).breadcrumbs).toEqual(['Paris']);
  });

  it('keeps bare-string crumbs that are names', () => {
    const doc = ldDoc([{ '@type': 'BreadcrumbList', itemListElement: ['France', ' Paris ', ''] }]);
    expect(genericAdapter.extractContext(doc).breadcrumbs).toEqual(['France', 'Paris']);
  });

  it('bounds a hostile breadcrumb list and never throws', () => {
    const itemListElement = Array.from({ length: 5000 }, (_, i) => ({ item: { name: `crumb ${i}` } }));
    const doc = ldDoc([{ '@type': 'BreadcrumbList', itemListElement }]);
    let context;
    expect(() => { context = genericAdapter.extractContext(doc); }).not.toThrow();
    expect(context!.breadcrumbs.length).toBe(12);
  });

  it('stops scanning a list of label-less entries instead of walking all of it', () => {
    // A cap on output is not a cap on work: entries that yield no label would
    // otherwise be walked to the end of an attacker-sized array. The buried
    // crumb proves the scan stopped, rather than a timing assertion that would
    // be flaky on a loaded machine.
    const itemListElement: unknown[] = Array.from({ length: 1000 }, () => ({ '@type': 'ListItem' }));
    itemListElement.push({ '@type': 'ListItem', name: 'Buried Crumb' });
    const doc = ldDoc([{ '@type': 'BreadcrumbList', itemListElement }]);
    expect(genericAdapter.extractContext(doc).breadcrumbs).toEqual([]);
  });

  it('survives a BreadcrumbList whose itemListElement is not an array', () => {
    const doc = ldDoc([{ '@type': 'BreadcrumbList', itemListElement: 'nope' }]);
    expect(genericAdapter.extractContext(doc).breadcrumbs).toEqual([]);
  });

  it('reads breadcrumbs on a page that carries no lodging markup at all', () => {
    // The two readers are independent: a page can publish a trail and no
    // lodging node, and the trail is still the honest answer for A3.
    const doc = ldDoc([{ '@type': 'BreadcrumbList', itemListElement: [{ name: 'France' }, { name: 'Paris' }] }]);
    expect(genericAdapter.extractContext(doc)).toEqual({
      breadcrumbs: ['France', 'Paris'],
      pois: [],
      reviews: [],
      reviewSet: { availability: 'in-page', items: [] },
    });
  });
});

// ---------------------------------------------------------------------------
// schema.org Review
// ---------------------------------------------------------------------------

describe('readSchemaOrgReviews', () => {
  function review(extra: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      '@type': 'Review',
      reviewRating: { '@type': 'Rating', ratingValue: 4 },
      reviewBody: 'Great location, quiet room.',
      datePublished: '2026-08-09T07:23:53-0400',
      author: { '@type': 'Person', name: 'Sarah M' },
      ...extra,
    };
  }

  it('reads a review the way standard markup publishes one', () => {
    const doc = ldDoc([hotel({
      aggregateRating: { ratingValue: 4.4, reviewCount: 11992, bestRating: 5 },
      review: [review()],
    })]);
    expect(genericAdapter.extractContext(doc).reviewSet).toEqual({
      availability: 'in-page',
      summary: { score: 8.8, total: 11992 },
      items: [{
        // 4 of 5 normalizes to 8 of 10 so nothing downstream compares it
        // against Booking's 8/10 as though the scales matched…
        score: 8,
        // …while the scale the site actually published stays visible, for the
        // evidence row that has to read "4/5" and not a rescaled number.
        rawScore: { value: 4, max: 5 },
        reviewedAt: Date.parse('2026-08-09T07:23:53-0400'),
        positive: 'Great location, quiet room.',
      }],
    });
  });

  it('reads a single review that is not wrapped in an array', () => {
    const doc = ldDoc([hotel({ review: review() })]);
    expect(genericAdapter.extractContext(doc).reviewSet!.items).toHaveLength(1);
  });

  it('accepts the `reviews` spelling several CMSs emit', () => {
    const doc = ldDoc([hotel({ reviews: [review()] })]);
    expect(genericAdapter.extractContext(doc).reviewSet!.items).toHaveLength(1);
  });

  it('trusts bestRating on the review over the property aggregate', () => {
    const doc = ldDoc([hotel({
      aggregateRating: { ratingValue: 4.4, bestRating: 5 },
      review: [review({ reviewRating: { ratingValue: 80, bestRating: 100 } })],
    })]);
    expect(genericAdapter.extractContext(doc).reviewSet!.items[0]).toMatchObject({
      score: 8,
      rawScore: { value: 80, max: 100 },
    });
  });

  it('falls back to the property scale when the review states none', () => {
    // A lone 5 is a perfect 5-star review and a mediocre 10-point one. The
    // aggregate is the only thing on the page that tells them apart, so a site
    // rating itself out of 10 must not have its 5 read as full marks.
    const doc = ldDoc([hotel({
      aggregateRating: { ratingValue: 7.8, bestRating: 10 },
      review: [review({ reviewRating: { ratingValue: 5 } })],
    })]);
    expect(genericAdapter.extractContext(doc).reviewSet!.items[0]).toMatchObject({
      score: 5,
      rawScore: { value: 5, max: 10 },
    });
  });

  it('ignores a bestRating that cannot hold its own score', () => {
    // Markup in the wild carries a copied `bestRating: 1` next to a 4.8.
    // Taking it literally would normalize the score to 48 out of 10.
    const doc = ldDoc([hotel({ review: [review({ reviewRating: { ratingValue: 4.8, bestRating: 1 } })] })]);
    expect(genericAdapter.extractContext(doc).reviewSet!.items[0]).toMatchObject({
      score: 9.6,
      rawScore: { value: 4.8, max: 5 },
    });
  });

  it('reads the title, language and id when the markup carries them', () => {
    const doc = ldDoc([hotel({
      review: [review({ name: 'Great stay', inLanguage: 'en-GB', identifier: 'r-1' })],
    })]);
    expect(genericAdapter.extractContext(doc).reviewSet!.items[0]).toMatchObject({
      id: 'r-1', title: 'Great stay', lang: 'en-GB',
    });
  });

  it('drops a review that carries neither words nor a score', () => {
    const doc = ldDoc([hotel({ review: [review({ reviewBody: undefined, reviewRating: undefined })] })]);
    expect(genericAdapter.extractContext(doc).reviewSet!.items).toEqual([]);
  });

  it('leaves an implausible date absent rather than reporting 1970', () => {
    const doc = ldDoc([hotel({ review: [review({ datePublished: 'sometime last summer' })] })]);
    const item = genericAdapter.extractContext(doc).reviewSet!.items[0];
    expect(item.reviewedAt).toBeUndefined();
    expect(item.positive).toBe('Great location, quiet room.');
  });

  it('bounds a hostile review list without walking all of it', () => {
    const many = Array.from({ length: 5000 }, () => review());
    const doc = ldDoc([hotel({ review: many })]);
    let context;
    expect(() => { context = genericAdapter.extractContext(doc); }).not.toThrow();
    expect(context!.reviewSet!.items).toHaveLength(12);
  });

  it('bounds one enormous review body instead of carrying all of it', () => {
    const doc = ldDoc([hotel({ review: [review({ reviewBody: 'x'.repeat(200_000) })] })]);
    expect(genericAdapter.extractContext(doc).reviewSet!.items[0].positive).toHaveLength(2000);
  });

  it('survives a review list that is not a list of reviews', () => {
    const doc = ldDoc([hotel({ review: ['a string', 42, null, [], { '@type': 'Review' }] })]);
    expect(genericAdapter.extractContext(doc).reviewSet!.items).toEqual([]);
  });

  it('feeds Engine L the review text it read', () => {
    const doc = ldDoc([hotel({ review: [review({ name: 'Great stay' })] })]);
    expect(genericAdapter.extractContext(doc).reviews)
      .toEqual(['Great stay\nGreat location, quiet room.']);
  });
});

// ---------------------------------------------------------------------------
// normalizePhotoUrl
// ---------------------------------------------------------------------------

describe('normalizePhotoUrl', () => {
  it.each([
    ['strips query and fragment', 'https://cdn.example/photos/a.jpg?w=1200&sig=abc#zoom', 'https://cdn.example/photos/a.jpg'],
    ['lowercases the host only', 'https://CDN.Example/Photos/A.JPG', 'https://cdn.example/Photos/A.JPG'],
    ['forces https so an http archive capture still matches', 'http://cdn.example/a.jpeg', 'https://cdn.example/a.jpeg'],
    ['accepts protocol-relative sources', '//cdn.example/a.webp', 'https://cdn.example/a.webp'],
    ['keeps a port', 'https://cdn.example:8443/a.png', 'https://cdn.example:8443/a.png'],
  ])('%s', (_label, input, expected) => {
    expect(normalizePhotoUrl(input)).toBe(expected);
  });

  it.each([
    ['a path with no image extension', 'https://cdn.example/photos/a'],
    ['an extension only in the query', 'https://cdn.example/photo?file=a.jpg'],
    ['a relative path', '/photos/a.jpg'],
    ['a data URL', 'data:image/png;base64,AAAA'],
    ['a javascript URL', 'javascript:alert(1)//a.jpg'],
    ['an empty string', ''],
    ['nonsense', 'not a url at all'],
  ])('returns null for %s', (_label, input) => {
    expect(normalizePhotoUrl(input)).toBeNull();
  });

  it('returns null for an absurdly long URL instead of working on it', () => {
    expect(normalizePhotoUrl(`https://cdn.example/${'a'.repeat(4000)}.jpg`)).toBeNull();
  });

  it('is the adapter member too', () => {
    expect(genericAdapter.normalizePhotoUrl('https://cdn.example/a.jpg?x=1')).toBe('https://cdn.example/a.jpg');
  });
});
