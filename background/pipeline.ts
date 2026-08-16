/**
 * Analysis orchestration: identity in, verdict out.
 *
 * Kept free of `chrome.*` and of the message plumbing so the whole decision
 * path can be tested end to end with fakes. `entrypoints/background.ts` owns
 * the browser-facing side and injects the real geocoder.
 *
 * Two passes, in this order. Engine A (intra-page) runs first and always: it
 * needs nothing but the page in front of it, which is what makes a verdict
 * possible on a first visit. Engine L (the optional local model) refines that
 * verdict in place afterwards and by contract cannot make it worse. Every
 * engine is individually guarded, because one throwing adapter must not take
 * down the checks that did succeed.
 */
import { adapterForUrl, adapterById } from '../lib/sites/registry';
import { runEngineA } from '../lib/enginea';
import { runEngineL, type EngineLModels, type EngineLOutput, type EngineLStatus } from '../lib/enginel';
import { scanReviews } from '../lib/reviewscan';
import { score, type ScoreContext } from '../lib/score';
import type { OllamaClient } from './llm/ollama';
import type { Geocoder } from '../lib/geocoder';
import type { IdentityVector } from '../lib/identity';
import type { ListingDetectedMessage, ReviewReport } from '../lib/messages';
import type { PageReviews } from '../lib/pagecontext';
import type { ScoreResult, Signal } from '../lib/signals';

/**
 * Fallback canonical identity, for callers that did not supply one.
 *
 * The message normally carries `canonical`, resolved by the adapter that
 * claimed the page. This only covers a caller that did not — and it cannot
 * resolve a generic page, because no adapter owns that URL.
 *
 * Returns null for a page no adapter recognises — Engine A1's slug comes from
 * here, so an unrecognised URL simply means that check does not run, not that
 * anything failed.
 */
function canonicalOf(url: string) {
  try {
    return adapterForUrl(url)?.canonicalize(new URL(url)) ?? null;
  } catch {
    return null;
  }
}

export interface PipelineDeps {
  geocoder: Geocoder;
  /**
   * Clock in milliseconds, for the review ages. Injected rather than read deep
   * inside so a test can pin an age across a month or year boundary; defaults
   * to `Date.now`, the same convention as `lib/cache.ts` and `lib/ratelimit.ts`.
   */
  now?: () => number;
}

export interface PipelineOutcome {
  result: ScoreResult;
  /** Raw signals before scoring, so the optional LLM pass can build on them. */
  signals: Signal[];
  /**
   * What the page's guest reviews say. Read here because this is where a page
   * becomes a set of reports, but it is NOT an engine: nothing in it reaches
   * `score()`, and it travels beside the verdict rather than into it.
   */
  reviewReport?: ReviewReport;
  /**
   * The context the verdict was scored under, kept so the LLM refinement
   * re-scores under the same facts (with only the landmark count updated).
   */
  scoring: ScoreContext;
  /** Set once the optional local-model pass has been attempted. */
  llmStatus?: EngineLStatus;
}

/**
 * Enough of an identity to draw a conclusion from. Without a name there is
 * nothing to compare; without any location there is nothing to place. Failing
 * this check produces GRAY — an honest "could not read the page" rather than a
 * GREEN that means "found no problems in data we never had".
 */
function isIdentityComplete(identity: IdentityVector): boolean {
  const hasName = identity.name.trim().length > 0;
  const hasLocation =
    (identity.lat !== undefined && identity.lng !== undefined) || identity.address.trim().length > 0;
  return hasName && hasLocation;
}

/**
 * Read the reviews the page served, when there were any to read.
 *
 * Three answers, and they are not interchangeable (see `ReviewAvailability`):
 * a context with no `reviewSet` at all came from somewhere that does not read
 * reviews, `not-in-page` means the platform embeds none, and only `in-page`
 * yields a scan — whose emptiness, if it is empty, is a fact about this page.
 *
 * Guarded like every engine above: a throwing scan must cost its own section
 * and nothing else. The verdict does not depend on it in any case.
 */
function readReviews(set: PageReviews | undefined, now: () => number): ReviewReport | undefined {
  if (set === undefined) return undefined;
  if (set.availability === 'not-in-page') return { availability: set.availability };
  try {
    return { availability: set.availability, scan: scanReviews(set, now()) };
  } catch (error) {
    console.error('[listingproof] review scan failed:', error);
    return undefined;
  }
}

/**
 * The deterministic analysis: Engine A over the live page, scored. Ready in the
 * time the geocoder takes (~1-2 s, often cached), which is what the user waits
 * for — `refineWithLlm` updates this in place if a local model is available.
 */
