// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { extractLiveIdentity, nameFromOgTitle, normalizePhotoUrl } from './extract';

// vitest runs with the project root as cwd (import.meta.url is not a file:
// URL under the jsdom environment).
const FIXTURE_DIR = join(process.cwd(), 'fixtures/live');
const FIXTURE_TIMEOUT = 30_000; // jsdom parses ~1.7 MB per fixture

function parseFixture(file: string): Document {
  const html = readFileSync(join(FIXTURE_DIR, file), 'utf8');
  return new DOMParser().parseFromString(html, 'text/html');
}

const NOW = () => new Date('2026-08-11T12:00:00Z');
const CANONICAL_PHOTO = /^https:\/\/cf\.bstatic\.com\/xdata\/images\/hotel\/\d+\.jpg$/;

interface Expected {
  name: string;
  listingId: string;
  city: string;
  country: string;
  lat: number;
  lng: number;
  reviewCount: number;
  reviewScore: number;
  addressIncludes: string;
  headPhotoId: string;
}

/**
 * Ground truth recorded at capture time (2026-08-11) by parsing each
 * fixture's JSON-LD / utag_data / map vars directly (scripts/, probe run).
 * Values are frozen with the fixtures; they do not drift with the live site.
 */
const FIXTURES: Record<string, Expected> = {
  'de-schulz-berlin-wall.de.html': {
    name: 'Schulz Hotel Berlin Wall at the East Side Gallery',
    listingId: '3573182', city: 'Berlin', country: 'de',
    lat: 52.508824, lng: 13.433772, reviewCount: 18572, reviewScore: 8.6,
    addressIncludes: 'Stralauer Platz 36', headPhotoId: '887746162',
  },
  'es-catalonia-la-boqueria.es.html': {
    name: 'Catalonia La Boquería',
    listingId: '49918', city: 'Barcelona', country: 'es',
    lat: 41.38092536, lng: 2.17214406, reviewCount: 3069, reviewScore: 8.5,
    addressIncludes: 'Hospital, 26', headPhotoId: '583678623',
  },
  'fr-hijack-paris-eiffel.en-gb.html': {
    // Hijack candidate: slug says Alpine village, page says central Paris.
    // The extractor must report what the page CLAIMS; flagging is Engine A's job.
    name: 'Paris Eiffel Residence',
    listingId: '5961542', city: 'Paris', country: 'fr',
    lat: 48.85399374, lng: 2.29421493, reviewCount: 127, reviewScore: 8.1,
    addressIncludes: '12 Rue Desaix', headPhotoId: '905692998',
  },
  'fr-le-regent-paris.fr.html': {
    name: 'Hôtel Le Regent Paris',
    listingId: '180592', city: 'Paris', country: 'fr',
    lat: 48.85383851, lng: 2.33872309, reviewCount: 2194, reviewScore: 8.6,
    addressIncludes: '61 Rue Dauphine', headPhotoId: '330739420',
  },
  'gb-strandpalace.en-gb.html': {
    name: 'Strand Palace',
    listingId: '230802', city: 'London', country: 'gb',
    lat: 51.51071898, lng: -0.12107491, reviewCount: 17597, reviewScore: 8.5,
    addressIncludes: '372 Strand', headPhotoId: '260560238',
  },
  'gr-electra-metropolis.el.html': {
    name: 'Electra Metropolis',
    listingId: '1705056', city: 'Αθήνα', country: 'gr',
    lat: 37.9752132, lng: 23.732138, reviewCount: 5703, reviewScore: 9.2,
    addressIncludes: 'Mitropoleos 15', headPhotoId: '613882130',
  },
  'it-grand-rimini.it.html': {
    name: 'Grand Hotel Rimini',
    listingId: '84430', city: 'Rimini', country: 'it',
    lat: 44.07249421, lng: 12.57621288, reviewCount: 924, reviewScore: 8.5,
    addressIncludes: 'Parco Fellini 1', headPhotoId: '327034296',
  },
  'it-hotelbellevue_rimini.en-us.html': {
    name: 'Hotel Bellevue by OasiGroup Hotels',
    listingId: '83037', city: 'Rimini', country: 'it',
    lat: 44.06691126, lng: 12.58233368, reviewCount: 4719, reviewScore: 8.8,
    addressIncludes: 'Piazzale John Fitzgerald Kennedy 12', headPhotoId: '299398973',
  },
  'jp-shibuya-excel-tokyu.ja.html': {
    name: 'Shibuya Excel Hotel Tokyu',
    listingId: '235699', city: '東京', country: 'jp',
    lat: 35.6587455, lng: 139.6997036, reviewCount: 3526, reviewScore: 8.9,
    addressIncludes: 'Dogenzaka 1-12-2', headPhotoId: '635445392',
  },
  'nl-nhcollection-flower-market.nl.html': {
    name: 'NH Collection Amsterdam Flower Market',
    listingId: '10438', city: 'Amsterdam', country: 'nl',
    lat: 52.36646131, lng: 4.89308417, reviewCount: 5304, reviewScore: 8.7,
    addressIncludes: 'Vijzelstraat 4', headPhotoId: '890040314',
  },
  'pt-corpo-santo.pt-pt.html': {
    name: 'Corpo Santo Lisbon Historical Hotel',
    listingId: '2508912', city: 'Lisboa', country: 'pt',
    lat: 38.70732395, lng: -9.14200768, reviewCount: 1406, reviewScore: 9.6,
    addressIncludes: 'Largo do Corpo Santo', headPhotoId: '870342852',
  },
  'us-the-warwick-new-york.html': {
    name: 'Warwick New York',
    listingId: '55903', city: 'New York', country: 'us',
    lat: 40.7623695, lng: -73.97826634, reviewCount: 7735, reviewScore: 8.4,
    addressIncludes: '65 West 54th street', headPhotoId: '98978448',
  },
};

