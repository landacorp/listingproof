import { describe, expect, it, vi } from 'vitest';
import { createTabStates } from './tabstate';
import type { TabStateDeps } from './tabstate';
import type { PipelineOutcome } from './pipeline';
import type { AnalysisState, ListingDetectedMessage } from '../lib/messages';
import type { ScoreResult } from '../lib/signals';

const IDENTITY = {
  name: 'Paris Eiffel Residence',
  address: '12 Rue Desaix, 75015 Paris, France',
  city: 'Paris',
  photoUrls: [],
  capturedAt: '2026-08-11T12:00:00.000Z',
  source: { kind: 'live' as const },
};

function listingMessage(canonicalUrl: string, name = IDENTITY.name): ListingDetectedMessage {
  return {
    type: 'LISTING_DETECTED',
    url: canonicalUrl,
    vector: { ...IDENTITY, name },
    canonical: { platform: 'booking', canonicalUrl, cdxPrefix: canonicalUrl.replace('https://', '') },
    context: { breadcrumbs: [], pois: [], reviews: [] },
  };
}

const LISTING_A = listingMessage('https://www.booking.com/hotel/fr/gite-a.html');
const LISTING_B = listingMessage('https://www.booking.com/hotel/fr/hotel-b.html');

function scored(verdict: ScoreResult['verdict']): PipelineOutcome {
  return {
    result: { verdict, signals: [], reasons: [], llmCapped: false },
    signals: [],
    scoring: { identityComplete: true },
  };
}

interface Deferred<T> {
  resolve(value: T): void;
  reject(reason?: unknown): void;
}

/**
 * Deps double: analyze and refine hand back deferreds so tests decide exactly
 * when — and in what order — runs finish.
 */
function makeDeps() {
  const analyses: Array<Deferred<PipelineOutcome>> = [];
  const refines: Array<Deferred<PipelineOutcome | null>> = [];
  const sent: Array<{ tabId: number; state: AnalysisState }> = [];
  const deps: TabStateDeps = {
    analyze: vi.fn(
      () =>
        new Promise<PipelineOutcome>((resolve, reject) => {
          analyses.push({ resolve, reject });
        }),
    ),
    refine: vi.fn(
      () =>
        new Promise<PipelineOutcome | null>((resolve, reject) => {
          refines.push({ resolve, reject });
        }),
    ),
    sendState: vi.fn((tabId: number, state: AnalysisState) => {
      sent.push({ tabId, state });
    }),
  };
  return { deps, analyses, refines, sent };
}

/** Let queued promise callbacks run. */
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

const phasesOf = (sent: Array<{ state: AnalysisState }>) =>
  sent.map(({ state }) => `${state.phase}:${state.canonicalUrl ?? ''}`);

const donePublishes = (sent: Array<{ state: AnalysisState }>) =>
  sent.filter(({ state }) => state.phase === 'done');

describe('progressive publish lifecycle', () => {
  it('publishes checking, then the deterministic verdict with the LLM pass pending', async () => {
    const { deps, analyses, sent } = makeDeps();
    const tabs = createTabStates(deps);
    const handling = tabs.handleListingDetected(LISTING_A, 7);
    analyses[0]!.resolve(scored('RED'));
    await handling;

    expect(phasesOf(sent)).toEqual([
      `checking:${LISTING_A.canonical!.canonicalUrl}`,
      `done:${LISTING_A.canonical!.canonicalUrl}`,
    ]);
    expect(sent[1]!.state.llmPending).toBe(true);
    expect(tabs.get(7)).toEqual(sent[1]!.state);
  });

  it('the deterministic verdict is on screen before the LLM pass finishes', async () => {
    // The reason the publish is staged at all: Engine L is a local model and
    // can run for many seconds. The user must not be waiting on it, and
    // `handleListingDetected` must not be either.
    const { deps, analyses, refines, sent } = makeDeps();
    const tabs = createTabStates(deps);
    const handling = tabs.handleListingDetected(LISTING_A, 7);

    analyses[0]!.resolve(scored('YELLOW'));
    await handling; // resolves with the LLM pass still outstanding

    expect(refines).toHaveLength(1);
    const shown = sent.at(-1)!.state;
    expect(shown.phase).toBe('done');
    expect(shown.result?.verdict).toBe('YELLOW');
    expect(shown.llmPending).toBe(true);
  });

  it('repaints with the refined result once the LLM pass lands', async () => {
    const { deps, analyses, refines, sent } = makeDeps();
    const tabs = createTabStates(deps);
    const handling = tabs.handleListingDetected(LISTING_A, 7);
    analyses[0]!.resolve(scored('YELLOW'));
    await handling;
    refines[0]!.resolve({ ...scored('RED'), llmStatus: 'ran' });
    await settle();

    const last = sent.at(-1)!.state;
    expect(last.llmPending).toBe(false);
    expect(last.llmStatus).toBe('ran');
    expect(last.result?.verdict).toBe('RED');
  });

  it('keeps the deterministic verdict and marks the LLM pass failed when it throws', async () => {
    const { deps, analyses, refines, sent } = makeDeps();
    const tabs = createTabStates(deps);
    const handling = tabs.handleListingDetected(LISTING_A, 7);
    analyses[0]!.resolve(scored('YELLOW'));
    await handling;
    refines[0]!.reject(new Error('model gone'));
    await settle();

    const last = sent.at(-1)!.state;
    expect(last.llmPending).toBe(false);
    expect(last.llmStatus).toBe('failed');
    expect(last.result?.verdict).toBe('YELLOW');
  });

  it('publishes the error state when analysis fails', async () => {
    const { deps, analyses, sent } = makeDeps();
    const tabs = createTabStates(deps);
    const handling = tabs.handleListingDetected(LISTING_A, 7);
    analyses[0]!.reject(new Error('offscreen died'));
    await handling;

    const last = sent.at(-1)!.state;
    expect(last.phase).toBe('error');
    expect(last.error).toBe('offscreen died');
  });
});

