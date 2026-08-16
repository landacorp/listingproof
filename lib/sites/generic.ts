/**
 * Generic schema.org adapter — the fallback that makes "any listing site" true.
 *
 * A bespoke adapter exists only where a platform's markup is missing or
 * misleading (Booking puts the street in `addressLocality` and omits `geo`
 * entirely). Everywhere else the platform already publishes standard
 * schema.org lodging markup, and reading it needs no per-platform code at all.
 * This module is that reader, plus the thinnest possible adapter around it.
 *
 * What it deliberately does NOT claim: a name-bearing URL, a destination id, or
 * a landmark list. A generic page gives us none of those. Declaring otherwise
 * would have Engine A1 compare a URL segment that is not a name against the
 * property title and call every honest listing a mismatch.
 *
 * Everything here parses attacker-authored markup: every traversal is bounded,
 * extraction never throws, and a value that is absent stays `undefined` (GRAY)
 * rather than becoming a confident zero.
 */
import { collapse, reviewTexts, type PageContext, type PageReviews } from '../pagecontext';
import type { IdentityVector } from '../identity';
import type { ReviewItem, ReviewSummary } from '../reviews';
import type { CanonicalListing, ExtractOptions, SiteAdapter } from './types';

// ---------------------------------------------------------------------------
// bounds — page content is hostile input, so every loop has a ceiling
// ---------------------------------------------------------------------------

/** JSON-LD blocks scanned per document. */
const LD_SCRIPT_CAP = 40;
/** Characters of a single JSON-LD block we are willing to parse. Real lodging
 *  markup is a few KB; this only exists so a megabyte of crafted JSON cannot
 *  stall the content script's main thread. */
const LD_TEXT_CAP = 2_000_000;
/** Nodes walked per block, covering `@graph` expansion. */
const LD_NODE_CAP = 1000;
/** Raw image entries read out of the markup before normalization. */
const IMAGE_CANDIDATE_CAP = 200;
/** Normalized photo identities kept on the vector. */
const PHOTO_CAP = 60;
/** Longest photo URL considered; beyond this it is not a real asset URL. */
const PHOTO_URL_MAX_CHARS = 2048;

const NAME_MAX_CHARS = 200;
const ADDRESS_MAX_CHARS = 300;
const PLACE_MAX_CHARS = 120;
const ID_MAX_CHARS = 120;
const DESCRIPTION_MAX_CHARS = 4000;
const BREADCRUMB_CAP = 12;
const BREADCRUMB_MAX_CHARS = 120;
/**
 * Entries of `itemListElement` examined. Distinct from `BREADCRUMB_CAP`: a
 * hostile list of a million entries that each yield no label would otherwise be
 * walked in full, because a cap on *output* is not a cap on *work*. Real trails
 * are under ten deep.
 */
const BREADCRUMB_SCAN_CAP = 200;

/**
 * `@type` values that mean "this page describes a place someone can stay in".
 *
 * Wider than the Booking extractor's list because that one only ever sees
 * `Hotel`: here the type is the platform's own honest answer, so
 * `VacationRental`, `Accommodation` and `SingleFamilyResidence` (short-let
 * platforms) all have to be recognised or their listings read as "no markup".
 */
const LODGING_TYPES = new Set([
  'Hotel', 'Hostel', 'Motel', 'Resort', 'BedAndBreakfast', 'Apartment',
  'House', 'VacationRental', 'LodgingBusiness', 'Campground', 'Accommodation',
  'SingleFamilyResidence',
]);

/** Image file extensions. A path without one is UI chrome, not a listing photo. */
const IMAGE_EXTENSION = /\.(?:jpe?g|png|webp|avif|gif)$/i;

// ---------------------------------------------------------------------------
// the pure JSON-LD reader
// ---------------------------------------------------------------------------

