/**
 * Great-circle geometry for the two geographic rules in PLAN.md:
 *   Engine B diff — coordinates that moved > 5 km between snapshots → RED
 *   Engine A2     — median distance from the claimed address to the attractions
 *                   the page itself calls "nearby" > 50 km → RED
 *
 * Both are threshold comparisons in which a wrong *small* answer is the
 * dangerous one: it silently suppresses a RED on a listing that deserves it.
 * So every failure mode in this module resolves to NaN / undefined — which the
 * scorer reads as GRAY, "we could not check" — and never to a confident 0.
 *
 * Pure module: no browser APIs, no I/O, no clock.
 */

export interface LatLng {
  /** Degrees north, in [-90, 90]. */
  lat: number;
  /** Degrees east, in [-360, 360] — one wrap of slack, see haversineKm. */
  lng: number;
}

/**
 * Mean Earth radius (IUGG R₁), km.
 *
 * A sphere, not the WGS-84 ellipsoid: spherical distance errs by up to ~0.5%
 * against a Vincenty solve, i.e. ~25 m on the 5 km drift threshold and ~250 m
 * on the 50 km POI threshold. Both are far inside the noise floor of the inputs
 * (Nominatim resolves a POI to a building or a whole park), so the extra
 * machinery would buy precision the data does not have.
 */
const EARTH_RADIUS_KM = 6371.0088;

const DEG_TO_RAD = Math.PI / 180;

/**
 * Widest longitude accepted, degrees.
 *
 * Not 180: a longitude one wrap out of range is a real thing rather than a
 * corruption — slippy-map libraries hand back 190 rather than -170 once the
 * viewport has panned past the antimeridian, and normalization code that adds
 * 360 to a negative is a common enough shortcut that the values leak into
 * markup. The formula reads those correctly (see haversineKm), so rejecting
 * them would throw away answers it can give.
 *
 * Not unbounded either, which is where this started: 360 is the point past
 * which a value stops being a wrapped coordinate and becomes evidence of a
 * parse landing on the wrong field. `lib/extract.ts` is stricter still — its
 * `parseLatLng` rejects |lng| > 180 outright — so in practice only the geocoder
 * path can reach this guard at all.
 */
const MAX_ABS_LNG = 360;

/**
 * Great-circle distance between two points, in kilometres.
 *
 * Haversine in its atan2 form, not the textbook law-of-cosines
 * `acos(sin·sin + cos·cos·cos)`. The acos form is broken for the case this
 * module cares most about: for two references to the *same* point its argument
 * rounds to 1.0000000000000002 and acos returns NaN — on a sweep of coincident
 * points across the globe, most of them do. A NaN distance passes every
 * `> threshold` test silently, so the naive formula fails GREEN on a listing it
 * never actually checked. (Its short-range precision loss is real too, but only
 * shows below ~1 m — irrelevant next to a 5 km threshold.)
 *
 * The antimeridian needs no special case. Longitude only ever enters through
 * sin²(Δλ/2), which is periodic, so 179°E → 179°W is read as the 2° hop it is
 * rather than a 358° trip the other way round the planet. That also makes an
 * un-normalized longitude (190°) equivalent to its normalized twin (-170°),
 * which is worth relying on: geocoders and page markup are not consistent here.
 *
 * Returns NaN for non-finite input, |lat| > 90, or |lng| > MAX_ABS_LNG. Those
 * are not coordinates, they are corrupt input — a swapped lat/lng pair (any
 * true longitude east of 90°E lands there), a parse of the wrong field, a units
 * mix-up. Left alone the formula would happily answer anyway. For latitude it
 * continues analytically, so (95°N, 0°) is silently read as its over-the-pole
 * twin (85°N, 180°) and out comes a perfectly plausible 1112 km. For longitude
 * the periodicity that makes 190° useful is what makes garbage dangerous: it
 * reduces any magnitude modulo 360, so a longitude of 1000001882.32 — the shape
 * of a field mix-up, not of a coordinate — answers "2.4 km from Paris". That is
 * the worst possible failure here, a *suppressed* RED sourced from data already
 * known to be wrong. GRAY is the honest answer to all of it.
 *
 * NaN rather than a throw because callers run this over every POI on a page in
 * a loop, and a try/catch per POI is worse than a value that poisons the
 * aggregate — the poisoning is deliberate and `median` completes it.
 */
