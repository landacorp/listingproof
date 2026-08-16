/**
 * Namespaced, TTL-aware cache over an injectable key-value store.
 *
 * Two very different callers share one physical store (`chrome.storage.local`
 * in the extension, an in-memory map in tests):
 * - Wayback CDX responses — 7-day TTL, because archive coverage grows.
 * - Nominatim geocodes — `ttlMs: null`, permanent: a street address does not
 *   move, and Nominatim's usage policy asks that results be cached forever
 *   rather than re-queried.
 *
 * Design notes:
 * - `chrome.storage.local` is a flat namespace shared by every feature of the
 *   extension and has no per-key expiry, so both concerns are handled here:
 *   keys are prefixed per cache, and each write is wrapped in an envelope that
 *   records when it happened.
 * - The `StorageArea` interface exists so this module stays pure — no
 *   `chrome.*`, no globals — and unit-tests under Vitest's node environment.
 *   The `chrome.storage.local` adapter lives elsewhere.
 * - Values are not validated against `T` on read: a runtime type check for an
 *   arbitrary generic is not expressible, and the extension is the only writer.
 *   The envelope's version tag is the migration lever instead — bump it and
 *   every older entry reads as a miss, which is exactly the desired behaviour
 *   when the cached shape changes.
 */

/**
 * The slice of `chrome.storage.local` this cache needs.
 * `get` resolves to a bag keyed by the requested key, `{}` when absent —
 * matching Chrome's own contract, so the adapter is a one-liner.
 *
 * Implementations must hand back snapshots, not live references: Chrome
 * structured-clones across the extension message boundary in both directions,
 * and this module adds no copying of its own, so an in-memory adapter that
 * skipped cloning would let a caller mutate another caller's cached value.
 */
export interface StorageArea {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(key: string): Promise<void>;
}

export interface CacheOptions {
  /** Distinguishes this cache's keys from every other writer's. */
  namespace: string;
  /**
   * Entry lifetime in milliseconds; `null` = never expires. Must be finite and
   * >= 0 — `null` is the only spelling of "permanent" this module accepts.
   */
  ttlMs: number | null;
  storage: StorageArea;
  /** Injectable clock for deterministic tests. Defaults to `Date.now`. */
  now?: () => number;
}

export interface Cache<T> {
  get(key: string): Promise<T | undefined>;
  set(key: string, value: T): Promise<void>;
  delete(key: string): Promise<void>;
}

/**
 * Bump when the envelope shape changes. Old entries then fail validation and
 * read as misses, which self-heals on the next write — no migration code.
 */
const ENVELOPE_VERSION = 1;

/** Marks every key this module owns inside the shared storage area. */
const KEY_PREFIX = 'lp';

/** Field names are terse because `storage.local` is quota-bounded (~10 MB). */
interface Envelope {
  v: number;
  value: unknown;
  storedAt: number;
}

/**
 * `lp:<encoded namespace>:<key>`.
 *
 * Only the namespace is percent-encoded, which is enough to make the mapping
 * injective: an encoded namespace can never contain ':', so the second
 * separator is unambiguous and namespace `a` + key `b:c` cannot collide with
 * namespace `a:b` + key `c`. Keys are left raw — they are long already (URLs,
 * full addresses) and encoding them would inflate every entry for no gain.
 */
function storageKeyFor(namespace: string, key: string): string {
  return `${KEY_PREFIX}:${encodeURIComponent(namespace)}:${key}`;
}

/**
 * Accept a stored record only if it is unmistakably one of ours.
 *
 * Storage is shared and long-lived: it may hold values written by an older (or
 * newer) build of the extension, or by a different feature that picked a
 * colliding key. Anything unrecognised must read as a miss rather than throw —
 * a cache that can crash the caller is worse than no cache.
 */
function readEnvelope(raw: unknown): Envelope | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
  const record = raw as Record<string, unknown>;
  if (record.v !== ENVELOPE_VERSION) return undefined;
  const storedAt = record.storedAt;
  if (typeof storedAt !== 'number' || !Number.isFinite(storedAt)) return undefined;
  // `value` may legitimately be null or false, so presence is the test, not truthiness.
  if (!('value' in record)) return undefined;
  return { v: ENVELOPE_VERSION, value: record.value, storedAt };
}