/** What standard lodging markup can tell us. Every field optional: markup varies. */
export interface SchemaOrgLodging {
  name?: string;
  description?: string;
  listingId?: string;
  streetAddress?: string;
  city?: string;
  country?: string;
  lat?: number;
  lng?: number;
  reviewCount?: number;
  reviewScore?: number;
  /** Top of this platform's rating scale — see `ratingScale()`. */
  reviewScoreMax?: number;
  images: string[];
  /** The schema.org type that matched, e.g. `Hotel`, verbatim. */
  propertyType?: string;
}

type Node = Record<string, unknown>;

/**
 * Append at most `cap - target.length` items. Never `...spread`: spreading an
 * attacker-sized array throws RangeError (call-stack overflow) before any
 * length check downstream can run.
 */
function pushBounded<T>(target: T[], source: readonly T[], cap: number): void {
  for (let i = 0; i < source.length && target.length < cap; i++) target.push(source[i]);
}

function asString(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined;
}

/** Whitespace-collapsed, length-capped string, or undefined when empty/absent. */
function boundedString(v: unknown, max: number): string | undefined {
  return typeof v === 'string' ? collapse(v, max) || undefined : undefined;
}

/**
 * Numeric coercion that treats "absent" as absent. `Number('')` is 0, which
 * would turn a missing coordinate into null island (0,0) and a missing review
 * count into a real-looking zero — a hard default on missing data, exactly what
 * the GRAY contract forbids. Strings are accepted because schema.org markup
 * routinely quotes numbers (`"latitude": "48.8584"`).
 */
function asFiniteNumber(v: unknown): number | undefined {
  if (typeof v === 'string' && v.trim() === '') return undefined;
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : undefined;
}

/**
 * A scalar that may have been wrapped in a node: `addressCountry` is a bare
 * string on most sites and a `Country` object on some, `identifier` is a string
 * on most and a `PropertyValue` on some.
 */
function scalarOf(v: unknown): string | undefined {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  if (typeof v === 'object' && v !== null && !Array.isArray(v)) {
    const obj = v as Node;
    return asString(obj['name']) ?? asString(obj['value']) ?? asString(obj['identifier']);
  }
  return undefined;
}

/** `@type` normalized to a list: it is a string on most pages, an array on some. */
function typesOf(obj: Node): string[] {
  const type = obj['@type'];
  const list = Array.isArray(type) ? type : [type];
  const out: string[] = [];
  for (let i = 0; i < list.length && i < 32; i++) {
    if (typeof list[i] === 'string') out.push(list[i] as string);
  }
  return out;
}

/**
 * First JSON-LD node in the document that `match` accepts.
 *
 * Walks the top-level array form and `@graph` containers, which is how most
 * CMS-generated markup nests its nodes. The queue is bounded and iterated by
 * `for…of` so nodes appended mid-walk are visited without recursion.
 */
function findJsonLdNode(doc: Document, match: (obj: Node, types: readonly string[]) => boolean):
  Node | undefined {
  const scripts = Array.from(doc.querySelectorAll('script[type="application/ld+json"]'))
    .slice(0, LD_SCRIPT_CAP);
  for (const script of scripts) {
    const text = script.textContent ?? '';
    if (text.length === 0 || text.length > LD_TEXT_CAP) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      continue; // truncated or hostile markup must never throw
    }
    const queue: unknown[] = [];
    pushBounded(queue, Array.isArray(parsed) ? parsed : [parsed], LD_NODE_CAP);
    for (const node of queue) {
      if (typeof node !== 'object' || node === null || Array.isArray(node)) continue;
      const obj = node as Node;
      const graph = obj['@graph'];
      if (Array.isArray(graph)) pushBounded(queue, graph, LD_NODE_CAP);
      if (match(obj, typesOf(obj))) return obj;
    }
  }
  return undefined;
}