export async function analyzeFirstPass(
  message: ListingDetectedMessage,
  deps: PipelineDeps,
): Promise<PipelineOutcome> {
  const identity = message.vector;
  const canonical = message.canonical ?? canonicalOf(message.url);
  const signals: Signal[] = [];

  if (canonical) {
    try {
      signals.push(
        ...(await runEngineA({
          identity,
          // Absent on platforms whose URLs are opaque ids (Airbnb's /rooms/<id>).
          // Engine A1 has no fossil to read there and skips itself; A2 and A3
          // are unaffected, because geography does not depend on the URL.
          slug: canonical.slug,
          context: message.context,
          geocoder: deps.geocoder,
        })),
      );
    } catch (error) {
      console.error('[listingproof] Engine A failed:', error);
    }
  }

  const capabilities = canonical ? adapterById(canonical.platform)?.capabilities : undefined;
  const scoring: ScoreContext = {
    identityComplete: isIdentityComplete(identity),
    ...(capabilities ? { capabilities } : {}),
    inputs: {
      hasSlug: canonical?.slug !== undefined,
      poiCount: message.context.pois.length,
      breadcrumbCount: message.context.breadcrumbs.length,
      hasCoordinates: identity.lat !== undefined && identity.lng !== undefined,
      hasAddress: identity.address.trim().length > 0,
    },
  };
  const result = score(signals, scoring);
  const reviewReport = readReviews(message.context.reviewSet, deps.now ?? Date.now);

  return { result, signals, scoring, ...(reviewReport === undefined ? {} : { reviewReport }) };
}

/**
 * Optional second pass: local-LLM checks, run after the deterministic verdict
 * is already on screen.
 *
 * Two things happen here, and only one of them can move the verdict. Engine L's
 * landmark extraction (L1) is merged into the POI list and Engine A2 is re-run
 * over it — that path is deterministic, because the geocoder still has to
 * confirm every landmark the model proposed, so a hallucinated place either
 * fails to resolve or lands where the real ones do. Engine L's own findings
 * (L2/L3) are attached as advisory evidence and, per the scorer, cannot change
 * the verdict on their own.
 *
 * Returns null when nothing changed, so the caller can skip a pointless redraw.
 */
export async function refineWithLlm(
  message: ListingDetectedMessage,
  base: PipelineOutcome,
  deps: PipelineDeps & { llm: { client: OllamaClient; models?: EngineLModels } },
): Promise<PipelineOutcome | null> {
  let engineL: EngineLOutput;
  try {
    engineL = await runEngineL({
      identity: message.vector,
      context: message.context,
      client: deps.llm.client,
      models: deps.llm.models,
    });
  } catch (error) {
    console.error('[listingproof] Engine L failed:', error);
    return null;
  }
  // Status always propagates, even when nothing ran: the panel uses it to offer
  // the optional setup, and "not installed" must reach the user as an offer
  // rather than as silence.
  if (!engineL.ran) return { ...base, llmStatus: engineL.status };

  const canonical = message.canonical ?? canonicalOf(message.url);
  let signals = base.signals;
  let poiCount = base.scoring.inputs?.poiCount ?? message.context.pois.length;

  // Re-run Engine A over the enriched landmark list. Geocodes are cached
  // permanently, so the landmarks A2 already resolved cost nothing the second
  // time; only the newly proposed ones hit the network.
  if (canonical && engineL.extraPois.length > 0) {
    const known = new Set(message.context.pois.map((p) => p.name.toLowerCase()));
    const merged = [
      ...message.context.pois,
      ...engineL.extraPois.filter((p) => !known.has(p.name.toLowerCase())),
    ];
    try {
      const refreshed = await runEngineA({
        identity: message.vector,
        slug: canonical.slug,
        context: { ...message.context, pois: merged },
        geocoder: deps.geocoder,
      });
      signals = [...refreshed, ...base.signals.filter((s) => s.engine !== 'A')];
      // The coverage report must describe what A2 actually saw this pass —
      // L1's landmarks can make A2 checkable on a page that listed none.
      poiCount = merged.length;
    } catch (error) {
      console.error('[listingproof] Engine A re-run failed:', error);
    }
  }

  const scoring: ScoreContext = {
    ...base.scoring,
    ...(base.scoring.inputs ? { inputs: { ...base.scoring.inputs, poiCount } } : {}),
  };
  const combined = [...signals, ...engineL.signals];
  const result = score(combined, scoring);

  return {
    result,
    signals: combined,
    scoring,
    // The reviews were read from the same page and nothing here re-reads them;
    // carrying the first pass's reading forward is what keeps the panel's
    // review section from vanishing when the local model finishes.
    ...(base.reviewReport === undefined ? {} : { reviewReport: base.reviewReport }),
    llmStatus: engineL.status,
  };
}
