import { describe, expect, it, vi } from 'vitest';
import { analyzeFirstPass, refineWithLlm, type PipelineDeps } from './pipeline';
import type { OllamaClient, OllamaProbe, StructuredRequest } from './llm/ollama';
import type { Geocoder, GeocodeResult } from '../lib/geocoder';
import type { IdentityVector } from '../lib/identity';
import type { ListingDetectedMessage } from '../lib/messages';
import type { PageContext, PageReviews } from '../lib/pagecontext';
import type { ReviewItem } from '../lib/reviews';

/**
 * Orchestration contract for the two passes: what `analyzeFirstPass` puts in
 * the scoring context, and how `refineWithLlm` folds the optional local model
 * into a verdict that is already on screen.
 *
 * The engines have their own unit suites and the corpora are exercised in
 * `acceptance*.test.ts`; what is under test here is the wiring — that a
 * throwing dependency costs only its own check, that the coverage report
 * describes what actually ran, and that Engine L's landmark extraction really
 * reaches Engine A2 rather than being collected and dropped.
 */

const BOOKING_URL = 'https://www.booking.com/hotel/fr/le-grand-paris.html';

const IDENTITY: IdentityVector = {
  platform: 'booking',
  name: 'Le Grand Paris',
  address: '12 Rue Desaix, 75015 Paris, France',
  city: 'Paris',
  lat: 48.8503,
  lng: 2.2936,
  photoUrls: [],
  capturedAt: '2026-08-16T12:00:00.000Z',
  source: { kind: 'live' },
};

const CONTEXT: PageContext = {
  breadcrumbs: ['France', 'Île-de-France', 'Paris'],
  pois: [{ name: 'Eiffel Tower', statedDistanceKm: 0.4 }],
  reviews: ['Lovely stay, right by the tower.'],
};

function messageOf(over: Partial<ListingDetectedMessage> = {}): ListingDetectedMessage {
  return {
    type: 'LISTING_DETECTED',
    vector: IDENTITY,
    url: BOOKING_URL,
    context: CONTEXT,
    ...over,
  };
}

/** Places every query at the listing's own coordinates: no contradiction. */
function agreeableGeocoder(at = { lat: IDENTITY.lat!, lng: IDENTITY.lng! }): Geocoder {
  return {
    async geocode(query: string): Promise<GeocodeResult | null> {
      return { ...at, displayName: query };
    },
  };
}

/**
 * An Ollama that is reachable, has a model, and answers L1 with `poi` while
 * leaving L2/L3 with nothing to parse — so the landmark path is exercised
 * without the advisory signals, which belong to Engine L's own suite.
 */
function ollamaReturning(pois: Array<{ name: string; statedDistanceKm?: number }>): OllamaClient {
  return {
    async available(): Promise<boolean> {
      return true;
    },
    async probe(): Promise<OllamaProbe> {
      return { reachable: true, models: ['llama3.1:8b'] };
    },
    async complete(_request: StructuredRequest): Promise<unknown> {
      return { poi: pois };
    },
  };
}

const UNREACHABLE_OLLAMA: OllamaClient = {
  async available() {
    return false;
  },
  async probe(): Promise<OllamaProbe> {
    return { reachable: false, models: [] };
  },
  async complete() {
    return null;
  },
};