function parseLatLng(lat: unknown, lng: unknown): { lat: number; lng: number } | undefined {
  const la = asFiniteNumber(lat);
  const ln = asFiniteNumber(lng);
  if (la === undefined || ln === undefined) return undefined;
  if (Math.abs(la) > 90 || Math.abs(ln) > 180) return undefined;
  return { lat: la, lng: ln };
}

/**
 * Top of the rating scale.
 *
 * `bestRating` is the schema.org answer and is trusted when present — but only
 * when it can actually hold the score. Markup in the wild carries a copied
 * `bestRating: 1` next to a 4.8, and taking that literally would normalise the
 * score to 4.8x its own maximum. A scale below its own score is a broken field,
 * not a scale, so it falls through to the inference.
 *
 * With no usable `bestRating` the scale is guessed: <= 5 means a 5-point scale,
 * above 5 means a 10-point one. A 5-point platform never emits 7.3, so the
 * upper half is safe. The lower half is not, and the limit is worth stating
 * because a downstream rule normalises by this value: a 10-point platform that
 * publishes no `bestRating` and whose score crosses 5 between two captures
 * (5.1 → 4.9) flips the inferred scale from 10 to 5, which normalises to a
 * halving that never happened. The alternative — leaving the scale undefined —
 * would drop the score comparison on every honest platform that omits
 * `bestRating`, which is the far commoner case, so the guess stands and any
 * rule reading it should treat a bare 2x move as unproven.
 */
function ratingScale(bestRating: unknown, reviewScore: number | undefined): number | undefined {
  const best = asFiniteNumber(bestRating);
  if (best !== undefined && best > 0 && (reviewScore === undefined || best >= reviewScore)) {
    return best;
  }
  if (reviewScore === undefined) return undefined;
  return reviewScore <= 5 ? 5 : 10;
}

/**
 * `image` in the wild: a string, an array of strings, an array of ImageObject
 * (`{url}`), or a single ImageObject. All four appear; all four are read.
 */
function imageUrls(value: unknown): string[] {
  const items: unknown[] = [];
  pushBounded(items, Array.isArray(value) ? value : [value], IMAGE_CANDIDATE_CAP);
  const out: string[] = [];
  for (const item of items) {
    const url = typeof item === 'string'
      ? asString(item)
      : typeof item === 'object' && item !== null && !Array.isArray(item)
        ? asString((item as Node)['url']) ?? asString((item as Node)['contentUrl'])
        : undefined;
    if (url !== undefined) out.push(url);
  }
  return out;
}

/**
 * Read standard schema.org lodging markup out of a document.
 *
 * Returns undefined when the page carries none — which is the signal the
 * registry uses to decide the generic adapter should not claim the page.
 * Exported so a bespoke adapter whose platform emits clean markup (Airbnb) can
 * reuse the reader and override only what its platform does differently.
 */