export function createCache<T>(options: CacheOptions): Cache<T> {
  const { namespace, ttlMs, storage } = options;

  // Reject a nonsense TTL at construction rather than inherit NaN's comparison
  // semantics: every comparison against NaN is false, so a `ttlMs` that arrived
  // as NaN (a unit conversion over a missing config value, `Number(undefined)`)
  // would turn the 7-day CDX cache into a permanent one and keep serving
  // archive answers that stopped being true months ago — the freshness
  // equivalent of asserting agreement we never checked. `Infinity` is rejected
  // for a different reason: `null` already means "never expires", and a second
  // spelling only ever arrives here by accident (a division by zero), where it
  // would read as intent.
  if (ttlMs !== null && (!Number.isFinite(ttlMs) || ttlMs < 0)) {
    throw new RangeError(
      `createCache(${namespace}): ttlMs must be null or a finite number >= 0, got ${String(ttlMs)}`,
    );
  }

  const now = options.now ?? Date.now;

  /**
   * An entry written at `storedAt` is valid for the half-open window
   * [storedAt, storedAt + ttlMs): a 7-day TTL means seven days, and the entry
   * is already stale at exactly the boundary.
   *
   * Skew is tolerated symmetrically, up to one TTL in either direction. A
   * `storedAt` slightly in the future (system clock corrected backwards,
   * profile synced from a machine running fast) keeps its entry, because
   * treating skew as expiry would wipe the cache on every backwards jump and a
   * too-fresh entry costs at most one stale CDX answer.
   *
   * Beyond a full TTL the timestamp carries no usable information, and the two
   * errors are not symmetric there: an entry dated far in the future would be
   * fresh forever *and* immortal, since lazy eviction only ever fires on an
   * entry that has expired. One corrupt write would pin a stale answer in a
   * TTL'd cache for the life of the profile, so past that point the entry is
   * discarded and refetched.
   */
  function isExpired(storedAt: number): boolean {
    if (ttlMs === null) return false;
    return Math.abs(now() - storedAt) >= ttlMs;
  }

  /** Best-effort eviction: housekeeping must never fail the read it rides on. */
  async function evict(storageKey: string): Promise<void> {
    try {
      await storage.remove(storageKey);
    } catch {
      // Ignored deliberately: the caller asked for a value, not for a cleanup
      // guarantee. The entry stays expired and will be evicted on a later read.
    }
  }

  return {
    async get(key: string): Promise<T | undefined> {
      const storageKey = storageKeyFor(namespace, key);
      let raw: unknown;
      try {
        const bag = await storage.get(storageKey);
        raw = bag[storageKey];
      } catch {
        // A storage failure is reported as a miss, never rethrown: a miss is
        // always a safe answer (the caller refetches), whereas an exception
        // would take down a verdict over a failed optimisation.
        return undefined;
      }

      const envelope = readEnvelope(raw);
      if (envelope === undefined) return undefined;

      if (isExpired(envelope.storedAt)) {
        // Eviction is lazy — nothing sweeps entries that are never read again.
        // Acceptable for v1: `StorageArea` deliberately exposes no key
        // enumeration, and the two live caches are small (one CDX entry per
        // visited listing, geocodes never expire at all).
        await evict(storageKey);
        return undefined;
      }

      return envelope.value as T;
    },

    async set(key: string, value: T): Promise<void> {
      const envelope: Envelope = { v: ENVELOPE_VERSION, value, storedAt: now() };
      // Write failures propagate, unlike read failures: a quota or
      // write-rate error is real information the caller may want to act on,
      // and swallowing it would hide a cache that silently never persists.
      await storage.set({ [storageKeyFor(namespace, key)]: envelope });
    },

    async delete(key: string): Promise<void> {
      // Propagates too — an explicit invalidation that quietly failed would
      // leave the caller believing stale data is gone.
      await storage.remove(storageKeyFor(namespace, key));
    },
  };
}