export function haversineKm(a: LatLng, b: LatLng): number {
  if (!isUsablePoint(a) || !isUsablePoint(b)) return Number.NaN;

  const lat1 = a.lat * DEG_TO_RAD;
  const lat2 = b.lat * DEG_TO_RAD;
  const halfDLat = ((b.lat - a.lat) * DEG_TO_RAD) / 2;
  const halfDLng = ((b.lng - a.lng) * DEG_TO_RAD) / 2;

  const sinLat = Math.sin(halfDLat);
  const sinLng = Math.sin(halfDLng);
  const h = sinLat * sinLat + Math.cos(lat1) * Math.cos(lat2) * (sinLng * sinLng);

  // h is mathematically in [0, 1], but a near-antipodal pair can round a few
  // ulps past 1 (it reaches 1.0000000000000002) and turn sqrt(1 - h) into NaN.
  // Clamp the top; don't trust the algebra.
  //
  // Deliberately no matching `h < 0 → 0` clamp. h cannot go negative while the
  // latitude guard holds — it is a sum of a square and a product of two
  // non-negative cosines with a square — and if some future loosening of that
  // guard ever made it negative, sqrt(h) yields NaN and the whole call resolves
  // to GRAY. Flooring at 0 would instead report two arbitrary points as being
  // in the same place, which is the one answer this module must never invent.
  const clamped = h > 1 ? 1 : h;

  // Identical points give h = 0 exactly (both sines are exactly 0), and
  // atan2(0, 1) is exactly 0 — so this returns a true zero, not an epsilon.
  return EARTH_RADIUS_KM * 2 * Math.atan2(Math.sqrt(clamped), Math.sqrt(1 - clamped));
}

/**
 * Median of a sample, or undefined when there is no meaningful middle.
 *
 * A2 feeds this the distance to every attraction the page advertises as nearby.
 * Median and not mean because a single mis-geocoded POI — "Central Park"
 * resolving to the one in Cape Town — drags a mean over the 50 km line by
 * itself, while the median needs half the POIs to agree before it moves. That
 * robustness is the whole reason the rule is phrased in medians.
 *
 * A non-finite member returns undefined instead of a number. NaN compares false
 * against everything, so it would land wherever the sort happened to leave it
 * and make the "middle" an artifact of input order; worse, `NaN > 50` is false,
 * so an unknown distance would read as a passing check. Unknown in, unknown out.
 */
export function median(values: number[]): number | undefined {
  if (values.length === 0) return undefined;
  if (!values.every((v) => Number.isFinite(v))) return undefined;

  // Copy first: callers keep the array to render one evidence row per POI, and
  // it must still be in POI order when they do. `slice`, not spread — the house
  // rule is never to spread an array whose length was influenced by the page.
  // Explicit comparator, because the default sort is lexicographic and would
  // order [9, 10, 100] as [10, 100, 9].
  const sorted = values.slice().sort((x, y) => x - y);

  const mid = sorted.length >> 1;
  const hi = sorted[mid];
  if (sorted.length % 2 === 1) return hi;

  // Both midpoint forms overflow to Infinity, on opposite inputs: `lo + hi`
  // overflows when the two share a sign, `hi - lo` when they straddle zero
  // ([-MAX_VALUE, MAX_VALUE] answers Infinity, not 0). Branch on which pair is
  // in hand and the result always lands inside [lo, hi].
  //
  // Distances are non-negative, so A2 always takes the subtraction branch and
  // the addition branch is here for the general contract rather than for A2.
  // Worth having anyway: an Infinity leaking out of a median reads as "> 50 km"
  // to the scorer — a fabricated RED, from a sample whose real middle is
  // nowhere near the threshold.
  const lo = sorted[mid - 1];
  return lo <= 0 && hi >= 0 ? (lo + hi) / 2 : lo + (hi - lo) / 2;
}

/**
 * Finite coordinates inside the domain the formula is defined on.
 *
 * Latitude is bounded by geometry (cos φ must not go negative — see the clamp
 * note in haversineKm); longitude by plausibility rather than by mathematics.
 */
function isUsablePoint(p: LatLng): boolean {
  return (
    Number.isFinite(p.lat) &&
    Number.isFinite(p.lng) &&
    p.lat >= -90 &&
    p.lat <= 90 &&
    p.lng >= -MAX_ABS_LNG &&
    p.lng <= MAX_ABS_LNG
  );
}