export function readSchemaOrgLodging(doc: Document): SchemaOrgLodging | undefined {
  let propertyType: string | undefined;
  const node = findJsonLdNode(doc, (_obj, types) => {
    const hit = types.find((t) => LODGING_TYPES.has(t));
    if (hit === undefined) return false;
    propertyType = hit;
    return true;
  });
  if (node === undefined) return undefined;

  // `address` is a PostalAddress on most sites, a bare display string on some,
  // and absent on others. Unlike Booking — whose adapter exists precisely
  // because it puts the street here — `addressLocality` really is the city.
  const address = node['address'];
  let streetAddress: string | undefined;
  let city: string | undefined;
  let country: string | undefined;
  if (typeof address === 'string') {
    streetAddress = boundedString(address, ADDRESS_MAX_CHARS);
  } else if (typeof address === 'object' && address !== null && !Array.isArray(address)) {
    const postal = address as Node;
    streetAddress = boundedString(postal['streetAddress'], ADDRESS_MAX_CHARS);
    city = boundedString(postal['addressLocality'], PLACE_MAX_CHARS);
    country = boundedString(scalarOf(postal['addressCountry']), PLACE_MAX_CHARS);
  }

  // Coordinates appear two ways: nested `geo` (the schema.org norm) and
  // top-level `latitude`/`longitude` (what some short-let platforms emit).
  // Both are read; nested wins because it is the documented form.
  const geo = node['geo'];
  const nested = typeof geo === 'object' && geo !== null && !Array.isArray(geo)
    ? parseLatLng((geo as Node)['latitude'], (geo as Node)['longitude'])
    : undefined;
  const point = nested ?? parseLatLng(node['latitude'], node['longitude']);

  const ratingNode = node['aggregateRating'];
  const rating = typeof ratingNode === 'object' && ratingNode !== null && !Array.isArray(ratingNode)
    ? (ratingNode as Node)
    : undefined;
  const reviewScore = asFiniteNumber(rating?.['ratingValue']);
  // `reviewCount` is the schema.org field; `ratingCount` is what several
  // platforms emit instead. Either is the number of reviews behind the score.
  const rawCount = asFiniteNumber(rating?.['reviewCount']) ?? asFiniteNumber(rating?.['ratingCount']);
  const reviewCount = rawCount !== undefined && Number.isInteger(rawCount) && rawCount >= 0
    ? rawCount
    : undefined;
  const reviewScoreMax = ratingScale(rating?.['bestRating'], reviewScore);

  // Only explicit id fields. `@id` is deliberately NOT read: on most sites it
  // is the page URL, so an archived capture taken under a locale path would
  // read as a *different* listing id — and a differing listing id withdraws the
  // entire archive comparison (B.listingId). A missing id costs one GRAY row; a
  // wrong one silently discards every other rule.
  const listingId =
    boundedString(scalarOf(node['identifier']), ID_MAX_CHARS) ??
    boundedString(scalarOf(node['sku']), ID_MAX_CHARS) ??
    boundedString(scalarOf(node['productID']), ID_MAX_CHARS);

  const lodging: SchemaOrgLodging = { images: imageUrls(node['image']) };
  const name = boundedString(node['name'], NAME_MAX_CHARS);
  const description = boundedString(node['description'], DESCRIPTION_MAX_CHARS);
  if (name !== undefined) lodging.name = name;
  if (description !== undefined) lodging.description = description;
  if (listingId !== undefined) lodging.listingId = listingId;
  if (streetAddress !== undefined) lodging.streetAddress = streetAddress;
  if (city !== undefined) lodging.city = city;
  if (country !== undefined) lodging.country = country;
  if (point) { lodging.lat = point.lat; lodging.lng = point.lng; }
  if (reviewCount !== undefined) lodging.reviewCount = reviewCount;
  if (reviewScore !== undefined) lodging.reviewScore = reviewScore;
  if (reviewScoreMax !== undefined) lodging.reviewScoreMax = reviewScoreMax;
  if (propertyType !== undefined) lodging.propertyType = propertyType;
  return lodging;
}

// ---------------------------------------------------------------------------
// individual reviews
// ---------------------------------------------------------------------------

/** `Review` entries examined on the lodging node. */
const REVIEW_SCAN_CAP = 200;
/** Reviews kept. Premier Inn publishes 5; no standard says how many there may be. */
const REVIEW_CAP = 12;
/** Characters kept of one review body. Longest in the corpus: 1,406. */
const REVIEW_TEXT_MAX_CHARS = 2_000;
const REVIEW_TITLE_MAX_CHARS = 200;
/** Total review text handed to Engine L. */
const REVIEWS_TEXT_TOTAL_MAX = 16_000;
const REVIEW_ID_MAX_CHARS = 120;
const REVIEW_LANG_MAX_CHARS = 16;
/** Plausible review timestamps: 1990-01-01 to 2100-01-01, in epoch milliseconds. */
const EPOCH_MS_MIN = 631_152_000_000;
const EPOCH_MS_MAX = 4_102_444_800_000;

