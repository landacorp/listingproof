/**
 * Nominatim (OpenStreetMap) geocoder — the network half of Engine A2.
 *
 * A2 geocodes the address a listing claims plus the attractions the page itself
 * calls "nearby", and flags a median separation past 50 km. That makes this
 * module a supplier of *evidence*, and it is written accordingly:
 *
 * - It never throws. `geocode()` resolves to `null` for every failure — dead
 *   network, HTTP error, unparseable body, coordinates outside the WGS-84
 *   range. Engine A reads `null` as GRAY ("we could not check"), which is an
 *   honest answer; an exception escaping into the scorer would take down the
 *   whole verdict, including the deterministic rules that did work.
 * - It never invents a value. A row without usable coordinates or without the
 *   provider's own name for the match is dropped rather than patched up with a
 *   default, because every field here is shown in the evidence table as
 *   something the provider said.
 *
 * Nominatim's usage policy is a hard constraint rather than etiquette: it is
 * enforced by an operator, per source IP, with no appeals process, and the
 * failure mode is losing geocoding for every user behind that IP. Three rules
 * follow from it, and all three are load-bearing here — at most 1 request per
 * second (`lib/ratelimit.ts`, injected), identify the application (see
 * `NOMINATIM_REFERER`), and cache results rather than re-query (see
 * `CachedGeocode`).
 *
 * Wiring: the service worker must create ONE geocoder and share it. Each
 * instance that falls back to its own default limiter is a separate 1 req/s
 * budget, and two of them are a policy violation — inject a shared limiter if a
 * second instance is ever unavoidable.
 */
import type { Cache } from '../lib/cache';
import { createRateLimiter, type RateLimiter } from '../lib/ratelimit';
import type { Geocoder, GeocodeOptions, GeocodeResult } from '../lib/geocoder';

// `background/storage.ts` builds the geocode cache and imports the stored shape
// from here, so the module that owns the wire format also owns the export.
export type { GeocodeResult, GeocodeOptions } from '../lib/geocoder';

export const NOMINATIM_SEARCH_URL = 'https://nominatim.openstreetmap.org/search';

/**
 * 1000 ms between request starts.
 *
 * Exactly the policy number ("an absolute maximum of 1 request per second"), no
 * safety margin, because `lib/ratelimit.ts` spaces start-to-start and never
 * bursts: the far side sees one request per interval, not an average that a
 * burst could satisfy. A larger value would only make a page with six POIs
 * slower to score without buying any additional compliance.
 */
export const NOMINATIM_MIN_INTERVAL_MS = 1000;

/**
 * 1 result per query.
 *
 * A2 uses the top match only — it asks "where is the place this page named",
 * and a list of alternates would need a disambiguation rule this module has no
 * information to make. Fetching one row also keeps each response small, which
 * is the courteous half of the same policy.
 */
export const NOMINATIM_RESULT_LIMIT = 1;

/**
 * 10 s ceiling on a single request.
 *
 * Not a nicety: the limiter runs exactly one task at a time, so a request that
 * hangs forever holds the only slot and silently freezes every later geocode on
 * the page. Ten seconds is well past Nominatim's normal response time (tens of
 * ms) yet short enough that a stalled lookup degrades one POI row to GRAY
 * instead of stalling the panel.
 */
export const NOMINATIM_TIMEOUT_MS = 10_000;

/**
 * Application identifier sent with every request.
 *
 * The policy requires a Referer or User-Agent that identifies the application.
 * `User-Agent` cannot be set from extension code — Chrome owns it — so Referer
 * is the identifier available to us. Note that `Referer` is also on Fetch's
 * forbidden-header list, so the browser may drop it; when it does, the request
 * still carries `Origin: chrome-extension://<id>`, which identifies the
 * extension to the operator. Sending it is what this module can control, and
 * costs nothing when it is ignored.
 *
 * The `.invalid` TLD (RFC 2606) is deliberate: it says "placeholder" rather
 * than claiming a domain we do not own. Replace with the Web Store listing URL
 * at M8 — a *contactable* identifier is the point of the policy.
 */