describe('extractLiveIdentity on live fixtures', () => {
  it.each(Object.entries(FIXTURES))('%s', (file, expected) => {
    const doc = parseFixture(file);
    const vector = extractLiveIdentity(doc, { now: NOW });

    expect(vector).not.toBeNull();
    const v = vector!;
    expect(v.name).toBe(expected.name);
    expect(v.listingId).toBe(expected.listingId);
    expect(v.city).toBe(expected.city);
    expect(v.country).toBe(expected.country);
    expect(v.lat).toBeCloseTo(expected.lat, 5);
    expect(v.lng).toBeCloseTo(expected.lng, 5);
    expect(v.reviewCount).toBe(expected.reviewCount);
    expect(v.reviewScore).toBe(expected.reviewScore);
    expect(v.address).toContain(expected.addressIncludes);
    expect(v.propertyType).toMatch(/^bkg:\d+$/);
    expect(v.capturedAt).toBe('2026-08-11T12:00:00.000Z');
    expect(v.source).toEqual({ kind: 'live' });

    // Photos: lead photo is the JSON-LD hero image; the rest come from the
    // rendered gallery. All must be in canonical form and unique.
    expect(v.photoUrls[0]).toBe(`https://cf.bstatic.com/xdata/images/hotel/${expected.headPhotoId}.jpg`);
    expect(v.photoUrls.length).toBeGreaterThanOrEqual(10);
    expect(v.photoUrls.length).toBeLessThanOrEqual(60);
    for (const url of v.photoUrls) expect(url).toMatch(CANONICAL_PHOTO);
    expect(new Set(v.photoUrls).size).toBe(v.photoUrls.length);
  }, FIXTURE_TIMEOUT);
});

describe('destinationId is the locale-invariant town key', () => {
  it('is present on every fixture', () => {
    for (const file of Object.keys(FIXTURES)) {
      const vector = extractLiveIdentity(parseFixture(file), { now: NOW })!;
      expect(vector.destinationId, file).toMatch(/^-?\d+$/);
    }
  }, 60_000);

  it.each([
    // Two captures of one town, taken in different languages. The city NAMES
    // differ; the destination id must not. This is the whole reason the field
    // exists — comparing the names is what accused an honest listing of moving.
    ['Rimini', 'it-grand-rimini.it.html', 'it-hotelbellevue_rimini.en-us.html'],
    ['Paris', 'fr-le-regent-paris.fr.html', 'fr-hijack-paris-eiffel.en-gb.html'],
  ])('is identical for two %s listings captured in different locales', (_town, a, b) => {
    const first = extractLiveIdentity(parseFixture(a), { now: NOW })!;
    const second = extractLiveIdentity(parseFixture(b), { now: NOW })!;
    expect(first.destinationId).toBe(second.destinationId);
  }, 60_000);

  it('differs between towns', () => {
    const berlin = extractLiveIdentity(parseFixture('de-schulz-berlin-wall.de.html'), { now: NOW })!;
    const athens = extractLiveIdentity(parseFixture('gr-electra-metropolis.el.html'), { now: NOW })!;
    expect(berlin.destinationId).not.toBe(athens.destinationId);
  }, 60_000);
});

