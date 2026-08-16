/**
 * Map-search page decisions, pure and DOM-free (mirrors the sidepanel/options
 * split: `controller.ts` decides, `main.ts` wires). Everything here is
 * unit-tested without a browser.
 *
 * Honesty notes that shaped these helpers:
 *  - `explainQueryRefusal` re-derives WHICH validation failed, because
 *    `circleToQuery` deliberately answers only null. The occupancy bounds are
 *    duplicated here (the lib does not export them); the test file pins them
 *    to `circleToQuery`'s real behaviour so they cannot drift.
 *  - There is no "your selection was clamped" status any more. The radius cap
 *    used to be applied silently at query time, so a sentence had to confess
 *    it afterwards; now the page clamps the DRAWN circle while the user drags
 *    and labels it "60 km (maximum)", so the limit is seen, not confessed.
 */
import type { SearchCircle } from '../../lib/areasearch';
// DOM-free at runtime (verified): `t` only reads the active catalog, so the
// controller stays pure and unit-testable without a browser.
import { selectPlural, t, type MessageKey } from '../../lib/i18n';

/** Mirror of lib/areasearch's occupancy bounds — pinned by controller.test.ts. */
export const OCCUPANCY_BOUNDS = {
  adults: { min: 1, max: 30 },
  rooms: { min: 1, max: 30 },
  children: { min: 0, max: 10 },
} as const;

/** Default stay: a month out, two nights — dates in the user's local calendar. */
export function defaultStayDates(now: Date): { checkin: string; checkout: string } {
  return { checkin: isoDatePlusDays(now, 30), checkout: isoDatePlusDays(now, 32) };
}

function isoDatePlusDays(now: Date, days: number): string {
  const date = new Date(now.getFullYear(), now.getMonth(), now.getDate() + days);
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

export type StayDates =
  | { kind: 'dated'; checkin: string; checkout: string }
  | { kind: 'undated' }
  | { kind: 'refused'; messageKey: MessageKey };

/**
 * Read the two date inputs. Both empty is a legitimate undated search; one
 * empty would silently become undated if passed through, so it is refused
 * instead. A refusal carries the message KEY, not the rendered sentence: the
 * page keeps the key so a language switch repaints the refusal in the new
 * language rather than replacing it with an unrelated line.
 */
export function readStayDates(checkin: string, checkout: string): StayDates {
  const a = checkin.trim();
  const b = checkout.trim();
  if (a === '' && b === '') return { kind: 'undated' };
  if (a === '' || b === '') {
    return { kind: 'refused', messageKey: 'search.dates.setBothOrClear' };
  }
  if (a >= b) return { kind: 'refused', messageKey: 'search.dates.checkoutAfterCheckin' };
  return { kind: 'dated', checkin: a, checkout: b };
}

export interface OccupancyInput {
  adults: number;
  rooms: number;
  children: number;
}

/**
 * Say which validation refused the query, in user words. Called only after
 * `circleToQuery` returned null; checks run in the same order the lib checks
 * them, so the first message matches the lib's actual reason.
 */
export function explainQueryRefusal(circle: SearchCircle, occupancy: OccupancyInput): string {
  const { latitude, longitude, radiusKm } = circle;
  if ([latitude, longitude, radiusKm].some((n) => typeof n !== 'number' || !Number.isFinite(n))) {
    return t('search.refusal.invalidCircle');
  }
  if (radiusKm <= 0) {
    return t('search.refusal.zeroSize');
  }
  if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) {
    return t('search.refusal.outOfBounds');
  }
  // Field names reuse the form-label keys, so a refusal names the field in
  // the same words the form shows.
  const counts = [
    { label: t('search.form.adults'), value: occupancy.adults, ...OCCUPANCY_BOUNDS.adults },
    { label: t('search.form.rooms'), value: occupancy.rooms, ...OCCUPANCY_BOUNDS.rooms },
    { label: t('search.form.children'), value: occupancy.children, ...OCCUPANCY_BOUNDS.children },
  ];
  for (const { label, value, min, max } of counts) {
    if (!Number.isInteger(value) || value < min || value > max) {
      return t('search.refusal.countRange', { label, min, max });
    }
  }
  return t('search.refusal.unanticipated');
}

/**
 * The after-render status line. Honest about zero — and the count it reports
 * is what is actually ON SCREEN inside the drawn circle, since the page drops
 * results the platform placed outside it (`partitionByRadius`).
 */
export function resultsStatus(count: number, dated: boolean): string {
  if (count === 0) return t('search.status.resultsZero');
  if (count === 1) return t(dated ? 'search.status.resultsOneDated' : 'search.status.resultsOne');
  return t(dated ? 'search.status.resultsManyDated' : 'search.status.resultsMany', { count });
}

