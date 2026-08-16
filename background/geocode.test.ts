import { describe, expect, it, vi } from 'vitest';
import { createCache, type Cache, type StorageArea } from '../lib/cache';
import { createRateLimiter, type RateLimiter } from '../lib/ratelimit';
import type { GeocodeOptions, GeocodeResult } from '../lib/geocoder';
import {
  NOMINATIM_MAX_DISPLAY_NAME_LENGTH,
  NOMINATIM_MAX_SCANNED_ROWS,
  NOMINATIM_MIN_INTERVAL_MS,
  NOMINATIM_REFERER,
  NOMINATIM_TIMEOUT_MS,
  createNominatimGeocoder,
} from './geocode';

/** One Nominatim `jsonv2` row, as it arrives: lat/lon are strings. */
const EIFFEL_ROW = {
  lat: '48.8582599',
  lon: '2.2945006',
  display_name: 'Tour Eiffel, Paris, Île-de-France, France',
  importance: 0.7841,
};

// ---------------------------------------------------------------------------
// Doubles
// ---------------------------------------------------------------------------

interface MemoryStorage extends StorageArea {
  /** Envelope values as written, for asserting *what* was cached. */
  values(): unknown[];
}

/**
 * One `chrome.storage.local` round-trip.
 *
 * The real store is IPC to the browser process, so a caller cannot observe a
 * write by yielding the microtask queue a few times. A double that resolved on
 * a microtask would hide exactly the bug these tests exist to catch: whether the
 * answer is stored *before* the rate-limit slot is released, or merely lands
 * eventually once the test has yielded enough turns.
 */
const storageRoundTrip = (): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, 0);
  });

/**
 * In-memory `chrome.storage.local`. Clones on the way in and out, as the
 * `StorageArea` contract requires — Chrome structured-clones across the message
 * boundary, so a shared reference would be a bug the real store cannot have.
 */
function createMemoryStorage(): MemoryStorage {
  const map = new Map<string, unknown>();
  return {
    async get(key: string): Promise<Record<string, unknown>> {
      await storageRoundTrip();
      return map.has(key) ? { [key]: structuredClone(map.get(key)) } : {};
    },
    async set(items: Record<string, unknown>): Promise<void> {
      await storageRoundTrip();
      for (const [key, value] of Object.entries(items)) map.set(key, structuredClone(value));
    },
    async remove(key: string): Promise<void> {
      await storageRoundTrip();
      map.delete(key);
    },
    values: () => [...map.values()].map((envelope) => (envelope as { value: unknown }).value),
  };
}

/** Write a raw value straight into the geocode cache, bypassing the module's own encoder. */
async function seedCache(storage: StorageArea, key: string, value: unknown): Promise<void> {
  await (createTestCache(storage) as unknown as Cache<unknown>).set(key, value);
}

/** Production wiring: the permanent geocode cache from `background/storage.ts`. */
function createTestCache(storage: StorageArea): Cache<GeocodeResult> {
  return createCache<GeocodeResult>({ namespace: 'geo', ttlMs: null, storage });
}

interface FetchCall {
  url: URL;
  init: RequestInit | undefined;
}

type Responder = (call: FetchCall, index: number) => Response | Promise<Response>;

function createFakeFetch(responder: Responder): { fetchImpl: typeof fetch; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const call: FetchCall = { url: new URL(String(input)), init };
    calls.push(call);
    return await responder(call, calls.length - 1);
  };
  return { fetchImpl, calls };
}

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const respondWith =
  (body: unknown, status = 200): Responder =>
  () =>
    jsonResponse(body, status);

/** Fake clock in the shape `lib/ratelimit.ts` expects; runs a 1 req/s suite instantly. */
function createFakeClock(): { now: () => number; sleep: (ms: number) => Promise<void> } {
  let current = 0;
  return {
    now: () => current,
    sleep: async (ms: number) => {
      current += ms;
    },
  };
}

/** Wraps a limiter to prove a cache hit never enters it. */
function createCountingLimiter(inner: RateLimiter): { limiter: RateLimiter; runs: () => number } {
  let runs = 0;
  return {
    limiter: {
      run<T>(task: () => Promise<T>): Promise<T> {
        runs += 1;
        return inner.run(task);
      },
    },
    runs: () => runs,
  };
}

/**
 * Limiter whose queue is drained by the test, one slot at a time. Removes the
 * microtask race from tests about *what happens between two slots*.
 */
function createManualLimiter(): {
  limiter: RateLimiter;
  runs: () => number;
  pending: () => number;
  releaseNext: () => Promise<void>;
} {
  const queue: Array<() => Promise<void>> = [];
  let runs = 0;
  return {
    limiter: {
      run<T>(task: () => Promise<T>): Promise<T> {
        runs += 1;
        return new Promise<T>((resolve, reject) => {
          queue.push(async () => {
            try {
              resolve(await task());
            } catch (error) {
              reject(error);
            }
          });
        });
      },
    },
    runs: () => runs,
    pending: () => queue.length,
    releaseNext: async () => {
      const next = queue.shift();
      if (next !== undefined) await next();
    },
  };
}