// ---------------------------------------------------------------------------
// synthetic documents — fallback chain and hostile input
// ---------------------------------------------------------------------------

function docFromHtml(html: string): Document {
  return new DOMParser().parseFromString(html, 'text/html');
}

const UTAG_SCRIPT = `<script>
  var utag_data = { city_name: 'Testville', dest_cc: 'fr', hotel_name: 'Utag Hotel Name', hotel_id: '42' };
  b_hotel_id: '4242', accommodation_type_id: '204'
</script>`;

describe('extractLiveIdentity fallback chain', () => {
  it('falls back to og:title + utag when JSON-LD is absent', () => {
    const doc = docFromHtml(`
      <meta property="og:title" content="Fallback Hotel, Testville (updated prices 2026)">
      ${UTAG_SCRIPT}`);
    const v = extractLiveIdentity(doc)!;
    expect(v.name).toBe('Fallback Hotel'); // parenthetical and ", <city>" stripped
    expect(v.listingId).toBe('4242'); // b_hotel_id outranks utag hotel_id
    expect(v.city).toBe('Testville');
    expect(v.country).toBe('fr');
    expect(v.propertyType).toBe('bkg:204');
  });

  it('survives malformed JSON-LD and uses the fallback chain', () => {
    const doc = docFromHtml(`
      <script type="application/ld+json">{"@type":"Hotel","name":</script>
      <meta property="og:title" content="Broken Markup Inn (updated prices 2026)">
      ${UTAG_SCRIPT}`);
    const v = extractLiveIdentity(doc)!;
    expect(v.name).toBe('Broken Markup Inn');
  });

  it('uses utag hotel_name when og:title is missing too', () => {
    const doc = docFromHtml(UTAG_SCRIPT);
    expect(extractLiveIdentity(doc)!.name).toBe('Utag Hotel Name');
  });

  it('uses the DOM heading as the last-resort name', () => {
    const doc = docFromHtml('<h2 class="pp-header__title"> DOM Hotel </h2>');
    expect(extractLiveIdentity(doc)!.name).toBe('DOM Hotel');
  });

  it('reads coordinates from data-atlas-latlng when script vars are absent', () => {
    const doc = docFromHtml(`
      <h2 class="pp-header__title">Atlas Hotel</h2>
      <a data-atlas-latlng="48.85,2.29"></a>`);
    const v = extractLiveIdentity(doc)!;
    expect(v.lat).toBeCloseTo(48.85);
    expect(v.lng).toBeCloseTo(2.29);
  });

  it('drops out-of-range coordinates instead of reporting garbage', () => {
    const doc = docFromHtml(`
      <h2 class="pp-header__title">Nowhere Hotel</h2>
      <a data-atlas-latlng="999,2.29"></a>`);
    const v = extractLiveIdentity(doc)!;
    expect(v.lat).toBeUndefined();
    expect(v.lng).toBeUndefined();
  });

  it('coerces string-typed aggregateRating values', () => {
    const doc = docFromHtml(`<script type="application/ld+json">
      {"@type":"Hotel","name":"Stringly Inn",
       "aggregateRating":{"ratingValue":"8.4","reviewCount":"120"}}
    </script>`);
    const v = extractLiveIdentity(doc)!;
    expect(v.reviewScore).toBe(8.4);
    expect(v.reviewCount).toBe(120);
  });

  it('leaves review fields undefined (GRAY), never defaults them', () => {
    const doc = docFromHtml(`<script type="application/ld+json">
      {"@type":"Hotel","name":"Unrated Inn"}</script>`);
    const v = extractLiveIdentity(doc)!;
    expect(v.reviewCount).toBeUndefined();
    expect(v.reviewScore).toBeUndefined();
    expect(v.lat).toBeUndefined();
    expect(v.city).toBeUndefined();
  });

  it('returns null for a non-property page even when og:title exists', () => {
    const doc = docFromHtml(`
      <meta property="og:title" content="Booking.com: Hotels in London. Book your hotel now!">
      <script>var page = 'searchresults';</script>`);
    expect(extractLiveIdentity(doc)).toBeNull();
  });

  it('returns null for an empty document', () => {
    expect(extractLiveIdentity(docFromHtml(''))).toBeNull();
  });

  it('collects gallery photos from the hotelPhotos script blob, deduped against the hero', () => {
    const doc = docFromHtml(`
      <script type="application/ld+json">{"@type":"Hotel","name":"Gallery Inn",
        "image":"https://cf.bstatic.com/xdata/images/hotel/max500/111.jpg?k=a"}</script>
      <script>
        var recommended = { large_url: 'https://cf.bstatic.com/xdata/images/hotel/max300/999.jpg' };
        hotelPhotos: [
          { large_url: 'https://cf.bstatic.com/xdata/images/hotel/max1024x768/111.jpg?k=a' },
          { large_url: 'https://cf.bstatic.com/xdata/images/hotel/max1024x768/222.jpg?k=b' },
        ]
      </script>`);
    const v = extractLiveIdentity(doc)!;
    // Hero first, gallery follows, duplicate asset ids collapse; the
    // recommended-property URL before the hotelPhotos marker is ignored.
    expect(v.photoUrls).toEqual([
      'https://cf.bstatic.com/xdata/images/hotel/111.jpg',
      'https://cf.bstatic.com/xdata/images/hotel/222.jpg',
    ]);
  });
});

