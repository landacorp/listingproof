/**
 * Message protocol between the four extension contexts.
 *
 *   content script  --LISTING_DETECTED-->  service worker
 *   side panel      --REQUEST_STATE----->  service worker
 *   service worker  --STATE-------------> side panel
 *   side panel      --REREPORT----------> content script  (the worker was
 *       evicted and its per-tab state died with it — ask the page to report
 *       itself again rather than dead-ending at "idle")
 *   content script  --PAGE_MOVED--------> service worker  (the page rewrote its
 *       own address without loading a new document; the worker drops the tab's
 *       verdict if that rewrite left the listing it describes)
 *   search page     --SEARCH_AREA_FETCH-> service worker  (carries a QUERY,
 *       never a URL; the worker spells the URL via the site adapter and
 *       returns raw HTML for the page to parse)
 *   search page     --SEARCH_FOCUS_LISTING-> service worker  (analyze one
 *       result in place: the worker fetches the listing page, extracts via
 *       offscreen, and publishes STATE for the search page's tab — the
 *       panel then shows the verdict without the user opening the listing)
 *   service worker  --PARSE_LISTING_HTML-> offscreen document  (MV3 service
 *       workers have no DOMParser, so a listing page the worker fetched on the
 *       search page's behalf is parsed there)
 *
 * The panel is a pure view: it never computes a verdict itself. It renders
 * only STATE stamped with its own window's active tab — every analysis runs
 * per-tab, and an unfiltered broadcast would let a background tab's GREEN
 * replace the active tab's RED.
 */
import type { IdentityVector } from './identity';
import type { ScoreResult } from './signals';
import type { PageContext, ReviewAvailability } from './pagecontext';
import type { AreaSearchQuery } from './areasearch';
import type { CanonicalListing, SearchFetchOutcome } from './sites/types';
import type { ListingTerms, TermsReport } from './terms';
import type { ReviewScan } from './reviewscan';
import type { EngineLStatus } from './enginel';

/**
 * The guest-review reading, plus the one fact `ReviewScan` cannot carry:
 * whether this platform publishes individual reviews in the page at all.
 *
 * `scan` is ABSENT for `not-in-page`, and deliberately so. `scanReviews` on an
 * empty set answers "the page served no guest reviews… that is not a clean
 * record; it is no record" — true of a Booking page that served none, and a
 * fabricated claim about an Airbnb property with 132 reviews the page simply
 * does not embed (see `ReviewAvailability`). Not producing the scan makes that
 * sentence unrepresentable rather than merely unrendered, so no consumer can
 * print it by reading one field and not the other.
 */
export interface ReviewReport {
  availability: ReviewAvailability;
  /** The reading, present only when the platform serves reviews in the page. */
  scan?: ReviewScan;
}

/** Analysis is progressive: the deterministic verdict lands first, the optional LLM pass updates it in place. */
export type AnalysisPhase = 'idle' | 'extracting' | 'checking' | 'done' | 'error';

export interface AnalysisState {
  phase: AnalysisPhase;
  /** Canonical page this state describes. */
  canonicalUrl?: string;
  identity?: IdentityVector;
  result?: ScoreResult;
  /** True while Engine L is still running behind the deterministic verdict. */
  llmPending?: boolean;
  /**
   * Outcome of the optional local-model pass. Present so the panel can offer
   * the upgrade when it is missing — never so it can report a failure. Every
   * value here describes a fully working extension.
   */
  llmStatus?: EngineLStatus;
  /** Consumer advisories about the booking terms, separate from the verdict. */
  termsReport?: TermsReport;
  /**
   * What the page's own guest reviews say. Advisory in exactly the sense
   * `termsReport` is, and for a stronger reason: the reviews are written by
   * other people and SELECTED by the platform, so a planted review must not be
   * able to accuse an honest property. Nothing here reaches `lib/score.ts`.
   *
   * Arrives with the first `done` publish (it is read from the page, but by the
   * pipeline, alongside the verdict) — absent while a tab is still checking.
   */
  reviewReport?: ReviewReport;
  error?: string;
}

export interface ListingDetectedMessage {
  type: 'LISTING_DETECTED';
  vector: IdentityVector;
  url: string;
  /**
   * The canonical identity, resolved by the adapter that actually claimed the
   * page.
   *
   * It travels in the message because only the content script can resolve it:
   * the generic adapter decides from the DOM, not the URL, so the worker asking
   * "which adapter owns this URL?" gets nothing back for a generic page. When
   * that happened, Engine A silently skipped and the listing scored a confident
   * GREEN with no checks run at all.
   */
  canonical?: CanonicalListing;
  /**
   * Booking-terms facts the adapter could read (parking, cancellation,
   * payment). Advisory input only — never part of the tampering verdict.
   */
  terms?: ListingTerms;
  /**
   * Breadcrumbs, nearby POIs, description and review snippets — the inputs for
   * Engine A2/A3 and Engine L. All of it is attacker-authored page text and is
   * treated as untrusted data, never as instructions.
   */
  context: PageContext;
}