export const NOMINATIM_REFERER = 'https://listingproof.invalid/chrome-extension';

/** WGS-84 latitude range. Anything outside it is a parse landing on a wrong field. */
export const NOMINATIM_MAX_ABS_LAT = 90;

/**
 * WGS-84 longitude range.
 *
 * Stricter than `lib/geo.ts`, which tolerates one antimeridian wrap (|lng| ≤
 * 360) because slippy-map code leaks 190-for-−170 into markup. Nothing
 * generates that here: this is a provider response in canonical form, so a
 * value past 180 is corruption, not a wrap.
 */
export const NOMINATIM_MAX_ABS_LNG = 180;

/**
 * Rows examined per response.
 *
 * We ask for one; scanning a few more covers a provider that ignores `limit`
 * without walking a response that has stopped making sense. Traversals over
 * structures we did not author are capped as a matter of house style
 * (DECISIONS.md M1) — the parse has already allocated the array, so this only
 * bounds the work, but an uncapped loop over a hostile body is a habit worth
 * not having.
 */
export const NOMINATIM_MAX_SCANNED_ROWS = 4;

/**
 * 512 characters of provider name.
 *
 * `display_name` is the full administrative hierarchy ("Tour Eiffel, Avenue
 * Gustave Eiffel, Quartier du Gros-Caillou, …, France") and tops out near 250
 * characters in practice, so 512 is roughly double the longest real answer —
 * comfortably inside the range where a rejection cannot cost a legitimate
 * lookup.
 *
 * The cap exists because this string is written to a *permanent* entry in a
 * ~10 MB storage area shared with every other feature: one oversized response
 * cached forever is a quota failure that outlives the request that caused it,
 * and it is also rendered verbatim in the evidence panel. Over-long rows are
 * dropped rather than truncated — this module's rule is that a value it cannot
 * trust becomes a GRAY, never a repaired half-quote attributed to the provider.
 */
export const NOMINATIM_MAX_DISPLAY_NAME_LENGTH = 512;

/** ISO 3166-1 alpha-2, the only shape Nominatim's `countrycodes` accepts. */
const ISO_3166_1_ALPHA_2 = /^[a-z]{2}$/;

/**
 * Cache-key segment standing in for "no country hint".
 *
 * `*` is not a valid ISO-2 code, so a hinted lookup can never collide with an
 * unhinted one — they are different questions with legitimately different
 * answers ("Bellevue" in Italy vs "Bellevue" anywhere).
 */
const ANY_COUNTRY_KEY = '*';

export interface NominatimOptions {
  /** Injectable `fetch` for tests. Defaults to the global. */
  fetchImpl?: typeof fetch;
  /**
   * Permanent geocode cache (`createGeocodeCache()` in `background/storage.ts`,
   * `ttlMs: null`). Optional so this module stays free of `chrome.*` and unit-
   * testable; omitting it means every lookup goes to the network, which is a
   * test-only mode.
   */
  cache?: Cache<GeocodeResult>;
  /** Shared 1 req/s limiter. Defaults to a private one — see the module note. */
  limiter?: RateLimiter;
}

/**
 * What is actually stored, which is not simply a `GeocodeResult`.
 *
 * A landmark Nominatim cannot resolve — a hotel's invented "beach club", a POI
 * name mangled by the extractor — is a *stable* property of the query text, and
 * re-asking on every page view spends the 1 req/s budget to be told the same
 * thing. So absence is recorded explicitly, and the two states stay distinct:
 * `{found: false}` is "asked, answered, no such place" (return `null` without a
 * request), whereas *no entry at all* is "never asked" (go and ask). Collapsing
 * them either way is a bug — one re-queries forever, the other would let a
 * storage gap masquerade as an answer.
 *
 * Permanence is inherited from the injected cache (`ttlMs: null`). For a hit
 * that is obviously right, coordinates do not move. For a miss it means a place
 * OSM adds later stays unknown to us until the cache envelope version bumps —
 * accepted, because the cost is one GRAY evidence row, never a wrong verdict.
 */
