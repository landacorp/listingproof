/**
 * `chrome.storage.local` adapter for `lib/cache.ts`.
 *
 * Kept separate from the cache logic so the cache stays unit-testable without
 * a browser. This is the only place the extension touches persistent storage,
 * and it stores API responses exclusively — never a record of which listings
 * the user looked at. A visit log would make a tool people install *because*
 * they distrust a listing into a log of every listing they distrusted.
 */
import { browser } from 'wxt/browser';
import { createCache, type Cache, type StorageArea } from '../lib/cache';
import type { GeocodeResult } from './geocode';

export const extensionStorage: StorageArea = {
  async get(key: string): Promise<Record<string, unknown>> {
    return (await browser.storage.local.get(key)) as Record<string, unknown>;
  },
  async set(items: Record<string, unknown>): Promise<void> {
    await browser.storage.local.set(items);
  },
  async remove(key: string): Promise<void> {
    await browser.storage.local.remove(key);
  },
};

/**
 * Geocodes never expire: a landmark's coordinates do not move, and Nominatim's
 * usage policy asks callers to cache aggressively rather than re-query.
 */
export function createGeocodeCache(storage: StorageArea = extensionStorage): Cache<GeocodeResult> {
  return createCache<GeocodeResult>({ namespace: 'geo', ttlMs: null, storage });
}

/**
 * Namespaces this extension used to write and no longer reads: the Wayback CDX
 * listings and the perceptual photo hashes that served the archive comparison.
 */
export const RETIRED_NAMESPACES = ['cdx', 'phash'];

/**
 * The whole-area operations `purgeRetiredCaches` needs, which per-key
 * `StorageArea` deliberately does not expose. Separate so the sweep is
 * testable without a browser, like every other module here.
 */
export interface BulkStorageArea {
  /** Every key/value pair in the area. */
  entries(): Promise<Record<string, unknown>>;
  removeAll(keys: string[]): Promise<void>;
}

export const extensionBulkStorage: BulkStorageArea = {
  async entries(): Promise<Record<string, unknown>> {
    return (await browser.storage.local.get(null)) as Record<string, unknown>;
  },
  async removeAll(keys: string[]): Promise<void> {
    await browser.storage.local.remove(keys);
  },
};

/**
 * Delete what an older version left behind in `storage.local`.
 *
 * `lib/cache.ts` expires entries lazily, on read — so a namespace nothing reads
 * any more is a namespace nothing ever frees. Both retired caches grew one
 * entry per listing (and per photo) the user looked at, inside a ~10 MB quota
 * shared with the geocode cache, which by design never expires. Left alone that
 * is a permanently smaller budget for the caches still in use.
 *
 * Safe to run repeatedly: after the first pass it finds nothing. `lp:<ns>:` is
 * an unambiguous prefix — `lib/cache.ts` percent-encodes the namespace, so it
 * cannot contain ':' and no other cache's key can begin with one of these.
 */
export async function purgeRetiredCaches(
  storage: BulkStorageArea = extensionBulkStorage,
): Promise<void> {
  const prefixes = RETIRED_NAMESPACES.map((namespace) => `lp:${namespace}:`);
  try {
    const stale = Object.keys(await storage.entries()).filter((key) =>
      prefixes.some((prefix) => key.startsWith(prefix)),
    );
    if (stale.length > 0) await storage.removeAll(stale);
  } catch (error) {
    // Housekeeping, not a feature. Failing it must cost nothing.
    console.error('[listingproof] purging retired caches failed:', error);
  }
}
