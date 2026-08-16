import { describe, expect, it } from 'vitest';
import { haversineKm, median, type LatLng } from './geo';

/** Half the great circle: the largest distance the function can ever return. */
const ANTIPODAL_KM = 6371.0088 * Math.PI;

const LONDON: LatLng = { lat: 51.5074, lng: -0.1278 };
const PARIS: LatLng = { lat: 48.8566, lng: 2.3522 };
const NEW_YORK: LatLng = { lat: 40.7128, lng: -74.006 };
const LOS_ANGELES: LatLng = { lat: 34.0522, lng: -118.2437 };
const SUVA: LatLng = { lat: -18.1416, lng: 178.4419 };
const APIA: LatLng = { lat: -13.8333, lng: -171.7667 };
const SYDNEY: LatLng = { lat: -33.8688, lng: 151.2093 };
const AUCKLAND: LatLng = { lat: -36.8485, lng: 174.7633 };
const NORTH_POLE: LatLng = { lat: 90, lng: 0 };
const SOUTH_POLE: LatLng = { lat: -90, lng: 0 };

// Two ordinary Booking destinations that happen to be the counterexample the
// zero-distance test needs: at these latitudes sin²φ + cos²φ evaluates to
// 1.0000000000000002 in IEEE double, so the law-of-cosines form returns NaN for
// a point measured against itself. Roughly 5% of latitudes do this; most do not,
// which is why the row has to name specific ones rather than any old city.
const BARCELONA: LatLng = { lat: 41.3874, lng: 2.1686 };
const WARSAW: LatLng = { lat: 52.2297, lng: 21.0122 };

/**
 * Independent reference: great-circle distance by Vincenty's sphere formula,
 * over 3D direction vectors rather than half-angle sines. Written from the
 * definition, not derived from the implementation under test — it shares only
 * the Earth radius, so a mistake in the haversine algebra cannot hide in it.
 * Agrees with the implementation to sub-micrometre across the globe.
 */
function vincentySphereKm(a: LatLng, b: LatLng): number {
  const rad = Math.PI / 180;
  const p1 = a.lat * rad;
  const p2 = b.lat * rad;
  const dl = (b.lng - a.lng) * rad;
  const num = Math.hypot(
    Math.cos(p2) * Math.sin(dl),
    Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl),
  );
  const den = Math.sin(p1) * Math.sin(p2) + Math.cos(p1) * Math.cos(p2) * Math.cos(dl);
  return (ANTIPODAL_KM / Math.PI) * Math.atan2(num, den);
}

// The M1 hijack fixture: an alpine slug (Le Petit-Bornand) wearing a Paris
// identity. A2 must see hundreds of km between the claimed address and the
// Eiffel Tower it lists as "nearby".
const EIFFEL_TOWER: LatLng = { lat: 48.8584, lng: 2.2945 };
const PETIT_BORNAND: LatLng = { lat: 46.0333, lng: 6.3333 };

