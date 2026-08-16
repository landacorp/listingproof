import { describe, expect, it, vi } from 'vitest';
import { purgeRetiredCaches, type BulkStorageArea } from './storage';

/**
 * The one-time sweep that follows the archive check out of the product.
 *
 * `lib/cache.ts` only ever expires an entry when something reads it, so the two
 * caches the archive pass owned would otherwise sit in the ~10 MB
 * `storage.local` quota forever — next to a geocode cache that by design never
 * expires. What matters here is the blast radius: the sweep must take every
 * retired key and nothing else.
 */
function fakeStorage(seed: Record<string, unknown>) {
  const data = { ...seed };
  const storage: BulkStorageArea = {
    async entries() {
      return { ...data };
    },
    async removeAll(keys) {
      for (const key of keys) delete data[key];
    },
  };
  return { storage, data };
}

const POPULATED = {
  'lp:cdx:booking.com/hotel/fr/x.html': { v: 1, at: 0, value: [] },
  'lp:phash:https://cf.bstatic.com/xdata/images/hotel/1.jpg': { v: 1, at: 0, value: 'abc' },
  'lp:geo:Eiffel Tower': { v: 1, at: 0, value: { lat: 48.85, lng: 2.29 } },
  settings: { ollamaModel: '' },
};

describe('purgeRetiredCaches', () => {
  it('removes the retired archive caches and leaves everything else alone', async () => {
    const { storage, data } = fakeStorage(POPULATED);
    await purgeRetiredCaches(storage);

    expect(Object.keys(data).sort()).toEqual(['lp:geo:Eiffel Tower', 'settings']);
  });

  it('touches nothing when there is nothing to purge, and is safe to repeat', async () => {
    const { storage, data } = fakeStorage(POPULATED);
    const removeAll = vi.spyOn(storage, 'removeAll');

    await purgeRetiredCaches(storage);
    await purgeRetiredCaches(storage);

    // Second pass finds nothing, so it must not write at all.
    expect(removeAll).toHaveBeenCalledTimes(1);
    expect(Object.keys(data).sort()).toEqual(['lp:geo:Eiffel Tower', 'settings']);
  });

  it('does not mistake a namespace that merely starts with a retired one', async () => {
    // `lib/cache.ts` percent-encodes the namespace and separates with ':', so
    // `cdxfoo` is a different cache — the prefix must include the separator.
    const { storage, data } = fakeStorage({ 'lp:cdxfoo:key': 1, 'lp:phashing:key': 2 });
    await purgeRetiredCaches(storage);

    expect(Object.keys(data).sort()).toEqual(['lp:cdxfoo:key', 'lp:phashing:key']);
  });

  it('swallows a storage failure — housekeeping must never break the worker', async () => {
    const broken: BulkStorageArea = {
      async entries() {
        throw new Error('storage unavailable');
      },
      async removeAll() {},
    };
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(purgeRetiredCaches(broken)).resolves.toBeUndefined();
    expect(logged).toHaveBeenCalled();
    logged.mockRestore();
  });
});