describe('same-tab supersession', () => {
  it("a slow run's verdict cannot paint over the listing the tab now shows", async () => {
    const { deps, analyses, sent } = makeDeps();
    const tabs = createTabStates(deps);

    // Tab 7 shows listing A; its analysis grinds on.
    const handlingA = tabs.handleListingDetected(LISTING_A, 7);
    // The user navigates the same tab to listing B, which analyses quickly.
    const handlingB = tabs.handleListingDetected(LISTING_B, 7);
    analyses[1]!.resolve(scored('RED'));
    await handlingB;
    // Listing A's stale analysis finally resolves — GREEN, for a page the
    // user is no longer reading. It must not replace B's RED.
    analyses[0]!.resolve(scored('GREEN'));
    await handlingA;

    expect(donePublishes(sent).every(({ state }) => state.result?.verdict === 'RED')).toBe(true);
    expect(tabs.get(7)?.result?.verdict).toBe('RED');
  });

  it('does not start the LLM pass for a superseded run', async () => {
    const { deps, analyses } = makeDeps();
    const tabs = createTabStates(deps);
    const handlingA = tabs.handleListingDetected(LISTING_A, 7);
    void tabs.handleListingDetected(LISTING_B, 7);
    analyses[0]!.resolve(scored('GREEN'));
    await handlingA;

    expect(deps.refine).not.toHaveBeenCalled();
  });

  it("a stale run's failure is not the new listing's error", async () => {
    const { deps, analyses, sent } = makeDeps();
    const tabs = createTabStates(deps);
    const handlingA = tabs.handleListingDetected(LISTING_A, 7);
    const handlingB = tabs.handleListingDetected(LISTING_B, 7);
    analyses[1]!.resolve(scored('RED'));
    await handlingB;
    analyses[0]!.reject(new Error('geocoder timeout'));
    await handlingA;

    expect(sent.every(({ state }) => state.phase !== 'error')).toBe(true);
    expect(tabs.get(7)?.result?.verdict).toBe('RED');
  });

  it('a stale LLM repaint is dropped after same-tab navigation', async () => {
    const { deps, analyses, refines, sent } = makeDeps();
    const tabs = createTabStates(deps);
    const handlingA = tabs.handleListingDetected(LISTING_A, 7);
    analyses[0]!.resolve(scored('YELLOW'));
    await handlingA; // A's verdict is on screen, its LLM pass still running

    void tabs.handleListingDetected(LISTING_B, 7);
    refines[0]!.resolve({ ...scored('GREEN'), llmStatus: 'ran' });
    await settle();

    expect(phasesOf(sent).at(-1)).toBe(`checking:${LISTING_B.canonical!.canonicalUrl}`);
  });

  it('a same-URL hydration re-report supersedes the half-hydrated run', async () => {
    const { deps, analyses, sent } = makeDeps();
    const tabs = createTabStates(deps);
    const url = LISTING_A.canonical!.canonicalUrl;

    // First read of a page still hydrating: partial identity, same URL.
    const handlingEarly = tabs.handleListingDetected(listingMessage(url, 'gite a'), 7);
    // The name arrives; the content script re-reports the SAME canonical URL
    // with the fuller vector, and that run's verdict must be the one kept.
    const handlingLate = tabs.handleListingDetected(listingMessage(url, 'Le Grand Paris'), 7);
    analyses[1]!.resolve(scored('RED'));
    await handlingLate;
    analyses[0]!.resolve(scored('GRAY'));
    await handlingEarly;

    expect(donePublishes(sent).every(({ state }) => state.result?.verdict === 'RED')).toBe(true);
    expect(tabs.get(7)?.result?.verdict).toBe('RED');
  });

  it('returning to a listing does not revive its earlier abandoned run', async () => {
    const { deps, analyses, sent } = makeDeps();
    const tabs = createTabStates(deps);

    const handlingFirst = tabs.handleListingDetected(LISTING_A, 7); // A, slow
    void tabs.handleListingDetected(LISTING_B, 7); // away to B…
    const handlingBack = tabs.handleListingDetected(LISTING_A, 7); // …and back to A
    analyses[2]!.resolve(scored('RED'));
    await handlingBack;
    // The abandoned first run resolves last — same tab, same canonicalUrl as
    // the run now on screen, but a stale vector. It must stay dead.
    analyses[0]!.resolve(scored('GREEN'));
    await handlingFirst;

    expect(donePublishes(sent).every(({ state }) => state.result?.verdict === 'RED')).toBe(true);
    expect(tabs.get(7)?.result?.verdict).toBe('RED');
  });

  it("a superseded run's LLM repaint is dropped even for the same URL", async () => {
    const { deps, analyses, refines, sent } = makeDeps();
    const tabs = createTabStates(deps);
    const url = LISTING_A.canonical!.canonicalUrl;

    const handlingEarly = tabs.handleListingDetected(listingMessage(url, 'gite a'), 7);
    analyses[0]!.resolve(scored('GRAY'));
    await handlingEarly; // GRAY on screen, its LLM pass still running

    void tabs.handleListingDetected(listingMessage(url, 'Le Grand Paris'), 7);
    refines[0]!.resolve({ ...scored('GRAY'), llmStatus: 'ran' });
    await settle();

    expect(phasesOf(sent).at(-1)).toBe(`checking:${url}`);
  });

  it('a run whose tab was closed publishes nothing more', async () => {
    const { deps, analyses, sent } = makeDeps();
    const tabs = createTabStates(deps);
    const handling = tabs.handleListingDetected(LISTING_A, 7);
    tabs.drop(7);
    analyses[0]!.resolve(scored('RED'));
    await handling;

    expect(phasesOf(sent)).toEqual([`checking:${LISTING_A.canonical!.canonicalUrl}`]);
    expect(tabs.get(7)).toBeUndefined();
  });

  it('runs on different tabs do not supersede each other', async () => {
    const { deps, analyses } = makeDeps();
    const tabs = createTabStates(deps);
    const handlingA = tabs.handleListingDetected(LISTING_A, 7);
    const handlingB = tabs.handleListingDetected(LISTING_B, 8);
    analyses[0]!.resolve(scored('RED'));
    analyses[1]!.resolve(scored('GREEN'));
    await Promise.all([handlingA, handlingB]);

    expect(tabs.get(7)?.result?.verdict).toBe('RED');
    expect(tabs.get(8)?.result?.verdict).toBe('GREEN');
  });
});