/**
 * Let pending async work settle, storage round-trips included. A `geocode()`
 * call reaches the limiter only after its cache read resolves, which is several
 * hops deep (cache → storage IPC → decode), so tests that assert on queue state
 * have to wait for the whole chain rather than a single turn.
 */
async function flushPendingWork(turns = 8): Promise<void> {
  for (let turn = 0; turn < turns; turn += 1) await storageRoundTrip();
}

/** Limiter that never runs the task, as when it could not take the delay it owes. */
const failingLimiter: RateLimiter = {
  run<T>(): Promise<T> {
    return Promise.reject(new Error('timer unavailable'));
  },
};

/** Real limiter on a fake clock: spacing is asserted, wall time is not spent. */
function pacedLimiter(): { limiter: RateLimiter; now: () => number } {
  const clock = createFakeClock();
  return {
    limiter: createRateLimiter({
      minIntervalMs: NOMINATIM_MIN_INTERVAL_MS,
      now: clock.now,
      sleep: clock.sleep,
    }),
    now: clock.now,
  };
}

// ---------------------------------------------------------------------------

describe('createNominatimGeocoder', () => {
  describe('successful lookups', () => {
    it('parses a jsonv2 row into a GeocodeResult', async () => {
      const { fetchImpl, calls } = createFakeFetch(respondWith([EIFFEL_ROW]));
      const geocoder = createNominatimGeocoder({ fetchImpl, limiter: pacedLimiter().limiter });

      const result = await geocoder.geocode('Tour Eiffel');

      expect(result).toEqual({
        lat: 48.8582599,
        lng: 2.2945006,
        displayName: 'Tour Eiffel, Paris, Île-de-France, France',
        importance: 0.7841,
      });
      expect(calls).toHaveLength(1);
    });

    it('coerces the string lat/lon to numbers rather than passing strings downstream', async () => {
      const { fetchImpl } = createFakeFetch(respondWith([EIFFEL_ROW]));
      const geocoder = createNominatimGeocoder({ fetchImpl, limiter: pacedLimiter().limiter });

      const result = await geocoder.geocode('Tour Eiffel');

      // haversineKm does arithmetic on these; a string would silently produce
      // a wrong distance rather than an error.
      expect(typeof result?.lat).toBe('number');
      expect(typeof result?.lng).toBe('number');
    });

    it('accepts numeric lat/lon too', async () => {
      const { fetchImpl } = createFakeFetch(
        respondWith([{ lat: 41.9028, lon: 12.4964, display_name: 'Roma' }]),
      );
      const geocoder = createNominatimGeocoder({ fetchImpl, limiter: pacedLimiter().limiter });

      await expect(geocoder.geocode('Roma')).resolves.toEqual({
        lat: 41.9028,
        lng: 12.4964,
        displayName: 'Roma',
      });
    });

    it('takes the first usable row when an earlier one is unreadable', async () => {
      const { fetchImpl } = createFakeFetch(
        respondWith([{ lat: 'n/a', lon: '2.2', display_name: 'broken' }, EIFFEL_ROW]),
      );
      const geocoder = createNominatimGeocoder({ fetchImpl, limiter: pacedLimiter().limiter });

      const result = await geocoder.geocode('Tour Eiffel');

      expect(result?.displayName).toBe('Tour Eiffel, Paris, Île-de-France, France');
    });

    it('omits importance when the provider does not send a usable one', async () => {
      const { fetchImpl } = createFakeFetch(
        respondWith([{ lat: '51.5', lon: '-0.12', display_name: 'Strand', importance: 'high' }]),
      );
      const geocoder = createNominatimGeocoder({ fetchImpl, limiter: pacedLimiter().limiter });

      const result = await geocoder.geocode('Strand');

      expect(result).toEqual({ lat: 51.5, lng: -0.12, displayName: 'Strand' });
      expect(result && 'importance' in result).toBe(false);
    });
  });

  describe('request shape', () => {
    it('asks the documented endpoint with format, limit and no country filter', async () => {
      const { fetchImpl, calls } = createFakeFetch(respondWith([EIFFEL_ROW]));
      const geocoder = createNominatimGeocoder({ fetchImpl, limiter: pacedLimiter().limiter });

      await geocoder.geocode('Tour Eiffel');

      const { url } = calls[0];
      expect(url.origin).toBe('https://nominatim.openstreetmap.org');
      expect(url.pathname).toBe('/search');
      expect(url.searchParams.get('q')).toBe('Tour Eiffel');
      expect(url.searchParams.get('format')).toBe('jsonv2');
      expect(url.searchParams.get('limit')).toBe('1');
      expect(url.searchParams.has('countrycodes')).toBe(false);
    });

    it('reads with GET, as the search endpoint documents', async () => {
      const { fetchImpl, calls } = createFakeFetch(respondWith([EIFFEL_ROW]));
      const geocoder = createNominatimGeocoder({ fetchImpl, limiter: pacedLimiter().limiter });

      await geocoder.geocode('Tour Eiffel');

      expect(calls[0].init?.method ?? 'GET').toBe('GET');
      expect(calls[0].init?.body ?? null).toBeNull();
    });

    it('identifies the application on every request', async () => {
      const { fetchImpl, calls } = createFakeFetch(respondWith([EIFFEL_ROW]));
      const geocoder = createNominatimGeocoder({ fetchImpl, limiter: pacedLimiter().limiter });

      await geocoder.geocode('Tour Eiffel');

      // Referer is the identifier extension code can set; the policy requires
      // one, and an unidentified caller is the one that gets the IP banned.
      expect(calls[0].init?.headers).toMatchObject({ Referer: NOMINATIM_REFERER });
      // Asserted against the policy rather than against the constant: comparing
      // the header to the constant alone would still pass if the constant were
      // emptied, which is precisely the state the operator cannot distinguish
      // from an anonymous client.
      expect(NOMINATIM_REFERER).toMatch(/^https:\/\/\S+$/);
      expect(NOMINATIM_REFERER.toLowerCase()).toContain('listingproof');
    });

    it('bounds every request with an abort signal', async () => {
      const { fetchImpl, calls } = createFakeFetch(respondWith([EIFFEL_ROW]));
      const geocoder = createNominatimGeocoder({ fetchImpl, limiter: pacedLimiter().limiter });

      await geocoder.geocode('Tour Eiffel');

      // The limiter runs one task at a time, so an unbounded request holds the
      // only slot and stalls every later lookup on the page.
      expect(calls[0].init?.signal).toBeInstanceOf(AbortSignal);
      expect(calls[0].init?.signal?.aborted).toBe(false);
    });

    it.each([
      ['lowercase', 'fr'],
      ['uppercase, as ISO codes are often written', 'FR'],
      ['padded', '  fr  '],
    ])('propagates a %s country hint as countrycodes', async (_name, countryCode) => {
      const { fetchImpl, calls } = createFakeFetch(respondWith([EIFFEL_ROW]));
      const geocoder = createNominatimGeocoder({ fetchImpl, limiter: pacedLimiter().limiter });

      await geocoder.geocode('Tour Eiffel', { countryCode });

      expect(calls[0].url.searchParams.get('countrycodes')).toBe('fr');
    });

    it.each([
      ['a three-letter code', 'USA'],
      ['a subdivision', 'gb-eng'],
      ['digits', '12'],
      ['a country name', 'France'],
    ])('refuses to search worldwide when the country hint is %s', async (_name, countryCode) => {
      const { fetchImpl, calls } = createFakeFetch(respondWith([EIFFEL_ROW]));
      const counting = createCountingLimiter(pacedLimiter().limiter);
      const geocoder = createNominatimGeocoder({ fetchImpl, limiter: counting.limiter });

      // Silently dropping the hint would let a same-named landmark on another
      // continent become an A2 "median distance > 50 km" RED on a legit listing.
      await expect(geocoder.geocode('Bellevue', { countryCode })).resolves.toBeNull();
      expect(calls).toHaveLength(0);
      expect(counting.runs()).toBe(0);
    });

    it.each([
      ['a number', 42],
      ['an object', { code: 'fr' }],
      ['null, which is not the same as omitting the field', null],
    ])('refuses a country hint that is %s', async (_name, countryCode) => {
      const { fetchImpl, calls } = createFakeFetch(respondWith([EIFFEL_ROW]));
      const geocoder = createNominatimGeocoder({ fetchImpl, limiter: pacedLimiter().limiter });

      // The declared `string` is not a runtime guarantee: the value originates
      // in extraction. A hint we cannot honour must not silently become a
      // worldwide search — same reasoning as the malformed-string cases above.
      const options = { countryCode } as unknown as GeocodeOptions;
      await expect(geocoder.geocode('Bellevue', options)).resolves.toBeNull();
      expect(calls).toHaveLength(0);
    });

    it('treats an empty country hint as no hint, not as a malformed one', async () => {
      const { fetchImpl, calls } = createFakeFetch(respondWith([EIFFEL_ROW]));
      const geocoder = createNominatimGeocoder({ fetchImpl, limiter: pacedLimiter().limiter });

      await expect(geocoder.geocode('Tour Eiffel', { countryCode: '   ' })).resolves.not.toBeNull();
      expect(calls[0].url.searchParams.has('countrycodes')).toBe(false);
    });

    it.each([
      ['Greek', 'Ακρόπολη Αθηνών'],
      ['Japanese', '東京タワー'],
      ['Cyrillic', 'Красная площадь'],
      ['a name with a plus sign', 'Hotel A+B'],
      ['a name with an ampersand', 'Bed & Breakfast Rimini'],
    ])('round-trips a %s query through the URL encoding', async (_name, query) => {
      const { fetchImpl, calls } = createFakeFetch(respondWith([EIFFEL_ROW]));
      const geocoder = createNominatimGeocoder({ fetchImpl, limiter: pacedLimiter().limiter });

      await geocoder.geocode(query);

      expect(calls[0].url.searchParams.get('q')).toBe(query);
    });

    it('percent-encodes non-ASCII rather than sending raw bytes', async () => {
      const { fetchImpl, calls } = createFakeFetch(respondWith([EIFFEL_ROW]));
      const geocoder = createNominatimGeocoder({ fetchImpl, limiter: pacedLimiter().limiter });

      await geocoder.geocode('東京タワー');

      expect(calls[0].url.href).toContain('%E6%9D%B1%E4%BA%AC');
    });

    it('trims the query before sending it', async () => {
      const { fetchImpl, calls } = createFakeFetch(respondWith([EIFFEL_ROW]));
      const geocoder = createNominatimGeocoder({ fetchImpl, limiter: pacedLimiter().limiter });

      await geocoder.geocode('  Tour Eiffel\n');

      expect(calls[0].url.searchParams.get('q')).toBe('Tour Eiffel');
    });
  });

  describe('null answers', () => {
    it('returns null for an empty result array', async () => {
      const { fetchImpl } = createFakeFetch(respondWith([]));
      const geocoder = createNominatimGeocoder({ fetchImpl, limiter: pacedLimiter().limiter });

      await expect(geocoder.geocode('Hotel Atlantis Beach Club')).resolves.toBeNull();
    });

    it('returns null on malformed JSON instead of throwing', async () => {
      const { fetchImpl } = createFakeFetch(() => new Response('<html>blocked</html>'));
      const geocoder = createNominatimGeocoder({ fetchImpl, limiter: pacedLimiter().limiter });

      await expect(geocoder.geocode('Tour Eiffel')).resolves.toBeNull();
    });

    it.each([
      ['an object body', { lat: '48.8', lon: '2.29', display_name: 'x' }],
      ['a bare string body', 'nope'],
      ['null', null],
    ])('returns null when the body is %s rather than an array', async (_name, body) => {
      const { fetchImpl } = createFakeFetch(respondWith(body));
      const geocoder = createNominatimGeocoder({ fetchImpl, limiter: pacedLimiter().limiter });

      await expect(geocoder.geocode('Tour Eiffel')).resolves.toBeNull();
    });

    it.each([
      ['500', 500],
      ['429, the rate-limit rejection', 429],
      ['403', 403],
      ['404', 404],
    ])('returns null on HTTP %s', async (_name, status) => {
      const { fetchImpl } = createFakeFetch(respondWith([EIFFEL_ROW], status));
      const geocoder = createNominatimGeocoder({ fetchImpl, limiter: pacedLimiter().limiter });

      await expect(geocoder.geocode('Tour Eiffel')).resolves.toBeNull();
    });

    it('returns null when the network throws', async () => {
      const { fetchImpl } = createFakeFetch(() => {
        throw new TypeError('Failed to fetch');
      });
      const geocoder = createNominatimGeocoder({ fetchImpl, limiter: pacedLimiter().limiter });

      await expect(geocoder.geocode('Tour Eiffel')).resolves.toBeNull();
    });

    it('abandons a request that never settles, rather than holding the only slot forever', async () => {
      // `AbortSignal.timeout` is not reachable through any injected seam, so it
      // is stubbed to hand back a signal this test can fire. That keeps the
      // assertion on real behaviour — the signal really is passed to fetch, and
      // firing it really does produce null — without spending ten wall-clock
      // seconds. What is *not* asserted here is the length of the deadline.
      const timeoutSpy = vi.spyOn(AbortSignal, 'timeout');
      try {
        const controller = new AbortController();
        timeoutSpy.mockReturnValue(controller.signal);

        const { fetchImpl, calls } = createFakeFetch(
          async ({ init }) =>
            await new Promise<Response>((_resolve, reject) => {
              init?.signal?.addEventListener('abort', () => {
                reject(new DOMException('The operation timed out.', 'TimeoutError'));
              });
            }),
        );
        const geocoder = createNominatimGeocoder({ fetchImpl, limiter: pacedLimiter().limiter });

        const pending = geocoder.geocode('Tour Eiffel');
        await flushPendingWork();
        expect(calls).toHaveLength(1);
        expect(timeoutSpy).toHaveBeenCalledWith(NOMINATIM_TIMEOUT_MS);

        controller.abort(new DOMException('The operation timed out.', 'TimeoutError'));

        await expect(pending).resolves.toBeNull();
      } finally {
        timeoutSpy.mockRestore();
      }
    });

    it('returns null when fetch resolves with something that is not a Response', async () => {
      const fetchImpl = (async () => undefined) as unknown as typeof fetch;
      const geocoder = createNominatimGeocoder({ fetchImpl, limiter: pacedLimiter().limiter });

      await expect(geocoder.geocode('Tour Eiffel')).resolves.toBeNull();
    });

    it('returns null when the limiter refuses to grant a slot', async () => {
      const { fetchImpl, calls } = createFakeFetch(respondWith([EIFFEL_ROW]));
      const geocoder = createNominatimGeocoder({ fetchImpl, limiter: failingLimiter });

      // Fail closed: the limiter rejects rather than fire early, and an
      // unspaced request is the thing the policy bans us for.
      await expect(geocoder.geocode('Tour Eiffel')).resolves.toBeNull();
      expect(calls).toHaveLength(0);
    });

    it.each([
      ['latitude past the pole', { lat: '95.1', lon: '2.29' }],
      ['latitude far past the pole', { lat: '910', lon: '2.29' }],
      ['longitude past the antimeridian', { lat: '48.85', lon: '200.4' }],
      ['a non-numeric latitude', { lat: 'forty-eight', lon: '2.29' }],
      ['an empty latitude, which Number() would read as 0', { lat: '', lon: '2.29' }],
      ['a whitespace longitude, which Number() would read as 0', { lat: '48.85', lon: '  ' }],
      ['NaN spelled out', { lat: 'NaN', lon: '2.29' }],
      ['Infinity', { lat: 'Infinity', lon: '2.29' }],
      ['a null latitude, which Number() would read as 0', { lat: null, lon: '2.29' }],
      ['a missing longitude', { lat: '48.85' }],
      ['lng under the wrong key', { lat: '48.85', lng: '2.29' }],
      ['an array in place of the row', []],
      ['a string in place of the row', 'Paris'],
    ])('returns null for %s', async (_name, row) => {
      const { fetchImpl } = createFakeFetch(
        respondWith([{ display_name: 'Tour Eiffel, Paris', ...(row as object) }]),
      );
      const geocoder = createNominatimGeocoder({ fetchImpl, limiter: pacedLimiter().limiter });

      await expect(geocoder.geocode('Tour Eiffel')).resolves.toBeNull();
    });

    it.each([
      ['missing', {}],
      ['empty', { display_name: '   ' }],
      ['not a string', { display_name: 42 }],
    ])(
      'returns null when the provider name is %s, rather than echoing the query as evidence',
      async (_name, patch) => {
        const { fetchImpl } = createFakeFetch(
          respondWith([{ lat: '48.85', lon: '2.29', ...patch }]),
        );
        const geocoder = createNominatimGeocoder({ fetchImpl, limiter: pacedLimiter().limiter });

        // displayName is shown as *the provider's* name for the match. Filling
        // it from the query would present the listing's own claim as
        // corroboration of itself.
        await expect(geocoder.geocode('Tour Eiffel')).resolves.toBeNull();
      },
    );

    it('stops scanning a response that has stopped making sense', async () => {
      const broken = { lat: 'x', lon: 'y', display_name: 'broken' };
      const { fetchImpl } = createFakeFetch(
        // One usable row, parked just past the scan window.
        respondWith([...Array<unknown>(NOMINATIM_MAX_SCANNED_ROWS).fill(broken), EIFFEL_ROW]),
      );
      const geocoder = createNominatimGeocoder({ fetchImpl, limiter: pacedLimiter().limiter });

      await expect(geocoder.geocode('Tour Eiffel')).resolves.toBeNull();
    });

    it('accepts a provider name right at the length ceiling', async () => {
      const name = 'a'.repeat(NOMINATIM_MAX_DISPLAY_NAME_LENGTH);
      const { fetchImpl } = createFakeFetch(
        respondWith([{ lat: '48.85', lon: '2.29', display_name: name }]),
      );
      const geocoder = createNominatimGeocoder({ fetchImpl, limiter: pacedLimiter().limiter });

      await expect(geocoder.geocode('Tour Eiffel')).resolves.toMatchObject({ displayName: name });
    });

    it('drops a provider name past the ceiling instead of caching it forever', async () => {
      const { fetchImpl } = createFakeFetch(
        respondWith([
          {
            lat: '48.85',
            lon: '2.29',
            display_name: 'a'.repeat(NOMINATIM_MAX_DISPLAY_NAME_LENGTH + 1),
          },
        ]),
      );
      const storage = createMemoryStorage();
      const geocoder = createNominatimGeocoder({
        fetchImpl,
        cache: createTestCache(storage),
        limiter: pacedLimiter().limiter,
      });

      // Geocode entries never expire, so an oversized one is a permanent charge
      // against a ~10 MB area shared with every other cache in the extension.
      await expect(geocoder.geocode('Tour Eiffel')).resolves.toBeNull();
      expect(storage.values()).toEqual([]);
    });

    it.each([
      ['empty', ''],
      ['whitespace only', '   \n'],
    ])('returns null for a %s query without spending a request', async (_name, query) => {
      const { fetchImpl, calls } = createFakeFetch(respondWith([EIFFEL_ROW]));
      const counting = createCountingLimiter(pacedLimiter().limiter);
      const geocoder = createNominatimGeocoder({ fetchImpl, limiter: counting.limiter });

      await expect(geocoder.geocode(query)).resolves.toBeNull();
      expect(calls).toHaveLength(0);
      expect(counting.runs()).toBe(0);
    });

    it('returns null for a non-string query from untrusted upstream extraction', async () => {
      const { fetchImpl, calls } = createFakeFetch(respondWith([EIFFEL_ROW]));
      const geocoder = createNominatimGeocoder({ fetchImpl, limiter: pacedLimiter().limiter });

      // A2's POI names can come from Engine L, whose output PLAN.md classifies
      // as untrusted — the declared `string` is not a runtime guarantee.
      const untrusted = undefined as unknown as string;
      await expect(geocoder.geocode(untrusted)).resolves.toBeNull();
      expect(calls).toHaveLength(0);
    });
  });

  describe('caching', () => {
    it('serves a repeat hit without touching the network or the limiter', async () => {
      const { fetchImpl, calls } = createFakeFetch(respondWith([EIFFEL_ROW]));
      const storage = createMemoryStorage();
      const cache = createTestCache(storage);
      const first = createNominatimGeocoder({ fetchImpl, cache, limiter: pacedLimiter().limiter });
      await first.geocode('Tour Eiffel');

      const counting = createCountingLimiter(pacedLimiter().limiter);
      const second = createNominatimGeocoder({ fetchImpl, cache, limiter: counting.limiter });
      const result = await second.geocode('Tour Eiffel');

      expect(result).toEqual({
        lat: 48.8582599,
        lng: 2.2945006,
        displayName: 'Tour Eiffel, Paris, Île-de-France, France',
        importance: 0.7841,
      });
      expect(calls).toHaveLength(1);
      expect(counting.runs()).toBe(0);
    });

    it.each([
      ['case', 'tour eiffel'],
      ['padding', '  Tour Eiffel  '],
      ['inner whitespace', 'Tour   Eiffel'],
    ])('reuses the cached answer across a difference in %s only', async (_name, variant) => {
      const { fetchImpl, calls } = createFakeFetch(respondWith([EIFFEL_ROW]));
      const cache = createTestCache(createMemoryStorage());
      const geocoder = createNominatimGeocoder({ fetchImpl, cache, limiter: pacedLimiter().limiter });

      await geocoder.geocode('Tour Eiffel');
      await geocoder.geocode(variant);

      expect(calls).toHaveLength(1);
    });

    it('does not reuse an answer across a different country hint', async () => {
      const { fetchImpl, calls } = createFakeFetch(respondWith([EIFFEL_ROW]));
      const cache = createTestCache(createMemoryStorage());
      const geocoder = createNominatimGeocoder({ fetchImpl, cache, limiter: pacedLimiter().limiter });

      await geocoder.geocode('Bellevue', { countryCode: 'it' });
      await geocoder.geocode('Bellevue', { countryCode: 'fr' });
      await geocoder.geocode('Bellevue');

      // Three different questions: same-named places exist in every country.
      expect(calls).toHaveLength(3);
    });

    it('remembers a miss so the same unresolvable landmark is asked once', async () => {
      const { fetchImpl, calls } = createFakeFetch(respondWith([]));
      const storage = createMemoryStorage();
      const cache = createTestCache(storage);
      const counting = createCountingLimiter(pacedLimiter().limiter);
      const geocoder = createNominatimGeocoder({ fetchImpl, cache, limiter: counting.limiter });

      await expect(geocoder.geocode('Atlantis Private Beach Club')).resolves.toBeNull();
      await expect(geocoder.geocode('Atlantis Private Beach Club')).resolves.toBeNull();

      expect(calls).toHaveLength(1);
      expect(counting.runs()).toBe(1);
    });

    it('stores a miss in a form distinct from a hit, not as an absent entry', async () => {
      const missStorage = createMemoryStorage();
      const missGeocoder = createNominatimGeocoder({
        fetchImpl: createFakeFetch(respondWith([])).fetchImpl,
        cache: createTestCache(missStorage),
        limiter: pacedLimiter().limiter,
      });
      const hitStorage = createMemoryStorage();
      const hitGeocoder = createNominatimGeocoder({
        fetchImpl: createFakeFetch(respondWith([EIFFEL_ROW])).fetchImpl,
        cache: createTestCache(hitStorage),
        limiter: pacedLimiter().limiter,
      });

      await missGeocoder.geocode('Atlantis Private Beach Club');
      await hitGeocoder.geocode('Tour Eiffel');

      // "asked, answered, no such place" is a stored fact; "never asked" is the
      // absence of one. Conflating them either re-queries forever or lets a
      // storage gap read as an answer.
      expect(missStorage.values()).toEqual([{ found: false }]);
      expect(hitStorage.values()).toEqual([
        {
          found: true,
          result: {
            lat: 48.8582599,
            lng: 2.2945006,
            displayName: 'Tour Eiffel, Paris, Île-de-France, France',
            importance: 0.7841,
          },
        },
      ]);
    });

    it.each([
      ['an HTTP error', respondWith([EIFFEL_ROW], 503)],
      [
        'a dead network',
        (() => {
          throw new TypeError('Failed to fetch');
        }) as Responder,
      ],
      ['an unreadable body', (() => new Response('<html>captive portal</html>')) as Responder],
      ['a body that is not an array', respondWith({ error: 'Unable to geocode' })],
      ['rows the parser cannot read', respondWith([{ lat: 'x', lon: 'y', display_name: 'z' }])],
    ])('does not cache %s, since it says nothing about the place', async (_name, firstResponder) => {
      let attempt = 0;
      const { fetchImpl, calls } = createFakeFetch((call, index) => {
        attempt += 1;
        return attempt === 1 ? firstResponder(call, index) : jsonResponse([EIFFEL_ROW]);
      });
      const storage = createMemoryStorage();
      const geocoder = createNominatimGeocoder({
        fetchImpl,
        cache: createTestCache(storage),
        limiter: pacedLimiter().limiter,
      });

      await expect(geocoder.geocode('Tour Eiffel')).resolves.toBeNull();
      expect(storage.values()).toEqual([]);

      // A transient failure cached permanently would blind this landmark for
      // the life of the profile.
      await expect(geocoder.geocode('Tour Eiffel')).resolves.not.toBeNull();
      expect(calls).toHaveLength(2);
    });

    // Positive control for the two suites below. They seed storage by hand and
    // then assert that the geocoder re-asks — an outcome a plain cache miss
    // produces just as well, so without this test they would pass unchanged
    // against an implementation that trusts poisoned entries but happens to
    // compute a different key. Pinning the key here is what makes them evidence.
    it.each([
      ['no country hint', '*|tour eiffel', undefined],
      ['a country hint', 'fr|tour eiffel', 'fr'],
    ])('serves a hand-written entry keyed for %s', async (_name, key, countryCode) => {
      const { fetchImpl, calls } = createFakeFetch(respondWith([EIFFEL_ROW]));
      const storage = createMemoryStorage();
      const seeded = { lat: 1.5, lng: -2.5, displayName: 'seeded, not fetched' };
      await seedCache(storage, key, { found: true, result: seeded });

      const geocoder = createNominatimGeocoder({
        fetchImpl,
        cache: createTestCache(storage),
        limiter: pacedLimiter().limiter,
      });

      const result = await geocoder.geocode('Tour Eiffel', countryCode ? { countryCode } : undefined);
      expect(result).toEqual(seeded);
      expect(calls).toHaveLength(0);
    });

    it('ignores a cache entry it cannot recognise and re-asks', async () => {
      const { fetchImpl, calls } = createFakeFetch(respondWith([EIFFEL_ROW]));
      const storage = createMemoryStorage();
      // An entry from an older build: the bare result, not the found/absent
      // envelope this module writes.
      await seedCache(storage, 'fr|tour eiffel', { lat: 1, lng: 2, displayName: 'stale' });

      const geocoder = createNominatimGeocoder({
        fetchImpl,
        cache: createTestCache(storage),
        limiter: pacedLimiter().limiter,
      });
      const result = await geocoder.geocode('Tour Eiffel', { countryCode: 'fr' });

      expect(result?.displayName).toBe('Tour Eiffel, Paris, Île-de-France, France');
      expect(calls).toHaveLength(1);
    });

    it.each([
      ['coordinates out of range', { found: true, result: { lat: 91, lng: 2, displayName: 'x' } }],
      ['a NaN coordinate', { found: true, result: { lat: 'NaN', lng: 2, displayName: 'x' } }],
      ['no display name', { found: true, result: { lat: 48.85, lng: 2.29 } }],
      ['found flagged with a string', { found: 'false' }],
      ['an array', []],
    ])('re-asks rather than trust a stored entry with %s', async (_name, poisoned) => {
      const { fetchImpl, calls } = createFakeFetch(respondWith([EIFFEL_ROW]));
      const storage = createMemoryStorage();
      await seedCache(storage, '*|tour eiffel', poisoned);

      const geocoder = createNominatimGeocoder({
        fetchImpl,
        cache: createTestCache(storage),
        limiter: pacedLimiter().limiter,
      });
      const result = await geocoder.geocode('Tour Eiffel');

      expect(result?.lat).toBeCloseTo(48.8582599);
      expect(calls).toHaveLength(1);
    });

    it('still answers when the cache cannot be read', async () => {
      const { fetchImpl } = createFakeFetch(respondWith([EIFFEL_ROW]));
      const brokenCache: Cache<GeocodeResult> = {
        get: () => Promise.reject(new Error('storage unavailable')),
        set: () => Promise.resolve(),
        delete: () => Promise.resolve(),
      };
      const geocoder = createNominatimGeocoder({
        fetchImpl,
        cache: brokenCache,
        limiter: pacedLimiter().limiter,
      });

      await expect(geocoder.geocode('Tour Eiffel')).resolves.not.toBeNull();
    });

    it('still answers when the cache cannot be written', async () => {
      const { fetchImpl } = createFakeFetch(respondWith([EIFFEL_ROW]));
      const fullCache: Cache<GeocodeResult> = {
        get: () => Promise.resolve(undefined),
        set: () => Promise.reject(new Error('QUOTA_BYTES quota exceeded')),
        delete: () => Promise.resolve(),
      };
      const geocoder = createNominatimGeocoder({
        fetchImpl,
        cache: fullCache,
        limiter: pacedLimiter().limiter,
      });

      // A quota failure must not lose a lookup we already paid a slot for.
      await expect(geocoder.geocode('Tour Eiffel')).resolves.not.toBeNull();
    });

    it('works with no cache injected', async () => {
      const { fetchImpl, calls } = createFakeFetch(respondWith([EIFFEL_ROW]));
      const geocoder = createNominatimGeocoder({ fetchImpl, limiter: pacedLimiter().limiter });

      await expect(geocoder.geocode('Tour Eiffel')).resolves.not.toBeNull();
      await expect(geocoder.geocode('Tour Eiffel')).resolves.not.toBeNull();

      expect(calls).toHaveLength(2);
    });
  });

  describe('rate limiting', () => {
    it('serializes concurrent lookups one second apart', async () => {
      const paced = pacedLimiter();
      const startedAt: number[] = [];
      const { fetchImpl, calls } = createFakeFetch(() => {
        startedAt.push(paced.now());
        return jsonResponse([EIFFEL_ROW]);
      });
      const geocoder = createNominatimGeocoder({
        fetchImpl,
        cache: createTestCache(createMemoryStorage()),
        limiter: paced.limiter,
      });

      const results = await Promise.all([
        geocoder.geocode('Tour Eiffel'),
        geocoder.geocode('Colosseo'),
        geocoder.geocode('Sagrada Família'),
      ]);

      expect(results.every((result) => result !== null)).toBe(true);
      expect(calls).toHaveLength(3);
      expect(startedAt).toEqual([0, NOMINATIM_MIN_INTERVAL_MS, 2 * NOMINATIM_MIN_INTERVAL_MS]);
    });

    it('routes every network lookup through the limiter', async () => {
      const { fetchImpl } = createFakeFetch(respondWith([EIFFEL_ROW]));
      const counting = createCountingLimiter(pacedLimiter().limiter);
      const geocoder = createNominatimGeocoder({ fetchImpl, limiter: counting.limiter });

      await Promise.all([geocoder.geocode('Colosseo'), geocoder.geocode('Duomo')]);

      expect(counting.runs()).toBe(2);
    });

    it('lets a duplicate queued behind an in-flight lookup reuse its answer', async () => {
      const { fetchImpl, calls } = createFakeFetch(respondWith([EIFFEL_ROW]));
      const manual = createManualLimiter();
      const storage = createMemoryStorage();
      const geocoder = createNominatimGeocoder({
        fetchImpl,
        cache: createTestCache(storage),
        limiter: manual.limiter,
      });

      const first = geocoder.geocode('Tour Eiffel');
      const second = geocoder.geocode('tour eiffel');
      // Both missed the cache before queueing, so both are waiting for a slot.
      await flushPendingWork();
      expect(manual.pending()).toBe(2);

      await manual.releaseNext();
      // Asserted here, before the test yields again: the slot is released only
      // once the answer is *durable*. A write left in flight past the end of the
      // slot is a write the caller behind us cannot see, and it would spend a
      // request on an answer we already hold.
      expect(storage.values()).toHaveLength(1);

      await manual.releaseNext();

      // The second re-checked the cache inside its slot and found the answer
      // that landed while it waited — it spends the slot, not a request.
      expect(await first).not.toBeNull();
      expect(await second).toEqual(await first);
      expect(calls).toHaveLength(1);
    });

    it('lets a duplicate queued behind an in-flight miss reuse the recorded absence', async () => {
      const { fetchImpl, calls } = createFakeFetch(respondWith([]));
      const manual = createManualLimiter();
      const storage = createMemoryStorage();
      const geocoder = createNominatimGeocoder({
        fetchImpl,
        cache: createTestCache(storage),
        limiter: manual.limiter,
      });

      const first = geocoder.geocode('Atlantis Private Beach Club');
      const second = geocoder.geocode('Atlantis Private Beach Club');
      await flushPendingWork();
      expect(manual.pending()).toBe(2);

      await manual.releaseNext();
      // A recorded absence has to be durable at slot release for the same
      // reason a hit does.
      expect(storage.values()).toEqual([{ found: false }]);

      await manual.releaseNext();

      await expect(first).resolves.toBeNull();
      await expect(second).resolves.toBeNull();
      expect(calls).toHaveLength(1);
    });

    it('uses its own 1 req/s limiter when none is injected', async () => {
      const { fetchImpl, calls } = createFakeFetch(respondWith([EIFFEL_ROW]));
      const geocoder = createNominatimGeocoder({ fetchImpl });

      // One lookup only: the default limiter uses real timers, and the point
      // here is that the default path is wired up at all, not its spacing
      // (which lib/ratelimit.test.ts covers).
      await expect(geocoder.geocode('Tour Eiffel')).resolves.not.toBeNull();
      expect(calls).toHaveLength(1);
    });
  });
});
