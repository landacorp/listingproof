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
 * Navigation (`dropIfNavigatedAway`): a tab that left the page its state
 * describes must not keep showing that page's verdict — the P0-1 invariant,
 * applied to the tab itself rather than to the panel. The decision lives here,
 * with the state it protects, because it needs to know what the tab is
 * currently showing; `entrypoints/background.ts` only translates Chrome's
 * `tabs.onUpdated` into "the tab is at this URL now".
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
  /** Forget a tab entirely, so nothing outlives the visit. */
  drop(tabId: number): void;
  /**
   * A tab is now at `url`. Forgets its state only when the tab has genuinely
   * left the page that state describes — see `NavigationHint` for why the
   * caller's `sameDocument` guess matters, and the implementation for what
   * counts as "left".
   *
   * `url === undefined` means the caller could not find out where the tab is,
   * which is no evidence of anything and changes nothing.
   */
  dropIfNavigatedAway(tabId: number, url: string | undefined, hint?: NavigationHint): void;
}

export interface NavigationHint {
  /**
   * True when the URL changed without loading a new document (History API,
   * hash). Only ever used to keep state that would otherwise be dropped, so a
   * caller that cannot tell should leave it out.
   */
  sameDocument?: boolean;
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
   * Did the tab leave the page its state describes?
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
   * same listing, and the tab has not gone anywhere.
   *
   * What Chrome does not tell us is whether a URL change loaded a new document.
   * `changeInfo.status` accompanies real loads and is absent from History-API
   * rewrites, which is a heuristic, not a contract — so it is used in one
   * direction only: to KEEP state we would otherwise drop. A stale verdict for
   * the page the tab is still on is a small wrong; destroying a running
   * analysis is a large one.
   */
  function navigatedAway(
    showing: AnalysisState,
    url: string,
    hint: NavigationHint | undefined,
  ): boolean {
    const shown = showing.canonicalUrl;
    const next = listingFor(url);
    // The same listing, however it is spelled now.
    if (next !== null && next === shown) return false;
    // A different listing: the tab moved, and its own content script is about
    // to report the new one.
    if (next !== null) return true;
    // Not a listing URL at all. Usually that is exactly what it looks like —
    // the tab left for a search page, a login wall, somewhere else entirely —
    // but a listing served by the generic adapter has no URL-resolvable
    // identity to compare against either, so a same-document rewrite there is
    // indistinguishable from leaving. Blind and mid-flight: keep.
    if (hint?.sameDocument === true && (shown === undefined || listingFor(shown) === null)) {
      return false;
    }
    return true;
  }

  return {
    handleListingDetected,
    get: (tabId) => state.get(tabId),
    drop,
    dropIfNavigatedAway: (tabId, url, hint) => {
      if (url === undefined) return;
      const showing = state.get(tabId);
      // Nothing on screen for this tab, so nothing can be wrong about it.
      if (showing === undefined) return;
      if (!navigatedAway(showing, url, hint)) return;
      drop(tabId);
    },
  };
}
