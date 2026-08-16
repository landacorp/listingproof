/**
 * Booking.com page-context scraping: breadcrumbs, nearby landmarks with their
 * claimed distances, description and guest reviews.
 *
 * The selectors here are Booking's and nobody else's. Generic shapes and the
 * shared helpers live in `lib/pagecontext.ts`.
 *
 * Reviews come from the page's embedded Apollo cache rather than from the
 * rendered DOM, because the DOM is a lossy projection of data the page is
 * already carrying: `featuredreview-text` holds the POSITIVE half only, clipped
 * at ~250 characters, with no score, no date and no language. The complaint
 * half — the text a contradiction check most wants — is never rendered at all.
 * Measured across this repo's 13 Booking captures, the DOM serves 1.0-1.9 KB of
 * review text per page where the embedded JSON serves 0.5-5.8 KB, and one
 * capture (`fr-hijack-gite-chassagne`) renders no review nodes whatsoever while
 * embedding five complete reviews.
 *
 * The blob is a ~300-580 KB attacker-influenced JSON document, so every step
 * below is bounded and none of it may throw: a page that defeats this parser
 * falls back to the DOM scrape, which is exactly what shipped before.
 */
import {
  collapse,
  parseStatedDistanceKm,
  reviewTexts,
  textNodes,
  type PageContext,
  type PageReviews,
  type PoiMention,
} from '../../pagecontext';
import type { ReviewItem, ReviewSummary } from '../../reviews';

const POI_CAP = 40;
const REVIEW_CAP = 12;
const REVIEW_MAX_CHARS = 600;
const DESCRIPTION_MAX_CHARS = 4000;

/**
 * POI rows render as text nodes ending with the distance; the name is the node
 * before it. A three-node row carries a leading category chip
 * (["Restaurant", "Pret A Manger", "100 m"]), so reading second-to-last covers
 * both shapes without locale-specific category lists.
 */
function poiFromRow(parts: string[]): PoiMention | undefined {
  if (parts.length < 2) {
    const only = parts[0];
    return only ? { name: collapse(only, 120) } : undefined;
  }
  const distance = parseStatedDistanceKm(parts[parts.length - 1]);
  const nameIndex = distance === undefined ? parts.length - 1 : parts.length - 2;
  const name = collapse(parts[nameIndex] ?? '', 120);
  if (!name) return undefined;
  return distance === undefined ? { name } : { name, statedDistanceKm: distance };
}

// ---------------------------------------------------------------------------
// embedded reviews — bounds first, because everything below reads hostile JSON
// ---------------------------------------------------------------------------

/** `<script type="application/json">` blocks examined. Real pages carry ~73. */
const JSON_SCRIPT_CAP = 80;
/**
 * Characters of one JSON block we are willing to parse. The Apollo store
 * measures 264-575 KB across the corpus; this exists only so a crafted
 * multi-megabyte blob cannot stall the content script's main thread.
 */
const JSON_TEXT_MAX_CHARS = 4_000_000;
/** Nesting walked. The reviews sit 4 levels deep; real stores are ~8. */
const JSON_DEPTH_CAP = 30;
/** Objects visited during the walk. Corpus pages hold 2.4-3.2 thousand. */
const JSON_NODE_CAP = 60_000;
/** Children queued from one object or array, so one huge fan-out cannot hang. */
const JSON_FANOUT_CAP = 2_000;
/** Characters kept of one half of one review. Longest in the corpus: 1,949. */
const REVIEW_TEXT_MAX_CHARS = 2_000;
const REVIEW_TITLE_MAX_CHARS = 200;
/** Total review text handed to Engine L. Corpus maximum: 5,761 characters. */
const REVIEWS_TEXT_TOTAL_MAX = 16_000;
/** Booking rates every review on a 1-10 integer scale. */
const REVIEW_SCORE_MAX = 10;
/** Plausible review timestamps: 1990-01-01 to 2100-01-01, in epoch SECONDS. */
const EPOCH_SECONDS_MIN = 631_152_000;
const EPOCH_SECONDS_MAX = 4_102_444_800;
/** Longest id accepted, and the shape one may take. */
const REVIEW_ID_MAX_CHARS = 40;
const REVIEW_ID = /^[0-9A-Za-z_-]{1,40}$/;
/** `en`, `pt-pt`, and Booking's own non-standard `xu`. Bounded, never trusted. */
const REVIEW_LANG = /^[A-Za-z]{2,3}(?:-[0-9A-Za-z]{2,8}){0,2}$/;

