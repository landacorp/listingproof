/**
 * Map-area search, phase (b): the worker fetch behind `SEARCH_AREA_FETCH`.
 *
 * The message carries a QUERY, never a URL. The URL is spelled here, by the
 * site adapter, from a query that `validateAreaSearchQuery` has already
 * accepted — so a compromised page cannot turn this handler into a
 * fetch-anything proxy (ROADMAP P1's rule for any URL a page supplies). The
 * fetch itself reuses exactly what phase (a) proved works: `credentials:
 * 'include'` so the request rides the user's cookie jar, `cache: 'no-store'`
 * so the HTTP cache cannot manufacture a stale pass, and a navigation-like
 * `Accept` header.
 *
 * No caching, deliberately. A dated search carries live rate cards that go
 * stale in minutes, and each search is one explicit user action (a rectangle
 * drawn on a map) — a cache here could only ever serve a wrong price, never
 * save a request worth saving.
 *
 * Never throws. Every failure resolves to `{ok: false, error}` — the page gets
 * an answer, not a dead `sendResponse` channel.
 *
 * Wiring: the service worker must create ONE handler and share it. Each
 * instance that falls back to its own default limiter is a separate politeness
 * budget, and two of them fetch twice as fast as this module promises.
 */
import { validateAreaSearchQuery } from '../lib/areasearch';
import { createRateLimiter, type RateLimiter } from '../lib/ratelimit';
import { adapterById as registryAdapterById } from '../lib/sites/registry';
import type { SearchAreaFetchMessage, SearchAreaFetchResponse } from '../lib/messages';
import type { SiteAdapter } from '../lib/sites/types';

/**
 * 2500 ms between fetch starts.
 *
 * Politeness, not policy: no operator published this number. One page of
 * results per explicit user action is the load profile of a person refining a
 * search, and 2.5 s start-to-start keeps even a rapid draw–redraw loop looking
 * like exactly that. The limiter serializes strictly (`lib/ratelimit.ts`), so
 * the far side sees one request per interval, never a burst that averages out.
 */
export const AREA_SEARCH_MIN_INTERVAL_MS = 2500;

/**
 * 30 s ceiling on a single fetch, armed inside the limiter slot so it budgets
 * the request and not the queue wait. The limiter runs one task at a time and
 * cannot abandon a request it has sent, so a socket that never settles would
 * otherwise wedge every later search for the life of the worker. 30 s matches
 * the phase (a) probe: results pages are slow behind bot-scoring CDNs, and a
 * timeout costs one search the user can simply retry.
 */
export const AREA_SEARCH_TIMEOUT_MS = 30_000;

/**
 * 5 MB body cap.
 *
 * A captured Booking results page is ~1.7 MB; anything at triple that is not a
 * results page, it is a mistake or an attack, and the honest answer is refusal
 * rather than a truncated parse. Checked twice because neither check alone is
 * enough: `Content-Length` is free but advisory (absent on chunked responses,
 * and a hostile server can lie), while the post-read string length is
 * authoritative but only after the bytes arrived. The post-read check counts
 * UTF-16 code units, which UTF-8 decoding can only ever produce fewer of than
 * it read bytes — a bound with slack, never one that rejects a legitimate page.
 */
export const AREA_SEARCH_MAX_BYTES = 5 * 1024 * 1024;

/**
 * The two adapter members this handler actually reads. The injected lookup is
 * typed to exactly them so a test stub is two functions, and so the handler
 * cannot quietly grow a dependency on the rest of the adapter surface.
 */
export type SearchCapableAdapter = Pick<SiteAdapter, 'buildSearchUrl' | 'assessSearchHtml'>;

export interface AreaSearchOptions {
  /** Injectable `fetch` for tests. Defaults to the global. */
  fetchImpl?: typeof fetch;
  /** Shared politeness limiter. Defaults to a private one — see the module note. */
  limiter?: RateLimiter;
  /** Adapter lookup. Defaults to the real registry. */
  adapterById?: (id: string) => SearchCapableAdapter | undefined;
}

export interface AreaSearchHandler {
  handle(message: SearchAreaFetchMessage): Promise<SearchAreaFetchResponse>;
}

export function createAreaSearchHandler(options: AreaSearchOptions = {}): AreaSearchHandler {
  const doFetch: typeof fetch = options.fetchImpl ?? ((input, init) => fetch(input, init));
  const limiter =
    options.limiter ?? createRateLimiter({ minIntervalMs: AREA_SEARCH_MIN_INTERVAL_MS });
  const adapterById = options.adapterById ?? registryAdapterById;

  return {
    async handle(message: SearchAreaFetchMessage): Promise<SearchAreaFetchResponse> {
      const adapter = adapterById(message.platform);
      // Both halves or neither: a platform that can spell the URL but not
      // classify the answer would return bodies nobody can label honestly.
      if (adapter?.buildSearchUrl === undefined || adapter.assessSearchHtml === undefined) {
        return { ok: false, error: `platform cannot search: ${String(message.platform)}` };
      }

      // Bound now: the guard's narrowing does not survive into the limiter
      // task's closure, and binding keeps whatever `this` the adapter expects.
      const assessSearchHtml = adapter.assessSearchHtml.bind(adapter);

      // Refused, never repaired: an out-of-bounds query is a bug (or an attack)
      // upstream, and clamping it would silently search somewhere else.
      const query = validateAreaSearchQuery(message.query);
      if (query === null) {
        return { ok: false, error: 'invalid area search query' };
      }

      try {
        // Built from the validated copy only — `message.query` never reaches
        // the adapter, so unknown fields a page smuggled in are already gone.
        const url = adapter.buildSearchUrl(query);

        return await limiter.run(async (): Promise<SearchAreaFetchResponse> => {
          const response = await doFetch(url, {
            credentials: 'include',
            cache: 'no-store',
            headers: { Accept: 'text/html,application/xhtml+xml' },
            // Created here rather than before the queue wait, so the budget
            // covers the request and not the time spent waiting for a slot.
            signal: AbortSignal.timeout(AREA_SEARCH_TIMEOUT_MS),
          });

          // Declared-size check before buffering the body at all.
          const declared = response.headers.get('content-length');
          if (declared !== null) {
            const size = Number(declared);
            if (Number.isFinite(size) && size > AREA_SEARCH_MAX_BYTES) {
              return { ok: false, error: 'response too large' };
            }
          }

          // No status gate: Booking's challenge stub arrives as HTTP 202 with
          // a body, and a refusal WITH a body is an outcome for the adapter to
          // classify, not a transport error. Only a fetch that throws is one.
          const html = await response.text();
          if (html.length > AREA_SEARCH_MAX_BYTES) {
            return { ok: false, error: 'response too large' };
          }

          return { ok: true, html, outcome: assessSearchHtml(html) };
        });
      } catch (error) {
        // Network death, timeout abort, a limiter that failed closed, an
        // adapter that threw — all the same answer to the page: no result,
        // and the reason as text.
        return { ok: false, error: String(error) };
      }
    },
  };
}
