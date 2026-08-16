import type { IdentityVector } from './identity';
import type { PageContext } from './pagecontext';
import type { ListingTerms } from './terms';

/**
 * Decides whether an extraction is news worth sending to the worker.
 *
 * The content script re-extracts on every settled mutation burst, so most
 * extractions repeat what was already reported. The original dedup keyed on
 * (URL, name) — too coarse, and it broke the deadline extraction's own safety
 * story: when the 2.5 s deadline fires on a page still hydrating, the report
 * carries the final name but half the identity, the dedup locks, and the
 * fuller post-hydration re-read is discarded. A hostile page could force that
 * ordering deliberately, converting the fixed verdict-suppression lever into
 * a lasting verdict-degradation one. Keying on what was actually extracted
 * makes the follow-up report real: anything material changes, it sends, and
 * the worker's run-id supersession keeps the newest.
 *
 * The fingerprint deliberately covers the verdict-bearing inputs — identity,
 * landmarks, breadcrumbs, terms — and leaves out the description and review
 * text. Review carousels rotate their snippets on a timer; fingerprinting
 * them would re-run the whole analysis on every rotation. Engine L reads
 * them, but Engine L is advisory by contract (it cannot move a verdict
 * without deterministic support), so a stale snippet set is a bounded loss
 * while a re-analysis loop is not. `capturedAt` is excluded because it is a
 * timestamp: including it would make every extraction "new" and turn the
 * gate into a no-op.
 */
export function reportFingerprint(
  identity: IdentityVector,
  context: PageContext,
  terms: ListingTerms | undefined,
): string {
  const { capturedAt: _ignored, ...stable } = identity;
  return JSON.stringify({
    identity: stable,
    pois: context.pois,
    breadcrumbs: context.breadcrumbs,
    terms: terms ?? null,
  });
}

export interface ReportGate {
  /**
   * True when this extraction differs from the last one that was sent —
   * recording it as sent. Call only when prepared to actually send.
   */
  shouldSend(url: string, fingerprint: string): boolean;
  /** Forget history, so the next extraction always sends (REREPORT). */
  reset(): void;
}

export function createReportGate(): ReportGate {
  let lastSent: string | undefined;
  return {
    shouldSend(url: string, fingerprint: string): boolean {
      const key = `${url}\n${fingerprint}`;
      if (key === lastSent) return false;
      lastSent = key;
      return true;
    },
    reset(): void {
      lastSent = undefined;
    },
  };
}