/**
 * The scale one review was rated on.
 *
 * `bestRating` on the review's own Rating node is the schema.org answer and wins
 * when it can actually hold the score. Failing that the property's aggregate
 * scale is used — a site rating its property out of 5 rates its reviews out of 5
 * — and only failing that does the value get to imply its own scale. That order
 * matters for the case a lone inference gets wrong: a single 5-star review on a
 * 5-point site and a 5.0 on a 10-point site are identical numbers, and the
 * aggregate is the only thing on the page that tells them apart.
 */
function perReviewScale(bestRating: unknown, value: number, aggregateMax: number | undefined): number {
  const stated = asFiniteNumber(bestRating);
  if (stated !== undefined && stated > 0 && stated >= value) return stated;
  if (aggregateMax !== undefined && aggregateMax > 0 && aggregateMax >= value) return aggregateMax;
  return ratingScale(undefined, value) ?? 5;
}

/** ISO 8601 `datePublished` as epoch milliseconds, or undefined when implausible. */
function publishedAt(value: unknown): number | undefined {
  if (typeof value !== 'string' || value.length === 0 || value.length > 64) return undefined;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms) || ms < EPOCH_MS_MIN || ms > EPOCH_MS_MAX) return undefined;
  return ms;
}

/**
 * One schema.org `Review`.
 *
 * `reviewBody` lands in `positive` because the shared contract splits a review
 * into the two halves BOOKING publishes and schema.org has only one field for
 * "what the reviewer wrote". `positive` is that field for an undivided body —
 * it is the reviewer's own words, not a claim that the words are praise, and a
 * consumer that labels the field rather than showing it will need to read
 * `rawScore` to know which it is. Splitting it by sentiment here would mean
 * inventing an opinion the page never published.
 */
function reviewFromNode(node: Node, aggregateMax: number | undefined): ReviewItem | undefined {
  const item: ReviewItem = {};

  const rating = node['reviewRating'];
  if (typeof rating === 'object' && rating !== null && !Array.isArray(rating)) {
    const value = asFiniteNumber((rating as Node)['ratingValue']);
    if (value !== undefined && value >= 0) {
      const max = perReviewScale((rating as Node)['bestRating'], value, aggregateMax);
      item.rawScore = { value, max };
      item.score = Math.min(10, (value / max) * 10);
    }
  }

  const body = boundedString(node['reviewBody'], REVIEW_TEXT_MAX_CHARS)
    ?? boundedString(node['description'], REVIEW_TEXT_MAX_CHARS);
  const title = boundedString(node['name'], REVIEW_TITLE_MAX_CHARS)
    ?? boundedString(node['headline'], REVIEW_TITLE_MAX_CHARS);
  const at = publishedAt(node['datePublished']) ?? publishedAt(node['dateCreated']);
  const id = boundedString(scalarOf(node['identifier']), REVIEW_ID_MAX_CHARS);
  const lang = boundedString(scalarOf(node['inLanguage']), REVIEW_LANG_MAX_CHARS);

  if (id !== undefined) item.id = id;
  if (at !== undefined) item.reviewedAt = at;
  if (body !== undefined) item.positive = body;
  if (title !== undefined) item.title = title;
  if (lang !== undefined) item.lang = lang;

  // A review that carries neither words nor a score says nothing at all.
  return item.positive === undefined && item.score === undefined ? undefined : item;
}

/**
 * Individual reviews published on the lodging node, as `review` (the schema.org
 * spelling) or `reviews` (what several CMSs emit). Single objects and arrays are
 * both accepted; both appear in the wild.
 */
