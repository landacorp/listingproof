import { describe, expect, it } from 'vitest';
import { createCache, type StorageArea } from './cache';

const DAY_MS = 86_400_000;
const SEVEN_DAYS = 7 * DAY_MS;
/** Arbitrary fixed epoch — every test drives time explicitly, none waits. */
const T0 = 1_700_000_000_000;

/** Stand-in for a cached CDX response: an object, so identity/copy bugs show. */
interface CdxRows {
  rows: string[];
}
const ROWS: CdxRows = { rows: ['20240102030405 200'] };
const OTHER_ROWS: CdxRows = { rows: ['20250102030405 200', '20250607080910 200'] };

const LISTING = 'booking.com/hotel/fr/le-petit-bornand';

/**
 * Mirror of the module's private key layout, needed to plant raw (corrupt or
 * skewed) entries. The "stores under a namespaced key" test below pins the
 * real format against this copy, so the two cannot drift apart unnoticed.
 */
function rawKey(namespace: string, key: string): string {
  return `lp:${encodeURIComponent(namespace)}:${key}`;
}

interface FakeStorage extends StorageArea {
  readonly data: Map<string, unknown>;
  failGet: boolean;
  failSet: boolean;
  failRemove: boolean;
  /** Keys passed to `remove`, in order — proves eviction actually happened. */
  readonly removed: string[];
}

function fakeStorage(seed: Record<string, unknown> = {}): FakeStorage {
  const data = new Map<string, unknown>(Object.entries(seed));
  const removed: string[] = [];
  const fake: FakeStorage = {
    data,
    removed,
    failGet: false,
    failSet: false,
    failRemove: false,
    async get(key) {
      if (fake.failGet) throw new Error('storage unavailable');
      // Chrome resolves to `{}` for an absent key and round-trips values
      // through structured clone; the fake does both, so a cache that handed
      // back a live reference to stored data would fail here rather than in
      // the browser.
      if (!data.has(key)) return {};
      return { [key]: structuredClone(data.get(key)) };
    },
    async set(items) {
      if (fake.failSet) throw new Error('QUOTA_BYTES quota exceeded');
      for (const [key, value] of Object.entries(items)) data.set(key, structuredClone(value));
    },
    async remove(key) {
      if (fake.failRemove) throw new Error('storage unavailable');
      removed.push(key);
      data.delete(key);
    },
  };
  return fake;
}

/** Fake clock: tests move time by hand, so there are no timers and no waiting. */
function fakeClock(start: number) {
  let t = start;
  return {
    now: () => t,
    advance(ms: number) {
      t += ms;
    },
  };
}

function setup(ttlMs: number | null = SEVEN_DAYS, namespace = 'cdx') {
  const storage = fakeStorage();
  const clock = fakeClock(T0);
  const cache = createCache<CdxRows>({ namespace, ttlMs, storage, now: clock.now });
  return { cache, storage, clock };
}

/** A well-formed envelope as the module writes it, for hand-planted entries. */
function envelope(value: unknown, storedAt: number): Record<string, unknown> {
  return { v: 1, value, storedAt };
}

/**
 * A cache over hand-planted raw storage with the clock frozen at T0. Used
 * wherever the entry under test cannot be produced by `set` — corrupt data,
 * foreign keys, timestamps from a skewed clock.
 */
function plant<T = CdxRows>(
  stored: Record<string, unknown>,
  ttlMs: number | null = SEVEN_DAYS,
  namespace = 'cdx',
) {
  const storage = fakeStorage(stored);
  const cache = createCache<T>({ namespace, ttlMs, storage, now: () => T0 });
  return { cache, storage };
}