type CachedGeocode = { readonly found: true; readonly result: GeocodeResult } | { readonly found: false };

/**
 * Outcome of one live lookup, split by what the answer is *about*:
 *
 * - `hit`    — usable coordinates.
 * - `absent` — Nominatim answered, and its answer was "no such place". A fact
 *              about the place; safe to remember.
 * - `failed` — we never got an interpretable answer: transport died, HTTP
 *              error, body that is not a JSON array, rows we cannot read. A
 *              fact about our connection to the provider, which says nothing
 *              about the place. Caching it would let one bad minute of
 *              connectivity blind this landmark for the life of the profile, so
 *              `failed` is never written.
 */
type LookupOutcome =
  | { kind: 'hit'; result: GeocodeResult }
  | { kind: 'absent' }
  | { kind: 'failed' };

/**
 * Coordinate from a provider or storage value, or `undefined` if unusable.
 *
 * `jsonv2` sends `lat`/`lon` as strings; a stored `GeocodeResult` holds numbers.
 * Both are accepted, everything else is rejected rather than coerced —
 * `Number(null)` is 0 and `Number('')` is 0, so the one input that must not
 * silently succeed is the empty one, which would fabricate a confident null-
 * island coordinate 5000 km from any real answer and turn a missing field into
 * a 50 km A2 flag.
 */
function parseCoordinate(raw: unknown, maxAbs: number): number | undefined {
  let value: number;
  if (typeof raw === 'number') {
    value = raw;
  } else if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (trimmed === '') return undefined;
    value = Number(trimmed);
  } else {
    return undefined;
  }
  if (!Number.isFinite(value) || Math.abs(value) > maxAbs) return undefined;
  return value;
}

/** `importance` is optional evidence: keep it only when it is a real number. */
function parseImportance(raw: unknown): number | undefined {
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : undefined;
}

/**
 * Build a result from an object with caller-supplied field names, so the same
 * validation covers both the wire row (`lat`/`lon`/`display_name`) and a value
 * read back from storage (`lat`/`lng`/`displayName`).
 *
 * A missing, empty or over-long name (see `NOMINATIM_MAX_DISPLAY_NAME_LENGTH`)
 * rejects the whole row even though the coordinates may be fine. The panel
 * presents `displayName` as *the provider's* name for what it matched, and
 * echoing the query back in that slot would show the user their own claim
 * dressed as corroboration — the exact failure this extension exists to catch.
 * Dropping the row costs a GRAY; inventing the label costs the truth.
 */
function buildResult(
  raw: unknown,
  fields: { readonly lng: string; readonly name: string },
): GeocodeResult | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
  const row = raw as Record<string, unknown>;

  const lat = parseCoordinate(row.lat, NOMINATIM_MAX_ABS_LAT);
  const lng = parseCoordinate(row[fields.lng], NOMINATIM_MAX_ABS_LNG);
  if (lat === undefined || lng === undefined) return undefined;

  const rawName = row[fields.name];
  const displayName = typeof rawName === 'string' ? rawName.trim() : '';
  if (displayName === '' || displayName.length > NOMINATIM_MAX_DISPLAY_NAME_LENGTH) return undefined;

  const importance = parseImportance(row.importance);
  // Built conditionally so an absent `importance` is absent from the cached
  // JSON too, rather than persisted as an explicit `undefined`.
  return importance === undefined ? { lat, lng, displayName } : { lat, lng, displayName, importance };
}

const readWireRow = (raw: unknown): GeocodeResult | undefined =>
  buildResult(raw, { lng: 'lon', name: 'display_name' });

const readStoredResult = (raw: unknown): GeocodeResult | undefined =>
  buildResult(raw, { lng: 'lng', name: 'displayName' });

