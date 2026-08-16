/**
 * Live-page identity extractor for Booking.com property pages.
 *
 * Pure module: takes a `Document` (real DOM in the content script, jsdom in
 * tests), returns an IdentityVector or null when the document is not a
 * property page. No browser APIs, no network.
 *
 * Extractor chain (PLAN.md): JSON-LD → og:/meta → `b_hotel_id`/utag regex →
 * DOM anchors. Each field takes the first source in that order that yields a
 * usable value; fields no source yields stay undefined (GRAY input — the
 * scorer must treat missing as "unknown", never "ok").
 *
 * Source quirks this module encodes (verified against fixtures/live/, 12
 * pages, 10 locales, 2026-08):
 * - JSON-LD `@type: "Hotel"` is present on every page but carries no `geo`;
 *   `streetAddress` holds the FULL localized address line, while
 *   `addressLocality` holds the street — so addressLocality is never used.
 * - `@type` is "Hotel" regardless of the actual property type, so it is
 *   useless as a propertyType signal; `accommodation_type_id` in page JS is
 *   the discriminating value.
 * - Coordinates live in `b_map_center_latitude/longitude` script vars and in
 *   `data-atlas-latlng="lat,lng"` DOM attributes.
 * - `utag_data` has clean `city_name`, `dest_cc` (ISO country), `hotel_id`,
 *   `hotel_name`.
 */
import type { IdentityVector } from '../../identity';

export interface ExtractOptions {
  /** Injectable clock for deterministic tests. */
  now?: () => Date;
}

const PHOTO_CAP = 60;
/** Bounds on attacker-controlled structures. Page content is hostile input:
 *  every unbounded traversal is a denial-of-service on the content script. */
const CANDIDATE_CAP = 5000;
const LD_NODE_CAP = 1000;
const OG_TITLE_CAP = 300;
const TITLE_STRIP_ITERATIONS = 8;

/** JSON-LD types we accept as "this page describes lodging". */
const LODGING_TYPES = new Set([
  'Hotel', 'Hostel', 'Motel', 'Resort', 'BedAndBreakfast', 'Apartment',
  'House', 'VacationRental', 'LodgingBusiness', 'Campground',
]);

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function scriptTexts(doc: Document): string[] {
  return Array.from(doc.querySelectorAll('script:not([type="application/ld+json"])'))
    .map((s) => s.textContent ?? '')
    .filter((t) => t.length > 0);
}

/** First capture group of `re` across script bodies, else undefined. */
function matchScripts(scripts: string[], re: RegExp): string | undefined {
  for (const text of scripts) {
    const m = re.exec(text);
    if (m?.[1] !== undefined) return m[1];
  }
  return undefined;
}

/**
 * utag_data-style single-quoted value with backslash escapes:
 * `city_name: 'L\'Aquila'`. Returns the unescaped string.
 */
function utagString(scripts: string[], key: string): string | undefined {
  const raw = matchScripts(scripts, new RegExp(`${key}\\s*:\\s*'((?:\\\\.|[^'\\\\])*)'`));
  return raw?.replace(/\\(.)/g, '$1').trim() || undefined;
}

/**
 * Append at most `cap - target.length` items. Never uses `...spread`: spreading
 * an attacker-sized array throws RangeError (call-stack overflow) well before
 * any downstream length check runs.
 */
function pushBounded<T>(target: T[], source: readonly T[], cap: number): void {
  for (let i = 0; i < source.length && target.length < cap; i++) target.push(source[i]);
}

interface JsonLdHotel {
  name?: unknown;
  address?: { streetAddress?: unknown; addressCountry?: unknown };
  aggregateRating?: { ratingValue?: unknown; reviewCount?: unknown };
  image?: unknown;
  geo?: { latitude?: unknown; longitude?: unknown };
}