const LD_SCRIPT_CAP = 40;
const LD_TEXT_MAX_CHARS = 2_000_000;
const LD_NODE_CAP = 1_000;
const LODGING_TYPES = new Set([
  'Hotel', 'Hostel', 'Motel', 'Resort', 'BedAndBreakfast', 'Apartment',
  'House', 'VacationRental', 'LodgingBusiness', 'Campground',
]);

/**
 * The two shapes the same ten reviews appear in.
 *
 * `FeaturedReview` entries are top-level normalized cache entries;
 * `PropertyFeaturedReview` is the inline projection under the reviews query.
 * They carry identical ids, scores and timestamps, so both are read and merged
 * by id — which is not redundancy for its own sake: `PropertyFeaturedReview`
 * supplies a title that `FeaturedReview` usually leaves empty, and one capture
 * in the corpus embeds `FeaturedReview` entries with no projection at all.
 */
const REVIEW_TYPENAMES = new Set(['PropertyFeaturedReview', 'FeaturedReview']);

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Numeric coercion that treats "absent" as absent. `Number('')` is 0, which
 * would turn a missing aggregate into a confident zero — a hard default on
 * missing data, exactly what the GRAY contract forbids. JSON-LD quotes its
 * numbers (`"ratingValue": "8.6"`), so strings are accepted.
 */
function asFiniteNumber(value: unknown): number | undefined {
  if (typeof value === 'string' && value.trim() === '') return undefined;
  const n = typeof value === 'string' ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) ? n : undefined;
}

/**
 * Named entities Booking's projection escapes with. The inline
 * `PropertyFeaturedReview` text arrives HTML-escaped (`L&#39;accès`) while the
 * normalized `FeaturedReview` copy of the same sentence arrives raw, so without
 * decoding, the two shapes of one review would not compare equal, the panel
 * would print entity soup, and Engine L's quote grounding — which matches model
 * output against this text — would fail on any review containing an apostrophe.
 *
 * Decoding restores exactly what the DOM already renders through `textContent`,
 * which is what the previous scrape produced. The result is text, never markup:
 * nothing downstream interpolates it as HTML.
 */
const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
};
const ENTITY = /&(?:#(\d{1,7})|#[xX]([0-9A-Fa-f]{1,6})|([A-Za-z]{2,8}));/g;

function fromCodePoint(code: number): string | undefined {
  // Lone surrogates are rejected: `String.fromCodePoint` accepts them and the
  // result is an unpaired code unit that breaks string comparison downstream.
  if (!Number.isInteger(code) || code <= 0 || code > 0x10ffff) return undefined;
  if (code >= 0xd800 && code <= 0xdfff) return undefined;
  return String.fromCodePoint(code);
}

export function decodeEntities(text: string): string {
  if (!text.includes('&')) return text;
  return text.replace(ENTITY, (whole, dec: string | undefined, hex: string | undefined, name: string | undefined) => {
    if (dec !== undefined) return fromCodePoint(Number(dec)) ?? whole;
    if (hex !== undefined) return fromCodePoint(Number.parseInt(hex, 16)) ?? whole;
    return (name !== undefined ? NAMED_ENTITIES[name.toLowerCase()] : undefined) ?? whole;
  });
}

/** Decoded, whitespace-collapsed, capped text, or undefined when it says nothing. */
function reviewText(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined;
  // Sliced before decoding as well as after: the regex must not be run across
  // a megabyte of crafted entities to produce a 2,000-character result.
  return collapse(decodeEntities(value.slice(0, max * 4)), max) || undefined;
}

function reviewId(value: unknown): string | undefined {
  if (typeof value !== 'number' && typeof value !== 'string') return undefined;
  if (typeof value === 'number' && !Number.isFinite(value)) return undefined;
  const text = String(value);
  return text.length <= REVIEW_ID_MAX_CHARS && REVIEW_ID.test(text) ? text : undefined;
}

function reviewLang(value: unknown): string | undefined {
  return typeof value === 'string' && REVIEW_LANG.test(value) ? value : undefined;
}

/**
 * Booking publishes an integer 1-10, which is already the normalized scale, so
 * `score` and `rawScore.value` agree here. They will not on a 5-point platform,
 * which is why both fields exist.
 */
function reviewScore(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= REVIEW_SCORE_MAX
    ? value
    : undefined;
}

/** Epoch SECONDS as Booking publishes them, converted to the contract's milliseconds. */
function reviewedAt(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isInteger(value)) return undefined;
  if (value < EPOCH_SECONDS_MIN || value > EPOCH_SECONDS_MAX) return undefined;
  return value * 1000;
}

