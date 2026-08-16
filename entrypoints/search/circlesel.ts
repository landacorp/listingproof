/**
 * Circle-selection geometry and its one piece of formatting, kept pure so
 * both are testable without Leaflet and without a DOM.
 *
 * The page used to draw a RECTANGLE, which `bboxToQuery` then converted into a
 * centre and a half-diagonal: the area searched was never the area drawn, and
 * it bulged past every edge of the box. The platform's search is natively a
 * centre and a radius, so the drawn shape is one too. A drag now runs from the
 * centre outward, which also means the radius is a number the user can SEE
 * while dragging — hence `formatRadius`, which exists purely so the drag can
 * say how far it has got.
 */
import { haversineKm } from '../../lib/geo';
import type { SearchCircle } from '../../lib/areasearch';
import type { MessageKey } from '../../lib/i18n';

/** A latitude/longitude pair — the shape Leaflet's `LatLng` satisfies. */
export interface Point {
  lat: number;
  lng: number;
}

/**
 * Distance from the circle's centre to the point under the cursor, in km.
 *
 * `haversineKm` is the project's one distance function (it already guards
 * garbage coordinates by answering NaN rather than a plausible-looking
 * number); a second implementation here would be a second set of edge cases
 * to keep in step with it.
 */
export function radiusKmBetween(centre: Point, edge: Point): number {
  return haversineKm(centre, edge);
}

/**
 * The drag's live read-out, as a catalog key plus the number already
 * formatted for the reader's locale.
 *
 * Split that way on purpose: the digits need `Intl` (a Russian panel wants
 * "2,3", not "2.3"), while the unit needs the catalog — hardcoding "m"/"km"
 * here would leave one untranslatable word inside an otherwise translated UI,
 * and would put this module's fingers in i18n it has no business holding. The
 * caller renders `t(key, { value })`, or swaps the key for the capped variant
 * when the drag has run past the search radius limit.
 *
 * Below 1000 m the answer is whole metres; from there up it is one decimal of
 * km. The unit is chosen AFTER rounding, so 999.6 m reads "1.0 km" rather
 * than the nonsense "1,000 m".
 */
export interface FormattedRadius {
  key: MessageKey;
  value: string;
}

export function formatRadius(km: number, languageTag: string): FormattedRadius {
  // A non-finite or negative distance is not a radius; show zero rather than
  // "NaN m". The drag itself cannot produce one — a broken map projection or
  // an unusable coordinate can.
  const safeKm = Number.isFinite(km) && km > 0 ? km : 0;
  const metres = Math.round(safeKm * 1000);
  if (metres < 1000) {
    return { key: 'search.radius.metres', value: formatNumber(metres, languageTag, 0) };
  }
  return { key: 'search.radius.km', value: formatNumber(metres / 1000, languageTag, 1) };
}

function formatNumber(value: number, languageTag: string, digits: number): string {
  return new Intl.NumberFormat(languageTag, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(value);
}

/** The only part of a result card this module reads: where it is, if known. */
export interface PositionedCard {
  latitude?: number;
  longitude?: number;
}

/** Cards kept because the circle contains them (or cannot exclude them), and
 * cards dropped because their own coordinates place them elsewhere. */
export interface AreaPartition<T> {
  inside: T[];
  outside: T[];
}

/**
 * Split the platform's answer by the circle the user actually drew.
 *
 * The platform is sent a centre and a radius and honours neither exactly: a
 * small area over central Paris came back with places in Melun and Plaisir,
 * 42 km away. The platform's idea of "near" is not ours, so the circle is
 * enforced here, on coordinates the cards carry themselves.
 *
 * The rule is deliberately one-sided, unchanged from the rectangle version
 * this replaces: only a card we can PROVE sits outside is dropped. Proof means
 * finite coordinates farther from the centre than the radius. A card with no
 * coordinates, or unusable ones, is KEPT — it might be inside, and inventing a
 * position for it (or assuming the worst) would be worse than showing one
 * extra result. `haversineKm` answers NaN for coordinates it cannot trust, and
 * `NaN > radius` is false, so those cards land on the keep side by the same
 * rule rather than by a special case. The edge counts as inside.
 *
 * A circle with no radius, or a centre that is not a usable point, proves
 * nothing about anything, so every card is kept rather than dropped against
 * it. Order is preserved within each side.
 */
export function partitionByRadius<T extends PositionedCard>(
  circle: SearchCircle,
  cards: readonly T[],
): AreaPartition<T> {
  const inside: T[] = [];
  const outside: T[] = [];
  const usable = Number.isFinite(circle.radiusKm) && circle.radiusKm > 0;
  for (const card of cards) {
    if (usable && provenOutside(circle, card)) outside.push(card);
    else inside.push(card);
  }
  return { inside, outside };
}

/** True only when the card's own coordinates put it beyond the radius. */
function provenOutside(circle: SearchCircle, card: PositionedCard): boolean {
  const { latitude, longitude } = card;
  if (latitude === undefined || longitude === undefined) return false;
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return false;
  const centre = { lat: circle.latitude, lng: circle.longitude };
  return haversineKm(centre, { lat: latitude, lng: longitude }) > circle.radiusKm;
}