export function readSchemaOrgReviews(doc: Document, aggregateMax?: number): ReviewItem[] {
  const node = findJsonLdNode(doc, (_obj, types) => types.some((t) => LODGING_TYPES.has(t)));
  if (node === undefined) return [];

  const out: ReviewItem[] = [];
  for (const key of ['review', 'reviews'] as const) {
    const value = node[key];
    if (value === undefined || value === null) continue;
    const entries: unknown[] = [];
    pushBounded(entries, Array.isArray(value) ? value : [value], REVIEW_SCAN_CAP);
    for (let i = 0; i < entries.length && out.length < REVIEW_CAP; i++) {
      const entry = entries[i];
      if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) continue;
      const item = reviewFromNode(entry as Node, aggregateMax);
      if (item !== undefined) out.push(item);
    }
    if (out.length > 0) break;
  }
  return out;
}

/** The aggregate the page publishes, normalized to the contract's 0-10. */
function reviewSummary(lodging: SchemaOrgLodging | undefined): ReviewSummary | undefined {
  if (lodging === undefined) return undefined;
  const summary: ReviewSummary = {};
  const max = lodging.reviewScoreMax;
  if (lodging.reviewScore !== undefined && max !== undefined && max > 0) {
    summary.score = Math.min(10, (lodging.reviewScore / max) * 10);
  }
  if (lodging.reviewCount !== undefined) summary.total = lodging.reviewCount;
  return summary.score === undefined && summary.total === undefined ? undefined : summary;
}

// ---------------------------------------------------------------------------
// adapter pieces
// ---------------------------------------------------------------------------

/**
 * An Open Graph value. `property=` is the correct attribute and `name=` is the
 * one a large minority of CMSs emit instead; on a generic reader that has no
 * second source for the hero image, reading only the correct spelling would
 * lose the whole signal on those sites. First match wins, and `property=`
 * appears first in the selector for its own sake, not for precedence — CSS
 * selector lists resolve in document order, so a page carrying both spellings
 * yields whichever it printed first. They agree in practice, and disagreeing
 * copies of a title are not a distinction this adapter can adjudicate.
 */
function metaContent(doc: Document, property: string): string | undefined {
  const selector = `meta[property="${property}"], meta[name="${property}"]`;
  return asString(doc.querySelector(selector)?.getAttribute('content'));
}

/**
 * Canonical identity of a photo URL on a platform we know nothing about.
 *
 * All we can strip is delivery noise: query string (resize and signing params)
 * and fragment. A bespoke adapter can do far better — Booking's reduces every
 * variant of a photo to its numeric asset id, so the same picture at two sizes
 * from two hosts compares equal. Here a CDN that serves the same image under
 * two paths will read as two photos, which can only ever understate gallery
 * overlap, never invent a change that is not there.
 *
 * The scheme is forced to https so an http-era archive capture and a live
 * https page compare equal; every image CDN in use answers on https.
 */
