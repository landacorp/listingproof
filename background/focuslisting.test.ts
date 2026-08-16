import { describe, expect, it, vi } from 'vitest';
import type { RateLimiter } from '../lib/ratelimit';
import type { IdentityVector } from '../lib/identity';
import type { ListingDetectedMessage, SearchFocusListingMessage } from '../lib/messages';
import type { PageContext } from '../lib/pagecontext';
import type { CanonicalListing } from '../lib/sites/types';
import type { ListingTerms } from '../lib/terms';
import { FOCUS_MAX_BYTES, createFocusListingHandler, type ParsedListing } from './focuslisting';

const TAB_ID = 7;

/** What a search card hands over: canonical target plus tracking baggage. */
const MESSAGE_URL = 'https://stub.example/hotel/x.html?aid=999&label=track-me';

// ---------------------------------------------------------------------------
// Doubles
// ---------------------------------------------------------------------------

function canonicalFor(listingId: string): CanonicalListing {
  return {
    platform: 'stub',
    canonicalUrl: `https://stub.example/hotel/${listingId}.html`,
    cdxPrefix: `stub.example/hotel/${listingId}.html`,
    listingId,
  };
}

const CANONICAL = canonicalFor('x');
/** A second listing, for the supersession / cap / redirect cases. */
const CANONICAL_Y = canonicalFor('y');

/**
 * Stand-in for the registry gate: one URL shape is a listing page, and the id
 * in the path is the listing's identity. Tests never import a real adapter —
 * the handler's contract is the injected canonicalizer, not any one platform.
 */
const stubCanonicalize = (url: string): CanonicalListing | null => {
  const match = /^https:\/\/stub\.example\/hotel\/([a-z0-9-]+)\.html/.exec(url);
  return match === null ? null : canonicalFor(match[1]!);
};