/**
 * Decode a stored entry into the tri-state the caller needs:
 * `undefined` = nothing usable on record (ask the network),
 * `{hit: null}` = a recorded absence (answer `null`, ask nobody),
 * `{hit: result}` = a recorded place.
 *
 * Unrecognised shapes read as `undefined`. `lib/cache.ts` deliberately does not
 * validate values against its generic, and this store is shared, versioned and
 * long-lived, so a shape check here is the only thing standing between an old
 * build's entry and a `NaN` reaching the distance rule.
 */
function decodeCacheEntry(raw: unknown): { hit: GeocodeResult | null } | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
  const entry = raw as Record<string, unknown>;
  if (entry.found === false) return { hit: null };
  if (entry.found !== true) return undefined;
  const result = readStoredResult(entry.result);
  return result === undefined ? undefined : { hit: result };
}

/**
 * Cache key: country hint + normalized query.
 *
 * Case and inner whitespace are normalized because Nominatim ignores both, so
 * folding them raises the hit rate — i.e. cuts requests — without ever merging
 * two questions that could have different answers. Nothing else is stripped:
 * diacritics and scripts are part of the query the provider will see.
 */
function cacheKeyFor(query: string, countryCode: string | null): string {
  return `${countryCode ?? ANY_COUNTRY_KEY}|${query.toLowerCase().replace(/\s+/gu, ' ')}`;
}

/** Cache reads never fail a lookup: an unreadable cache is a cache miss. */
async function readCache(
  store: Cache<CachedGeocode> | undefined,
  key: string,
): Promise<{ hit: GeocodeResult | null } | undefined> {
  if (store === undefined) return undefined;
  try {
    return decodeCacheEntry(await store.get(key));
  } catch {
    return undefined;
  }
}

/**
 * Cache writes never fail a lookup either. `Cache.set` propagates storage
 * errors by design (a quota failure is real information), but the caller here
 * already has its answer, and losing a good geocode to a full disk would be a
 * worse outcome than a cache that silently did not persist.
 */
async function writeCache(
  store: Cache<CachedGeocode> | undefined,
  key: string,
  entry: CachedGeocode,
): Promise<void> {
  if (store === undefined) return;
  try {
    await store.set(key, entry);
  } catch {
    // Deliberately ignored — see above.
  }
}

/**
 * One live request. Every throw is contained: `fetch` rejects on a dead
 * network, `json()` rejects on a captive-portal HTML page, and a hostile
 * `fetchImpl` may return something that is not a `Response` at all.
 */
async function lookup(
  doFetch: typeof fetch,
  query: string,
  countryCode: string | null,
): Promise<LookupOutcome> {
  try {
    const url = new URL(NOMINATIM_SEARCH_URL);
    // `URLSearchParams` percent-encodes UTF-8, so non-Latin POI names
    // ("Ακρόπολη Αθηνών", "東京タワー") reach the provider intact.
    url.searchParams.set('q', query);
    url.searchParams.set('format', 'jsonv2');
    url.searchParams.set('limit', String(NOMINATIM_RESULT_LIMIT));
    if (countryCode !== null) url.searchParams.set('countrycodes', countryCode);

    const response = await doFetch(url.toString(), {
      headers: { Accept: 'application/json', Referer: NOMINATIM_REFERER },
      // Created here rather than before the queue wait, so the budget covers the
      // request and not the up-to-N-seconds spent waiting for a rate-limit slot.
      signal: AbortSignal.timeout(NOMINATIM_TIMEOUT_MS),
    });

    if (!response.ok) return { kind: 'failed' };

    const body: unknown = await response.json();
    // The empty array is Nominatim's own "no such place" and the only answer
    // this module is willing to remember. Anything else it cannot read — a
    // non-array body, rows missing the fields we need — could equally be
    // protocol drift, and caching that verdict would poison every key in the
    // namespace at once instead of costing one repeated request.
    if (!Array.isArray(body)) return { kind: 'failed' };
    if (body.length === 0) return { kind: 'absent' };

    for (const row of body.slice(0, NOMINATIM_MAX_SCANNED_ROWS)) {
      const result = readWireRow(row);
      if (result !== undefined) return { kind: 'hit', result };
    }
    return { kind: 'failed' };
  } catch {
    return { kind: 'failed' };
  }
}