/**
 * The other half of the results line: how many cards the platform sent that
 * the drawn circle does not contain and the page therefore hides. Empty when
 * nothing was dropped — silence is the honest answer to "none". Saying this
 * out loud is the replacement for the old partial-coverage warning, which
 * guessed at coverage from the spread of the results and told users to shrink
 * an area that had already answered them completely.
 */
export function outsideAreaLine(dropped: number): string {
  if (dropped <= 0) return '';
  if (dropped === 1) return t('search.status.outsideAreaOne');
  return t(
    selectPlural(dropped, {
      one: 'search.status.outsideAreaOne',
      few: 'search.status.outsideAreaFew',
      many: 'search.status.outsideAreaMany',
    }),
    { count: dropped },
  );
}

/** "8.3 · 15 reviews" — or just the score when the count is missing. */
export function reviewLine(score: number, count?: number): string {
  if (count === undefined) return String(score);
  if (count === 1) return t('search.card.reviewLineOne', { score });
  return t(
    selectPlural(count, {
      one: 'search.card.reviewLineOne',
      few: 'search.card.reviewLineFew',
      many: 'search.card.reviewLineMany',
    }),
    { score, count },
  );
}

/**
 * Admit a URL into an href/src only when it is plain http(s). Search results
 * are attacker-adjacent content: a card URL must never smuggle `javascript:`
 * (or anything else) into a link the user will click.
 */
export function httpUrl(value: string | undefined): string | null {
  if (value === undefined) return null;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.href : null;
}

// --- result selection -----------------------------------------------------

/** The parts of a card that say WHICH PROPERTY it stands for. */
export interface IdentifiableCard {
  url: string;
  canonicalUrl?: string;
}

/**
 * The identity a selection is held by — never the ordinal. Sorting renumbers
 * every card, so a selection kept by position would silently move to a
 * different property the moment the list is re-sorted, and a language
 * re-render rebuilds the list from scratch. The canonical URL is preferred
 * because it is the platform's own name for the property; the card URL (with
 * its tracking params) is what the page has when canonicalization failed.
 *
 * This value is an IDENTITY, not a link: it is never given to an href, and
 * never interpolated into a CSS selector (search URLs are attacker-adjacent).
 */
export function selectionKey(card: IdentifiableCard): string {
  return card.canonicalUrl ?? card.url;
}

/**
 * The card a selection key refers to now, or null when the current results no
 * longer contain it — a later search that drops the property simply drops the
 * selection with it. First match wins if a platform ever repeats a URL, which
 * is the same card the renderer registers its marker under.
 */
export function findByKey<T extends IdentifiableCard>(
  cards: readonly T[],
  key: string | null,
): T | null {
  if (key === null) return null;
  return cards.find((card) => selectionKey(card) === key) ?? null;
}

// --- result sorting -------------------------------------------------------

export type SortMode = 'price-asc' | 'price-desc' | 'rating-desc' | 'platform';

/** Ascending price is the default: the cheapest answer to "what does a stay here cost". */
export const DEFAULT_SORT: SortMode = 'price-asc';

/**
 * Numeric value of a printed price ("₪ 10,450", "€ 1.234"), or null. Digits
 * only: search prices are whole amounts in one currency per page, so
 * separators are grouping, not decimals. A parse failure sorts last rather
 * than as zero — an unreadable price must never masquerade as the cheapest.
 */
export function priceValue(priceText: string | undefined): number | null {
  if (priceText === undefined) return null;
  const digits = priceText.replace(/\D/g, '');
  if (digits === '') return null;
  const value = Number(digits);
  return Number.isFinite(value) ? value : null;
}

/**
 * Stable sort of the parsed cards. 'platform' keeps the page's own order —
 * the platform's ranking carries information the other modes discard, so it
 * stays selectable. Cards missing the sorted-by value go last in list order.
 */
export function sortCards<T extends { priceText?: string; reviewScore?: number }>(
  cards: readonly T[],
  mode: SortMode,
): T[] {
  if (mode === 'platform') return [...cards];
  const keyed = cards.map((card, index) => ({ card, index }));
  keyed.sort((a, b) => {
    const rank = (entry: { card: T }): number | null =>
      mode === 'rating-desc' ? (entry.card.reviewScore ?? null) : priceValue(entry.card.priceText);
    const ra = rank(a);
    const rb = rank(b);
    if (ra === null && rb === null) return a.index - b.index;
    if (ra === null) return 1;
    if (rb === null) return -1;
    const direction = mode === 'price-asc' ? ra - rb : rb - ra;
    return direction !== 0 ? direction : a.index - b.index;
  });
  return keyed.map((entry) => entry.card);
}