describe('navigation', () => {
  const A_URL = LISTING_A.canonical!.canonicalUrl;
  const ROOM_URL = 'https://www.airbnb.com/rooms/12345';
  const ROOM_LISTING: ListingDetectedMessage = {
    ...listingMessage(ROOM_URL),
    canonical: {
      platform: 'airbnb',
      canonicalUrl: ROOM_URL,
      cdxPrefix: 'airbnb.com/rooms/12345',
      listingId: '12345',
    },
  };
  /** A page no adapter claims by URL — the generic adapter's territory. */
  const GENERIC_URL = 'https://chambres-du-lac.example/chambre/vue-lac';
  const GENERIC_LISTING: ListingDetectedMessage = {
    type: 'LISTING_DETECTED',
    url: GENERIC_URL,
    vector: IDENTITY,
    context: { breadcrumbs: [], pois: [], reviews: [] },
  };

  /** A tab mid-analysis: 'checking' is on screen, the pipeline still out. */
  function showing(message: ListingDetectedMessage = LISTING_A) {
    const { deps, analyses, sent } = makeDeps();
    const tabs = createTabStates(deps);
    const handling = tabs.handleListingDetected(message, 7);
    return { tabs, analyses, sent, handling };
  }

  it('keeps the running analysis when the SPA rewrites the URL of the same listing', async () => {
    const { tabs, analyses, sent, handling } = showing();

    // Locale suffix, tracking params and a gallery hash — Booking standing
    // still while its address bar moves.
    tabs.dropIfNavigatedAway(7, `${A_URL.replace('.html', '.fr.html')}?aid=9#gallery`, {
      sameDocument: true,
    });
    expect(tabs.get(7)?.phase).toBe('checking');

    // …and the verdict still lands: the run was never orphaned.
    analyses[0]!.resolve(scored('RED'));
    await handling;
    expect(tabs.get(7)?.result?.verdict).toBe('RED');
    expect(donePublishes(sent)).not.toHaveLength(0);
  });

  it('keeps state for a platform sub-page of the listing (the photo viewer)', () => {
    const { tabs } = showing(ROOM_LISTING);

    // No adapter claims `/rooms/<id>/photos` as a listing page, but the tab
    // has not left the listing — and a country domain is not a move either.
    tabs.dropIfNavigatedAway(7, 'https://www.airbnb.fr/rooms/12345/photos', {
      sameDocument: true,
    });

    expect(tabs.get(7)?.phase).toBe('checking');
  });

  it('drops when the SPA moves to a DIFFERENT listing', () => {
    const { tabs } = showing();
    tabs.dropIfNavigatedAway(7, LISTING_B.canonical!.canonicalUrl, { sameDocument: true });
    expect(tabs.get(7)).toBeUndefined();
  });

  it('drops when the tab leaves for a page that is no listing at all', () => {
    const loaded = showing();
    loaded.tabs.dropIfNavigatedAway(7, 'https://www.booking.com/searchresults.html?dest=paris');
    expect(loaded.tabs.get(7)).toBeUndefined();

    // Same in-document, which is how Airbnb goes back to its search results.
    const spa = showing(ROOM_LISTING);
    spa.tabs.dropIfNavigatedAway(7, 'https://www.airbnb.com/s/Paris/homes', { sameDocument: true });
    expect(spa.tabs.get(7)).toBeUndefined();
  });

  it("drops the search tab's focus-check verdict when the tab reloads or leaves", () => {
    // The one state whose canonicalUrl was never the tab's own URL: a listing
    // checked from the search page. A reload leaves it showing a verdict for
    // results that no longer exist.
    const { tabs } = showing();
    tabs.dropIfNavigatedAway(7, 'chrome-extension://abcdef/search.html');
    expect(tabs.get(7)).toBeUndefined();
  });

  it('keeps a generic-adapter page rewriting its own URL — blind, so it keeps', () => {
    const { tabs } = showing(GENERIC_LISTING);

    // Neither side resolves to a listing identity here, so "moved" cannot be
    // established; killing a running analysis on a guess is the worse error.
    tabs.dropIfNavigatedAway(7, `${GENERIC_URL}?nuitees=2`, { sameDocument: true });

    expect(tabs.get(7)?.phase).toBe('checking');
  });

  it('drops a generic-adapter page on a real document load elsewhere', () => {
    const { tabs } = showing(GENERIC_LISTING);
    tabs.dropIfNavigatedAway(7, 'https://chambres-du-lac.example/contact');
    expect(tabs.get(7)).toBeUndefined();
  });

  it('changes nothing when the tab’s location is unknown, or when nothing is on screen', () => {
    const { tabs } = showing();
    tabs.dropIfNavigatedAway(7, undefined, { sameDocument: true });
    expect(tabs.get(7)?.phase).toBe('checking');
    // A tab with no state cannot be showing anything wrong.
    expect(() => tabs.dropIfNavigatedAway(99, 'https://example.com/')).not.toThrow();
  });

  it('a dropped tab publishes nothing further', async () => {
    const { tabs, analyses, sent, handling } = showing();
    tabs.dropIfNavigatedAway(7, 'https://www.example.com/');
    analyses[0]!.resolve(scored('RED'));
    await handling;

    expect(phasesOf(sent)).toEqual([`checking:${A_URL}`]);
    expect(tabs.get(7)).toBeUndefined();
  });
});

describe('tab state store', () => {
  it('answers unknown tabs with undefined', () => {
    const { deps } = makeDeps();
    expect(createTabStates(deps).get(123)).toBeUndefined();
  });

  it('falls back to the raw URL when no adapter claims the page and no canonical travelled', async () => {
    const { deps, analyses, sent } = makeDeps();
    const tabs = createTabStates(deps);
    const message: ListingDetectedMessage = {
      type: 'LISTING_DETECTED',
      url: 'https://example.com/some-page',
      vector: IDENTITY,
      context: { breadcrumbs: [], pois: [], reviews: [] },
    };
    const handling = tabs.handleListingDetected(message, 7);
    analyses[0]!.resolve(scored('GRAY'));
    await handling;

    expect(sent[0]!.state.canonicalUrl).toBe('https://example.com/some-page');
    expect(sent.at(-1)!.state.phase).toBe('done');
  });
});