describe('hostile input is bounded and never fabricates data', () => {
  it('treats empty-string numbers as missing, not as 0', () => {
    // Number('') === 0 would put the property on null island and invent a
    // review count of 0 — both are hard defaults on missing data.
    const doc = docFromHtml(`<script type="application/ld+json">
      {"@type":"Hotel","name":"Empty Fields Inn",
       "geo":{"latitude":"","longitude":"  "},
       "aggregateRating":{"ratingValue":"","reviewCount":""}}</script>`);
    const v = extractLiveIdentity(doc)!;
    expect(v.lat).toBeUndefined();
    expect(v.lng).toBeUndefined();
    expect(v.reviewCount).toBeUndefined();
    expect(v.reviewScore).toBeUndefined();
  });

  it('does not let empty JSON-LD geo mask real coordinates later in the chain', () => {
    const doc = docFromHtml(`
      <script type="application/ld+json">
        {"@type":"Hotel","name":"Masked Geo Inn","geo":{"latitude":"","longitude":""}}</script>
      <script>b_map_center_latitude: '48.8534', b_map_center_longitude: '2.2942'</script>`);
    const v = extractLiveIdentity(doc)!;
    expect(v.lat).toBeCloseTo(48.8534);
    expect(v.lng).toBeCloseTo(2.2942);
  });

  it('ignores an empty data-atlas-latlng attribute', () => {
    const doc = docFromHtml(`
      <h2 class="pp-header__title">Comma Hotel</h2>
      <a data-atlas-latlng=","></a>`);
    const v = extractLiveIdentity(doc)!;
    expect(v.lat).toBeUndefined();
  });

  it('survives a JSON-LD image array far larger than any real page', () => {
    // `push(...arr)` blows the call stack around 100k elements; the extractor
    // must degrade to a capped list instead of throwing.
    const images = JSON.stringify(
      Array.from({ length: 200_000 }, (_, i) => `https://cf.bstatic.com/xdata/images/hotel/max500/${i}.jpg`),
    );
    const doc = docFromHtml(`<script type="application/ld+json">
      {"@type":"Hotel","name":"Boom Inn","image":${images}}</script>`);
    const v = extractLiveIdentity(doc)!;
    expect(v.name).toBe('Boom Inn');
    expect(v.photoUrls.length).toBeLessThanOrEqual(60);
  }, 30_000);

  it('returns promptly on an og:title crafted to blow up the strip loop', () => {
    const doc = docFromHtml(`
      <meta property="og:title" content="X${'()'.repeat(20_000)}">
      ${UTAG_SCRIPT}`);
    const started = Date.now();
    const v = extractLiveIdentity(doc)!;
    expect(Date.now() - started).toBeLessThan(1000);
    // An absurd title is not a name; the chain falls through to the next
    // source rather than grinding or returning attacker-shaped junk.
    expect(v.name).toBe('Utag Hotel Name');
  }, 10_000);

  it('rejects an over-long og:title instead of grinding through it', () => {
    expect(nameFromOgTitle(`Hotel ${'x'.repeat(400)}`)).toBeUndefined();
  });
});