/**
 * One cache node in either shape, or undefined when nothing usable survives the
 * guards. A review with no id cannot be merged with its twin, so it is dropped
 * rather than duplicated.
 */
function reviewFromNode(node: JsonObject): { id: string; item: ReviewItem } | undefined {
  const id = reviewId(node['reviewId'] ?? node['id']);
  if (id === undefined) return undefined;

  // `textDetails` is the projection's nesting; the normalized entry is flat.
  const text = isObject(node['textDetails']) ? node['textDetails'] : node;

  const item: ReviewItem = { id };
  const score = reviewScore(node['reviewScore'] ?? node['averageScore']);
  if (score !== undefined) {
    item.score = score;
    item.rawScore = { value: score, max: REVIEW_SCORE_MAX };
  }
  const at = reviewedAt(node['reviewedDate'] ?? node['completed']);
  if (at !== undefined) item.reviewedAt = at;

  const positive = reviewText(text['positiveText'], REVIEW_TEXT_MAX_CHARS);
  const negative = reviewText(text['negativeText'], REVIEW_TEXT_MAX_CHARS);
  const title = reviewText(text['title'], REVIEW_TITLE_MAX_CHARS);
  const lang = reviewLang(text['lang'] ?? text['language']);
  if (positive !== undefined) item.positive = positive;
  if (negative !== undefined) item.negative = negative;
  if (title !== undefined) item.title = title;
  if (lang !== undefined) item.lang = lang;
  return { id, item };
}

/**
 * Merge a second sighting of one review into the first. First non-empty value
 * wins per field, so the two shapes complete each other (the projection's title,
 * the normalized entry's everything-else) without either being able to blank a
 * field the other filled.
 */
function mergeReview(into: ReviewItem, from: ReviewItem): void {
  into.score ??= from.score;
  into.rawScore ??= from.rawScore;
  into.reviewedAt ??= from.reviewedAt;
  into.positive ??= from.positive;
  into.negative ??= from.negative;
  into.title ??= from.title;
  into.lang ??= from.lang;
}

/**
 * Walk a parsed cache for review nodes, in document order, under a hard budget.
 *
 * Recursion is depth-capped well inside the engine's stack limit, and the node
 * budget is shared across the whole walk so that neither depth, breadth, nor
 * total size can be traded against each other to make this expensive.
 */
function collectReviews(root: unknown, into: Map<string, ReviewItem>): void {
  let budget = JSON_NODE_CAP;

  const visit = (node: unknown, depth: number): void => {
    if (budget <= 0 || depth > JSON_DEPTH_CAP || into.size >= REVIEW_CAP) return;
    budget--;
    if (Array.isArray(node)) {
      for (let i = 0; i < node.length && i < JSON_FANOUT_CAP; i++) visit(node[i], depth + 1);
      return;
    }
    if (!isObject(node)) return;

    const typename = node['__typename'];
    if (typeof typename === 'string' && REVIEW_TYPENAMES.has(typename)) {
      const parsed = reviewFromNode(node);
      if (parsed !== undefined) {
        const existing = into.get(parsed.id);
        if (existing === undefined) into.set(parsed.id, parsed.item);
        else mergeReview(existing, parsed.item);
      }
      return; // a review never contains another review
    }

    const values = Object.values(node);
    for (let i = 0; i < values.length && i < JSON_FANOUT_CAP; i++) visit(values[i], depth + 1);
  };

  visit(root, 0);
}

/** Structured reviews out of the page's embedded cache. Never throws. */
export function readEmbeddedReviews(doc: Document): ReviewItem[] {
  const scripts = Array.from(doc.querySelectorAll('script[type="application/json"]')).slice(0, JSON_SCRIPT_CAP);
  const found = new Map<string, ReviewItem>();
  for (const script of scripts) {
    if (found.size >= REVIEW_CAP) break;
    const text = script.textContent ?? '';
    // A page carries dozens of JSON blocks and one of them holds the reviews.
    // The marker test costs a substring scan and saves parsing the other 72.
    if (text.length === 0 || text.length > JSON_TEXT_MAX_CHARS) continue;
    if (!text.includes('positiveText')) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      continue; // truncated or hostile JSON must never reach the pipeline
    }
    collectReviews(parsed, found);
  }
  return Array.from(found.values());
}

