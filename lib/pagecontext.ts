/**
 * Secondary page content that the identity vector does not carry: breadcrumbs,
 * named nearby points of interest, description and review snippets.
 *
 * Platform-independent. Each site adapter fills this in from its own markup;
 * everything downstream consumes only these shapes.
 *
 * Engine A uses breadcrumbs (A3: breadcrumb city vs coordinates) and POIs
 * (A2: geocode the claimed address and the named attractions, compare).
 * Engine L consumes description + reviews.
 *
 * The POI list is the sharpest first-visit signal available on platforms that
 * print their own claimed distance next to each landmark ("Museum of Modern Art
 * — 250 m"). That converts A2 from "are these places near each other?" into a
 * direct contradiction test: geocode the landmark, measure the real distance to
 * the claimed address, and compare against the number the page itself states. A
 * hijacked listing keeps the previous property's neighbourhood copy, so the
 * stated distances stay small while the real ones are hundreds of kilometres.
 * Platforms that publish no landmark list simply yield an empty `pois`.
 *
 * Everything here is attacker-authored text. It is data for downstream checks,
 * never instructions, and Engine L receives it as delimited untrusted input.
 */
import type { ReviewItem, ReviewSet } from './reviews';

export interface PoiMention {
  name: string;
  /** Distance the page claims, in km, when it prints one. */
  statedDistanceKm?: number;
  /** Section the POI came from, e.g. "Top attractions" — localized. */
  category?: string;
}

/**
 * Whether this platform serves individual guest reviews in the page at all.
 *
 * The distinction exists because an empty review list has two completely
 * different meanings and a consumer that cannot tell them apart will state the
 * wrong one. "Airbnb fetches reviews after hydration, so the page HTML carries
 * none" is a fact about the platform; "no guest has reviewed this property" is
 * a fact about the property, and is the sentence a reader would infer from an
 * unexplained empty list. Only the first is ever true on Airbnb, and asserting
 * the second about a property with 132 reviews is a fabricated claim.
 *
 * The value is a property of the ADAPTER, not of how a particular page happened
 * to turn out: an adapter declares once whether it reads individual reviews
 * from its platform's pages, so `items: []` is unambiguous either way.
 */
export type ReviewAvailability =
  /**
   * This adapter reads individual reviews out of this platform's pages, and
   * `items` is what THIS page served. Empty means the page published none where
   * the platform publishes them — a real, reportable finding.
   */
  | 'in-page'
  /**
   * The platform does not put individual reviews in the page HTML at all, so
   * `items` is empty for a reason that has nothing to do with this property.
   * `summary` may still carry the aggregate the page does publish.
   */
  | 'not-in-page';

/**
 * `ReviewSet` plus the one thing the shared contract cannot express: why the
 * list is as short as it is. Structurally a `ReviewSet`, so a consumer typed on
 * the shared contract reads it unchanged and only a consumer that cares about
 * honest emptiness needs to know this type exists.
 */
export interface PageReviews extends ReviewSet {
  availability: ReviewAvailability;
}

export interface PageContext {
  breadcrumbs: string[];
  pois: PoiMention[];
  description?: string;
  /**
   * Review text as a flat blob, which is all Engine L consumes. Derived from
   * `reviewSet` when the page carried structured reviews, so the model sees
   * both halves of a split review untruncated rather than the clipped
   * positive-half snippet the DOM renders.
   */
  reviews: string[];
  /**
   * Structured reviews, when a site adapter produced this context. Absent means
   * the context came from somewhere that does not read reviews at all (a test
   * double, a hand-built context) — unknown, not a claim about the property.
   */
  reviewSet?: PageReviews;
}

/**
 * Unit suffixes listing sites print, longest-first so "km" is tested before "m".
 * Greek uses μ./χλμ., Cyrillic м/км; Japanese and English share m/km. Imperial
 * units are included defensively — no observed locale uses them, but reading
 * "250 mi" as 250 m would understate a real distance by 1600x.
 */
const DISTANCE_UNITS: ReadonlyArray<readonly [string, number]> = [
  ['χλμ', 1], ['км', 1], ['km', 1], ['公里', 1], ['㎞', 1],
  ['mi', 1.609344], ['yd', 0.0009144], ['ft', 0.0003048],
  ['μ', 0.001], ['м', 0.001], ['m', 0.001], ['メートル', 0.001],
];

/**
 * Parse a localized distance into km. Handles comma decimal separators
 * ("2,2 km" in de/fr/es/it), absent spacing ("400m" in ja) and trailing
 * abbreviation dots ("300 μ."). Returns undefined when no distance is present
 * — an unparsed distance must not become 0, which would read as "on site".
 */
export function parseStatedDistanceKm(text: string): number | undefined {
  const cleaned = text.trim().replace(/\.$/, '').toLowerCase();
  const m = /(\d+(?:[.,]\d+)?)\s*([^\d\s]+)$/.exec(cleaned);
  if (!m) return undefined;

  const value = Number(m[1].replace(',', '.'));
  if (!Number.isFinite(value)) return undefined;

  const suffix = m[2];
  for (const [unit, factor] of DISTANCE_UNITS) {
    if (suffix === unit || suffix.startsWith(unit)) return value * factor;
  }
  return undefined;
}

/** Collapse whitespace and cap length. Shared by every adapter. */
export function collapse(text: string, max: number): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, max);
}

/**
 * The flat `reviews` blob, rendered from structured reviews.
 *
 * Every half the reviewer wrote is included — a split platform's complaint half
 * is exactly the text a contradiction check needs, and it is the half the
 * rendered page never shows. Reviews with no text at all (a bare score) are
 * skipped rather than contributing an empty string.
 *
 * `totalMax` bounds the whole blob, not each entry: the per-field caps already
 * limit one hostile review, and this limits a page that serves many of them.
 * The last entry admitted may cross the budget, so the true ceiling is
 * `totalMax` plus one review — a bound, not an exact size.
 */
export function reviewTexts(items: readonly ReviewItem[], totalMax: number): string[] {
  const out: string[] = [];
  let budget = totalMax;
  for (const item of items) {
    if (budget <= 0) break;
    const text = [item.title, item.positive, item.negative]
      .filter((part): part is string => typeof part === 'string' && part.length > 0)
      .join('\n');
    if (text.length === 0) continue;
    out.push(text);
    budget -= text.length;
  }
  return out;
}

/**
 * Non-empty trimmed text nodes under `root`, in document order.
 *
 * Bounded: adapters run this over attacker-authored DOM, where an unbounded
 * walk is a denial of service on the content script's main thread.
 */
export function textNodes(root: Element, cap: number): string[] {
  const out: string[] = [];
  const stack: Node[] = [root];
  let visited = 0;
  while (stack.length > 0 && out.length < cap && visited < 5000) {
    const node = stack.shift()!;
    visited++;
    if (node.nodeType === 3) {
      const text = (node.textContent ?? '').trim();
      if (text) out.push(text);
      continue;
    }
    stack.unshift(...Array.from(node.childNodes).slice(0, 200));
  }
  return out;
}