/** First JSON-LD object on the page whose @type is a lodging type. */
function findJsonLdHotel(doc: Document): JsonLdHotel | undefined {
  for (const script of Array.from(doc.querySelectorAll('script[type="application/ld+json"]'))) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(script.textContent ?? '');
    } catch {
      continue; // attacker-authored or truncated markup must never throw
    }
    // Bounded queue: `...spread` of an attacker-sized array throws RangeError,
    // and an unbounded @graph walk is a hang. Both must degrade, not crash.
    const queue: unknown[] = [];
    pushBounded(queue, Array.isArray(parsed) ? parsed : [parsed], LD_NODE_CAP);
    for (const node of queue) {
      if (typeof node !== 'object' || node === null) continue;
      const obj = node as Record<string, unknown>;
      if (Array.isArray(obj['@graph'])) pushBounded(queue, obj['@graph'], LD_NODE_CAP);
      const type = obj['@type'];
      const types = Array.isArray(type) ? type : [type];
      if (types.some((t) => typeof t === 'string' && LODGING_TYPES.has(t))) {
        return obj as JsonLdHotel;
      }
    }
  }
  return undefined;
}

function asString(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined;
}

/**
 * Numeric coercion that treats "absent" as absent. `Number('')` and
 * `Number('  ')` are 0, which would silently turn a missing coordinate into
 * null island (0,0) and a missing review count into a real-looking 0 — hard
 * defaults on missing data, exactly what the GRAY contract forbids.
 */
function asFiniteNumber(v: unknown): number | undefined {
  if (typeof v === 'string' && v.trim() === '') return undefined;
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : undefined;
}

function metaContent(doc: Document, property: string): string | undefined {
  return asString(doc.querySelector(`meta[property="${property}"]`)?.getAttribute('content'));
}

/**
 * Derive a property name from og:title. Booking appends marketing suffixes:
 *   "Warwick New York, New York (updated prices 2026)"
 *   "Shibuya Excel Hotel Tokyu（東京）：（最新料金：2026年）"
 * Strip trailing parentheticals (ASCII and fullwidth) and separators, then a
 * trailing ", <city>" when the city is independently known.
 */
