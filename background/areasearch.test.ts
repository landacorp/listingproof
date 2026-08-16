import { describe, expect, it, vi } from 'vitest';
import type { RateLimiter } from '../lib/ratelimit';
import type { AreaSearchQuery } from '../lib/areasearch';
import type { SearchAreaFetchMessage } from '../lib/messages';
import type { SearchFetchOutcome } from '../lib/sites/types';
import {
  AREA_SEARCH_MAX_BYTES,
  createAreaSearchHandler,
  type SearchCapableAdapter,
} from './areasearch';

const VALID_QUERY: AreaSearchQuery = {
  latitude: 48.8584,
  longitude: 2.2945,
  radiusKm: 2,
  checkin: '2026-09-01',
  checkout: '2026-09-04',
  adults: 2,
  rooms: 1,
  children: 0,
};

function fetchMessage(overrides: Partial<SearchAreaFetchMessage> = {}): SearchAreaFetchMessage {
  return { type: 'SEARCH_AREA_FETCH', platform: 'stub', query: VALID_QUERY, ...overrides };
}

// ---------------------------------------------------------------------------
// Doubles
// ---------------------------------------------------------------------------

const STUB_URL = 'https://stub.example/searchresults.html?lat=48.8584';
const CHALLENGE_MARKER = 'px-captcha';

/**
 * Stand-in for a platform's search half: URL spelling is a fixed string, and
 * classification counts property-card markers the way a real assessor counts
 * result cards. Tests never import the booking module — the handler's contract
 * is the injected lookup, not any one platform.
 */
function stubAdapter() {
  return {
    buildSearchUrl: vi.fn((_query: AreaSearchQuery) => STUB_URL),
    assessSearchHtml: (html: string): SearchFetchOutcome => {
      if (html.includes(CHALLENGE_MARKER)) return 'challenge';
      const cards = html.split('data-testid="property-card"').length - 1;
      return cards >= 3 ? 'results' : 'other';
    },
  };
}

/** Lookup double: exactly one platform id resolves. */
const lookupOnly =
  (id: string, adapter: SearchCapableAdapter) =>
  (requested: string): SearchCapableAdapter | undefined =>
    requested === id ? adapter : undefined;

/** No spacing in unit tests — the limiter contract is `lib/ratelimit.test.ts`'s job. */
const immediateLimiter: RateLimiter = { run: (task) => task() };

interface FetchCall {
  url: string;
  init: RequestInit | undefined;
}

function fakeFetch(respond: (call: FetchCall) => Response | Promise<Response>): {
  fetchImpl: typeof fetch;
  calls: FetchCall[];
} {
  const calls: FetchCall[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const call: FetchCall = { url: String(input), init };
    calls.push(call);
    return respond(call);
  };
  return { fetchImpl, calls };
}

/** A plausible one-page results body: six cards plus filler. */
function resultsBody(): string {
  const card = '<div data-testid="property-card"><a href="/hotel/fr/x.html">Hotel X</a></div>';
  return `<!DOCTYPE html><html><body>${card.repeat(6)}</body></html>`;
}