export function normalizePhotoUrl(input: string): string | null {
  if (input.length === 0 || input.length > PHOTO_URL_MAX_CHARS) return null;
  let url: URL;
  try {
    // Protocol-relative sources ("//cdn.example/x.jpg") are still common.
    url = new URL(input.startsWith('//') ? `https:${input}` : input);
  } catch {
    return null; // relative or malformed: no host, so nothing stable to compare
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  if (!IMAGE_EXTENSION.test(url.pathname)) return null;
  return `https://${url.host}${url.pathname}`;
}

/** Anything with a `//` authority is a link, not a place name. */
const URL_LIKE = /^(?:[a-z][a-z0-9+.-]*:)?\/\//i;

/**
 * A crumb's visible label, or undefined when the entry carries none.
 *
 * Order matters, and the obvious order is the wrong one. The documented
 * `ListItem` shape is `{name: "Paris", item: "https://…/paris"}` — the label is
 * on the ListItem and `item` is a bare URL — so reading `item` first turns a
 * breadcrumb trail into a list of URLs. That is not a cosmetic defect: Engine
 * A3 geocodes the second-to-last crumb, so a URL there spends a rate-limited
 * geocoder call on a string that names no place. A URL is therefore never
 * accepted as a label, whichever field it arrives in.
 */
function breadcrumbLabel(entry: unknown): string | undefined {
  if (typeof entry === 'string') return placeLabel(entry);
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return undefined;
  const listItem = entry as Node;
  const own = listItem['name'];
  if (typeof own === 'string') {
    const label = placeLabel(own);
    if (label !== undefined) return label;
  }
  // No ListItem name: fall back to `item`, which is a node with its own name on
  // the sites that nest one, and a bare URL (no label at all) on the rest.
  const item = listItem['item'];
  if (typeof item === 'string') return placeLabel(item);
  const nested = scalarOf(item);
  return nested === undefined ? undefined : placeLabel(nested);
}

function placeLabel(raw: string): string | undefined {
  const text = collapse(raw, BREADCRUMB_MAX_CHARS);
  return text && !URL_LIKE.test(text) ? text : undefined;
}

/**
 * Breadcrumbs from a schema.org `BreadcrumbList`, when the page publishes one.
 */
function breadcrumbs(doc: Document): string[] {
  const node = findJsonLdNode(doc, (_obj, types) => types.includes('BreadcrumbList'));
  const elements = node?.['itemListElement'];
  if (!Array.isArray(elements)) return [];
  const out: string[] = [];
  for (
    let i = 0;
    i < elements.length && i < BREADCRUMB_SCAN_CAP && out.length < BREADCRUMB_CAP;
    i++
  ) {
    const label = breadcrumbLabel(elements[i]);
    if (label !== undefined) out.push(label);
  }
  return out;
}

// ---------------------------------------------------------------------------
// the adapter
// ---------------------------------------------------------------------------

export const genericAdapter: SiteAdapter = {
  id: 'generic',
  // No brand to name: this adapter is whatever site the user is looking at.
  label: 'This page',

  capabilities: {
    // A generic URL is an opaque path. Claiming it bears the name would have
    // Engine A1 compare a slug that is not a name against the property title.
    nameBearingUrl: false,
    // No platform-internal town key is exposed by standard markup.
    destinationId: false,
    // Landmark blocks are bespoke UI; standard markup publishes none.
    nearbyLandmarks: false,
  },

  /**
   * Intentionally EMPTY.
   *
   * Match patterns become content-script host permissions, and this adapter
   * would need an all-URLs pattern to cover "any site" — an all-URLs permission on a
   * privacy extension, granted for pages that mostly are not listings at all.
   * The fallback earns its keep on pages a bespoke adapter's patterns already
   * cover (and, later, on hosts the user opts into explicitly). Broadening the
   * install-time permission is not a decision an adapter gets to make.
   */
  matchPatterns: [],

  /**
   * Always false: a URL alone never says whether a page carries lodging markup.
   * The registry calls `extractIdentity` on the document instead, and a null
   * there is how this adapter declines a page.
   */
  handles(): boolean {
    return false;
  },

  /**
   * Path-only canonical form.
   *
   * Known limitation, recorded here because it is invisible until it fires: on
   * a platform that keys listings by query parameter (`/property.php?id=1234`)
   * every listing collapses to one canonical URL, and `cdxPrefix` then matches
   * *other properties'* captures — so Engine B would diff this listing against
   * a stranger and call the difference a hijack. Stripping the query is still
   * right for the general case (dates, guests, currency and tracking params all
   * live there, and keeping them would make the archive prefix match nothing),
   * so the answer for such a platform is its own adapter, exactly as it is for
   * a platform whose markup misleads. Anyone enabling this adapter on a new
   * host should check where that host puts the listing id first.
   */
  canonicalize(url: URL): CanonicalListing | null {
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    // `host`, not `hostname`, so a non-default port survives; the URL parser
    // has already lowercased it. Query and fragment are session/tracking noise
    // and a trailing slash is a formatting choice, so both go.
    const host = url.host.toLowerCase();
    const path = url.pathname.replace(/\/+$/, '');
    if (host.length === 0) return null;
    return {
      platform: 'generic',
      canonicalUrl: `${url.protocol}//${host}${path}`,
      // Scheme-less, for archive `matchType=prefix` queries.
      cdxPrefix: `${host}${path}`,
      // No slug and no countryCode: a generic URL encodes neither, and an
      // invented one is worse than a missing one.
    };
  },

  extractIdentity(doc: Document, options?: ExtractOptions): IdentityVector | null {
    const lodging = readSchemaOrgLodging(doc);
    const ogTitle = metaContent(doc, 'og:title');
    // No lodging markup and no og:title means there is nothing here to read.
    // Returning null is how the registry decides not to claim the page.
    if (lodging === undefined && ogTitle === undefined) return null;

    const name = lodging?.name ?? (ogTitle ? collapse(ogTitle, NAME_MAX_CHARS) : undefined);
    // A vector with no name cannot be diffed or displayed; claiming the page
    // with an empty one would be worse than declining it.
    if (name === undefined || name === '') return null;

    const candidates: string[] = [];
    pushBounded(candidates, lodging?.images ?? [], IMAGE_CANDIDATE_CAP);
    const ogImage = metaContent(doc, 'og:image');
    if (ogImage !== undefined) candidates.push(ogImage);

    const seen = new Set<string>();
    const photoUrls: string[] = [];
    for (const candidate of candidates) {
      const normalized = normalizePhotoUrl(candidate);
      if (normalized && !seen.has(normalized)) {
        seen.add(normalized);
        photoUrls.push(normalized);
        if (photoUrls.length >= PHOTO_CAP) break;
      }
    }

    const vector: IdentityVector = {
      platform: 'generic',
      name,
      // Empty string, not a fabricated line: the address rules read "" as
      // nothing to compare rather than as an address that disagrees.
      address: lodging?.streetAddress ?? '',
      photoUrls,
      capturedAt: (options?.now?.() ?? new Date()).toISOString(),
      source: { kind: 'live' },
    };
    if (lodging?.listingId !== undefined) vector.listingId = lodging.listingId;
    if (lodging?.city !== undefined) vector.city = lodging.city;
    if (lodging?.country !== undefined) vector.country = lodging.country;
    if (lodging?.lat !== undefined) vector.lat = lodging.lat;
    if (lodging?.lng !== undefined) vector.lng = lodging.lng;
    if (lodging?.reviewCount !== undefined) vector.reviewCount = lodging.reviewCount;
    if (lodging?.reviewScore !== undefined) vector.reviewScore = lodging.reviewScore;
    if (lodging?.reviewScoreMax !== undefined) vector.reviewScoreMax = lodging.reviewScoreMax;
    if (lodging?.propertyType !== undefined) vector.propertyType = lodging.propertyType;
    return vector;
  },

  extractContext(doc: Document): PageContext {
    const lodging = readSchemaOrgLodging(doc);
    // `pois` stays empty on purpose. Landmark lists live in platform-specific
    // UI; there is no standard markup for them, and guessing at DOM shapes
    // would feed Engine A2 invented input. Reviews are different: schema.org
    // has `Review`, and reading it is the whole premise of this adapter.
    //
    // `availability` is `in-page` whatever this page turned out to contain —
    // this adapter does read individual reviews, so an empty list means the
    // page published none where standard markup puts them, not that we
    // declined to look.
    const summary = reviewSummary(lodging);
    const reviewSet: PageReviews = {
      availability: 'in-page',
      items: readSchemaOrgReviews(doc, lodging?.reviewScoreMax),
      ...(summary === undefined ? {} : { summary }),
    };
    const context: PageContext = {
      breadcrumbs: breadcrumbs(doc),
      pois: [],
      reviews: reviewTexts(reviewSet.items, REVIEWS_TEXT_TOTAL_MAX),
      reviewSet,
    };
    if (lodging?.description !== undefined) context.description = lodging.description;
    return context;
  },

  normalizePhotoUrl,
};