export function createNominatimGeocoder(options: NominatimOptions = {}): Geocoder {
  const doFetch: typeof fetch = options.fetchImpl ?? ((input, init) => fetch(input, init));
  const limiter =
    options.limiter ?? createRateLimiter({ minIntervalMs: NOMINATIM_MIN_INTERVAL_MS });

  // `lib/cache.ts` performs no runtime validation of its generic, so widening
  // the injected `Cache<GeocodeResult>` to the union actually stored is a
  // compile-time fiction with no runtime effect. The declared type stays
  // `Cache<GeocodeResult>` because that is what the storage layer builds and
  // what callers understand the cache to hold; `decodeCacheEntry` validates
  // every read regardless, which a shared storage area requires anyway.
  const store = options.cache as unknown as Cache<CachedGeocode> | undefined;

  return {
    async geocode(query: string, geocodeOptions?: GeocodeOptions): Promise<GeocodeResult | null> {
      // Typed `string`, but A2's POI names can originate in Engine L, whose
      // output PLAN.md classifies as untrusted — a runtime shape check here
      // costs one comparison and keeps `undefined.trim()` out of the scorer.
      const trimmed = typeof query === 'string' ? query.trim() : '';
      // An empty landmark name is an extraction gap, not a place. Asking
      // Nominatim `q=` spends a slot from a 1 req/s budget to be told nothing.
      if (trimmed === '') return null;

      const rawCountry = geocodeOptions?.countryCode;
      let countryCode: string | null = null;
      if (rawCountry !== undefined) {
        if (typeof rawCountry !== 'string') return null;
        const candidate = rawCountry.trim().toLowerCase();
        // Empty means the extractor found no country — the same information as
        // omitting the field, so it is treated the same way: search worldwide.
        if (candidate !== '') {
          // A malformed hint ("USA", "gb-eng", "12") is a claim we cannot
          // honour. Dropping it silently would widen the search to every
          // country, and a same-named landmark on another continent is exactly
          // how A2 manufactures a false RED on a legitimate listing. Returning
          // null costs one GRAY evidence row and never a wrong verdict.
          if (!ISO_3166_1_ALPHA_2.test(candidate)) return null;
          countryCode = candidate;
        }
      }

      const key = cacheKeyFor(trimmed, countryCode);

      // Before the limiter, deliberately: a cached answer must cost neither a
      // request nor a second of queue delay, for a hit and for a recorded
      // absence alike.
      const cached = await readCache(store, key);
      if (cached !== undefined) return cached.hit;

      try {
        // The whole read-fetch-write cycle runs inside the slot, and the write
        // completes before the slot is released. An identical query that queued
        // behind this one then re-reads the cache on admission and finds the
        // answer already there, so it spends the queue slot it had already
        // waited for but not a request. Writing after `run()` resolved would
        // leave that ordering to microtask luck: with a short interval the next
        // slot can open while our write is still in flight, and the duplicate
        // would go to the network for an answer we already hold.
        return await limiter.run(async (): Promise<GeocodeResult | null> => {
          const late = await readCache(store, key);
          if (late !== undefined) return late.hit;

          const outcome = await lookup(doFetch, trimmed, countryCode);
          switch (outcome.kind) {
            case 'hit':
              await writeCache(store, key, { found: true, result: outcome.result });
              return outcome.result;
            case 'absent':
              await writeCache(store, key, { found: false });
              return null;
            default:
              // `failed` is a fact about our connection, not about the place —
              // never written. See `LookupOutcome`.
              return null;
          }
        });
      } catch {
        // The limiter rejects when it could not take the delay it owes; it
        // fails closed rather than fire early, and so do we. Nothing inside the
        // task can reject — `lookup` and both cache helpers contain their own
        // failures — so this only ever catches the limiter itself.
        return null;
      }
    },
  };
}