describe('haversineKm', () => {
  it.each<[string, LatLng, LatLng, number, number]>([
    // [name, a, b, expected km (published great-circle figure), tolerance km]
    ['London ↔ Paris', LONDON, PARIS, 343.6, 1],
    ['New York ↔ Los Angeles', NEW_YORK, LOS_ANGELES, 3936, 3],
    ['Sydney ↔ Auckland', SYDNEY, AUCKLAND, 2156, 3],
    // Crosses the antimeridian: 178.4°E to 171.8°W is a short hop east, not a
    // 350° detour back across Africa.
    ['Suva ↔ Apia (across the antimeridian)', SUVA, APIA, 1151, 3],
    // Analytic cases — tolerance is tight because the answer is exact geometry,
    // not a figure someone measured.
    ['equator, quarter of the way round', { lat: 0, lng: 0 }, { lat: 0, lng: 90 }, ANTIPODAL_KM / 2, 1e-9],
    ['one degree of latitude at the equator', { lat: 0, lng: 0 }, { lat: 1, lng: 0 }, 111.19508, 1e-5],
    ['north pole ↔ equator', NORTH_POLE, { lat: 0, lng: 0 }, ANTIPODAL_KM / 2, 1e-9],
    ['pole to pole', NORTH_POLE, SOUTH_POLE, ANTIPODAL_KM, 1e-9],
    ['exact antipodes on the equator', { lat: 0, lng: 0 }, { lat: 0, lng: 180 }, ANTIPODAL_KM, 1e-9],
    ['A2 hijack case: Eiffel Tower ↔ Le Petit-Bornand', EIFFEL_TOWER, PETIT_BORNAND, 436.8, 1],
  ])('%s', (_name, a, b, expected, tolerance) => {
    expect(haversineKm(a, b)).toBeGreaterThan(expected - tolerance);
    expect(haversineKm(a, b)).toBeLessThan(expected + tolerance);
  });

  it.each<[string, LatLng]>([
    ['a city', PARIS],
    ['the north pole', NORTH_POLE],
    ['the south pole', SOUTH_POLE],
    ['null island', { lat: 0, lng: 0 }],
    ['a point on the antimeridian', { lat: 12.34, lng: 180 }],
    ['a negative-zero coordinate', { lat: -0, lng: -0 }],
    // These two are the rows that fail loudly if anyone rewrites this as
    // `R * acos(sin·sin + cos·cos·cos)`: at their latitudes that form's argument
    // rounds to 1.0000000000000002 and acos returns NaN for a point compared
    // against itself — and a NaN distance quietly passes every `> threshold`
    // comparison downstream, so the naive rewrite fails GREEN on a listing it
    // never checked. Verified that the other six rows above do NOT catch it:
    // their arguments round to exactly 1 and the broken form answers 0 as well.
    ['Barcelona, where the law-of-cosines form returns NaN', BARCELONA],
    ['Warsaw, likewise', WARSAW],
  ])('returns exactly 0 for two references to the same place — %s', (_name, point) => {
    // Not `toBeCloseTo` — the panel prints this number, and Engine B reads it
    // against a 5 km threshold, so "0.0000000001 km of drift" is wrong and ugly.
    expect(haversineKm(point, { ...point })).toBe(0);
  });

  it('agrees with an independently written great-circle formula worldwide', () => {
    // The check the hand-picked city table cannot make: the published figures
    // above pin five pairs, this pins the algebra everywhere — including the
    // near-pole and near-antipodal corners where haversine and the vector form
    // have different error behaviour. Sub-micrometre, so the tolerance is about
    // float noise, not about the two formulas meaning slightly different things.
    for (let lat1 = -85; lat1 <= 85; lat1 += 13) {
      for (let lng1 = -175; lng1 <= 175; lng1 += 37) {
        for (let lat2 = -85; lat2 <= 85; lat2 += 17) {
          for (let lng2 = -175; lng2 <= 175; lng2 += 41) {
            const a: LatLng = { lat: lat1, lng: lng1 };
            const b: LatLng = { lat: lat2, lng: lng2 };
            expect(Math.abs(haversineKm(a, b) - vincentySphereKm(a, b))).toBeLessThan(1e-6);
          }
        }
      }
    }
  });

  it.each<[string, LatLng, LatLng]>([
    ['London ↔ Paris', LONDON, PARIS],
    ['Suva ↔ Apia (antimeridian)', SUVA, APIA],
    ['pole to pole', NORTH_POLE, SOUTH_POLE],
    ['New York ↔ Los Angeles', NEW_YORK, LOS_ANGELES],
  ])('is symmetric: %s', (_name, a, b) => {
    expect(haversineKm(a, b)).toBeCloseTo(haversineKm(b, a), 9);
  });

  it.each<[string, LatLng, LatLng, number]>([
    // Longitude enters only through sin²(Δλ/2), so a value one wrap out of range
    // must agree with its normalized twin — map libraries emit these once the
    // viewport pans past the antimeridian. Two wraps (540°) is out of contract;
    // it lives in the rejection table below.
    ['190°E ≡ -170°E, same point', { lat: 10, lng: 190 }, { lat: 10, lng: -170 }, 0],
    ['-190°E ≡ 170°E, same point', { lat: -5, lng: -190 }, { lat: -5, lng: 170 }, 0],
    ['360°E ≡ 0°E, same point', { lat: 33, lng: 360 }, { lat: 33, lng: 0 }, 0],
    // …and a real hop across the line is the short way round, not 358° the
    // other way. Closed form for two points on the same parallel:
    // 2R·asin(cos φ · sin(Δλ/2)) = 2 × 6371.0088 × asin(cos 60° · sin 1°).
    // (Not R·Δλ·cos φ — that is the along-parallel arc, 4 m longer than the
    // great circle here, and 4 m is far above this row's tolerance.)
    ['179°E → 179°W at 60°N is a 2° hop', { lat: 60, lng: 179 }, { lat: 60, lng: -179 }, 111.190846158],
  ])('treats un-normalized longitude as equivalent: %s', (_name, a, b, expected) => {
    expect(haversineKm(a, b)).toBeCloseTo(expected, 4);
  });

  it('collapses distance at the pole regardless of longitude', () => {
    // cos(90°) is 6.1e-17 in floating point rather than a true 0, so this is not
    // bit-zero — but it is sub-nanometre, which is as good as the same spot.
    const km = haversineKm(NORTH_POLE, { lat: 90, lng: 120 });
    expect(km).toBeLessThan(1e-6);
    expect(km).toBeGreaterThanOrEqual(0);
  });

  it('never overshoots into NaN for near-antipodal pairs', () => {
    // The rounding case the clamp exists for: h creeping past 1 makes
    // sqrt(1 - h) NaN, and a NaN distance silently fails every threshold test.
    for (let lat = -89; lat <= 89; lat += 7) {
      for (let lng = -180; lng <= 180; lng += 11) {
        const km = haversineKm({ lat, lng }, { lat: -lat, lng: lng + 180 });
        expect(Number.isFinite(km)).toBe(true);
        expect(km).toBeLessThanOrEqual(ANTIPODAL_KM + 1e-9);
        expect(km).toBeGreaterThan(ANTIPODAL_KM - 1);
      }
    }
  });

  it.each<[string, LatLng, LatLng]>([
    ['NaN latitude', { lat: Number.NaN, lng: 2.35 }, PARIS],
    ['NaN longitude', { lat: 48.85, lng: Number.NaN }, PARIS],
    ['infinite latitude', { lat: Number.POSITIVE_INFINITY, lng: 0 }, PARIS],
    ['infinite longitude', { lat: 0, lng: Number.NEGATIVE_INFINITY }, PARIS],
    ['latitude just past the north pole', { lat: 90.1, lng: 0 }, PARIS],
    ['latitude past the south pole', { lat: -91, lng: 0 }, PARIS],
    // The lat/lng swap only shows up as an out-of-domain latitude when the true
    // longitude is east of 90°E — Tokyo swapped is (139.65, 35.68). A swapped
    // Paris is (2.35, 48.85), a perfectly valid point off Somalia, and nothing
    // in this module can see it; that is a limitation, not a passing case, so
    // the row that belongs here is the one the guard actually covers.
    ['swapped lat/lng for Tokyo (139.65, 35.68)', { lat: 139.6503, lng: 35.6762 }, PARIS],
    ['a second argument out of the latitude domain', PARIS, { lat: 1000, lng: 0 }],
    // Longitude past one wrap. Periodicity means these do NOT fail on their own
    // — see the dedicated test below for why silence here would be dangerous.
    ['longitude two wraps out (540°E)', { lat: -5, lng: 540 }, { lat: -5, lng: 180 }],
    ['longitude just past the limit', { lat: 0, lng: 360.5 }, PARIS],
    ['longitude just past the negative limit', { lat: 0, lng: -360.5 }, PARIS],
    ['a millisecond timestamp parsed as longitude', { lat: 48.8566, lng: 1.7e12 }, PARIS],
    ['a second argument with a corrupt longitude', PARIS, { lat: 48.85, lng: 1e15 }],
  ])('returns NaN rather than a confident 0 for %s', (_name, a, b) => {
    expect(haversineKm(a, b)).toBeNaN();
  });

  it('accepts the boundary values rather than rejecting them by one', () => {
    // ±90 and ±360 are in the domain, not just short of it. Off-by-one here
    // would silently GRAY out every listing that sits exactly on a pole or
    // carries a fully wrapped longitude.
    expect(haversineKm({ lat: 90, lng: 360 }, { lat: -90, lng: -360 })).toBeCloseTo(ANTIPODAL_KM, 6);
    expect(haversineKm({ lat: 0, lng: 360 }, { lat: 0, lng: 0 })).toBeCloseTo(0, 6);
  });

  it('refuses an out-of-range latitude instead of continuing it over the pole', () => {
    // Left unguarded the formula answers anyway — it continues analytically, so
    // (95°N, 0°) is read as its over-the-pole twin (85°N, 180°) and produces a
    // perfectly plausible 1112 km. Plausible numbers from corrupt input are the
    // failure mode this guard exists for; the honest answer is "we don't know".
    expect(haversineKm({ lat: 95, lng: 0 }, { lat: 85, lng: 0 })).toBeNaN();
    // Sanity, from the independent formula: that twin really is what an
    // unguarded implementation would have handed the scorer.
    expect(vincentySphereKm({ lat: 95, lng: 0 }, { lat: 85, lng: 0 })).toBeCloseTo(1111.95, 1);
    expect(vincentySphereKm({ lat: 85, lng: 180 }, { lat: 85, lng: 0 })).toBeCloseTo(1111.95, 1);
  });

  it('refuses a corrupt longitude instead of reducing it modulo 360', () => {
    // The unsafe direction, and the reason the longitude guard exists at all.
    // Periodicity is a feature for 190°E and a trap for garbage: any magnitude
    // whatsoever reduces into range, so a longitude that is plainly a field
    // mix-up can land *next door* to the claimed address and suppress the RED
    // that A2 exists to raise. This value answers "2.4 km from Paris".
    const corrupt: LatLng = { lat: 48.8566, lng: 1000001882.32 };
    expect(vincentySphereKm(corrupt, PARIS)).toBeLessThan(50);
    expect(haversineKm(corrupt, PARIS)).toBeNaN();
  });
});