/**
 * The aggregate the page publishes, so the panel can say "10 of 3,526 reviews"
 * rather than presenting ten hand-picked reviews as the whole picture. Read from
 * JSON-LD, the same source the identity vector's score and count come from, so
 * the two can never disagree in the panel.
 */
export function readReviewSummary(doc: Document): ReviewSummary | undefined {
  const scripts = Array.from(doc.querySelectorAll('script[type="application/ld+json"]')).slice(0, LD_SCRIPT_CAP);
  for (const script of scripts) {
    const text = script.textContent ?? '';
    if (text.length === 0 || text.length > LD_TEXT_MAX_CHARS) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      continue;
    }
    const queue: unknown[] = Array.isArray(parsed) ? parsed.slice(0, LD_NODE_CAP) : [parsed];
    for (let i = 0; i < queue.length && i < LD_NODE_CAP; i++) {
      const node = queue[i];
      if (!isObject(node)) continue;
      const graph = node['@graph'];
      if (Array.isArray(graph)) {
        for (let g = 0; g < graph.length && queue.length < LD_NODE_CAP; g++) queue.push(graph[g]);
      }
      const type = node['@type'];
      const types = Array.isArray(type) ? type : [type];
      if (!types.some((t) => typeof t === 'string' && LODGING_TYPES.has(t))) continue;

      const rating = node['aggregateRating'];
      if (!isObject(rating)) continue;
      const summary: ReviewSummary = {};
      const score = reviewScore(asFiniteNumber(rating['ratingValue']));
      const total = asFiniteNumber(rating['reviewCount']);
      if (score !== undefined) summary.score = score;
      if (total !== undefined && Number.isInteger(total) && total >= 0) summary.total = total;
      return summary.score === undefined && summary.total === undefined ? undefined : summary;
    }
  }
  return undefined;
}

/**
 * Everything the page says about guest reviews.
 *
 * `availability` is always `in-page`: Booking embeds individual reviews in the
 * document, so an empty `items` here means this page served none — a finding,
 * not a gap in what we looked at.
 */
export function extractReviewSet(doc: Document): PageReviews {
  const items = readEmbeddedReviews(doc);
  const summary = readReviewSummary(doc);
  return { availability: 'in-page', items, ...(summary === undefined ? {} : { summary }) };
}

/** The clipped positive-half snippets the page renders. The fallback, not the source. */
function domReviews(doc: Document): string[] {
  return Array.from(doc.querySelectorAll('[data-testid="featuredreview-text"], [data-testid="review"]'))
    .map((el) => collapse(el.textContent ?? '', REVIEW_MAX_CHARS))
    .filter((t) => t.length > 0)
    .slice(0, REVIEW_CAP);
}

export function extractPageContext(doc: Document): PageContext {
  const breadcrumbs = Array.from(doc.querySelectorAll('[data-testid="breadcrumb-item"]'))
    .map((el) => collapse(el.textContent ?? '', 120))
    .filter((t) => t.length > 0)
    .slice(0, 12);

  const pois: PoiMention[] = [];
  for (const block of Array.from(doc.querySelectorAll('[data-testid="poi-block"]'))) {
    const category = collapse(block.querySelector('h3, h4, [role="heading"]')?.textContent ?? '', 60);
    for (const row of Array.from(block.querySelectorAll('li'))) {
      if (pois.length >= POI_CAP) break;
      const poi = poiFromRow(textNodes(row, 8));
      if (poi) pois.push(category ? { ...poi, category } : poi);
    }
  }

  const descriptionEl = doc.querySelector(
    '[data-testid="property-description"], [data-testid="property-section--content"]',
  );
  const description = collapse(descriptionEl?.textContent ?? '', DESCRIPTION_MAX_CHARS) || undefined;

  // A parse failure must cost the reviews, not the page context: breadcrumbs and
  // landmarks feed Engine A, and losing them to a crafted JSON blob would be a
  // way for a listing to switch off the checks against it.
  let reviewSet: PageReviews;
  try {
    reviewSet = extractReviewSet(doc);
  } catch {
    reviewSet = { availability: 'in-page', items: [] };
  }

  // Engine L reads whichever is richer. The embedded reviews carry both halves
  // untruncated; the DOM snippets are what remains when a page serves no
  // structured reviews at all — the synthetic and injection fixtures, and any
  // future markup change here.
  const fromItems = reviewTexts(reviewSet.items, REVIEWS_TEXT_TOTAL_MAX);
  const reviews = fromItems.length > 0 ? fromItems : domReviews(doc);

  return { breadcrumbs, pois, description, reviews, reviewSet };
}