function makeHandler(
  adapter: SearchCapableAdapter,
  respond: (call: FetchCall) => Response | Promise<Response>,
) {
  const { fetchImpl, calls } = fakeFetch(respond);
  const handler = createAreaSearchHandler({
    fetchImpl,
    limiter: immediateLimiter,
    adapterById: lookupOnly('stub', adapter),
  });
  return { handler, calls };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('area search fetch', () => {
  it('fetches the adapter-built URL with session cookies, no HTTP cache, and an HTML Accept', async () => {
    const adapter = stubAdapter();
    const { handler, calls } = makeHandler(adapter, () => new Response(resultsBody()));

    const response = await handler.handle(fetchMessage());

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(STUB_URL);
    expect(calls[0]!.init?.credentials).toBe('include');
    expect(calls[0]!.init?.cache).toBe('no-store');
    expect(new Headers(calls[0]!.init?.headers).get('accept')).toBe(
      'text/html,application/xhtml+xml',
    );
    expect(calls[0]!.init?.signal).toBeInstanceOf(AbortSignal);
    expect(response.ok).toBe(true);
    expect(response.outcome).toBe('results');
    expect(response.html).toBe(resultsBody());
    expect(response.error).toBeUndefined();
  });

  it('hands buildSearchUrl the validated copy, not the message object', async () => {
    const adapter = stubAdapter();
    const { handler } = makeHandler(adapter, () => new Response(resultsBody()));
    // A page could spread extra fields into the query; validation must strip
    // them before any of it reaches the URL speller.
    const smuggled = { ...VALID_QUERY, redirectTo: 'https://evil.example/' };
    const message = fetchMessage({ query: smuggled });

    await handler.handle(message);

    expect(adapter.buildSearchUrl).toHaveBeenCalledTimes(1);
    const received = adapter.buildSearchUrl.mock.calls[0]![0];
    expect(received).not.toBe(message.query);
    expect(received).toEqual(VALID_QUERY);
    expect(Object.keys(received)).not.toContain('redirectTo');
    // And the message itself was never repaired in place.
    expect(message.query).toEqual(smuggled);
  });

  it('passes validated categories through to the URL speller', async () => {
    const adapter = stubAdapter();
    const { handler } = makeHandler(adapter, () => new Response(resultsBody()));

    await handler.handle(
      fetchMessage({ query: { ...VALID_QUERY, categories: ['hotel', 'apartment'] } }),
    );

    expect(adapter.buildSearchUrl.mock.calls[0]![0].categories).toEqual(['hotel', 'apartment']);
  });

  it('refuses an out-of-vocabulary category before any network', async () => {
    const adapter = stubAdapter();
    const { handler, calls } = makeHandler(adapter, () => new Response(resultsBody()));

    const response = await handler.handle(
      fetchMessage({ query: { ...VALID_QUERY, categories: ['castle'] } as never }),
    );

    expect(response.ok).toBe(false);
    expect(calls).toHaveLength(0);
    expect(adapter.buildSearchUrl).not.toHaveBeenCalled();
  });

  it('refuses an unknown platform without touching the network', async () => {
    const { handler, calls } = makeHandler(stubAdapter(), () => new Response(resultsBody()));

    const response = await handler.handle(fetchMessage({ platform: 'nosuchsite' }));

    expect(response.ok).toBe(false);
    expect(response.error).toContain('nosuchsite');
    expect(calls).toHaveLength(0);
  });

  it('refuses a platform whose adapter cannot search', async () => {
    // Half an implementation is no implementation: URL spelling without
    // classification (or vice versa) must read as "cannot search".
    const halfAdapter = { assessSearchHtml: () => 'results' as const };
    const { handler, calls } = makeHandler(halfAdapter, () => new Response(resultsBody()));

    const response = await handler.handle(fetchMessage());

    expect(response.ok).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it('refuses an out-of-bounds query before building any URL', async () => {
    const adapter = stubAdapter();
    const { handler, calls } = makeHandler(adapter, () => new Response(resultsBody()));

    const response = await handler.handle(
      fetchMessage({ query: { ...VALID_QUERY, radiusKm: 999 } }),
    );

    expect(response.ok).toBe(false);
    expect(response.error).toContain('query');
    expect(adapter.buildSearchUrl).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
  });

  it('turns a fetch rejection into a refusal, never a throw', async () => {
    const { handler } = makeHandler(stubAdapter(), () => {
      throw new TypeError('Failed to fetch');
    });

    const response = await handler.handle(fetchMessage());

    expect(response.ok).toBe(false);
    expect(response.error).toContain('Failed to fetch');
    expect(response.html).toBeUndefined();
    expect(response.outcome).toBeUndefined();
  });

  it('refuses a body over the cap after reading it', async () => {
    const oversized = 'x'.repeat(AREA_SEARCH_MAX_BYTES + 1);
    const { handler } = makeHandler(stubAdapter(), () => new Response(oversized));

    const response = await handler.handle(fetchMessage());

    expect(response.ok).toBe(false);
    expect(response.error).toContain('too large');
    expect(response.html).toBeUndefined();
  });

  it('refuses on a declared over-cap Content-Length without reading the body', async () => {
    const body = { text: vi.fn() };
    const { handler } = makeHandler(
      stubAdapter(),
      () =>
        ({
          headers: new Headers({ 'content-length': String(AREA_SEARCH_MAX_BYTES + 1) }),
          text: body.text,
        }) as unknown as Response,
    );

    const response = await handler.handle(fetchMessage());

    expect(response.ok).toBe(false);
    expect(response.error).toContain('too large');
    expect(body.text).not.toHaveBeenCalled();
  });

  it('labels a challenge stub as an outcome, not an error — even on HTTP 202', async () => {
    const challenge = `<html><body><div class="${CHALLENGE_MARKER}"></div></body></html>`;
    const { handler } = makeHandler(
      stubAdapter(),
      () => new Response(challenge, { status: 202 }),
    );

    const response = await handler.handle(fetchMessage());

    expect(response.ok).toBe(true);
    expect(response.outcome).toBe('challenge');
    expect(response.html).toBe(challenge);
    expect(response.error).toBeUndefined();
  });

  it('still assesses a refusal that arrives as a non-2xx status with a body', async () => {
    const { handler } = makeHandler(
      stubAdapter(),
      () => new Response('<html><body>maintenance</body></html>', { status: 503 }),
    );

    const response = await handler.handle(fetchMessage());

    expect(response.ok).toBe(true);
    expect(response.outcome).toBe('other');
  });
});
