import { describe, expect, it } from 'vitest';
import {
  A1_MIN_DISCRIMINATING_NAME_TOKENS,
  A1_MIN_SLUG_NAME_OVERLAP,
  A2_MAX_GEOCODE_CALLS,
  A2_MAX_MEDIAN_DISCREPANCY_KM,
  A2_MAX_MEDIAN_DISTANCE_KM,
  A2_MIN_GEOCODED_POIS,
  A3_MAX_CITY_DISTANCE_KM,
  A3_MIN_BREADCRUMB_DEPTH,
  A3_MIN_QUERY_LEVELS,
  runEngineA,
  type EngineAInput,
} from './enginea';
import type { LatLng } from './geo';
import { en } from './i18n/en';
import { english } from './msg';
import { discriminatingTokenCount, slugTokens, tokenOverlap, tokenize } from './text';
import type { GeocodeOptions, GeocodeResult, Geocoder } from './geocoder';
import type { IdentityVector } from './identity';
import type { PageContext, PoiMention } from './pagecontext';
import type { LocalizedText, Signal } from './signals';

// ---------------------------------------------------------------------------
// fake geocoder — a Map, no network, no timers, no rate limiter
// ---------------------------------------------------------------------------

interface FakeGeocoder extends Geocoder {
  readonly calls: Array<{ query: string; countryCode?: string }>;
}

/**
 * A place the fake resolves to. Supplying `displayName` matters for A3, whose
 * guard reads the provider's name for what it matched: the default name below
 * echoes the query, which is what an answer to the question we asked looks
 * like, so a test about an answer to a DIFFERENT question has to say so.
 */
type FakePlace = LatLng | GeocodeResult;

/**
 * Keys are lowercased queries. Anything not in the map resolves to null, which
 * is the provider's honest "no match" and must never become a RED on its own.
 */
function makeGeocoder(
  places: Record<string, FakePlace>,
  options: { throws?: boolean } = {},
): FakeGeocoder {
  const calls: Array<{ query: string; countryCode?: string }> = [];
  return {
    calls,
    async geocode(query: string, geocodeOptions?: GeocodeOptions) {
      calls.push({ query, countryCode: geocodeOptions?.countryCode });
      if (options.throws) throw new Error('nominatim unavailable');
      const hit = places[query.trim().toLowerCase()];
      if (!hit) return null;
      return 'displayName' in hit ? hit : { ...hit, displayName: `${query} — fake match` };
    },
  };
}

// ---------------------------------------------------------------------------
// geography
// ---------------------------------------------------------------------------

/** Metres per degree of latitude along a meridian, for the sphere geo.ts uses. */
const KM_PER_DEGREE_LAT = 111.195;

/** A point exactly `km` due north — meridian distance is linear in latitude. */
function northOf(origin: LatLng, km: number): LatLng {
  return { lat: origin.lat + km / KM_PER_DEGREE_LAT, lng: origin.lng };
}

// The M1 hijack fixture's two halves: an alpine property (its coordinates and
// its fossilized slug) wearing a Paris identity (its name and its stolen
// neighbourhood copy). ~437 km apart.
const PETIT_BORNAND: LatLng = { lat: 46.0333, lng: 6.3333 };
const EIFFEL_TOWER: LatLng = { lat: 48.8584, lng: 2.2945 };
const LOUVRE: LatLng = { lat: 48.8606, lng: 2.3376 };
const NOTRE_DAME: LatLng = { lat: 48.853, lng: 2.3499 };
const ARC_DE_TRIOMPHE: LatLng = { lat: 48.8738, lng: 2.295 };
const SACRE_COEUR: LatLng = { lat: 48.8867, lng: 2.3431 };
const PARIS: LatLng = { lat: 48.8566, lng: 2.3522 };
const LISBON: LatLng = { lat: 38.7223, lng: -9.1393 };
const NEW_YORK: LatLng = { lat: 40.7128, lng: -74.006 };

const PARIS_LANDMARKS: Record<string, LatLng> = {
  'eiffel tower': EIFFEL_TOWER,
  'louvre museum': LOUVRE,
  'notre-dame de paris': NOTRE_DAME,
  'arc de triomphe': ARC_DE_TRIOMPHE,
  'sacré-cœur': SACRE_COEUR,
  paris: PARIS,
  // A3 asks about the trail as a place path, so the Paris trail of the two
  // hijack fixtures arrives here spelled exactly as those pages spell it.
  'paris, ile de france, france': PARIS,
};

/**
 * The trail of the two in-the-wild hijack fixtures, verbatim
 * (fixtures/live/fr-hijack-*.en-gb.html). Its deepest place level IS the city,
 * which is the shape A3's old positional read happened to get right.
 */
const HIJACK_TRAIL = [
  'Home',
  'Hotels',
  'All B&Bs',
  'France',
  'Ile de France',
  'Paris',
  'Paris Eiffel Residence (Bed and breakfast) (France) deals',
];

// ---------------------------------------------------------------------------
// input builders
// ---------------------------------------------------------------------------

function identity(overrides: Partial<IdentityVector> = {}): IdentityVector {
  return {
    name: 'Corpo Santo Lisbon Historical Hotel',
    address: 'Largo do Corpo Santo 25',
    country: 'PT',
    lat: LISBON.lat,
    lng: LISBON.lng,
    photoUrls: [],
    capturedAt: '2026-08-11T00:00:00.000Z',
    source: { kind: 'live' },
    ...overrides,
  };
}

function context(overrides: Partial<PageContext> = {}): PageContext {
  return { breadcrumbs: [], pois: [], reviews: [], ...overrides };
}

function poi(name: string, statedDistanceKm?: number): PoiMention {
  return statedDistanceKm === undefined ? { name } : { name, statedDistanceKm };
}