export function nameFromOgTitle(ogTitle: string, city?: string): string | undefined {
  // og:title is unbounded attacker-controlled meta content, and the strip loop
  // below rescans from the start each pass — O(n²) in trailing parentheticals.
  // A crafted title would freeze the content script's main thread (extraction
  // never completes = no verdict, a free evasion). Bound both dimensions; an
  // absurd title is not a name, so the caller falls through to the next source.
  if (ogTitle.length > OG_TITLE_CAP) return undefined;
  let name = ogTitle.trim();
  const trailing = /[\s:：,，-]*[(（][^()（）]*[)）]\s*$/;
  for (let i = 0; i < TITLE_STRIP_ITERATIONS && trailing.test(name); i++) {
    name = name.replace(trailing, '');
  }
  name = name.replace(/[\s:：,，-]+$/, '');
  if (city) {
    const suffix = new RegExp(`[,，]\\s*${escapeRegExp(city)}$`);
    name = name.replace(suffix, '').trim();
  }
  return name || undefined;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Canonical form for a Booking photo URL. The stable identity is the numeric
 * asset id; host (cf/q-xx/r-xx.bstatic.com), size segment (max500, 608x352…),
 * format (jpg/webp) and query params are delivery details that differ between
 * sources for the same photo. Non-photo URLs → null.
 */
export function normalizePhotoUrl(url: string): string | null {
  const m = /\/xdata\/images\/hotel\/(?:[^/?#]+\/)?(\d+)\.(?:jpe?g|png|webp|avif|gif)/i.exec(url);
  return m ? `https://cf.bstatic.com/xdata/images/hotel/${m[1]}.jpg` : null;
}

/**
 * Property gallery URLs from the `hotelPhotos: [{large_url: '…'}, …]` script
 * blob. Scoped to the slice after the marker so photo URLs of recommended
 * nearby properties elsewhere in page JS cannot leak into the vector.
 */
function galleryPhotoUrls(scripts: string[]): string[] {
  for (const text of scripts) {
    const start = text.indexOf('hotelPhotos');
    if (start === -1) continue;
    const slice = text.slice(start);
    const urls: string[] = [];
    for (const m of slice.matchAll(/large_url\s*:\s*'((?:\\.|[^'\\])*)'/g)) {
      urls.push(m[1].replace(/\\(.)/g, '$1'));
      if (urls.length >= PHOTO_CAP) break;
    }
    if (urls.length > 0) return urls;
  }
  return [];
}

function collectPhotoUrls(doc: Document, scripts: string[], jsonLd: JsonLdHotel | undefined): string[] {
  const candidates: string[] = [];
  const ldImage = jsonLd?.image;
  if (typeof ldImage === 'string') candidates.push(ldImage);
  if (Array.isArray(ldImage)) {
    pushBounded(candidates, ldImage.filter((u): u is string => typeof u === 'string'), CANDIDATE_CAP);
  }
  const og = metaContent(doc, 'og:image');
  if (og) candidates.push(og);
  pushBounded(candidates, galleryPhotoUrls(scripts), CANDIDATE_CAP);
  for (const img of Array.from(doc.querySelectorAll('img'))) {
    if (candidates.length >= CANDIDATE_CAP) break;
    const src = img.getAttribute('src');
    if (src) candidates.push(src);
  }

  const seen = new Set<string>();
  const urls: string[] = [];
  for (const candidate of candidates) {
    const normalized = normalizePhotoUrl(candidate);
    if (normalized && !seen.has(normalized)) {
      seen.add(normalized);
      urls.push(normalized);
      if (urls.length >= PHOTO_CAP) break;
    }
  }
  return urls;
}

function parseLatLng(lat: unknown, lng: unknown): { lat: number; lng: number } | undefined {
  const la = asFiniteNumber(lat);
  const ln = asFiniteNumber(lng);
  if (la === undefined || ln === undefined) return undefined;
  if (Math.abs(la) > 90 || Math.abs(ln) > 180) return undefined;
  return { lat: la, lng: ln };
}

function coordinates(doc: Document, scripts: string[], jsonLd: JsonLdHotel | undefined):
  { lat: number; lng: number } | undefined {
  // JSON-LD geo first per chain order (absent on Booking today, but archives
  // and future markup may carry it).
  const fromLd = parseLatLng(jsonLd?.geo?.latitude, jsonLd?.geo?.longitude);
  if (fromLd) return fromLd;

  const NUM = /['"]?(-?\d+(?:\.\d+)?)/.source;
  const lat = matchScripts(scripts, new RegExp(`b_map_center_latitude\\s*[:=]\\s*${NUM}`));
  const lng = matchScripts(scripts, new RegExp(`b_map_center_longitude\\s*[:=]\\s*${NUM}`));
  const fromScripts = parseLatLng(lat, lng);
  if (fromScripts) return fromScripts;

  const atlas = doc.querySelector('[data-atlas-latlng]')?.getAttribute('data-atlas-latlng');
  if (atlas) {
    const [a, b] = atlas.split(',');
    return parseLatLng(a, b);
  }
  return undefined;
}

function domName(doc: Document): string | undefined {
  return asString(doc.querySelector('.pp-header__title, #hp_hotel_name h2')?.textContent);
}

/**
 * Address from the page header, for when JSON-LD is absent (archive snapshots,
 * markup drift). The header wrapper's first non-empty text node is the address;
 * everything after it is location-score UI ("Excellent location – rated 9.6/10!").
 *
 * Walked structurally rather than by selector: the wrapper's inner class names
 * are build-hashed (`a297f43545`) and the address sits in a bare text node, so
 * there is no stable element to target. Verified first-text-node == JSON-LD
 * streetAddress on 11/12 fixtures (the 12th, ja, differs only by an extra
 * locality token). Markup is minified — no newlines to split on.
 */
function domAddress(doc: Document): string | undefined {
  const wrapper = doc.querySelector('[data-testid="PropertyHeaderAddressDesktop-wrapper"]');
  if (!wrapper) return undefined;

  const stack: Node[] = [wrapper];
  let visited = 0;
  while (stack.length > 0 && visited < 2000) {
    const node = stack.shift()!;
    visited++;
    if (node.nodeType === 3 /* TEXT_NODE */) {
      const text = (node.textContent ?? '').trim();
      if (text) return text;
      continue;
    }
    // Unshift children in order so the walk stays depth-first, left-to-right.
    stack.unshift(...Array.from(node.childNodes).slice(0, 200));
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// main entry
// ---------------------------------------------------------------------------

export function extractLiveIdentity(doc: Document, opts: ExtractOptions = {}): IdentityVector | null {
  const jsonLd = findJsonLdHotel(doc);
  const scripts = scriptTexts(doc);

  const listingId =
    matchScripts(scripts, /b_hotel_id\s*[:=]\s*['"]?(\d+)/) ??
    matchScripts(scripts, /\bhotel_id\s*:\s*'(\d+)'/);
  const domTitle = domName(doc);

  // Property-page gate: og:title alone is not evidence (search pages have it
  // too). Require at least one property-specific carrier.
  if (!jsonLd && listingId === undefined && domTitle === undefined) return null;

  const city = utagString(scripts, 'city_name');
  const destCc = utagString(scripts, 'dest_cc')?.toLowerCase();
  // `ufi` is the locale-invariant destination key. Verified across the fixture
  // corpus: the two Rimini captures (it, en-us) both read -126373 and the two
  // Paris captures (fr, en-gb) both read -1456928, while their `city_name`
  // strings differ. Signed, so the leading minus is part of the value.
  const destinationId = matchScripts(scripts, /\bufi\s*:\s*'(-?\d+)'/)
    ?? matchScripts(scripts, /\bufi\s*:\s*(-?\d+)/);

  const ogTitle = metaContent(doc, 'og:title');
  const name =
    asString(jsonLd?.name) ??
    (ogTitle ? nameFromOgTitle(ogTitle, city) : undefined) ??
    utagString(scripts, 'hotel_name') ??
    domTitle;
  if (name === undefined) return null;

  const address = asString(jsonLd?.address?.streetAddress) ?? domAddress(doc) ?? '';

  const country =
    (destCc && /^[a-z]{2}$/.test(destCc) ? destCc : undefined) ??
    asString(jsonLd?.address?.addressCountry);

  const geo = coordinates(doc, scripts, jsonLd);

  const reviewScore = asFiniteNumber(jsonLd?.aggregateRating?.ratingValue);
  const rawCount = asFiniteNumber(jsonLd?.aggregateRating?.reviewCount);
  const reviewCount = rawCount !== undefined && Number.isInteger(rawCount) && rawCount >= 0
    ? rawCount
    : undefined;

  const typeId = matchScripts(scripts, /accommodation_type_id\s*[:=]\s*['"]?(\d+)/);

  const vector: IdentityVector = {
    name,
    address,
    photoUrls: collectPhotoUrls(doc, scripts, jsonLd),
    capturedAt: (opts.now?.() ?? new Date()).toISOString(),
    source: { kind: 'live' },
  };
  if (listingId !== undefined) vector.listingId = listingId;
  if (city !== undefined) vector.city = city;
  if (destinationId !== undefined) vector.destinationId = destinationId;
  if (country !== undefined) vector.country = country;
  if (geo) { vector.lat = geo.lat; vector.lng = geo.lng; }
  if (reviewCount !== undefined) vector.reviewCount = reviewCount;
  if (reviewScore !== undefined) vector.reviewScore = reviewScore;
  if (typeId !== undefined) vector.propertyType = `bkg:${typeId}`;

  return vector;
}