/** A promise a test resolves by hand, to hold a flight open. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

const VECTOR: IdentityVector = {
  platform: 'stub',
  listingId: 'x',
  name: 'Hotel X',
  address: '1 Rue Example, 75001 Paris',
  photoUrls: [],
  capturedAt: '2026-08-15T12:00:00.000Z',
  source: { kind: 'live' },
};

const CONTEXT: PageContext = {
  breadcrumbs: ['France', 'Paris'],
  pois: [{ name: 'Louvre', statedDistanceKm: 0.4 }],
  reviews: ['Great stay'],
};

const TERMS: ListingTerms = { parking: { advertisedFree: true } };

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

function listingBody(): string {
  return '<!DOCTYPE html><html><body><h1>Hotel X</h1></body></html>';
}

function focusMessage(url: string = MESSAGE_URL): SearchFocusListingMessage {
  return { type: 'SEARCH_FOCUS_LISTING', url };
}

function makeHandler(
  overrides: {
    respond?: (call: FetchCall) => Response | Promise<Response>;
    parse?: (html: string, canonicalUrl: string) => Promise<ParsedListing | null>;
    onDetected?: (message: ListingDetectedMessage, tabId: number) => void | Promise<void>;
    maxInFlight?: number;
    tabUrl?: (tabId: number) => Promise<string | undefined>;
  } = {},
) {
  const { fetchImpl, calls } = fakeFetch(overrides.respond ?? (() => new Response(listingBody())));
  const parseListingHtml = vi.fn(
    overrides.parse ??
      (async (): Promise<ParsedListing | null> => ({
        vector: VECTOR,
        context: CONTEXT,
        terms: TERMS,
      })),
  );
  const onListingDetected = vi.fn(overrides.onDetected ?? (() => {}));
  const handler = createFocusListingHandler({
    fetchImpl,
    limiter: immediateLimiter,
    canonicalize: stubCanonicalize,
    parseListingHtml,
    onListingDetected,
    ...(overrides.maxInFlight === undefined ? {} : { maxInFlightPerTab: overrides.maxInFlight }),
    ...(overrides.tabUrl === undefined ? {} : { tabUrl: overrides.tabUrl }),
  });
  return { handler, calls, parseListingHtml, onListingDetected };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('focus-listing fetch', () => {
  it('refuses a non-listing URL before any network', async () => {
    const { handler, calls, parseListingHtml, onListingDetected } = makeHandler();

    const response = await handler.handle(
      focusMessage('https://stub.example/searchresults.html?dest=paris'),
      TAB_ID,
    );

    expect(response.ok).toBe(false);
    expect(response.error).toContain('not a recognized listing URL');
    expect(calls).toHaveLength(0);
    expect(parseListingHtml).not.toHaveBeenCalled();
    expect(onListingDetected).not.toHaveBeenCalled();
  });

  it('fetches the CANONICAL url with session cookies, no HTTP cache, and an HTML Accept', async () => {
    const { handler, calls } = makeHandler();

    const response = await handler.handle(focusMessage(), TAB_ID);

    expect(calls).toHaveLength(1);
    // Tracking params died at the boundary: the canonical page was fetched.
    expect(calls[0]!.url).toBe(CANONICAL.canonicalUrl);
    expect(calls[0]!.init?.credentials).toBe('include');
    expect(calls[0]!.init?.cache).toBe('no-store');
    expect(new Headers(calls[0]!.init?.headers).get('accept')).toBe(
      'text/html,application/xhtml+xml',
    );
    expect(calls[0]!.init?.signal).toBeInstanceOf(AbortSignal);
    expect(response.ok).toBe(true);
    expect(response.error).toBeUndefined();
  });

  it('hands the fetched HTML and the canonical URL to the parser', async () => {
    const { handler, parseListingHtml } = makeHandler();

    await handler.handle(focusMessage(), TAB_ID);

    expect(parseListingHtml).toHaveBeenCalledTimes(1);
    expect(parseListingHtml).toHaveBeenCalledWith(listingBody(), CANONICAL.canonicalUrl);
  });

  it('refuses when the page does not extract, and starts no analysis', async () => {
    const { handler, onListingDetected } = makeHandler({ parse: async () => null });

    const response = await handler.handle(focusMessage(), TAB_ID);

    expect(response.ok).toBe(false);
    expect(response.error).toContain('could not be extracted');
    expect(onListingDetected).not.toHaveBeenCalled();
  });

  it('synthesizes a LISTING_DETECTED for the search tab on success', async () => {
    const { handler, onListingDetected } = makeHandler();

    const response = await handler.handle(focusMessage(), TAB_ID);

    expect(response).toEqual({ ok: true });
    expect(onListingDetected).toHaveBeenCalledTimes(1);
    const [detected, tabId] = onListingDetected.mock.calls[0]!;
    expect(tabId).toBe(TAB_ID);
    expect(detected).toEqual({
      type: 'LISTING_DETECTED',
      vector: VECTOR,
      url: CANONICAL.canonicalUrl, // the page actually fetched, not the tracked one
      canonical: CANONICAL,
      terms: TERMS,
      context: CONTEXT,
    });
  });

  it('omits the terms key entirely when the parse found none', async () => {
    const { handler, onListingDetected } = makeHandler({
      parse: async () => ({ vector: VECTOR, context: CONTEXT }),
    });

    await handler.handle(focusMessage(), TAB_ID);

    const [detected] = onListingDetected.mock.calls[0]!;
    expect('terms' in detected).toBe(false);
  });

  it('refuses a body over the cap after reading it, without parsing', async () => {
    const oversized = 'x'.repeat(FOCUS_MAX_BYTES + 1);
    const { handler, parseListingHtml, onListingDetected } = makeHandler({
      respond: () => new Response(oversized),
    });

    const response = await handler.handle(focusMessage(), TAB_ID);

    expect(response.ok).toBe(false);
    expect(response.error).toContain('too large');
    expect(parseListingHtml).not.toHaveBeenCalled();
    expect(onListingDetected).not.toHaveBeenCalled();
  });

  it('refuses on a declared over-cap Content-Length without reading the body', async () => {
    const body = { text: vi.fn() };
    const { handler } = makeHandler({
      respond: () =>
        ({
          headers: new Headers({ 'content-length': String(FOCUS_MAX_BYTES + 1) }),
          text: body.text,
        }) as unknown as Response,
    });

    const response = await handler.handle(focusMessage(), TAB_ID);

    expect(response.ok).toBe(false);
    expect(response.error).toContain('too large');
    expect(body.text).not.toHaveBeenCalled();
  });

  it('turns a fetch rejection into a refusal, never a throw', async () => {
    const { handler, onListingDetected } = makeHandler({
      respond: () => {
        throw new TypeError('Failed to fetch');
      },
    });

    const response = await handler.handle(focusMessage(), TAB_ID);

    expect(response.ok).toBe(false);
    expect(response.error).toContain('Failed to fetch');
    expect(onListingDetected).not.toHaveBeenCalled();
  });

  it('does not retract an accepted detection when the analysis sink rejects', async () => {
    const { handler, onListingDetected } = makeHandler({
      onDetected: () => Promise.reject(new Error('pipeline defect')),
    });

    const response = await handler.handle(focusMessage(), TAB_ID);
    // Let the swallowed rejection settle so an unhandled one would fail here.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(response).toEqual({ ok: true });
    expect(onListingDetected).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Where the fetch actually landed
// ---------------------------------------------------------------------------

/** A response that reports the URL it was finally served from, as a redirect does. */
function landedResponse(url: string): Response {
  return {
    url,
    headers: new Headers(),
    text: async () => listingBody(),
  } as unknown as Response;
}

