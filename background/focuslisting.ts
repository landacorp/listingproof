/**
 * Map-area search, phase (d): the worker fetch behind `SEARCH_FOCUS_LISTING`.
 *
 * "Check this result in place": the search page names one of its own result
 * URLs, the worker fetches the listing page with the same warm-cookie fetch
 * the search itself uses, extracts identity/context/terms through the
 * offscreen document, and then feeds a synthesized LISTING_DETECTED into the
 * ordinary per-tab pipeline — so the verdict arrives as the search tab's
 * STATE broadcast and the panel renders it exactly as if the tab were the
 * listing.
 *
 * The message carries a URL, which is precisely what a page-supplied value
 * must never be trusted to be (ROADMAP P1). It is therefore
 * canonicalized-or-refused before any network: only a URL some registered
 * adapter recognises as one of its listing pages is fetched, and what is
 * fetched is the CANONICAL form — the page's tracking params die at this
 * boundary, and the analysis is stamped with the same canonical URL the
 * content-script path would have produced.
 * The answer is held to the same standard as the request: a fetch that
 * followed a redirect somewhere else is refused, never stamped with the
 * identity of the page we asked for.
 *
 * Never throws. Every failure resolves to `{ok: false, error}` — the page gets
 * an answer, not a dead `sendResponse` channel. The `{ok: true}` answer means
 * "accepted and analysis started"; the verdict itself arrives via STATE.
 *
 * One verdict at a time, and only the one asked for last. A search tab shows a
 * single verdict, so clicking through results must not multiply third-party
 * traffic behind the user's back: repeat clicks on the SAME result join the
 * flight already running, a burst across DIFFERENT results is capped
 * (`FOCUS_MAX_IN_FLIGHT_PER_TAB`), and a flight whose listing is no longer the
 * tab's latest request says nothing at all — neither a verdict nor a failure,
 * because it answered a question the user has already replaced and the newer
 * check owns both the panel and the page's status line.
 *
 * And only onto the page that asked. A check takes seconds; the tab can
 * navigate inside that window, and a verdict published afterwards would create
 * per-tab state for a page showing nothing related to it — the false display
 * the panel's tab filtering (ROADMAP P0-1) exists to prevent, arriving from
 * behind. So the asking PAGE is identified when the request is accepted and
 * re-checked before publishing; a page that is gone is answered with silence.
 *
 * "Which page" is a presence token from `lib/presence.ts` — the search page's
 * own `runtime.connect` port — not the tab's URL. That used to be
 * `browser.tabs.get(tabId).url`, which bought this one comparison at the price
 * of the `tabs` permission ("Read your browsing history" in the install
 * dialog). The port is strictly better anyway: a RELOAD of the search page
 * keeps its URL but destroys the result list the user was looking at, and a
 * verdict for a result that no longer exists is exactly the false display this
 * guard exists to prevent. A reload is a new document, so it is a new token.
 *
 * Wiring: the service worker must create ONE handler and share it. Each
 * instance that falls back to its own default limiter is a separate politeness
 * budget, and two of them fetch twice as fast as this module promises.
 */
import { createRateLimiter, type RateLimiter } from '../lib/ratelimit';
import { adapterForUrl } from '../lib/sites/registry';
import type { IdentityVector } from '../lib/identity';
import type {
  ListingDetectedMessage,
  SearchFocusListingMessage,
  SearchFocusListingResponse,
} from '../lib/messages';
import type { PageContext } from '../lib/pagecontext';
import type { CanonicalListing } from '../lib/sites/types';
import type { ListingTerms } from '../lib/terms';

/**
 * 2500 ms between fetch starts — the same figure, and the same reasoning, as
 * `AREA_SEARCH_MIN_INTERVAL_MS`, but deliberately a separate limiter instance:
 * politeness is budgeted per feature, and a user clicking through results
 * while a search is in flight should look like two polite features, not one
 * rude one racing itself.
 */
export const FOCUS_FETCH_MIN_INTERVAL_MS = 2500;

/**
 * 30 s ceiling on a single fetch, armed inside the limiter slot so it budgets
 * the request and not the queue wait. Property pages sit behind the same
 * bot-scoring CDNs the results pages do, and a timeout costs one check the
 * user can simply retry.
 */
export const FOCUS_FETCH_TIMEOUT_MS = 30_000;

