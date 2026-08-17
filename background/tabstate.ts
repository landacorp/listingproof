import { adapterForUrl } from '../lib/sites/registry';
import { evaluateTerms } from '../lib/terms';
import type { AnalysisState, ListingDetectedMessage } from '../lib/messages';
import type { PipelineOutcome } from './pipeline';

/**
 * Per-tab analysis state machine: LISTING_DETECTED in, progressive STATE
 * publishes out (checking → done → LLM-refined done).
 *
 * Kept free of `chrome.*` — the analysis itself and the browser-facing
 * broadcast arrive as injected deps — for the same reason `pipeline.ts` is:
 * so the publish lifecycle can be tested end to end with fakes.
 * `entrypoints/background.ts` owns the browser side and injects the real
 * pipeline and `runtime.sendMessage`.
 *
 * Supersession: the same tab legitimately shows different listings over time
 * (the content script re-reports on same-tab navigation, SPA or full load),
 * and analysis is slow — the optional local model can run for many seconds.
 * Every publish that follows an await therefore re-checks that its run is
 * still the tab's LATEST report, or a stale run's verdict would paint over the
 * listing the user is now reading — the same-tab analogue of the bug fixed in
 * P0-1, which tab identity alone cannot catch. Runs are compared by identity,
 * not by URL: the content script also re-reports when a hydrating page's
 * name firms up at an unchanged URL, and that newer same-URL run carries the
 * better vector, not a duplicate. The superseded run itself still runs to
 * completion; cancelling it is the remaining half of the ROADMAP P1 item.
 *
 * Navigation: a tab that left the page its state describes must not keep
 * showing that page's verdict — the P0-1 invariant, applied to the tab itself
 * rather than to the panel. Two signals arrive, and neither costs a
 * permission (the pair replaced `tabs.onUpdated` + `tabs.get(id).url`, which
 * cost the `tabs` permission and, worse, could not see a tab that left for a
 * host the extension holds no permission for — the commonest departure there
 * is):
 *
 *  - `dropForDeparture`: the page's presence port disconnected
 *    (`lib/presence.ts`), so its DOCUMENT is gone — navigated, reloaded,
 *    closed. Nothing to compare: whatever this tab was showing, the page that
 *    produced it no longer exists.
 *  - `dropIfNavigatedAway`: the page rewrote its own address without loading a
 *    new document, and said so. Only the content script can see that, and only
 *    from inside the page — so it is reported, not inferred, and "did that URL
 *    change load a new document?" stops being a heuristic.
 *
 * Both publish `idle` as well as forgetting: dropping alone leaves the panel
 * rendering the verdict it last received until something else makes it
 * re-request, which is precisely the false display these paths exist to end.
 * A closed tab (`drop`) is the exception — there is no panel showing it.
 */

export interface TabStateDeps {
  /** The deterministic pass (`analyzeFirstPass`): Engine A, scored. */
  analyze(message: ListingDetectedMessage): Promise<PipelineOutcome>;
  /** The optional LLM pass (`refineWithLlm`); null when nothing changed. */
  refine(message: ListingDetectedMessage, outcome: PipelineOutcome): Promise<PipelineOutcome | null>;
  /** Browser-facing broadcast. Recording the state in the map is internal. */
  sendState(tabId: number, state: AnalysisState): void;
}

export interface TabStates {
  handleListingDetected(message: ListingDetectedMessage, tabId: number): Promise<void>;
  get(tabId: number): AnalysisState | undefined;
  /**
   * Forget a tab entirely, so nothing outlives the visit. For a tab that is
   * GONE: no panel can be showing it, so nothing is published.
   */
  drop(tabId: number): void;
  /**
   * The page whose analysis this tab is showing has been destroyed — it
   * navigated, reloaded, or closed, and its presence port disconnected.
   * Forgets the state and tells the panel, which is otherwise still rendering
   * the verdict for a page that no longer exists.
   */
  dropForDeparture(tabId: number): void;
  /**
   * A tab's page rewrote its own address to `url` WITHOUT loading a new
   * document, and reported it. Forgets the state only when that rewrite means
   * the page left the listing the state describes — see the implementation for
   * what counts as "left".
   *
   * `url === undefined` means the caller could not say where the page is,
   * which is no evidence of anything and changes nothing.
   */
  dropIfNavigatedAway(tabId: number, url: string | undefined): void;
}

/**
 * How far up a path to look for the listing a sub-page belongs to.
 *
 * Platforms hang extra views off a listing's own path — Airbnb's photo viewer
 * is `/rooms/<id>/photos` — and no adapter claims those as listing pages, even
 * though the tab has not left the listing at all. Two segments covers the
 * shapes that exist; deeper would be guessing.
 */
const SUBPAGE_LOOKUP_DEPTH = 2;

/** The canonical listing a URL belongs to, or null if it is not part of one. */
function listingFor(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const own = adapterForUrl(url)?.canonicalize(parsed)?.canonicalUrl;
  if (own !== undefined) return own;
  const segments = parsed.pathname.split('/').filter((segment) => segment !== '');
  for (let up = 1; up <= SUBPAGE_LOOKUP_DEPTH && segments.length - up > 0; up += 1) {
    const parent = new URL(parsed.href);
    parent.pathname = `/${segments.slice(0, segments.length - up).join('/')}`;
    const listing = adapterForUrl(parent.href)?.canonicalize(parent)?.canonicalUrl;
    if (listing !== undefined) return listing;
  }
  return null;
}