describe('DOM address fallback', () => {
  // Shape copied from the live header: hashed class names, address as a bare
  // text node, location-score UI immediately after with no separating newline.
  const HEADER = `
    <div data-testid="PropertyHeaderAddressDesktop-wrapper">
      <div class="b6937ecb12">
        <a data-atlas-latlng="40.762,-73.978"><span><span class="fc70cba028"></span></span></a>
        <div class="ca9d921c46"><span class="a297f43545"><button class="de576f5064"><div
          class="b99b6ef58f">65 West 54th street, New York, NY 10019, United States</div></button></span>
          <span class="b70006e9dc">–</span>
          <div>Excellent location – rated 9.6/10!</div>
        </div>
      </div>
    </div>`;

  it('reads the address from the header when JSON-LD is absent', () => {
    const doc = docFromHtml(`<h2 class="pp-header__title">Warwick New York</h2>${HEADER}`);
    const v = extractLiveIdentity(doc)!;
    expect(v.address).toBe('65 West 54th street, New York, NY 10019, United States');
  });

  it('prefers JSON-LD over the header when both are present', () => {
    const doc = docFromHtml(`
      <script type="application/ld+json">
        {"@type":"Hotel","name":"Warwick New York",
         "address":{"streetAddress":"From JSON-LD"}}</script>${HEADER}`);
    expect(extractLiveIdentity(doc)!.address).toBe('From JSON-LD');
  });

  it('reports an empty address rather than location-score copy when the header has no address', () => {
    const doc = docFromHtml(`
      <h2 class="pp-header__title">No Address Inn</h2>
      <div data-testid="PropertyHeaderAddressDesktop-wrapper"><div><a data-atlas-latlng="1,2"></a></div></div>`);
    expect(extractLiveIdentity(doc)!.address).toBe('');
  });
});

describe('nameFromOgTitle', () => {
  it.each([
    ['Warwick New York, New York (updated prices 2026)', 'New York', 'Warwick New York'],
    ['Shibuya Excel Hotel Tokyu（東京）：（最新料金：2026年）', '東京', 'Shibuya Excel Hotel Tokyu'],
    ['Hôtel Le Regent Paris, Paris (tarifs actualisés pour 2026)', 'Paris', 'Hôtel Le Regent Paris'],
    ['Electra Metropolis, Αθήνα (ενημερωμένες τιμές για το 2026)', 'Αθήνα', 'Electra Metropolis'],
    ['No Suffix Hotel', undefined, 'No Suffix Hotel'],
  ])('%s → %s', (title, city, expected) => {
    expect(nameFromOgTitle(title, city as string | undefined)).toBe(expected);
  });

  it('keeps a ", city" tail when the city is unknown rather than guessing', () => {
    expect(nameFromOgTitle('Warwick New York, New York (updated prices 2026)'))
      .toBe('Warwick New York, New York');
  });
});

describe('normalizePhotoUrl', () => {
  it.each([
    ['https://cf.bstatic.com/xdata/images/hotel/max500/887746162.jpg?k=abc&o=',
      'https://cf.bstatic.com/xdata/images/hotel/887746162.jpg'],
    ['https://q-xx.bstatic.com/xdata/images/hotel/608x352/583678623.webp?k=x',
      'https://cf.bstatic.com/xdata/images/hotel/583678623.jpg'],
    ['https://r-xx.bstatic.com/xdata/images/hotel/max1024x768/98978448.jpeg',
      'https://cf.bstatic.com/xdata/images/hotel/98978448.jpg'],
  ])('%s', (input, expected) => {
    expect(normalizePhotoUrl(input)).toBe(expected);
  });

  it('rejects non-photo URLs', () => {
    expect(normalizePhotoUrl('https://cf.bstatic.com/static/img/logo.png')).toBeNull();
    expect(normalizePhotoUrl('https://example.com/xdata/images/city/max500/1.jpg')).toBeNull();
    expect(normalizePhotoUrl('not a url')).toBeNull();
  });
});