/**
 * 5 MB body cap, checked twice (advisory Content-Length before buffering,
 * authoritative string length after) — the OOM defense `areasearch.ts`
 * documents in full. A captured Booking property page is ~1.7 MB; triple that
 * is not a listing page, and the honest answer is refusal, not a truncated
 * parse.
 */
export const FOCUS_MAX_BYTES = 5 * 1024 * 1024;

/**
 * At most 3 DISTINCT listing checks in flight per search tab.
 *
 * The tab displays one verdict, so every check beyond the newest is traffic
 * nobody will ever look at — and each accepted fetch also holds the 2500 ms
 * politeness slot, so an unbounded burst keeps fetching long after the user
 * has moved on. Repeat clicks on the same result cost nothing (they join the
 * running flight), so this bounds only genuine mind-changing: three leaves
 * room for "wrong one — this one — no, that one" and refuses the rest.
 * Refusal is the honest answer: the click visibly did nothing and can be
 * repeated a moment later, which is strictly better than a queue the user
 * cannot see or stop.
 *
 * A count rather than a cooldown, deliberately: it needs no clock (so tests
 * stay deterministic without a fake one), and it clears itself exactly when
 * the cost it bounds — an outstanding fetch — is gone, instead of blocking a
 * user who is simply reading faster than a fixed timer expects.
 */
export const FOCUS_MAX_IN_FLIGHT_PER_TAB = 3;

/** What the offscreen parse yields: the fields a LISTING_DETECTED carries. */
export interface ParsedListing {
  vector: IdentityVector;
  context: PageContext;
  terms?: ListingTerms;
}

export interface FocusListingOptions {
  /** Injectable `fetch` for tests. Defaults to the global. */
  fetchImpl?: typeof fetch;
  /** Shared politeness limiter. Defaults to a private one — see the module note. */
  limiter?: RateLimiter;
  /**
   * URL → canonical listing identity, or null for anything that is not a
   * listing page. Defaults to the adapter registry. This is the proxy gate:
   * whatever this returns null for is never fetched.
   */
  canonicalize?: (url: string) => CanonicalListing | null;
  /**
   * Parse fetched listing HTML into the LISTING_DETECTED fields, or null when
   * the page does not extract. Production: the offscreen document's
   * PARSE_LISTING_HTML round-trip (`entrypoints/background.ts`).
   */
  parseListingHtml: (html: string, canonicalUrl: string) => Promise<ParsedListing | null>;
  /**
   * Sink for the synthesized detection. Production: `tabs.handleListingDetected`
   * — the same entry point a content-script report takes, so supersession,
   * progressive publishes and eviction behavior all come for free.
   */
  onListingDetected: (message: ListingDetectedMessage, tabId: number) => void | Promise<void>;
  /**
   * Ceiling on distinct in-flight checks per tab. Defaults to
   * `FOCUS_MAX_IN_FLIGHT_PER_TAB`; injectable so a test can reach the cap
   * without holding three real flights open.
   */
  maxInFlightPerTab?: number;
  /**
   * Which page is connected from a tab right now, or undefined when none is —
   * a closed tab, a page that has navigated away, or a worker whose port
   * bookkeeping has no entry for it. Production: the presence registry in
   * `entrypoints/background.ts`.
   *
   * Synchronous by construction: the registry is a Map the worker already
   * holds, so unlike the `tabs.get()` round trip it replaced there is no await
   * between deciding to publish and publishing, and therefore no window for a
   * newer click to slip through it.
   *
   * Defaults to "never knew", which skips the publish-time check entirely: a
   * handler wired without this cannot tell a departed page from a present one,
   * and inventing an answer would suppress verdicts rather than protect them.
   */
  askerToken?: (tabId: number) => number | undefined;
}

export interface FocusListingHandler {
  handle(message: SearchFocusListingMessage, tabId: number): Promise<SearchFocusListingResponse>;
}

/** Registry-backed default for `canonicalize`. */
function registryCanonicalize(url: string): CanonicalListing | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  return adapterForUrl(url)?.canonicalize(parsed) ?? null;
}