export interface RequestStateMessage {
  type: 'REQUEST_STATE';
  /**
   * The tab whose state the panel wants — its own window's active tab. The
   * worker answers for exactly this tab; when the panel could not resolve one
   * it omits the field and the worker falls back to the focused window's
   * active tab.
   */
  tabId?: number;
}

/** Reply to REQUEST_STATE. */
export interface RequestStateResponse {
  /**
   * The tab `state` describes; absent when the worker found no active tab.
   * Present even when the request named the tab, so the shape is uniform —
   * and so a panel that could not resolve its own active tab can adopt the
   * worker's answer instead of dropping every later broadcast.
   */
  tabId?: number;
  state: AnalysisState;
}

export interface StateMessage {
  type: 'STATE';
  /**
   * The tab this state describes. `runtime.sendMessage` reaches every open
   * panel in every window, so the stamp is what lets each panel drop
   * broadcasts about tabs it is not showing.
   */
  tabId: number;
  state: AnalysisState;
}

/**
 * Panel → content script (via `tabs.sendMessage`): report the listing again
 * even though URL and name are unchanged. Sent when the worker answers "idle"
 * for a tab — MV3 eviction wipes the worker's state Map, and the content
 * script's own dedup would otherwise keep the page unreported forever.
 */
export interface RereportMessage {
  type: 'REREPORT';
}

/**
 * Content script → service worker: the page rewrote its own address without
 * loading a new document (a single-page-app navigation, a hash, a History-API
 * push), and this is where it is now.
 *
 * The page is the only context that can see this for free. The worker used to
 * learn it from `tabs.onUpdated`, which costs the `tabs` permission — Chrome's
 * "Read your browsing history" — and still could not see a tab that had moved
 * to a host the extension holds no permission for. A document reporting its
 * own `location` needs nothing, and is authoritative about the one thing
 * `tabs.onUpdated` could only guess at: that no new document loaded.
 *
 * A page can only ever move its OWN tab's state, and only in the direction of
 * forgetting it — the tab id comes from `sender.tab.id`, which the browser
 * fills in, and the worker's only response is to drop state or do nothing. A
 * hostile listing page can already suppress its own verdict by refusing to
 * extract, so this adds no leverage.
 */
export interface PageMovedMessage {
  type: 'PAGE_MOVED';
  /** The page's current `location.href`. */
  url: string;
}

/**
 * Search page → service worker: fetch one page of search results for a
 * validated area query. The message carries a QUERY, never a URL — the
 * worker spells the URL itself via the adapter's `buildSearchUrl`, so a
 * message channel any content script can reach cannot be turned into a
 * fetch-anything proxy.
 */
export interface SearchAreaFetchMessage {
  type: 'SEARCH_AREA_FETCH';
  /** Adapter id, e.g. "booking". Refused unless the adapter can search. */
  platform: string;
  query: AreaSearchQuery;
}

/** Worker's answer. `outcome` is present whenever the fetch itself worked. */
export interface SearchAreaFetchResponse {
  ok: boolean;
  /** Raw results HTML for the page to parse — MV3 workers have no DOMParser. */
  html?: string;
  outcome?: SearchFetchOutcome;
  error?: string;
}

/**
 * Search page → service worker: run the FULL analysis on one search result
 * without the user opening it — the worker fetches the property page itself
 * (the same warm-cookie fetch the search uses), extracts through the
 * offscreen document, and publishes the verdict as the search page's tab
 * state, so the side panel shows it exactly as if the tab were the listing.
 * The worker canonicalizes the URL and refuses anything that is not a
 * listing page — this must never become a fetch-anything proxy.
 */
export interface SearchFocusListingMessage {
  type: 'SEARCH_FOCUS_LISTING';
  url: string;
}

export interface SearchFocusListingResponse {
  ok: boolean;
  error?: string;
}

/**
 * Service worker → offscreen document: parse a listing page the worker fetched
 * for SEARCH_FOCUS_LISTING, exactly the way the content script reads a live
 * page — same adapter registry, same extractors. `url` is the listing's
 * CANONICAL URL (the worker fetched that, not whatever the page sent), and it
 * is what picks the adapter.
 */
export interface ParseListingHtmlMessage {
  type: 'PARSE_LISTING_HTML';
  html: string;
  url: string;
}

export type ExtensionMessage =
  | ListingDetectedMessage
  | RequestStateMessage
  | StateMessage
  | RereportMessage
  | PageMovedMessage
  | SearchAreaFetchMessage
  | SearchFocusListingMessage
  | ParseListingHtmlMessage;