describe('analyzeFirstPass', () => {
  it('scores the live page and reports which checks had their inputs', async () => {
    const deps: PipelineDeps = { geocoder: agreeableGeocoder() };
    const outcome = await analyzeFirstPass(messageOf(), deps);

    expect(outcome.result.verdict).toBeDefined();
    expect(outcome.scoring.identityComplete).toBe(true);
    expect(outcome.scoring.inputs).toMatchObject({
      hasSlug: true,
      poiCount: 1,
      breadcrumbCount: 3,
      hasCoordinates: true,
      hasAddress: true,
    });
    // The adapter's declared capabilities travel with the score, so the
    // coverage report can say "this platform cannot support that check".
    expect(outcome.scoring.capabilities).toBeDefined();
  });

  it('yields GRAY on an unreadable identity rather than a confident GREEN', async () => {
    const blank: IdentityVector = { ...IDENTITY, name: '', address: '', lat: undefined, lng: undefined };
    const outcome = await analyzeFirstPass(
      messageOf({ vector: blank }),
      { geocoder: agreeableGeocoder({ lat: 0, lng: 0 }) },
    );

    expect(outcome.scoring.identityComplete).toBe(false);
    expect(outcome.result.verdict).toBe('GRAY');
  });

  it('a throwing geocoder costs Engine A, never the verdict', async () => {
    const angry: Geocoder = {
      async geocode() {
        throw new Error('Nominatim down');
      },
    };
    const outcome = await analyzeFirstPass(messageOf(), { geocoder: angry });

    expect(outcome.result.verdict).toBeDefined();
    // The rules that needed the geocoder report themselves as unchecked; none
    // of them accuses the listing on the strength of a failed lookup.
    const accusations = outcome.signals.filter(
      (s) => s.engine === 'A' && s.severity !== 'GRAY',
    );
    expect(accusations, JSON.stringify(accusations)).toHaveLength(0);
  });

  it('still scores a page no adapter claims by URL, with Engine A skipped', async () => {
    // No canonical travelled and no adapter owns the URL: A1 has no slug to
    // read. The page must still be scored — silently returning nothing is how
    // an unchecked page used to become a confident GREEN.
    const outcome = await analyzeFirstPass(
      messageOf({ url: 'https://chambres-du-lac.example/chambre/vue-lac' }),
      { geocoder: agreeableGeocoder() },
    );

    expect(outcome.result.verdict).toBeDefined();
    expect(outcome.signals).toHaveLength(0);
    expect(outcome.scoring.inputs?.hasSlug).toBe(false);
  });

  it('survives a malformed URL instead of throwing out of the pipeline', async () => {
    const outcome = await analyzeFirstPass(messageOf({ url: 'not a url at all' }), {
      geocoder: agreeableGeocoder(),
    });
    expect(outcome.result.verdict).toBeDefined();
  });
});

describe('guest reviews travel beside the verdict', () => {
  // A fixed clock: review ages are the one output that would otherwise drift a
  // day at a time, and `now` is injected precisely so they can be pinned.
  const NOW = Date.parse('2026-08-16T12:00:00.000Z');
  const DAY = 86_400_000;

  const LOW: ReviewItem = {
    id: 'r1',
    rawScore: { value: 1, max: 5 },
    reviewedAt: NOW - 90 * DAY,
    lang: 'en',
    negative: 'The flat was nothing like the photos.',
  };
  const HAPPY: ReviewItem = {
    id: 'r2',
    rawScore: { value: 5, max: 5 },
    reviewedAt: NOW - 10 * DAY,
    lang: 'en',
    positive: 'Spotless and central.',
  };

  function withReviews(reviewSet: PageReviews): ListingDetectedMessage {
    return messageOf({ context: { ...CONTEXT, reviewSet } });
  }

  const deps = (): PipelineDeps => ({ geocoder: agreeableGeocoder(), now: () => NOW });

  it('attaches the scan, aged against the injected clock', async () => {
    const outcome = await analyzeFirstPass(
      withReviews({
        availability: 'in-page',
        items: [HAPPY, LOW],
        summary: { score: 8.4, total: 3526 },
      }),
      deps(),
    );

    const scan = outcome.reviewReport?.scan;
    expect(outcome.reviewReport?.availability).toBe('in-page');
    expect(scan?.counts.seen).toBe(2);
    // Only the one worth a look is surfaced, and its age is measured from the
    // clock the caller supplied rather than from today.
    expect(scan?.flagged.map((review) => review.id)).toEqual(['r1']);
    expect(scan?.flagged[0]?.ageDays).toBe(90);
    // The platform's own pair survives the trip: 1/5 is not 2/10.
    expect(scan?.flagged[0]?.rawScore).toEqual({ value: 1, max: 5 });
    expect(scan?.sample.claimedTotal).toBe(3526);
    // The honesty notes are what the panel prints beside the finding.
    expect(scan?.notes.map((note) => note.id)).toContain('sample');
  });

  it('defaults to the real clock when no caller supplies one', async () => {
    const recent: ReviewItem = { ...LOW, reviewedAt: Date.now() - 2 * DAY };
    const outcome = await analyzeFirstPass(
      withReviews({ availability: 'in-page', items: [recent] }),
      { geocoder: agreeableGeocoder() },
    );
    expect(outcome.reviewReport?.scan?.flagged[0]?.ageDays).toBe(2);
  });

  it('produces no scan for a platform that embeds no reviews in the page', async () => {
    // Airbnb hydrates its reviews after load. An empty list there says nothing
    // about the property, so there is nothing to scan and nothing to say — but
    // the distinction itself travels, so the panel is never left guessing why.
    const outcome = await analyzeFirstPass(
      withReviews({ availability: 'not-in-page', items: [], summary: { score: 4.9 } }),
      deps(),
    );
    expect(outcome.reviewReport).toEqual({ availability: 'not-in-page' });
    expect(outcome.reviewReport?.scan).toBeUndefined();
  });

  it('reports a page that served none where the platform does serve them', async () => {
    const outcome = await analyzeFirstPass(
      withReviews({ availability: 'in-page', items: [] }),
      deps(),
    );
    expect(outcome.reviewReport?.scan?.counts.seen).toBe(0);
    expect(outcome.reviewReport?.scan?.notes.map((note) => note.id)).toEqual(['sample', 'limits']);
  });

  it('attaches nothing at all for a context that carries no reviews field', async () => {
    // Unknown, not a claim: this context came from somewhere that does not read
    // reviews, which is neither "none served" nor "none exist".
    const outcome = await analyzeFirstPass(messageOf(), deps());
    expect(outcome.reviewReport).toBeUndefined();
  });

  it('never lets a review reach the verdict', async () => {
    const accusing: ReviewItem = {
      rawScore: { value: 1, max: 10 },
      reviewedAt: NOW - DAY,
      lang: 'en',
      negative: 'A total scam, the address does not exist.',
    };
    const withReview = await analyzeFirstPass(
      withReviews({ availability: 'in-page', items: [accusing] }),
      deps(),
    );
    const without = await analyzeFirstPass(messageOf(), deps());

    expect(withReview.reviewReport?.scan?.flagged).toHaveLength(1);
    expect(withReview.result.verdict).toBe(without.result.verdict);
    expect(withReview.result.signals).toEqual(without.result.signals);
  });

  it('carries the reading through the local-model pass so the section does not vanish', async () => {
    const message = withReviews({ availability: 'in-page', items: [LOW] });
    const first = await analyzeFirstPass(message, deps());
    const refined = await refineWithLlm(message, first, {
      ...deps(),
      llm: { client: ollamaReturning([{ name: 'Champ de Mars' }]) },
    });

    expect(refined?.reviewReport).toEqual(first.reviewReport);
  });
});