export function createTabStates(deps: TabStateDeps): TabStates {
  const state = new Map<number, AnalysisState>();
  /** The run each tab currently belongs to; publishes from any other run are dropped. */
  const latestRun = new Map<number, number>();
  let runCounter = 0;

  function publish(tabId: number, next: AnalysisState): void {
    state.set(tabId, next);
    deps.sendState(tabId, next);
  }

  async function handleListingDetected(
    message: ListingDetectedMessage,
    tabId: number,
  ): Promise<void> {
    const runId = ++runCounter;
    latestRun.set(tabId, runId);
    const canonical =
      message.canonical ?? adapterForUrl(message.url)?.canonicalize(new URL(message.url)) ?? null;
    const canonicalUrl = canonical?.canonicalUrl ?? message.url;
    // Advisories are computed once, up front: they read the page's stated terms
    // and touch no network, so they are ready before the engines are and ride
    // along with every state publish.
    const termsReport = evaluateTerms(message.terms);
    publish(tabId, {
      phase: 'checking',
      canonicalUrl,
      identity: message.vector,
      termsReport,
    });

    // True once a newer report owns this tab — a navigation to another
    // listing, a same-URL re-report from a page that finished hydrating
    // (whose fuller vector must win over this run's partial one), a return
    // to this same listing (whose fresh run must not be shadowed by this
    // stale one) — or once the tab was dropped and nothing may publish.
    const superseded = () => latestRun.get(tabId) !== runId;

    try {
      // The deterministic verdict goes on screen the moment Engine A has it —
      // the user never waits on the local model.
      const outcome = await deps.analyze(message);
      if (superseded()) return; // a newer listing owns this tab now
      publish(tabId, {
        phase: 'done',
        canonicalUrl,
        identity: message.vector,
        result: outcome.result,
        llmPending: true,
        termsReport,
        // Read from the page by the first pass, like the terms — and like them
        // it rides along with every later publish rather than being recomputed.
        reviewReport: outcome.reviewReport,
      });

      // Engine L runs behind the verdict that is already on screen: it is
      // optional, slow (a local model), and by contract cannot make the answer
      // worse — so the user should never wait on it.
      void deps
        .refine(message, outcome)
        .then((refined) => {
          if (superseded()) return; // only redraw for the listing still shown
          publish(tabId, {
            phase: 'done',
            canonicalUrl,
            identity: message.vector,
            result: (refined ?? outcome).result,
            llmPending: false,
            llmStatus: (refined ?? outcome).llmStatus,
            termsReport,
            reviewReport: (refined ?? outcome).reviewReport,
          });
        })
        .catch(() => {
          if (superseded()) return;
          publish(tabId, {
            phase: 'done',
            canonicalUrl,
            identity: message.vector,
            result: outcome.result,
            llmPending: false,
            llmStatus: 'failed',
            termsReport,
            reviewReport: outcome.reviewReport,
          });
        });
    } catch (error) {
      if (superseded()) return; // a stale failure is not this listing's news
      publish(tabId, {
        phase: 'error',
        canonicalUrl,
        identity: message.vector,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  function drop(tabId: number): void {
    state.delete(tabId);
    latestRun.delete(tabId);
  }

  /**
   * Forget this tab's state AND say so, for a tab that still exists. Silent
   * when there was nothing on screen: an `idle` broadcast for a tab nobody
   * ever analysed is noise, and the panel already renders idle for it.
   */
  function dropForDeparture(tabId: number): void {
    if (!state.has(tabId)) return;
    drop(tabId);
    // The panel keeps rendering the last STATE it received until something
    // replaces it; without this, the verdict for the page just left would
    // stay on screen until the user happened to switch tabs.
    deps.sendState(tabId, { phase: 'idle' });
  }

  /**
   * Did an in-document address rewrite leave the page its state describes?
   *
   * The naive rule — "any URL change drops the state" — is wrong on the two
   * platforms this extension exists for. Booking and Airbnb are single-page
   * apps that rewrite the address bar constantly while standing still: opening
   * the photo gallery, expanding a room rate, a hash anchor. Dropping there
   * kills a running analysis on the very listing the user is looking at, and
   * dead-ends the panel on a page whose content script has nothing new to
   * re-report.
   *
   * So the comparison is between IDENTITIES, not URLs: the same listing under
   * a locale suffix, tracking params, a country domain or a sub-page is the
   * same listing, and the page has not gone anywhere.
   *
   * Every URL that reaches here came from a document that is STILL RUNNING and
   * reported its own `location` — a departure destroys the document and
   * arrives as `dropForDeparture` instead. So "the document did not change" is
   * a fact here, not the `changeInfo.status` guess it used to be, and the one
   * case that turns on it is safe to decide: a listing served by the generic
   * adapter has no URL-resolvable identity on either side of the comparison,
   * so a rewrite there is indistinguishable from leaving. Blind and
   * mid-flight, on a page we know is still alive: keep.
   */
  function navigatedAway(showing: AnalysisState, url: string): boolean {
    const shown = showing.canonicalUrl;
    const next = listingFor(url);
    // The same listing, however it is spelled now.
    if (next !== null && next === shown) return false;
    // A different listing: the page moved, and its own content script is about
    // to report the new one.
    if (next !== null) return true;
    // Not a listing URL at all — a search page, a login wall, somewhere else
    // entirely — unless neither side resolves, which is the blind case above.
    return shown !== undefined && listingFor(shown) !== null;
  }

  return {
    handleListingDetected,
    get: (tabId) => state.get(tabId),
    drop,
    dropForDeparture,
    dropIfNavigatedAway: (tabId, url) => {
      if (url === undefined) return;
      const showing = state.get(tabId);
      // Nothing on screen for this tab, so nothing can be wrong about it.
      if (showing === undefined) return;
      if (!navigatedAway(showing, url)) return;
      dropForDeparture(tabId);
    },
  };
}