function input(overrides: Partial<EngineAInput> = {}): EngineAInput {
  return {
    identity: identity(),
    slug: 'corpo-santo',
    context: context(),
    geocoder: makeGeocoder({}),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// assertions
// ---------------------------------------------------------------------------

function find(signals: Signal[], id: string): Signal | undefined {
  return signals.find((s) => s.id === id);
}

/** The signal with this id, failing the test loudly if it is missing. */
function require_(signals: Signal[], id: string): Signal {
  const signal = find(signals, id);
  if (!signal) throw new Error(`expected a ${id} signal, got [${signals.map((s) => s.id)}]`);
  return signal;
}

function evidence(signal: Signal, label: string): string {
  const row = signal.values?.find((v) => v.label === label);
  if (!row) {
    throw new Error(`no "${label}" row in ${signal.id}: [${(signal.values ?? []).map((v) => v.label)}]`);
  }
  return row.value;
}

/** The leading number of an evidence value like "436.8 km away — …". */
function km(value: string): number {
  const match = /(-?\d+(?:\.\d+)?)\s*km/.exec(value);
  return match ? Number(match[1]) : Number.NaN;
}

// ===========================================================================
// A1 — slug vs displayed name
// ===========================================================================

describe('A1 — slug vs displayed name', () => {
  it('flags the real hijack: an alpine slug on a Paris name', async () => {
    const signals = await runEngineA(
      input({
        slug: 'l-39-horizon-des-alpes-le-petit-bornand-les-glieres',
        identity: identity({ name: 'Paris Eiffel Residence', country: 'FR' }),
      }),
    );

    const a1 = require_(signals, 'A1');
    expect(a1.severity).toBe('RED');
    expect(a1.engine).toBe('A');
    // The panel must be able to show its work: both strings and the score.
    expect(evidence(a1, 'URL slug')).toContain('petit-bornand');
    expect(evidence(a1, 'Displayed name')).toBe('Paris Eiffel Residence');
    expect(Number(evidence(a1, 'Overlap').split(' ')[0])).toBeLessThan(A1_MIN_SLUG_NAME_OVERLAP);
  });

  // The measured corpus (fixtures/live/, 12 real listings). These three are the
  // whole calibration: everything else scores 1.000. The expected overlap is
  // asserted directly against lib/text.ts, so this table fails if a folding rule
  // regresses OR if the threshold drifts into the legitimate range — rather than
  // the verdict distribution shifting quietly.
  it.each<[string, string, number]>([
    ['corpo-santo', 'Corpo Santo Lisbon Historical Hotel', 0.667],
    ['hotelbellevue_rimini', 'Hotel Bellevue by OasiGroup Hotels', 0.5],
    ['strand-palace', 'Strand Palace Hotel', 1.0],
  ])('clears the legitimate listing %s (measured overlap %s)', async (slug, name, measured) => {
    // Independently measured value, from the brief's ground-truth table.
    const overlap = tokenOverlap(slugTokens(slug), tokenize(name));
    expect(overlap).toBeCloseTo(measured, 3);
    expect(overlap).toBeGreaterThanOrEqual(A1_MIN_SLUG_NAME_OVERLAP);

    const signals = await runEngineA(input({ slug, identity: identity({ name }) }));
    expect(find(signals, 'A1')).toBeUndefined();
  });

  it('scores the known hijack at zero, below the threshold', async () => {
    expect(
      tokenOverlap(
        slugTokens('l-39-horizon-des-alpes-le-petit-bornand-les-glieres'),
        tokenize('Paris Eiffel Residence'),
      ),
    ).toBe(0);
  });

  it('keeps the threshold inside the measured separation gap', () => {
    // Hijack 0.000 must be below it, the worst legitimate listing (0.500) above
    // it, both with headroom. A change that violates either bound is a
    // regression in detection or a false-positive risk, not a tuning choice.
    expect(A1_MIN_SLUG_NAME_OVERLAP).toBeGreaterThan(0);
    expect(A1_MIN_SLUG_NAME_OVERLAP).toBeLessThan(0.5);
  });

  it('is GRAY, never RED, when the name is not in the Latin script', async () => {
    // Booking slugs are always Latin, so a Japanese name shares no tokens with
    // its slug by construction — score 0.000, identical to a hijack. Accusing
    // this listing would be a pure false positive.
    const signals = await runEngineA(
      input({
        slug: 'shibuya-excel-hotel-tokyu',
        identity: identity({ name: '渋谷エクセルホテル東急', country: 'JP' }),
      }),
    );

    const a1 = require_(signals, 'A1');
    expect(a1.severity).toBe('GRAY');
  });

  it.each<[string, string, string]>([
    ['the slug has no usable tokens', '39', 'Paris Eiffel Residence'],
    ['the name has no usable tokens', 'corpo-santo', '!!! ???'],
  ])('says nothing when %s', async (_case, slug, name) => {
    const signals = await runEngineA(input({ slug, identity: identity({ name }) }));
    expect(find(signals, 'A1')).toBeUndefined();
  });

  it('caps a one-word disagreement at YELLOW instead of RED', async () => {
    // "Hotel Astoria" has exactly one word that carries identity, so its score
    // is 0.00 or 1.00 with nothing in between and the whole accusation rests on
    // that single word. Reported, but not enough to condemn on its own.
    expect(discriminatingTokenCount(tokenize('Hotel Astoria'))).toBe(1);

    const signals = await runEngineA(
      input({ slug: 'hotel-lutetia', identity: identity({ name: 'Hotel Astoria' }) }),
    );

    const a1 = require_(signals, 'A1');
    expect(a1.severity).toBe('YELLOW');
    // Not silence and not GRAY: lib/score.ts drops GRAY rows before deciding,
    // so greying this out would let the page come back GREEN.
    expect(evidence(a1, 'Identity words in the name')).toBe('1');
  });

  it('still reaches RED on the hijack, which has two identity words', async () => {
    // The downgrade above must not reach the case it was calibrated around:
    // "Paris Eiffel Residence" is paris + eiffel once the category word goes.
    expect(discriminatingTokenCount(tokenize('Paris Eiffel Residence'))).toBe(
      A1_MIN_DISCRIMINATING_NAME_TOKENS,
    );
  });

  it('is GRAY when the name is made only of category words', async () => {
    // "The Hotel" against any slug says nothing about which property is sold.
    const signals = await runEngineA(
      input({ slug: 'corpo-santo', identity: identity({ name: 'The Hotel' }) }),
    );

    const a1 = require_(signals, 'A1');
    expect(a1.severity).toBe('GRAY');
  });
});

// ===========================================================================
// A1 — slugs that run the name's words together
// ===========================================================================

/**
 * The false positive this pass exists to remove, and the detection it must not
 * cost. Both halves are asserted here because they are one trade: every
 * character of tolerance that clears an honest hotel also widens the set of
 * names a fossil slug can be said to explain.
 */
describe('A1 — a slug that is the name with the separators taken out', () => {
  it('does not accuse Hôtel Le Colisée, whose slug IS its name', async () => {
    // Reported by a real user. Booking serves this Paris hotel at
    // /hotel/fr/lecolise.html: "Le Colisée" with the space, the accent and one
    // trailing letter gone. Word-by-word the slug matches nothing and A1 called
    // an ordinary hotel a hijack.
    expect(tokenOverlap(slugTokens('lecolise'), tokenize('Hôtel Le Colisée'))).toBe(0);

    const signals = await runEngineA(
      input({ slug: 'lecolise', identity: identity({ name: 'Hôtel Le Colisée', country: 'FR' }) }),
    );

    expect(find(signals, 'A1')).toBeUndefined();
  });

  it.each<[string, string, string]>([
    // The exact form, already handled by lib/text.ts and kept honest here.
    ['a clean concatenation', 'strandpalace', 'Strand Palace'],
    ['a concatenation with a suffix', 'lecolise-paris', 'Hôtel Le Colisée'],
    ['a name that gained a word', 'lecolise', 'Hôtel Le Colisée Montmartre'],
    ['an accented, spaced original', 'catalonialaboqueria', 'Catalonia La Boquería'],
  ])('clears %s', async (_case, slug, name) => {
    const signals = await runEngineA(input({ slug, identity: identity({ name }) }));
    expect(find(signals, 'A1')).toBeUndefined();
  });

  it('still flags both real in-the-wild hijacks', async () => {
    // fixtures/live/manifest.json: the two pages the extension caught while
    // browsing normally. Neither has any glued run within reach of its slug —
    // the nearest are 3 and 11 edits away against a budget of 1 — so the pass
    // hands back nothing and the accusation is exactly the one A1 made before.
    const alpine = await runEngineA(
      input({
        slug: 'l-39-horizon-des-alpes-le-petit-bornand-les-glieres',
        identity: identity({ name: 'Paris Eiffel Residence', country: 'FR' }),
      }),
    );
    expect(require_(alpine, 'A1').severity).toBe('RED');
    expect(Number(evidence(require_(alpine, 'A1'), 'Overlap').split(' ')[0])).toBe(0);

    const gite = await runEngineA(
      input({
        slug: 'gitenchassagne',
        identity: identity({ name: 'Le Grand Paris Apartments', country: 'FR' }),
      }),
    );
    expect(require_(gite, 'A1').severity).toBe('RED');
    expect(Number(evidence(require_(gite, 'A1'), 'Overlap').split(' ')[0])).toBe(0);
  });

  it.each<[string, string, string]>([
    // The adversarial shape: a hijacker who renames the property to something
    // that keeps the fossil slug's letters. One character is forgiven; the
    // second is where the line is, and past it the rule is untouched.
    ['a six-letter shared prefix is not enough', 'lecolise', 'Hôtel Le Colibri'],
    ['two edits do not clear', 'gitenchassagne', 'Gîtes en Chassagnes'],
    // The tolerance is for a missing separator, never for a misspelt word: a
    // one-word near match is a far looser claim and the one that costs
    // detection ("parisien" would come to explain a different property).
    ['a one-word near match is refused', 'parisien', 'Suite Parisian'],
    // Below the character floor a single letter is most of the identity.
    ['a glue shorter than the floor is refused', 'lemar', 'Le Mas'],
  ])('%s', async (_case, slug, name) => {
    // Not vacuous: each of these is a pair the word-by-word comparison already
    // scores at zero, so the only question is whether the concatenation pass
    // hands the accusation away. It must not.
    expect(tokenOverlap(slugTokens(slug), tokenize(name))).toBe(0);

    const signals = await runEngineA(input({ slug, identity: identity({ name }) }));
    const a1 = require_(signals, 'A1');
    expect(a1.severity === 'RED' || a1.severity === 'YELLOW').toBe(true);
  });

  it('draws the line at exactly one character', async () => {
    // The same slug against two names the word comparison scores identically
    // (0.00 both), separated only by how far the glued spellings are from the
    // slug: one character clears, two does not. Everything this pass gives
    // away is inside that one character.
    for (const name of ['Hôtel Le Colisée', 'Hôtel Le Colisées']) {
      expect(tokenOverlap(slugTokens('lecolise'), tokenize(name))).toBe(0);
    }

    const oneEdit = await runEngineA(
      input({ slug: 'lecolise', identity: identity({ name: 'Hôtel Le Colisée' }) }),
    );
    expect(find(oneEdit, 'A1')).toBeUndefined();

    const twoEdits = await runEngineA(
      input({ slug: 'lecolise', identity: identity({ name: 'Hôtel Le Colisées' }) }),
    );
    expect(find(twoEdits, 'A1')).toBeDefined();
  });

  it('shows the run-together forms it actually compared', async () => {
    // The evidence table has to state the check that was made, not an older
    // one: A1 now compares the words and the glued spellings, and when it fires
    // the reader can see both readings failed.
    const signals = await runEngineA(
      input({
        slug: 'gitenchassagne',
        identity: identity({ name: 'Le Grand Paris Apartments', country: 'FR' }),
      }),
    );

    const a1 = require_(signals, 'A1');
    expect(evidence(a1, 'Slug run together')).toBe('gitenchassagne');
    expect(evidence(a1, 'Name run together')).toBe('legrandparisapartments');
  });

  it('leaves the legitimate corpus where it was', async () => {
    // The three calibration listings score exactly what lib/text.ts measures
    // for them; the pass may only ever add credit, never remove it.
    for (const [slug, name] of [
      ['corpo-santo', 'Corpo Santo Lisbon Historical Hotel'],
      ['hotelbellevue_rimini', 'Hotel Bellevue by OasiGroup Hotels'],
      ['strand-palace', 'Strand Palace Hotel'],
    ] as const) {
      const signals = await runEngineA(input({ slug, identity: identity({ name }) }));
      expect(find(signals, 'A1'), `${slug} must stay clear`).toBeUndefined();
    }
  });
});

// ===========================================================================
// A2 — nearby landmarks vs coordinates
// ===========================================================================

describe('A2 — nearby landmarks vs coordinates', () => {
  it('flags the hijack shape: Paris landmarks "250 m" from an alpine hotel', async () => {
    const geocoder = makeGeocoder(PARIS_LANDMARKS);
    const signals = await runEngineA({
      identity: identity({
        name: 'Paris Eiffel Residence',
        country: 'FR',
        lat: PETIT_BORNAND.lat,
        lng: PETIT_BORNAND.lng,
      }),
      slug: 'l-39-horizon-des-alpes-le-petit-bornand-les-glieres',
      context: context({
        pois: [
          poi('Eiffel Tower', 0.25),
          poi('Louvre Museum', 1.8),
          poi('Notre-Dame de Paris', 2.1),
          poi('Arc de Triomphe', 1.2),
        ],
      }),
      geocoder,
    });

    // The acceptance case from PLAN.md M4: RED on a first visit, zero archive
    // coverage, from A1 and A2 together.
    expect(require_(signals, 'A1').severity).toBe('RED');
    const a2 = require_(signals, 'A2');
    expect(a2.severity).toBe('RED');

    expect(km(evidence(a2, 'Median real distance'))).toBeGreaterThan(400);
    expect(km(evidence(a2, 'Median gap vs the stated distance'))).toBeGreaterThan(
      A2_MAX_MEDIAN_DISCREPANCY_KM,
    );
    // One evidence row per landmark, carrying both numbers.
    expect(evidence(a2, 'Eiffel Tower')).toMatch(/43[0-9](\.\d)? km away — page says 0\.25 km/);
    expect(a2.links?.[0]?.href).toContain('openstreetmap.org');
    // The country hint narrows ambiguous landmark names.
    expect(geocoder.calls.every((c) => c.countryCode === 'FR')).toBe(true);
  });

  it('flags landmarks that are far away even when the page states no distances', async () => {
    const signals = await runEngineA(
      input({
        identity: identity({
          name: 'Paris Eiffel Residence',
          country: 'FR',
          lat: PETIT_BORNAND.lat,
          lng: PETIT_BORNAND.lng,
        }),
        slug: 'paris-eiffel-residence',
        context: context({
          pois: [poi('Eiffel Tower'), poi('Louvre Museum'), poi('Sacré-Cœur')],
        }),
        geocoder: makeGeocoder(PARIS_LANDMARKS),
      }),
    );

    const a2 = require_(signals, 'A2');
    expect(a2.severity).toBe('RED');
    expect(a2.title).toContain('nowhere near');
    expect(km(evidence(a2, 'Median real distance'))).toBeGreaterThan(A2_MAX_MEDIAN_DISTANCE_KM);
  });

  it('says nothing about a normal listing whose landmarks check out', async () => {
    const signals = await runEngineA(
      input({
        context: context({
          pois: [
            poi('Praça do Comércio', 0.4),
            poi('Time Out Market', 0.3),
            poi('Castelo de São Jorge', 1.1),
            poi('Belém Tower', 6.5),
          ],
        }),
        geocoder: makeGeocoder({
          'praça do comércio': northOf(LISBON, 0.4),
          'time out market': northOf(LISBON, 0.3),
          'castelo de são jorge': northOf(LISBON, 1.1),
          'belém tower': northOf(LISBON, 6.4),
        }),
      }),
    );

    expect(signals).toEqual([]);
  });

  it('does not accuse a genuinely remote property that states its distances honestly', async () => {
    // Landmarks 60–80 km out, and the page says so. Self-consistent: a remote
    // hotel describing itself, not a hijack. A2(a) alone would call this RED.
    const remote = PETIT_BORNAND;
    const signals = await runEngineA(
      input({
        slug: 'chalet-horizon',
        identity: identity({
          name: 'Chalet Horizon',
          country: 'FR',
          lat: remote.lat,
          lng: remote.lng,
        }),
        context: context({
          pois: [poi('Geneva Airport', 60), poi('Annecy', 70), poi('Chamonix', 80)],
        }),
        geocoder: makeGeocoder({
          'geneva airport': northOf(remote, 60),
          annecy: northOf(remote, 70),
          chamonix: northOf(remote, 80),
        }),
      }),
    );

    expect(find(signals, 'A2')).toBeUndefined();
  });

  it('does not let a minority of honest rows vouch for the landmarks they do not cover', async () => {
    // Three landmarks whose stated distance checks out, and three the page says
    // nothing about that are 500 km from its coordinates. Half the sample being
    // self-consistent is not the page explaining itself.
    const remote = PETIT_BORNAND;
    const signals = await runEngineA(
      input({
        slug: 'chalet-horizon',
        identity: identity({ name: 'Chalet Horizon', country: 'FR', lat: remote.lat, lng: remote.lng }),
        context: context({
          pois: [
            poi('Geneva Airport', 60),
            poi('Annecy', 70),
            poi('Chamonix', 80),
            poi('Far One'),
            poi('Far Two'),
            poi('Far Three'),
          ],
        }),
        geocoder: makeGeocoder({
          'geneva airport': northOf(remote, 60),
          annecy: northOf(remote, 70),
          chamonix: northOf(remote, 80),
          'far one': northOf(remote, 500),
          'far two': northOf(remote, 520),
          'far three': northOf(remote, 540),
        }),
      }),
    );

    const a2 = require_(signals, 'A2');
    expect(a2.severity).toBe('RED');
    expect(a2.title).toContain('nowhere near');
  });

  it.each<[string, number, boolean]>([
    ['inside the threshold', A2_MAX_MEDIAN_DISTANCE_KM - 5, false],
    ['past the threshold', A2_MAX_MEDIAN_DISTANCE_KM + 5, true],
  ])('reads a median real distance %s correctly', async (_case, distanceKm, shouldFire) => {
    // Pins the direction and the boundary: a rule that fired on both sides, or
    // on neither, would pass every other test in this file.
    const signals = await runEngineA(
      input({
        context: context({ pois: [poi('Alpha One'), poi('Beta Two'), poi('Gamma Three')] }),
        geocoder: makeGeocoder({
          'alpha one': northOf(LISBON, distanceKm),
          'beta two': northOf(LISBON, distanceKm),
          'gamma three': northOf(LISBON, distanceKm),
        }),
      }),
    );

    expect(find(signals, 'A2')?.severity).toBe(shouldFire ? 'RED' : undefined);
  });

  it.each<[string, number, boolean]>([
    ['inside the threshold', A2_MAX_MEDIAN_DISCREPANCY_KM - 5, false],
    ['past the threshold', A2_MAX_MEDIAN_DISCREPANCY_KM + 5, true],
  ])('reads a median stated-distance gap %s correctly', async (_case, gapKm, shouldFire) => {
    // The landmarks sit 1 km away; the page claims they are `gapKm + 1` away,
    // so only the self-contradiction branch is in play (real median ≪ 50 km).
    const signals = await runEngineA(
      input({
        context: context({
          pois: [poi('Alpha One', gapKm + 1), poi('Beta Two', gapKm + 1), poi('Gamma Three', gapKm + 1)],
        }),
        geocoder: makeGeocoder({
          'alpha one': northOf(LISBON, 1),
          'beta two': northOf(LISBON, 1),
          'gamma three': northOf(LISBON, 1),
        }),
      }),
    );

    const a2 = find(signals, 'A2');
    expect(a2?.severity).toBe(shouldFire ? 'RED' : undefined);
    if (shouldFire) expect(a2?.title).toContain('contradicts itself');
  });

  it('is GRAY when fewer than three landmarks can be located', async () => {
    const signals = await runEngineA(
      input({
        context: context({
          pois: [poi('Time Out Market', 0.3), poi('Ye Olde Unmappable Pub', 0.2), poi('Nowhere')],
        }),
        geocoder: makeGeocoder({ 'time out market': northOf(LISBON, 0.3) }),
      }),
    );

    const a2 = require_(signals, 'A2');
    expect(a2.severity).toBe('GRAY');
    expect(evidence(a2, 'Landmarks located')).toBe('1');
    expect(a2.title).toContain('Could not verify');
  });

  it('is GRAY, not RED, when a landmark geocodes to nonsense coordinates', async () => {
    // A provider answering with an impossible latitude is corrupt input, not a
    // measurement: it must reduce the sample, never contribute a distance.
    const signals = await runEngineA(
      input({
        context: context({
          pois: [poi('A', 0.3), poi('Bee', 0.3), poi('Cee', 0.3), poi('Dee', 0.3)],
        }),
        geocoder: makeGeocoder({
          bee: { lat: 999, lng: 0 },
          cee: { lat: Number.NaN, lng: 2 },
          dee: northOf(LISBON, 0.3),
        }),
      }),
    );

    expect(require_(signals, 'A2').severity).toBe('GRAY');
  });

  it('is GRAY when the page lists no landmarks at all', async () => {
    const signals = await runEngineA(input({ context: context({ pois: [] }) }));
    expect(require_(signals, 'A2').severity).toBe('GRAY');
  });

  it('is GRAY when the listing publishes no coordinates', async () => {
    const signals = await runEngineA(
      input({
        identity: identity({ lat: undefined, lng: undefined }),
        context: context({
          pois: [poi('Time Out Market', 0.3), poi('Belém Tower', 6.5), poi('Louvre Museum', 1.0)],
        }),
        geocoder: makeGeocoder(PARIS_LANDMARKS),
      }),
    );

    const a2 = require_(signals, 'A2');
    expect(a2.severity).toBe('GRAY');
    expect(a2.title).toContain('no usable coordinates');
  });

  it('treats (0, 0) as a missing coordinate, not as a location in the Atlantic', async () => {
    // Null Island is the shape of a field that was never filled in. Measured
    // from there every real landmark is thousands of km away, so scoring it
    // would produce a confident RED built entirely on a missing value.
    const signals = await runEngineA(
      input({
        identity: identity({ lat: 0, lng: 0 }),
        context: context({
          pois: [poi('Time Out Market', 0.3), poi('Praça do Comércio', 0.4), poi('Belém Tower', 6.5)],
        }),
        geocoder: makeGeocoder({
          'time out market': northOf(LISBON, 0.3),
          'praça do comércio': northOf(LISBON, 0.4),
          'belém tower': northOf(LISBON, 6.4),
        }),
      }),
    );

    expect(require_(signals, 'A2').severity).toBe('GRAY');
    expect(signals.every((s) => s.severity !== 'RED')).toBe(true);
  });

  it('is GRAY, and does not throw, when the geocoder itself fails', async () => {
    const signals = await runEngineA(
      input({
        context: context({
          breadcrumbs: ['Início', 'Hotéis', 'Portugal', 'Lisboa', 'Corpo Santo (Portugal) Ofertas'],
          pois: [poi('Time Out Market', 0.3), poi('Belém Tower', 6.5), poi('Praça do Comércio', 0.4)],
        }),
        geocoder: makeGeocoder({}, { throws: true }),
      }),
    );

    // Every rule that needed the network degrades; none of them turns RED and
    // nothing escapes as an exception.
    expect(require_(signals, 'A2').severity).toBe('GRAY');
    expect(require_(signals, 'A3').severity).toBe('GRAY');
    expect(signals.every((s) => s.severity !== 'RED')).toBe(true);
  });

  it('spends at most the geocoder budget on one page', async () => {
    const geocoder = makeGeocoder(PARIS_LANDMARKS);
    const pois = Array.from({ length: 12 }, (_, i) => poi(`Landmark number ${i}`, 0.5));

    await runEngineA(input({ context: context({ pois }), geocoder }));

    // Nominatim allows 1 req/s; a listing page is not worth 12 seconds.
    expect(geocoder.calls).toHaveLength(A2_MAX_GEOCODE_CALLS);
  });

  it('spends the budget on landmarks that come with a stated distance first', async () => {
    const geocoder = makeGeocoder(PARIS_LANDMARKS);
    const pois: PoiMention[] = [
      poi('Unstated one'),
      poi('Unstated two'),
      poi('Unstated three'),
      poi('Unstated four'),
      poi('Unstated five'),
      poi('Unstated six'),
      poi('Eiffel Tower', 0.25),
      poi('Louvre Museum', 1.8),
    ];

    await runEngineA(input({ context: context({ pois }), geocoder }));

    const queried = geocoder.calls.map((c) => c.query);
    // They are last on the page but first in the budget: only a stated distance
    // enables the self-contradiction test.
    expect(queried).toContain('Eiffel Tower');
    expect(queried).toContain('Louvre Museum');
    expect(queried).toHaveLength(A2_MAX_GEOCODE_CALLS);
  });

  it('does not spend calls on repeated landmark names', async () => {
    const geocoder = makeGeocoder(PARIS_LANDMARKS);
    const pois = [
      poi('Eiffel Tower', 0.25),
      poi('eiffel tower', 0.25),
      poi('Eiffel  Tower', 0.3),
      poi('Louvre Museum', 1.8),
      poi('Notre-Dame de Paris', 2.1),
    ];

    await runEngineA(input({ context: context({ pois }), geocoder }));

    expect(geocoder.calls.map((c) => c.query)).toHaveLength(3);
  });

  it('ignores landmark rows too short to geocode meaningfully', async () => {
    const geocoder = makeGeocoder(PARIS_LANDMARKS);
    await runEngineA(
      input({
        context: context({ pois: [poi('A', 0.1), poi('B', 0.2), poi('Eiffel Tower', 0.25)] }),
        geocoder,
      }),
    );

    expect(geocoder.calls.map((c) => c.query)).toEqual(['Eiffel Tower']);
  });

  it('treats a negative stated distance as "not stated" rather than as zero', async () => {
    // A parse artefact must not manufacture a discrepancy, and must not read as
    // "on site" either. Here the landmarks really are far, so the displacement
    // branch still fires — but on real distance, not on a fabricated gap.
    const signals = await runEngineA(
      input({
        slug: 'paris-eiffel-residence',
        identity: identity({
          name: 'Paris Eiffel Residence',
          country: 'FR',
          lat: PETIT_BORNAND.lat,
          lng: PETIT_BORNAND.lng,
        }),
        context: context({
          pois: [
            poi('Eiffel Tower', -1),
            poi('Louvre Museum', Number.NaN),
            poi('Sacré-Cœur', -0.5),
          ],
        }),
        geocoder: makeGeocoder(PARIS_LANDMARKS),
      }),
    );

    const a2 = require_(signals, 'A2');
    expect(a2.severity).toBe('RED');
    expect(a2.title).toContain('nowhere near');
    expect(evidence(a2, 'Eiffel Tower')).toContain('no distance stated');
  });

  it('needs a real sample before it will call a page self-contradictory', async () => {
    // Two contradicted landmarks and one unmappable: below the minimum sample,
    // so the honest answer is GRAY. One bad geocode must never condemn.
    expect(A2_MIN_GEOCODED_POIS).toBeGreaterThanOrEqual(3);
    const signals = await runEngineA(
      input({
        identity: identity({ lat: PETIT_BORNAND.lat, lng: PETIT_BORNAND.lng, country: 'FR' }),
        context: context({
          pois: [poi('Eiffel Tower', 0.25), poi('Louvre Museum', 1.8), poi('Unmappable Alley', 0.3)],
        }),
        geocoder: makeGeocoder({
          'eiffel tower': EIFFEL_TOWER,
          'louvre museum': LOUVRE,
        }),
      }),
    );

    expect(require_(signals, 'A2').severity).toBe('GRAY');
  });
});

// ===========================================================================
// A3 — breadcrumb city vs coordinates
// ===========================================================================

describe('A3 — breadcrumb city vs coordinates', () => {
  it('flags a breadcrumb city on the wrong side of the world', async () => {
    const geocoder = makeGeocoder({ 'new york, new york state, united states': NEW_YORK });
    const signals = await runEngineA(
      input({
        identity: identity({
          name: 'Warwick New York',
          country: 'US',
          lat: PARIS.lat,
          lng: PARIS.lng,
        }),
        context: context({
          breadcrumbs: [
            'Home',
            'Hotels',
            'United States',
            'New York State (NY)',
            'New York',
            'Warwick New York (Hotel) (US) Deals',
          ],
        }),
        geocoder,
      }),
    );

    const a3 = require_(signals, 'A3');
    expect(a3.severity).toBe('YELLOW');
    // The evidence prints the query the check actually sent, not a token it
    // picked out of the trail and then qualified behind the reader's back.
    expect(evidence(a3, 'Breadcrumb place looked up')).toBe(
      'New York, New York State, United States',
    );
    expect(km(evidence(a3, 'Distance apart'))).toBeGreaterThan(A3_MAX_CITY_DISTANCE_KM);
    // One call: an accusation the geocoder corroborated needs no second opinion.
    expect(geocoder.calls).toEqual([
      { query: 'New York, New York State, United States', countryCode: 'US' },
    ]);
  });

  it('says nothing when the breadcrumb place matches the coordinates', async () => {
    const signals = await runEngineA(
      input({
        context: context({
          breadcrumbs: [
            'Início',
            'Hotéis',
            'Portugal',
            'Lisboa',
            'Misericordia',
            'Ofertas em Corpo Santo Lisbon Historical Hotel (Hotel) (Portugal)',
          ],
        }),
        geocoder: makeGeocoder({ 'misericordia, lisboa, portugal': northOf(LISBON, 2) }),
      }),
    );

    expect(find(signals, 'A3')).toBeUndefined();
  });

  /**
   * The trails as the pages actually publish them (derived from
   * fixtures/live/, never read into a test). Two shapes in the same corpus —
   * some stop at the city, some carry a district below it — which is why no
   * fixed position in this table is the city, and why the query is the path.
   */
  it.each<[string, string, string[], string]>([
    [
      'French, district below the city',
      'Hôtel Le Regent Paris',
      ['Accueil', 'Hôtels', 'France', 'Île-de-France', 'Paris', '6e arr.', "Offre à l'établissement Hôtel Le Regent Paris (Hôtel), (France)"],
      '6e arr., Paris, Île-de-France',
    ],
    [
      'German, district below the city',
      'Schulz Hotel Berlin Wall at the East Side Gallery',
      ['Startseite', 'Hotels', 'Deutschland', 'Brandenburg', 'Berlin', 'Friedrichshain-Kreuzberg', 'Schulz Hotel Berlin Wall at the East Side Gallery (Hotel) (Deutschland) Angebote'],
      'Friedrichshain-Kreuzberg, Berlin, Brandenburg',
    ],
    [
      'Greek, ending at the city',
      'Electra Metropolis',
      ['Αρχική σελίδα', 'Ξενοδοχεία', 'Ελλάδα', 'Αττική', 'Αθήνα', 'Electra Metropolis (Ξενοδοχείο) (Ελλάδα) προσφορές'],
      'Αθήνα, Αττική, Ελλάδα',
    ],
    [
      'Japanese, district below the city',
      'Shibuya Excel Hotel Tokyu',
      ['ホーム', 'ホテル', '日本', '東京都', '東京', '渋谷区', 'Shibuya Excel Hotel Tokyu (ホテル)（日本）のセール'],
      '渋谷区, 東京, 東京都',
    ],
    [
      'Portuguese, one region level short',
      'Corpo Santo Lisbon Historical Hotel',
      ['Início', 'Hotéis', 'Portugal', 'Lisboa', 'Misericordia', 'Ofertas em Corpo Santo Lisbon Historical Hotel (Hotel) (Portugal)'],
      'Misericordia, Lisboa, Portugal',
    ],
    [
      'a trail that ends at the city with no property row at all',
      'London County Hall',
      ['Home', 'Hotel Directory', 'England', 'Greater London', 'London'],
      'London, Greater London, England',
    ],
  ])('asks about the %s trail as a place path', async (_shape, name, breadcrumbs, query) => {
    // The trails are the ones the pages actually publish (derived from
    // fixtures/live/ and fixtures/live-generic/), which is the point: no fixed
    // index in this table is the city, the localized navigation rows never
    // reach the query, and the property's own row does not either.
    const geocoder = makeGeocoder({});
    await runEngineA(
      input({
        identity: identity({ name, lat: PARIS.lat, lng: PARIS.lng, country: 'FR' }),
        context: context({ breadcrumbs }),
        geocoder,
      }),
    );

    expect(geocoder.calls[0]?.query).toBe(query);
  });

  it.each<[string, number, boolean]>([
    ['inside the threshold', A3_MAX_CITY_DISTANCE_KM - 5, false],
    ['past the threshold', A3_MAX_CITY_DISTANCE_KM + 5, true],
  ])('reads a breadcrumb-place distance %s correctly', async (_case, distanceKm, shouldFire) => {
    const signals = await runEngineA(
      input({
        context: context({ breadcrumbs: HIJACK_TRAIL }),
        identity: identity({ name: 'Paris Eiffel Residence', country: 'FR' }),
        geocoder: makeGeocoder({
          'paris, ile de france, france': northOf(LISBON, distanceKm),
        }),
      }),
    );

    expect(find(signals, 'A3')?.severity).toBe(shouldFire ? 'YELLOW' : undefined);
  });

  it('strips parenthesised qualifiers before geocoding', async () => {
    const geocoder = makeGeocoder({});
    await runEngineA(
      input({
        identity: identity({
          name: 'Warwick New York',
          lat: NEW_YORK.lat,
          lng: NEW_YORK.lng,
          country: 'US',
        }),
        context: context({
          breadcrumbs: [
            'Home',
            'Hotels',
            'USA',
            'New York State (NY)',
            'New York (NY) (US)',
            'Warwick New York (Hotel) (US) Deals',
          ],
        }),
        geocoder,
      }),
    );

    expect(geocoder.calls[0]?.query).toBe('New York, New York State, USA');
  });

  it.each<[string, string[]]>([
    // Below the root and the category row this leaves one place level, and one
    // level is the bare token whose geocode started all this — worse, here it
    // is a country, whose centroid is hundreds of kilometres from most honest
    // properties.
    ['too short to carry a place path', ['Home', 'France', 'Hôtel X (France) Deals']],
    ['empty', []],
  ])('says nothing, and spends no call, when the trail is %s', async (_case, breadcrumbs) => {
    expect(A3_MIN_BREADCRUMB_DEPTH).toBeGreaterThanOrEqual(4);
    expect(A3_MIN_QUERY_LEVELS).toBeGreaterThanOrEqual(2);
    const geocoder = makeGeocoder({ france: { lat: 46.6, lng: 2.2 } });
    const signals = await runEngineA(
      input({
        identity: identity({ name: 'Hôtel X', country: 'FR' }),
        context: context({ breadcrumbs }),
        geocoder,
      }),
    );

    expect(find(signals, 'A3')).toBeUndefined();
    expect(geocoder.calls).toEqual([]);
  });

  it('is GRAY, never an accusation, when a short trail ends in something unplaceable', async () => {
    // A trail with too few levels to spare one keeps its last row, junk and
    // all, because the alternative — dropping it and geocoding what is left —
    // is how a region centroid gets compared against a property. The junk query
    // costs one lookup and a "could not check" row; it can never cost a flag.
    const geocoder = makeGeocoder({ france: { lat: 46.6, lng: 2.2 } });
    const signals = await runEngineA(
      input({
        identity: identity({ name: 'Sunrise Rooms', country: 'FR' }),
        context: context({ breadcrumbs: ['Home', 'Hotels', 'France', 'Book now'] }),
        geocoder,
      }),
    );

    expect(require_(signals, 'A3').severity).toBe('GRAY');
    expect(geocoder.calls.map((c) => c.query)).toEqual(['Book now, France']);
  });

  it('is GRAY when the breadcrumb place cannot be located', async () => {
    const signals = await runEngineA(
      input({
        context: context({
          breadcrumbs: [
            'Home',
            'Hotels',
            'Portugal',
            'Lisboa',
            'Nowhereville',
            'Corpo Santo Lisbon Historical Hotel (Hotel) (Portugal) Deals',
          ],
        }),
        geocoder: makeGeocoder({}),
      }),
    );

    const a3 = require_(signals, 'A3');
    expect(a3.severity).toBe('GRAY');
    expect(evidence(a3, 'Breadcrumb place looked up')).toBe('Nowhereville, Lisboa, Portugal');
  });

  it('is GRAY when the listing publishes no coordinates to compare against', async () => {
    const signals = await runEngineA(
      input({
        identity: identity({ lat: undefined, lng: undefined }),
        context: context({ breadcrumbs: HIJACK_TRAIL }),
        geocoder: makeGeocoder({ 'paris, ile de france, france': PARIS }),
      }),
    );

    expect(require_(signals, 'A3').severity).toBe('GRAY');
  });
});

// ===========================================================================
// A3 — the false positive it was repaired for
// ===========================================================================

/**
 * Reported by a real user: Hôtel Le Colisée, an ordinary hotel in the 8th
 * arrondissement of Paris, flagged YELLOW because "the breadcrumb city does not
 * match the map coordinates". Nothing on the page contradicted anything. The
 * check took `breadcrumbs[length - 2]`, which on a French trail is the
 * arrondissement rather than the city, geocoded the bare token "8th arr." with
 * country=FR, and Nominatim answered with Lyon's 8th arrondissement — 400 km
 * away, and the accusation was against the listing rather than against the
 * lookup that produced it.
 *
 * Both halves of the repair are asserted here, and both are measured against
 * the live provider rather than imagined: the query is now the qualified path,
 * and an answer that does not look like the place we asked about cannot accuse.
 */
describe('A3 — the arrondissement false positive', () => {
  /** The reported page's trail, and the coordinates it publishes. */
  const COLISEE_TRAIL = [
    'Home',
    'Hotels',
    'France',
    'Île-de-France',
    'Paris',
    '8th arr.',
    'Hôtel Le Colisée (Hotel) (France) deals',
  ];
  const COLISEE: LatLng = { lat: 48.87047, lng: 2.3077 };
  /** Verbatim from the user's evidence table. */
  const LYON_8E: GeocodeResult = {
    lat: 45.72957,
    lng: 4.88499,
    displayName:
      'Maison de la Métropole du 8e arr. Latarjet, Rue Narvik, Mermoz, Lyon 8e Arrondissement, Lyon, Métropole de Lyon, Rhône, Auvergne-Rhône-Alpes, France métropolitaine, 69008, France',
  };

  function colisee(geocoder: FakeGeocoder): Promise<Signal[]> {
    return runEngineA(
      input({
        slug: 'lecolise',
        identity: identity({
          name: 'Hôtel Le Colisée',
          country: 'FR',
          lat: COLISEE.lat,
          lng: COLISEE.lng,
        }),
        context: context({ breadcrumbs: COLISEE_TRAIL }),
        geocoder,
      }),
    );
  }

  it('says nothing about the reported hotel, and never asks the bare token', async () => {
    // Measured against Nominatim: "8th arr., Paris, Île-de-France" has no match
    // (nor does it with ", France" appended), "Paris, Île-de-France" answers
    // 2.5 km from this hotel, and the bare "8th arr." answers with Lyon. The
    // fake below is exactly that provider.
    const geocoder = makeGeocoder({ '8th arr.': LYON_8E, 'paris, île-de-france': PARIS });

    expect(find(await colisee(geocoder), 'A3')).toBeUndefined();
    expect(geocoder.calls.map((c) => c.query)).toEqual([
      '8th arr., Paris, Île-de-France',
      'Paris, Île-de-France',
    ]);
  });

  it('is GRAY, never YELLOW, when the answer names a place the trail does not', async () => {
    // The same provider, in the world where it answers the qualified query with
    // the Lyon record anyway. We asked with "Paris" and "Île-de-France" in the
    // query and were answered with Lyon, Rhône and Auvergne-Rhône-Alpes: that is
    // evidence the lookup is wrong, not that the listing is.
    const geocoder = makeGeocoder({ '8th arr., paris, île-de-france': LYON_8E });
    const a3 = require_(await colisee(geocoder), 'A3');

    expect(a3.severity).toBe('GRAY');
    expect(a3.title).toContain('Could not confirm');
    // The distance is still shown — but as a measurement, not as a breach.
    expect(km(evidence(a3, 'Distance apart'))).toBeGreaterThan(A3_MAX_CITY_DISTANCE_KM);
    expect(evidence(a3, 'Distance apart')).not.toContain('flagged');
    expect(evidence(a3, 'Place located at')).toContain('Lyon');
  });

  it('clears the page when the wider trail agrees with the coordinates', async () => {
    // Same wrong answer, and this time the level above it can be resolved. The
    // trail as a whole does not disagree with the map, so there is nothing to
    // show the user at all — not even a GRAY row.
    const geocoder = makeGeocoder({
      '8th arr., paris, île-de-france': LYON_8E,
      'paris, île-de-france': PARIS,
    });

    expect(find(await colisee(geocoder), 'A3')).toBeUndefined();
  });

  it('never lets the wider trail accuse, only clear', async () => {
    // The danger the exoneration lookup must not become. Measured: dropping a
    // level off "New York, New York State, United States" leaves "New York
    // State, United States", which answers 256 km from Manhattan, and off
    // "…, Rimini, Emilia-Romagna" leaves a region centroid 130 km from Rimini.
    // A second-choice query is not evidence enough to accuse an honest listing.
    const upstate: LatLng = { lat: 43.1562, lng: -75.845 };
    const signals = await runEngineA(
      input({
        identity: identity({
          name: 'Warwick New York',
          country: 'US',
          lat: NEW_YORK.lat,
          lng: NEW_YORK.lng,
        }),
        context: context({
          breadcrumbs: [
            'Home',
            'Hotels',
            'United States',
            'New York State (NY)',
            'New York',
            'Warwick New York (Hotel) (US) Deals',
          ],
        }),
        geocoder: makeGeocoder({ 'new york state, united states': upstate }),
      }),
    );

    const a3 = require_(signals, 'A3');
    expect(a3.severity).toBe('GRAY');
    expect(signals.every((s) => s.severity !== 'YELLOW')).toBe(true);
  });

  it('still flags a trail that files the property in a different city', async () => {
    // The power the repair must not cost: the page's own navigation trail says
    // Paris and its own coordinates are 437 km away in the Alps. The geocoder
    // answers the trail's question, and its answer names the trail's own
    // levels, so the disagreement is between the page and the page.
    const geocoder = makeGeocoder({ 'paris, ile de france, france': PARIS });
    const signals = await runEngineA(
      input({
        slug: 'paris-eiffel-residence',
        identity: identity({
          name: 'Paris Eiffel Residence',
          country: 'FR',
          lat: PETIT_BORNAND.lat,
          lng: PETIT_BORNAND.lng,
        }),
        context: context({ breadcrumbs: HIJACK_TRAIL }),
        geocoder,
      }),
    );

    const a3 = require_(signals, 'A3');
    expect(a3.severity).toBe('YELLOW');
    expect(evidence(a3, 'Breadcrumb place looked up')).toBe('Paris, Ile de France, France');
    expect(km(evidence(a3, 'Distance apart'))).toBeGreaterThan(400);
    expect(a3.links?.[0]?.href).toContain('openstreetmap.org');
    // No second opinion was needed, and none was spent.
    expect(geocoder.calls).toHaveLength(1);
  });

  it('drops the property row from the query, but not a city that looks like one', async () => {
    // Booking ends its trail with a marketing string that repeats the property
    // name; other platforms stop at the city. Dropping a fixed last entry would
    // throw the city away on the second shape — measured 0.33 overlap for
    // "London" against "London County Hall", against 0.8–1.0 for every
    // marketing string in the corpus.
    const geocoder = makeGeocoder({});
    await runEngineA(
      input({
        identity: identity({ name: 'London County Hall', country: 'GB' }),
        context: context({
          breadcrumbs: ['Home', 'Hotel Directory', 'England', 'Greater London', 'London'],
        }),
        geocoder,
      }),
    );

    expect(geocoder.calls[0]?.query).toBe('London, Greater London, England');
  });
});

// ===========================================================================
// engine contract
// ===========================================================================

describe('runEngineA', () => {
  it('returns signals in rule order', async () => {
    const signals = await runEngineA(
      input({
        slug: 'l-39-horizon-des-alpes-le-petit-bornand-les-glieres',
        identity: identity({
          name: 'Paris Eiffel Residence',
          country: 'FR',
          lat: PETIT_BORNAND.lat,
          lng: PETIT_BORNAND.lng,
        }),
        context: context({
          breadcrumbs: HIJACK_TRAIL,
          pois: [poi('Eiffel Tower', 0.25), poi('Louvre Museum', 1.8), poi('Sacré-Cœur', 2.4)],
        }),
        geocoder: makeGeocoder(PARIS_LANDMARKS),
      }),
    );

    expect(signals.map((s) => s.id)).toEqual(['A1', 'A2', 'A3']);
    // A3 is the interesting one here: the breadcrumb agrees with the *stolen*
    // Paris identity but not with the coordinates, so it fires too.
    expect(signals.map((s) => s.severity)).toEqual(['RED', 'RED', 'YELLOW']);
    expect(signals.every((s) => s.engine === 'A')).toBe(true);
  });

  it('never emits a signal without the numbers behind it', async () => {
    const signals = await runEngineA(
      input({
        slug: 'l-39-horizon-des-alpes-le-petit-bornand-les-glieres',
        identity: identity({
          name: 'Paris Eiffel Residence',
          country: 'FR',
          lat: PETIT_BORNAND.lat,
          lng: PETIT_BORNAND.lng,
        }),
        context: context({
          breadcrumbs: HIJACK_TRAIL,
          pois: [poi('Eiffel Tower', 0.25), poi('Louvre Museum', 1.8), poi('Sacré-Cœur', 2.4)],
        }),
        geocoder: makeGeocoder(PARIS_LANDMARKS),
      }),
    );

    for (const signal of signals) {
      expect(signal.title.length).toBeGreaterThan(0);
      expect(signal.detail.length).toBeGreaterThan(0);
      expect(signal.values?.length ?? 0).toBeGreaterThan(0);
    }
  });

  it('survives a geocoder that rejects on every call, for every rule', async () => {
    await expect(
      runEngineA(
        input({
          context: context({
            breadcrumbs: ['Home', 'Hotels', 'Portugal', 'Lisboa', 'Deals'],
            pois: [poi('Time Out Market', 0.3), poi('Belém Tower', 6.5)],
          }),
          geocoder: makeGeocoder({}, { throws: true }),
        }),
      ),
    ).resolves.toBeInstanceOf(Array);
  });

  it('omits the country hint when the listing does not state one', async () => {
    const geocoder = makeGeocoder(PARIS_LANDMARKS);
    await runEngineA(
      input({
        identity: identity({ country: undefined }),
        context: context({ pois: [poi('Eiffel Tower', 0.25)] }),
        geocoder,
      }),
    );

    expect(geocoder.calls).toEqual([{ query: 'Eiffel Tower', countryCode: undefined }]);
  });
});

// ===========================================================================
// the words are the catalog's, the numbers are ours
// ===========================================================================

/**
 * The measurement is the fact and travels as a param; "km" is a word and lives
 * in the catalog sentence
 * "Coordinates moved {km} km since the archived capture"). Glued onto the value
 * instead, the unit would be the one word in a translated evidence table that
 * stays English — and it is in every distance this engine prints.
 */
describe('units belong to the catalog, numbers to the evidence', () => {
  /** The hijack fixture, which fires A1, A2 and A3 with every distance shape. */
  async function everyDistanceRow(): Promise<Signal[]> {
    return runEngineA(
      input({
        slug: 'l-39-horizon-des-alpes-le-petit-bornand-les-glieres',
        identity: identity({
          name: 'Paris Eiffel Residence',
          country: 'FR',
          lat: PETIT_BORNAND.lat,
          lng: PETIT_BORNAND.lng,
        }),
        context: context({
          breadcrumbs: HIJACK_TRAIL,
          pois: [
            poi('Eiffel Tower', 0.25),
            poi('Louvre Museum', 1.8),
            poi('Sacré-Cœur', 2.4),
            // No stated distance: the other landmark-row sentence.
            poi('Arc de Triomphe'),
          ],
        }),
        geocoder: makeGeocoder(PARIS_LANDMARKS),
      }),
    );
  }

  it('prints a distance in every shape it has: median, gap, landmark rows, A3', async () => {
    const signals = await everyDistanceRow();
    const a2 = require_(signals, 'A2');
    expect(evidence(a2, 'Median real distance')).toMatch(/^\d+\.\d km$/);
    expect(evidence(a2, 'Median gap vs the stated distance')).toMatch(/^\d+\.\d km$/);
    expect(evidence(a2, 'Eiffel Tower')).toMatch(/^\d+\.\d km away — page says 0\.25 km — found: /);
    expect(evidence(a2, 'Arc de Triomphe')).toMatch(/^\d+\.\d km away — no distance stated — /);
    expect(evidence(require_(signals, 'A3'), 'Distance apart')).toMatch(
      /^\d+\.\d km \(flagged above 50 km\)$/,
    );
  });

  it('never puts the unit in a param — every "km" comes from a catalog template', async () => {
    const signals = await everyDistanceRow();
    for (const signal of signals) {
      for (const value of signal.values ?? []) {
        for (const [name, param] of Object.entries(value.valueMsg?.params ?? {})) {
          expect(String(param), `${value.valueMsg?.key}.${name}`).not.toMatch(/\bkm\b/);
        }
        if (!value.value.includes('km')) continue;
        // A value that prints a unit must be OUR sentence, rendered from a
        // template that owns the word — not a string assembled here.
        const key = value.valueMsg?.key;
        expect(key, `"${value.label}" prints km with no message behind it`).toBeDefined();
        expect(en[key as keyof typeof en]).toContain('km');
        expect(english(value.valueMsg!)).toBe(value.value);
      }
    }
  });

  /**
   * `MessageKey` makes a mistyped key a compile error at the authoring site, so
   * this is not here to re-check spelling. It checks the three things the type
   * cannot: that the sentence actually RENDERS (a key present in the catalog but
   * mapped to nothing still resolves to nothing), that no `{slot}` went
   * unfilled, and that the English sitting beside each message really is that
   * message's rendering rather than a second copy of the words that has since
   * drifted. It runs over the GRAY paths too, which is where an engine's least-
   * exercised prose lives.
   */
  it('renders every message it emits from the catalog, slots filled', async () => {
    const signals = [
      ...(await everyDistanceRow()),
      // No coordinates: the `noCoordinates` prose for A2 and A3.
      ...(await runEngineA(
        input({
          identity: identity({ lat: undefined, lng: undefined }),
          context: context({
            breadcrumbs: ['Home', 'Hotels', 'Portugal', 'Lisboa', 'Deals'],
            pois: [poi('Time Out Market', 0.3)],
          }),
        }),
      )),
      // A geocoder that throws on every call: the `checkFailed` prose.
      ...(await runEngineA(
        input({
          context: context({
            breadcrumbs: ['Home', 'Hotels', 'Portugal', 'Lisboa', 'Deals'],
            pois: [poi('Time Out Market', 0.3), poi('Belém Tower', 6.5)],
          }),
          geocoder: makeGeocoder({}, { throws: true }),
        }),
      )),
      // An answer that names a place the trail does not: A3's `inconsistent`
      // prose, the least-travelled path in this engine and the one a user in
      // the Lyon case now sees instead of a flag.
      ...(await runEngineA(
        input({
          identity: identity({ name: 'Corpo Santo Lisbon Historical Hotel', country: 'PT' }),
          context: context({
            breadcrumbs: [
              'Início',
              'Hotéis',
              'Portugal',
              'Lisboa',
              'Misericordia',
              'Ofertas em Corpo Santo Lisbon Historical Hotel (Hotel) (Portugal)',
            ],
          }),
          geocoder: makeGeocoder({
            'misericordia, lisboa, portugal': {
              ...NEW_YORK,
              displayName: 'Misericordia, Somewhere Else Entirely',
            },
          }),
        }),
      )),
    ];
    expect(signals.length).toBeGreaterThan(4);
    // Guards the sample: each block above is here for prose only it produces,
    // and the last one is worthless if its input stopped reaching that branch.
    expect(signals.map((s) => s.titleMsg?.key)).toContain('enginea.a3.inconsistent.title');

    type Rendered = [text: string, message: LocalizedText | undefined];
    let checked = 0;

    for (const signal of signals) {
      // Titles and details are always this engine's own sentences, so a missing
      // message there is a bug. Labels and values are not: a landmark row is
      // labelled with the landmark's name as the PAGE wrote it, and a value is
      // usually a measurement. Those stay unkeyed on purpose — evidence is
      // quoted, not translated — so they are only checked when a message is
      // present, which is exactly when the text became ours.
      const ours: Rendered[] = [
        [signal.title, signal.titleMsg],
        [signal.detail, signal.detailMsg],
      ];
      for (const [rendered, message] of ours) {
        expect(message, `${signal.id}: "${rendered}" has no message behind it`).toBeDefined();
      }

      const optional: Rendered[] = [
        ...(signal.values ?? []).flatMap((v): Rendered[] => [
          [v.label, v.labelMsg],
          [v.value, v.valueMsg],
        ]),
        ...(signal.links ?? []).map((l): Rendered => [l.label, l.labelMsg]),
      ];
      for (const [rendered, message] of [...ours, ...optional]) {
        if (message === undefined) continue;
        checked++;
        expect(
          en[message.key as keyof typeof en],
          `${signal.id}: ${message.key} not in en catalog`,
        ).toBeDefined();
        // An unfilled slot would reach the reader as a literal `{km}`.
        expect(rendered, `${signal.id}: unfilled slot in "${rendered}"`).not.toMatch(/\{\w+\}/);
        expect(english(message), `${signal.id}: ${message.key} drifted`).toBe(rendered);
      }
    }

    // Guards the guard: a refactor that stopped attaching messages would
    // otherwise turn every `continue` above into a silent pass.
    expect(checked).toBeGreaterThan(20);
  });
});