export function createFocusListingHandler(options: FocusListingOptions): FocusListingHandler {
  const doFetch: typeof fetch = options.fetchImpl ?? ((input, init) => fetch(input, init));
  const limiter =
    options.limiter ?? createRateLimiter({ minIntervalMs: FOCUS_FETCH_MIN_INTERVAL_MS });
  const canonicalize = options.canonicalize ?? registryCanonicalize;
  const { parseListingHtml, onListingDetected } = options;
  const maxInFlightPerTab = options.maxInFlightPerTab ?? FOCUS_MAX_IN_FLIGHT_PER_TAB;
  const askerToken = options.askerToken ?? ((): number | undefined => undefined);

  /** Canonical URLs currently being fetched/parsed, per search tab. */
  const inFlight = new Map<number, Set<string>>();
  /** The canonical URL each tab asked for LAST; older flights publish nothing. */
  const latest = new Map<number, string>();

  /**
   * Retire one flight. There is no tab-removal signal in this module, so the
   * bookkeeping is scoped to the flights themselves: the last one to settle
   * takes the tab's entries with it, and the maps cannot outgrow the work
   * actually outstanding.
   */
  function settle(tabId: number, canonicalUrl: string): void {
    const flights = inFlight.get(tabId);
    if (flights === undefined) return;
    flights.delete(canonicalUrl);
    if (flights.size > 0) return;
    inFlight.delete(tabId);
    latest.delete(tabId);
  }

  /**
   * Is the page that asked for this check still there?
   *
   * `asked === undefined` means the wiring cannot answer the question (no
   * `askerToken` injected, or the page had no port when the request was
   * accepted) — an unknown, and an unknown must not silence a verdict the user
   * is waiting for. Anything else is a comparison of page identities: no token
   * means the document is gone (navigated, reloaded, closed), and a DIFFERENT
   * token means a later document owns the tab now. Both leave nobody to show
   * this verdict to.
   */
  function stillTheAskingPage(tabId: number, asked: number | undefined): boolean {
    if (asked === undefined) return true;
    return askerToken(tabId) === asked;
  }

  return {
    async handle(
      message: SearchFocusListingMessage,
      tabId: number,
    ): Promise<SearchFocusListingResponse> {
      // Canonicalize-or-refuse before any network. A URL no adapter claims as
      // a listing page is not fetched at all — this handler must never become
      // a fetch-anything proxy.
      const canonical = canonicalize(message.url);
      if (canonical === null) {
        return { ok: false, error: 'not a recognized listing URL' };
      }
      const canonicalUrl = canonical.canonicalUrl;

      const flights = inFlight.get(tabId);
      if (flights !== undefined && flights.has(canonicalUrl)) {
        // An impatient second click on the SAME result. The check the user is
        // asking for is already running, so this starts no second fetch and no
        // second analysis — but it does make this listing the tab's latest
        // request again, which matters when the user came back to it after
        // clicking something else.
        latest.set(tabId, canonicalUrl);
        return { ok: true };
      }

      if (flights !== undefined && flights.size >= maxInFlightPerTab) {
        // Refused without touching `latest`: nothing was started, and letting
        // a rejected click claim the tab would silence the flight that IS
        // running and leave the user with no verdict at all.
        return { ok: false, error: 'too many listing checks already running for this tab' };
      }

      const tabFlights = flights ?? new Set<string>();
      if (flights === undefined) inFlight.set(tabId, tabFlights);
      tabFlights.add(canonicalUrl);
      latest.set(tabId, canonicalUrl);

      // Which page is asking, captured now and compared at publish time. A
      // plain Map read, so unlike the `tabs.get()` round trip this replaced it
      // costs the accept path nothing and needs no "started, not awaited"
      // dance to keep a burst of clicks from queueing behind it.
      const askedBy = askerToken(tabId);

      /**
       * A refusal is news only while this flight still owns the tab. A stale
       * flight's failure — a redirect, an over-cap body, a dead network —
       * would otherwise repaint the status line of the check the user is
       * actually waiting for, turning someone else's success into a visible
       * error. Superseded flights answer exactly as the superseded success
       * path does: `ok`, with nothing to say. The page reads that as "accepted,
       * the panel takes it from here" and leaves the newer check's own line
       * standing, which is precisely the truth.
       *
       * (A dedicated `superseded` flag on `SearchFocusListingResponse` would
       * say this outright rather than by convention; the shape is shared and
       * not this module's to widen.)
       */
      const answer = (response: SearchFocusListingResponse): SearchFocusListingResponse =>
        latest.get(tabId) === canonicalUrl ? response : { ok: true };

      try {
        // The limiter slot covers exactly the fetch: parsing and analysis
        // spend no politeness budget.
        const fetched = await limiter.run(
          async (): Promise<{ html: string } | { refusal: string }> => {
            const response = await doFetch(canonicalUrl, {
              credentials: 'include',
              cache: 'no-store',
              headers: { Accept: 'text/html,application/xhtml+xml' },
              // Created here rather than before the queue wait, so the budget
              // covers the request and not the time spent waiting for a slot.
              signal: AbortSignal.timeout(FOCUS_FETCH_TIMEOUT_MS),
            });

            // `fetch` follows redirects, so the body need not come from the
            // page we asked for: Booking can answer with a different property,
            // a login wall or a consent interstitial. Whatever arrives is
            // stamped with the REQUESTED canonical URL downstream, so a
            // redirect that lands elsewhere would attribute one listing's
            // identity to another — checked here, before the body is read at
            // all. An empty `response.url` (synthesized responses, test
            // doubles) carries no redirect information and is left alone; it
            // is not evidence of a redirect.
            const landedUrl: string | undefined = response.url;
            if (landedUrl !== undefined && landedUrl !== '') {
              // Through the same gate the request came through: a landing URL
              // no adapter claims canonicalizes to null and is refused with
              // the rest.
              if (canonicalize(landedUrl)?.canonicalUrl !== canonicalUrl) {
                return { refusal: 'redirected away from the requested listing' };
              }
            }

            // Declared-size check before buffering the body at all.
            const declared = response.headers.get('content-length');
            if (declared !== null) {
              const size = Number(declared);
              if (Number.isFinite(size) && size > FOCUS_MAX_BYTES) {
                return { refusal: 'response too large' };
              }
            }

            // No status gate: a challenge stub or an error page simply fails
            // to extract downstream, which is the honest outcome for it.
            const html = await response.text();
            if (html.length > FOCUS_MAX_BYTES) {
              return { refusal: 'response too large' };
            }
            return { html };
          },
        );
        if ('refusal' in fetched) {
          return answer({ ok: false, error: fetched.refusal });
        }

        const parsed = await parseListingHtml(fetched.html, canonicalUrl);
        if (parsed === null) {
          // Bot challenge, error page, or markup no adapter reads — an honest
          // "could not check", never a GRAY-less silence in the panel.
          return answer({ ok: false, error: 'listing page could not be extracted' });
        }

        // Superseded: the user's own newer click owns this tab now — another
        // result, or a return to this one whose fresh flight must not be
        // shadowed by this stale one. The same rule `background/tabstate.ts`
        // applies to its runs, applied one step earlier: the work still runs
        // to completion, it just publishes nothing, because only the newest
        // check can ever be the one on screen. Answered `ok` rather than as a
        // failure — nothing failed, the user moved on, and a late error would
        // paint over the newer check's own status line.
        if (latest.get(tabId) !== canonicalUrl) {
          return { ok: true };
        }

        // ...and the page that asked must still be there. This check has been
        // in the air for seconds; the tab may have gone to the listing itself,
        // to another result, or somewhere unrelated, and the search page may
        // simply have been reloaded — and its per-tab state was dropped when
        // it did. Publishing now would resurrect a verdict for a page that no
        // longer exists: the same false display P0-1 fixed in the panel,
        // arriving from behind. Nothing is reported to the page either: the
        // page that asked is gone.
        //
        // No await here, deliberately — the supersession check above is still
        // the newest word on this tab when this runs.
        if (!stillTheAskingPage(tabId, askedBy)) {
          return { ok: true };
        }

        // Synthesize what the content script would have sent from this page.
        // `url` is the canonical URL — it is the page that was actually
        // fetched, and the pipeline derives canonicalUrl from it either way.
        const detected: ListingDetectedMessage = {
          type: 'LISTING_DETECTED',
          vector: parsed.vector,
          url: canonicalUrl,
          canonical,
          ...(parsed.terms === undefined ? {} : { terms: parsed.terms }),
          context: parsed.context,
        };

        // Fire and forget: the pipeline can run for minutes (archive pass) and
        // the verdict travels via STATE, not via this response. The async
        // wrapper funnels a sync throw and an async rejection into the same
        // swallow — a failing sink must not retract an accepted detection,
        // and the production sink (`handleListingDetected`) never rejects.
        void (async () => onListingDetected(detected, tabId))().catch(() => {});

        return { ok: true };
      } catch (error) {
        // Network death, timeout abort, a limiter that failed closed, a parse
        // round-trip that rejected — all the same answer: no result, and the
        // reason as text.
        return answer({ ok: false, error: String(error) });
      } finally {
        // Whatever happened — published, superseded, refused, threw — this
        // flight is over and must stop counting against the tab's cap and its
        // deduplication.
        settle(tabId, canonicalUrl);
      }
    },
  };
}