describe('focus-listing redirect landing', () => {
  it('refuses a redirect that landed on a DIFFERENT listing, without parsing it', async () => {
    const { handler, parseListingHtml, onListingDetected } = makeHandler({
      respond: () => landedResponse(CANONICAL_Y.canonicalUrl),
    });

    const response = await handler.handle(focusMessage(), TAB_ID);

    expect(response.ok).toBe(false);
    expect(response.error).toContain('redirected');
    // The body is never read: another property's HTML must not be stamped
    // with the identity of the page we asked for.
    expect(parseListingHtml).not.toHaveBeenCalled();
    expect(onListingDetected).not.toHaveBeenCalled();
  });

  it('refuses a redirect off the listing space entirely (login wall, interstitial)', async () => {
    const { handler, onListingDetected } = makeHandler({
      respond: () => landedResponse('https://stub.example/login?next=/hotel/x.html'),
    });

    const response = await handler.handle(focusMessage(), TAB_ID);

    expect(response.ok).toBe(false);
    expect(response.error).toContain('redirected');
    expect(onListingDetected).not.toHaveBeenCalled();
  });

  it('accepts a landing URL that resolves to the same listing', async () => {
    const { handler, onListingDetected } = makeHandler({
      respond: () => landedResponse(CANONICAL.canonicalUrl),
    });

    expect(await handler.handle(focusMessage(), TAB_ID)).toEqual({ ok: true });
    expect(onListingDetected).toHaveBeenCalledTimes(1);
  });

  it('compares canonical identity, not raw strings: a tracked landing URL is fine', async () => {
    const { handler, onListingDetected } = makeHandler({
      respond: () => landedResponse('https://stub.example/hotel/x.html?lang=de&aid=1'),
    });

    expect(await handler.handle(focusMessage(), TAB_ID)).toEqual({ ok: true });
    expect(onListingDetected).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// One verdict at a time: dedup, supersession, cap
// ---------------------------------------------------------------------------

describe('focus-listing burst control', () => {
  it('collapses a burst of clicks on the SAME result into one fetch and one analysis', async () => {
    const gate = deferred();
    const { handler, calls, parseListingHtml, onListingDetected } = makeHandler({
      respond: async () => {
        await gate.promise;
        return new Response(listingBody());
      },
    });

    // Ten impatient clicks on one card while the first check is still running.
    const flights = Array.from({ length: 10 }, () => handler.handle(focusMessage(), TAB_ID));
    expect(calls).toHaveLength(1);

    gate.resolve();
    const responses = await Promise.all(flights);

    // Every click is answered "accepted" — the check asked for IS running.
    expect(responses).toEqual(Array.from({ length: 10 }, () => ({ ok: true })));
    expect(calls).toHaveLength(1);
    expect(parseListingHtml).toHaveBeenCalledTimes(1);
    expect(onListingDetected).toHaveBeenCalledTimes(1);
  });

  it('suppresses a superseded flight: only the listing clicked LAST is analyzed', async () => {
    const gate = deferred();
    const { handler, onListingDetected } = makeHandler({
      respond: async (call) => {
        // The first listing hangs; the second answers at once, so the user's
        // newer click reaches the pipeline first.
        if (call.url === CANONICAL.canonicalUrl) await gate.promise;
        return new Response(listingBody());
      },
    });

    const stale = handler.handle(focusMessage(), TAB_ID);
    const fresh = await handler.handle(focusMessage(CANONICAL_Y.canonicalUrl), TAB_ID);
    expect(fresh).toEqual({ ok: true });

    gate.resolve();
    // Accepted, then abandoned by the user — not a failure to report.
    expect(await stale).toEqual({ ok: true });

    expect(onListingDetected).toHaveBeenCalledTimes(1);
    const [detected] = onListingDetected.mock.calls[0]!;
    expect(detected).toMatchObject({ url: CANONICAL_Y.canonicalUrl });
  });

  it('still publishes when the user comes BACK to the listing already in flight', async () => {
    const gate = deferred();
    const { handler, calls, onListingDetected } = makeHandler({
      respond: async (call) => {
        if (call.url === CANONICAL.canonicalUrl) await gate.promise;
        return new Response(listingBody());
      },
    });

    const first = handler.handle(focusMessage(), TAB_ID);
    await handler.handle(focusMessage(CANONICAL_Y.canonicalUrl), TAB_ID);
    // Back to the first card: deduplicated onto its running flight, but it is
    // the tab's latest request again, so that flight may publish after all.
    expect(await handler.handle(focusMessage(), TAB_ID)).toEqual({ ok: true });

    gate.resolve();
    await first;

    expect(calls).toHaveLength(2); // no third fetch for the repeat click
    // The second listing published while it was the latest; the first then
    // published because the user came back to it, and the panel's own
    // supersession keeps the newer publish on screen. What matters here is
    // that the repeat click revived the running flight instead of leaving it
    // to be discarded as stale.
    const published = onListingDetected.mock.calls.map(([detected]) => detected?.url);
    expect(published).toEqual([CANONICAL_Y.canonicalUrl, CANONICAL.canonicalUrl]);
  });

  it('refuses distinct clicks past the in-flight cap, per tab, until one settles', async () => {
    const gate = deferred();
    const { handler, calls } = makeHandler({
      maxInFlight: 2,
      respond: async () => {
        await gate.promise;
        return new Response(listingBody());
      },
    });

    const first = handler.handle(focusMessage('https://stub.example/hotel/a.html'), TAB_ID);
    const second = handler.handle(focusMessage('https://stub.example/hotel/b.html'), TAB_ID);
    const third = await handler.handle(focusMessage('https://stub.example/hotel/c.html'), TAB_ID);

    expect(third.ok).toBe(false);
    expect(third.error).toContain('too many');
    expect(calls).toHaveLength(2); // the refused click never reached the network

    // Another search tab is another budget: the cap is per tab, not global.
    const otherTab = handler.handle(
      focusMessage('https://stub.example/hotel/c.html'),
      TAB_ID + 1,
    );
    expect(calls).toHaveLength(3);

    gate.resolve();
    await Promise.all([first, second, otherTab]);

    // The cap clears itself exactly when the flights it bounds are gone.
    expect(await handler.handle(focusMessage('https://stub.example/hotel/c.html'), TAB_ID)).toEqual(
      { ok: true },
    );
    expect(calls).toHaveLength(4);
  });

  it('re-checks a listing once its earlier flight has finished', async () => {
    const { handler, calls, onListingDetected } = makeHandler();

    expect(await handler.handle(focusMessage(), TAB_ID)).toEqual({ ok: true });
    // Deduplication is per FLIGHT, not a memory of what was checked: the
    // per-tab bookkeeping is gone once nothing is outstanding.
    expect(await handler.handle(focusMessage(), TAB_ID)).toEqual({ ok: true });

    expect(calls).toHaveLength(2);
    expect(onListingDetected).toHaveBeenCalledTimes(2);
  });

  it('a superseded flight reports its FAILURE to nobody either', async () => {
    const gate = deferred();
    const { handler } = makeHandler({
      respond: async (call) => {
        // The first listing hangs and then dies; the second answers at once.
        if (call.url === CANONICAL.canonicalUrl) {
          await gate.promise;
          throw new TypeError('Failed to fetch');
        }
        return new Response(listingBody());
      },
    });

    const stale = handler.handle(focusMessage(), TAB_ID);
    expect(await handler.handle(focusMessage(CANONICAL_Y.canonicalUrl), TAB_ID)).toEqual({
      ok: true,
    });

    gate.resolve();
    // Not `{ok:false}`: the page turns a failure into a visible error line,
    // and that line belongs to the check the user is now waiting for.
    expect(await stale).toEqual({ ok: true });
  });

  it('a superseded flight swallows a parse refusal too', async () => {
    const gate = deferred();
    const { handler } = makeHandler({
      respond: async (call) => {
        if (call.url === CANONICAL.canonicalUrl) await gate.promise;
        return new Response(listingBody());
      },
      // Only the first listing fails to extract.
      parse: async (_html, canonicalUrl) =>
        canonicalUrl === CANONICAL.canonicalUrl
          ? null
          : { vector: VECTOR, context: CONTEXT, terms: TERMS },
    });

    const stale = handler.handle(focusMessage(), TAB_ID);
    await handler.handle(focusMessage(CANONICAL_Y.canonicalUrl), TAB_ID);

    gate.resolve();
    expect(await stale).toEqual({ ok: true });
  });

  it('still reports a failure that is nobody else’s: the only flight owns the tab', async () => {
    const { handler } = makeHandler({
      respond: () => {
        throw new TypeError('Failed to fetch');
      },
    });

    const response = await handler.handle(focusMessage(), TAB_ID);

    expect(response.ok).toBe(false);
    expect(response.error).toContain('Failed to fetch');
  });
});

// ---------------------------------------------------------------------------
// Publishing onto the tab that actually asked
// ---------------------------------------------------------------------------

/** Where the search page lives — an extension page, not any listing. */
const SEARCH_PAGE = 'chrome-extension://abcdef/search.html';

describe('focus-listing publish target', () => {
  it('publishes nothing when the tab left the page that asked', async () => {
    const gate = deferred();
    let where: string | undefined = SEARCH_PAGE;
    const { handler, onListingDetected } = makeHandler({
      tabUrl: async () => where,
      respond: async () => {
        await gate.promise;
        return new Response(listingBody());
      },
    });

    const flight = handler.handle(focusMessage(), TAB_ID);
    // While the check is in the air the user opens the listing in this tab.
    where = CANONICAL.canonicalUrl;
    gate.resolve();

    // Accepted, then abandoned — silence, not an error: the asker is gone.
    expect(await flight).toEqual({ ok: true });
    expect(onListingDetected).not.toHaveBeenCalled();
  });

  it('publishes nothing when the tab is gone entirely', async () => {
    const gate = deferred();
    let closed = false;
    const { handler, onListingDetected } = makeHandler({
      tabUrl: async () => {
        if (closed) throw new Error('No tab with id: 7');
        return SEARCH_PAGE;
      },
      respond: async () => {
        await gate.promise;
        return new Response(listingBody());
      },
    });

    const flight = handler.handle(focusMessage(), TAB_ID);
    closed = true;
    gate.resolve();

    expect(await flight).toEqual({ ok: true });
    expect(onListingDetected).not.toHaveBeenCalled();
  });

  it('publishes when the tab is still the page that asked', async () => {
    const { handler, onListingDetected } = makeHandler({ tabUrl: async () => SEARCH_PAGE });

    expect(await handler.handle(focusMessage(), TAB_ID)).toEqual({ ok: true });
    expect(onListingDetected).toHaveBeenCalledTimes(1);
  });

  it('a URL respelled in place is still the page that asked', async () => {
    const gate = deferred();
    let where = 'https://stub.example/hotel/z.html';
    const { handler, onListingDetected } = makeHandler({
      tabUrl: async () => where,
      respond: async () => {
        await gate.promise;
        return new Response(listingBody());
      },
    });

    const flight = handler.handle(focusMessage(), TAB_ID);
    // Same page, new spelling — tracking params, a locale, a hash.
    where = 'https://stub.example/hotel/z.html?lang=de#photos';
    gate.resolve();

    expect(await flight).toEqual({ ok: true });
    expect(onListingDetected).toHaveBeenCalledTimes(1);
  });

  it('publishes when the tab cannot be located: an unknown must not silence a verdict', async () => {
    const { handler, onListingDetected } = makeHandler({ tabUrl: async () => undefined });

    expect(await handler.handle(focusMessage(), TAB_ID)).toEqual({ ok: true });
    expect(onListingDetected).toHaveBeenCalledTimes(1);
  });
});