describe('median', () => {
  it.each<[string, number[], number]>([
    ['single value', [42], 42],
    ['odd length, already sorted', [1, 2, 3], 2],
    ['odd length, unsorted', [3, 1, 2], 2],
    ['even length averages the two middle values', [1, 2, 3, 4], 2.5],
    ['even length, unsorted', [4, 1, 3, 2], 2.5],
    ['even length with an odd sum', [1, 2], 1.5],
    // Guards the numeric comparator: the default lexicographic sort orders these
    // as [10, 100, 9] and would answer 100.
    ['multi-digit values sort numerically, not lexicographically', [9, 10, 100], 10],
    ['negative values', [-10, -5, 5, 10], 0],
    ['all values identical', [2, 2, 2, 2], 2],
    ['fractional values', [0.1, 0.2, 0.3], 0.2],
    ['zero', [0], 0],
    // A2's robustness claim in one row: one POI geocoded to the wrong continent
    // must not move a median that four nearby POIs agree on.
    ['one wildly mis-geocoded POI does not move the median', [0.4, 0.9, 1.2, 2.1, 9500], 1.2],
    // …and a genuinely relocated listing still crosses the 50 km line.
    ['a hijacked listing clears the 50 km threshold', [430, 436, 441, 12, 450], 436],
  ])('%s', (_name, values, expected) => {
    expect(median(values)).toBeCloseTo(expected, 10);
  });

  it.each<[string, number[]]>([
    ['empty array', []],
    ['a NaN member (an ungeocodable POI)', [1, Number.NaN, 3]],
    ['a NaN member in an even-length sample', [1, 2, 3, Number.NaN]],
    ['positive infinity', [1, 2, Number.POSITIVE_INFINITY]],
    ['negative infinity', [Number.NEGATIVE_INFINITY, 5]],
  ])('returns undefined for %s', (_name, values) => {
    expect(median(values)).toBeUndefined();
  });

  it('does not mutate the caller’s array', () => {
    // Callers keep this array to render one evidence row per POI, in POI order.
    const distances = [9500, 1.2, 0.4, 2.1, 0.9];
    const before = distances.slice();
    median(distances);
    expect(distances).toEqual(before);
  });

  it.each<[string, number[], number]>([
    // Both midpoint forms overflow, on opposite inputs, and an overflowed median
    // is a fabricated RED: `Infinity > 50` fires the A2 rule on a sample whose
    // real middle is nowhere near the threshold. Same sign — `(lo + hi) / 2`
    // overflows, `lo + (hi - lo) / 2` survives:
    ['two huge positives', [1e308, 1.5e308], 1.25e308],
    ['the largest representable pair', [Number.MAX_VALUE, Number.MAX_VALUE], Number.MAX_VALUE],
    ['two huge negatives', [-1.5e308, -1e308], -1.25e308],
    // …and straddling zero it is the other way round: `hi - lo` overflows.
    ['the widest possible straddle', [-Number.MAX_VALUE, Number.MAX_VALUE], 0],
    ['a lopsided straddle', [-1e308, 1.5e308], 2.5e307],
  ])('averages %s without overflowing to Infinity', (_name, values, expected) => {
    expect(median(values)).toBe(expected);
  });

  it('keeps the midpoint inside the sample', () => {
    // The property behind the row above, stated directly: whichever form is
    // used, the answer must lie between the two middle values.
    const samples: number[][] = [
      [-Number.MAX_VALUE, Number.MAX_VALUE],
      [1e308, 1.5e308],
      [-1.5e308, -1e308],
      [0.4, 9500],
      [-7, 3],
      [Number.MIN_VALUE, Number.MIN_VALUE * 3],
    ];
    for (const values of samples) {
      const sorted = values.slice().sort((x, y) => x - y);
      const m = median(values);
      expect(m).toBeDefined();
      expect(m).toBeGreaterThanOrEqual(sorted[0]);
      expect(m).toBeLessThanOrEqual(sorted[sorted.length - 1]);
    }
  });

  it('feeds NaN distances through to an honest undefined', () => {
    // The composition the scorer relies on: an ungeocodable POI yields NaN from
    // haversineKm, which makes the median unknown (GRAY) rather than passing.
    const distances = [
      haversineKm(EIFFEL_TOWER, PETIT_BORNAND),
      haversineKm(EIFFEL_TOWER, { lat: Number.NaN, lng: Number.NaN }),
      haversineKm(EIFFEL_TOWER, PARIS),
    ];
    expect(median(distances)).toBeUndefined();
  });
});