describe('refineWithLlm', () => {
  const base = () => analyzeFirstPass(messageOf(), { geocoder: agreeableGeocoder() });

  it('reports a status without changing the verdict when no model is installed', async () => {
    const first = await base();
    const refined = await refineWithLlm(messageOf(), first, {
      geocoder: agreeableGeocoder(),
      llm: { client: UNREACHABLE_OLLAMA },
    });

    // The panel offers the optional upgrade off this status, so it must arrive
    // even though nothing ran.
    expect(refined?.llmStatus).toBe('unreachable');
    expect(refined?.result.verdict).toBe(first.result.verdict);
    expect(refined?.signals).toEqual(first.signals);
  });

  it("feeds Engine L's landmarks back through Engine A2 and says so in the coverage", async () => {
    const first = await base();
    const geocode = vi.fn(async (query: string) => ({
      lat: IDENTITY.lat!,
      lng: IDENTITY.lng!,
      displayName: query,
    }));

    const refined = await refineWithLlm(messageOf(), first, {
      geocoder: { geocode },
      llm: {
        client: ollamaReturning([
          { name: 'Champ de Mars', statedDistanceKm: 0.3 },
          // Already in the page's own list: must not be counted twice.
          { name: 'eiffel tower' },
        ]),
      },
    });

    expect(refined?.llmStatus).toBe('ran');
    // One page POI + one new landmark; the duplicate is folded in by name.
    expect(refined?.scoring.inputs?.poiCount).toBe(2);
    expect(geocode.mock.calls.some(([q]) => q.includes('Champ de Mars'))).toBe(true);
  });

  it('keeps the deterministic verdict when the Engine A re-run throws', async () => {
    const first = await base();
    let calls = 0;
    const flaky: Geocoder = {
      async geocode(query: string) {
        calls += 1;
        throw new Error(`geocoder died on ${query}`);
      },
    };

    const refined = await refineWithLlm(messageOf(), first, {
      geocoder: flaky,
      llm: { client: ollamaReturning([{ name: 'Champ de Mars' }]) },
    });

    expect(calls).toBeGreaterThan(0);
    expect(refined?.llmStatus).toBe('ran');
    expect(refined?.result.verdict).toBe(first.result.verdict);
  });

  it('returns null when Engine L itself throws, so the panel skips a pointless redraw', async () => {
    const first = await base();
    // `runEngineL` absorbs a rejecting probe by design, so the throw has to be
    // one it cannot: a client that does not honour the interface at all.
    const broken = { available: async () => true } as unknown as OllamaClient;
    const refined = await refineWithLlm(messageOf(), first, {
      geocoder: agreeableGeocoder(),
      llm: { client: broken },
    });

    expect(refined).toBeNull();
  });
});