describe('createCache', () => {
  it('returns a stored value on a hit', async () => {
    const { cache } = setup();
    await cache.set(LISTING, ROWS);
    await expect(cache.get(LISTING)).resolves.toEqual(ROWS);
  });

  it('returns undefined for a key that was never written', async () => {
    const { cache } = setup();
    await expect(cache.get(LISTING)).resolves.toBeUndefined();
  });

  it('stores under a namespaced key, wrapped in a versioned envelope', async () => {
    const { cache, storage } = setup(SEVEN_DAYS, 'cdx:v1');
    await cache.set(LISTING, ROWS);
    // Pins the on-disk layout: changing it invalidates every user's cache, so
    // it should only ever change together with the envelope version.
    expect([...storage.data.keys()]).toEqual([`lp:cdx%3Av1:${LISTING}`]);
    expect(storage.data.get(`lp:cdx%3Av1:${LISTING}`)).toEqual({
      v: 1,
      value: ROWS,
      storedAt: T0,
    });
  });

  /**
   * `undefined` is this API's spelling of "miss", so any value that a
   * truthiness check would swallow has to be shown surviving the round trip.
   * These are not hypothetical: a geocode that resolved to nothing is cached
   * as `null` precisely so the address is never re-asked, and a listing with no
   * archive coverage is cached as an empty CDX row set — the case PLAN.md calls
   * "normal flow for Booking, never an error".
   */
  it.each<[string, unknown]>([
    ['null (a geocode with no result)', null],
    ['false', false],
    ['zero', 0],
    ['an empty string', ''],
    ['an empty array (a listing with no captures)', []],
    ['an empty object', {}],
    ['a nested object', { rows: ['20240102030405 200'], meta: { count: 1 } }],
  ])('round-trips %s as a hit, not a miss', async (_name, value) => {
    const { cache } = plant<unknown>({});
    await cache.set(LISTING, value);

    const got = await cache.get(LISTING);
    expect(got).not.toBeUndefined();
    expect(got).toStrictEqual(value);
  });

  /**
   * The no-aliasing guarantee comes from the storage port (Chrome structured-
   * clones in both directions, and the fake mirrors that), so these two pin
   * that the cache adds no in-process layer which reintroduces sharing.
   */
  describe('isolation from caller objects', () => {
    it('hands back a copy, so mutating a result cannot poison the cache', async () => {
      const { cache } = setup();
      await cache.set(LISTING, ROWS);

      const first = await cache.get(LISTING);
      first?.rows.push('tampered');

      await expect(cache.get(LISTING)).resolves.toEqual(ROWS);
      expect(ROWS.rows).toHaveLength(1); // the shared fixture survived too
    });

    it('snapshots the value at set time, so a later caller mutation is not stored', async () => {
      const { cache } = setup();
      const mutable: CdxRows = { rows: ['20240102030405 200'] };

      await cache.set(LISTING, mutable);
      mutable.rows.push('added after the write');

      await expect(cache.get(LISTING)).resolves.toEqual({ rows: ['20240102030405 200'] });
    });
  });

  describe('expiry', () => {
    it.each([
      { elapsed: 'no time has passed', ms: 0, hit: true },
      { elapsed: 'one ms before the TTL', ms: SEVEN_DAYS - 1, hit: true },
      { elapsed: 'exactly at the TTL', ms: SEVEN_DAYS, hit: false },
      { elapsed: 'one ms past the TTL', ms: SEVEN_DAYS + 1, hit: false },
      { elapsed: 'long past the TTL', ms: 30 * DAY_MS, hit: false },
    ])('$elapsed -> hit=$hit', async ({ ms, hit }) => {
      const { cache, clock } = setup(SEVEN_DAYS);
      await cache.set(LISTING, ROWS);
      clock.advance(ms);
      await expect(cache.get(LISTING)).resolves.toEqual(hit ? ROWS : undefined);
    });

    it('removes an expired entry on read, so a dead key cannot linger', async () => {
      const key = rawKey('cdx', LISTING);
      const { cache, storage } = plant({ [key]: envelope(ROWS, T0 - SEVEN_DAYS) });

      await expect(cache.get(LISTING)).resolves.toBeUndefined();
      expect(storage.removed).toEqual([key]);
      expect(storage.data.size).toBe(0);
    });

    it('still reports a miss when evicting an expired entry fails', async () => {
      const key = rawKey('cdx', LISTING);
      const { cache, storage } = plant({ [key]: envelope(ROWS, T0 - SEVEN_DAYS) });
      storage.failRemove = true;

      await expect(cache.get(LISTING)).resolves.toBeUndefined();
      expect(storage.data.size).toBe(1); // eviction failed; the read did not
    });

    /**
     * Clock skew is tolerated up to one TTL in either direction. Under it, a
     * backwards clock jump must not wipe the cache; past it, the timestamp is
     * meaningless and the entry must not become immortal — nothing else would
     * ever evict it, since eviction only fires on expiry.
     */
    it.each([
      { skew: 'a day in the future (clock corrected backwards)', storedAt: T0 + DAY_MS, hit: true },
      { skew: 'one ms short of a TTL ahead', storedAt: T0 + SEVEN_DAYS - 1, hit: true },
      { skew: 'exactly a TTL ahead', storedAt: T0 + SEVEN_DAYS, hit: false },
      { skew: 'years ahead (a corrupt write)', storedAt: T0 + 400 * DAY_MS, hit: false },
    ])('$skew -> hit=$hit', async ({ storedAt, hit }) => {
      const key = rawKey('cdx', LISTING);
      const { cache, storage } = plant({ [key]: envelope(ROWS, storedAt) });

      await expect(cache.get(LISTING)).resolves.toEqual(hit ? ROWS : undefined);
      expect(storage.removed).toEqual(hit ? [] : [key]);
    });

    it('never expires when ttlMs is null (geocodes do not move)', async () => {
      const { cache, clock } = setup(null, 'geo');
      await cache.set('10 Downing Street, London', ROWS);
      clock.advance(10 * 365 * DAY_MS);
      await expect(cache.get('10 Downing Street, London')).resolves.toEqual(ROWS);
    });

    it('keeps a wildly future-dated entry when ttlMs is null', async () => {
      const key = rawKey('geo', LISTING);
      const { cache, storage } = plant({ [key]: envelope(ROWS, T0 + 400 * DAY_MS) }, null, 'geo');

      await expect(cache.get(LISTING)).resolves.toEqual(ROWS);
      expect(storage.removed).toEqual([]);
    });
  });

  describe('namespace isolation', () => {
    it('keeps identical keys in different namespaces apart', async () => {
      const storage = fakeStorage();
      const clock = fakeClock(T0);
      const cdx = createCache<CdxRows>({ namespace: 'cdx', ttlMs: SEVEN_DAYS, storage, now: clock.now });
      const geo = createCache<CdxRows>({ namespace: 'geo', ttlMs: null, storage, now: clock.now });

      await cdx.set(LISTING, ROWS);
      await geo.set(LISTING, OTHER_ROWS);

      await expect(cdx.get(LISTING)).resolves.toEqual(ROWS);
      await expect(geo.get(LISTING)).resolves.toEqual(OTHER_ROWS);
    });

    it('cannot be spoofed by a separator inside the namespace or the key', async () => {
      const storage = fakeStorage();
      const clock = fakeClock(T0);
      // Without encoding the namespace both of these would land on "lp:a:b:c".
      const nested = createCache<CdxRows>({ namespace: 'a:b', ttlMs: null, storage, now: clock.now });
      const plain = createCache<CdxRows>({ namespace: 'a', ttlMs: null, storage, now: clock.now });

      await nested.set('c', ROWS);
      await plain.set('b:c', OTHER_ROWS);

      await expect(nested.get('c')).resolves.toEqual(ROWS);
      await expect(plain.get('b:c')).resolves.toEqual(OTHER_ROWS);
      expect(storage.data.size).toBe(2);
    });

    it('does not read entries written by a foreign, unprefixed key', async () => {
      const { cache } = plant({ [LISTING]: envelope(ROWS, T0) }, null);
      await expect(cache.get(LISTING)).resolves.toBeUndefined();
    });
  });

  describe('corrupt or foreign stored data', () => {
    it.each<[string, unknown]>([
      ['a bare string', 'not an envelope'],
      ['a number', 42],
      ['null', null],
      ['an array', [{ v: 1, value: ROWS, storedAt: T0 }]],
      ['a missing version', { value: ROWS, storedAt: T0 }],
      ['a newer schema version', { v: 2, value: ROWS, storedAt: T0 }],
      ['a stringified version', { v: '1', value: ROWS, storedAt: T0 }],
      ['a missing timestamp', { v: 1, value: ROWS }],
      ['a non-numeric timestamp', { v: 1, value: ROWS, storedAt: '2026-08-11' }],
      ['a NaN timestamp', { v: 1, value: ROWS, storedAt: Number.NaN }],
      ['an infinite timestamp', { v: 1, value: ROWS, storedAt: Number.POSITIVE_INFINITY }],
      ['no value field at all', { v: 1, storedAt: T0 }],
    ])('reads %s as a miss without throwing', async (_name, stored) => {
      const key = rawKey('cdx', LISTING);
      const { cache, storage } = plant({ [key]: stored });

      await expect(cache.get(LISTING)).resolves.toBeUndefined();
      // Left in place on purpose: an unrecognised envelope may belong to a
      // newer build (profile synced, extension downgraded). The next set()
      // overwrites it anyway.
      expect(storage.data.has(key)).toBe(true);
      expect(storage.removed).toEqual([]);
    });

    it('overwrites an unreadable entry on the next write', async () => {
      const key = rawKey('cdx', LISTING);
      const { cache } = plant({ [key]: 'garbage' });

      await cache.set(LISTING, ROWS);
      await expect(cache.get(LISTING)).resolves.toEqual(ROWS);
    });
  });

  describe('storage failures', () => {
    it('reports a miss instead of throwing when get fails', async () => {
      const { cache, storage } = setup();
      await cache.set(LISTING, ROWS);
      storage.failGet = true;
      await expect(cache.get(LISTING)).resolves.toBeUndefined();
    });

    it('reports a miss when the adapter resolves to something unusable', async () => {
      const storage = fakeStorage();
      // A malformed adapter (or a mocked one) resolving to null must not throw
      // out of a cache read: the caller loses a shortcut, not the verdict.
      storage.get = async () => null as unknown as Record<string, unknown>;
      const cache = createCache<CdxRows>({ namespace: 'cdx', ttlMs: null, storage, now: () => T0 });

      await expect(cache.get(LISTING)).resolves.toBeUndefined();
    });

    it('recovers once storage works again', async () => {
      const { cache, storage } = setup();
      await cache.set(LISTING, ROWS);
      storage.failGet = true;
      await cache.get(LISTING);
      storage.failGet = false;
      await expect(cache.get(LISTING)).resolves.toEqual(ROWS);
    });

    it('propagates a set failure (quota errors are real information)', async () => {
      const { cache, storage } = setup();
      storage.failSet = true;
      await expect(cache.set(LISTING, ROWS)).rejects.toThrow(/quota/i);
    });

    it('propagates a delete failure', async () => {
      const { cache, storage } = setup();
      await cache.set(LISTING, ROWS);
      storage.failRemove = true;
      await expect(cache.delete(LISTING)).rejects.toThrow(/unavailable/);
    });
  });

  describe('delete and overwrite', () => {
    it('deletes an entry and leaves storage empty', async () => {
      const { cache, storage } = setup();
      await cache.set(LISTING, ROWS);
      await cache.delete(LISTING);

      await expect(cache.get(LISTING)).resolves.toBeUndefined();
      expect(storage.data.size).toBe(0);
      expect(storage.removed).toEqual([rawKey('cdx', LISTING)]);
    });

    it('deleting an absent key is a no-op, not an error', async () => {
      const { cache } = setup();
      await expect(cache.delete(LISTING)).resolves.toBeUndefined();
    });

    it('deletes only the requested namespace, leaving the twin key alone', async () => {
      const storage = fakeStorage();
      const clock = fakeClock(T0);
      const cdx = createCache<CdxRows>({ namespace: 'cdx', ttlMs: SEVEN_DAYS, storage, now: clock.now });
      const geo = createCache<CdxRows>({ namespace: 'geo', ttlMs: null, storage, now: clock.now });

      await cdx.set(LISTING, ROWS);
      await geo.set(LISTING, OTHER_ROWS);
      await cdx.delete(LISTING);

      await expect(cdx.get(LISTING)).resolves.toBeUndefined();
      await expect(geo.get(LISTING)).resolves.toEqual(OTHER_ROWS);
    });

    it('overwrites a value in place', async () => {
      const { cache, storage } = setup();
      await cache.set(LISTING, ROWS);
      await cache.set(LISTING, OTHER_ROWS);

      await expect(cache.get(LISTING)).resolves.toEqual(OTHER_ROWS);
      expect(storage.data.size).toBe(1);
    });

    it('restarts the TTL on overwrite', async () => {
      const { cache, clock } = setup(SEVEN_DAYS);
      await cache.set(LISTING, ROWS);
      clock.advance(SEVEN_DAYS - 1);
      await cache.set(LISTING, OTHER_ROWS);

      clock.advance(SEVEN_DAYS - 1);
      await expect(cache.get(LISTING)).resolves.toEqual(OTHER_ROWS);
      clock.advance(1);
      await expect(cache.get(LISTING)).resolves.toBeUndefined();
    });
  });

  describe('configuration', () => {
    /**
     * A TTL that arrived as NaN loses every comparison, so an unvalidated cache
     * would answer "fresh" forever — a 7-day CDX cache silently promoted to
     * permanent, which is the failure direction that matters here: stale
     * archive data presented as current. Infinity is rejected because `null` is
     * already how this module says "permanent"; arriving here it means a
     * division went wrong, not that a caller meant it.
     */
    it.each<[string, number]>([
      ['NaN', Number.NaN],
      ['a negative', -1],
      ['an infinite', Number.POSITIVE_INFINITY],
    ])('throws on %s ttlMs instead of caching forever by accident', (_name, ttlMs) => {
      expect(() => createCache({ namespace: 'cdx', ttlMs, storage: fakeStorage() })).toThrow(RangeError);
    });

    it('accepts ttlMs 0 as "a written entry is already stale"', async () => {
      const { cache, storage } = setup(0);
      await cache.set(LISTING, ROWS);

      await expect(cache.get(LISTING)).resolves.toBeUndefined();
      expect(storage.removed).toEqual([rawKey('cdx', LISTING)]);
    });

    it('defaults the clock to Date.now when none is injected', async () => {
      const storage = fakeStorage();
      const cache = createCache<CdxRows>({ namespace: 'cdx', ttlMs: SEVEN_DAYS, storage });
      const before = Date.now();

      await cache.set(LISTING, ROWS);

      const stored = storage.data.get(rawKey('cdx', LISTING)) as { storedAt: number };
      expect(stored.storedAt).toBeGreaterThanOrEqual(before);
      expect(stored.storedAt).toBeLessThanOrEqual(Date.now());
      await expect(cache.get(LISTING)).resolves.toEqual(ROWS);
    });
  });
});
