import { browser } from 'wxt/browser';
import { adapterForDocument } from '../lib/sites/registry';
import { LISTING_MATCH_PATTERNS } from '../lib/sites/patterns';
import { createReportGate, reportFingerprint } from '../lib/reportgate';
import { createSettleScheduler } from '../lib/settle';
import type { ExtensionMessage, ListingDetectedMessage } from '../lib/messages';

/** Quiet period after the last DOM mutation before re-reading the page. */
const SETTLE_MS = 400;
/**
 * Hard deadline after a mutation burst starts. Without it, a page mutating at
 * sub-SETTLE_MS intervals postpones extraction forever — a hostile page could
 * suppress its own verdict just by keeping the DOM busy. Long enough for real
 * hydration to finish; the follow-up report covers pages that were not done.
 */
const MAX_WAIT_MS = 2500;

/**
 * Content script: read the listing, hand it to the service worker, and stop.
 *
 * It knows nothing about any particular platform — the adapter registry does.
 *
 * All analysis happens in the worker. This side does no network, no scoring and
 * keeps no state, so a hostile page has nothing here to subvert beyond the DOM
 * it already controls.
 *
 * Two timing facts about listing sites drive the shape of this:
 *  - It hydrates asynchronously. JSON-LD and the POI blocks land after first
 *    paint, so a single read at document_idle sees a half-built page.
 *  - It is a single-page app. Moving between properties rewrites the DOM
 *    without a document load, so a one-shot read reports the first property the
 *    user opened and then goes quietly stale — the worst failure mode for a
 *    trust tool, since the panel would show a verdict for the wrong listing.
 *
 * So: watch for mutations, but debounce hard. Extraction walks every <img> and
 * every script on a page that can exceed a megabyte, and they mutate constantly (price
 * polling, lazy images, carousels); running it per mutation would burn the
 * user's main thread continuously.
 */
export default defineContentScript({
  matches: [...LISTING_MATCH_PATTERNS],
  main() {
    // Re-report whenever anything verdict-bearing changes: a navigation, but
    // also the address/coordinates/landmarks arriving on a page that was
    // still hydrating when an earlier read (the deadline's, especially) went
    // out. A name-only dedup would lock in that partial read for the whole
    // page view. The worker's run-id supersession keeps whichever is newest.
    const gate = createReportGate();

    const report = (): void => {
      // The page is attacker-authored. Extraction is written not to throw, but
      // a crash here would silently suppress the verdict, which is exactly the
      // failure mode a hijacker wants.
      try {
        // The registry picks the adapter: a bespoke one where the site's
        // markup has known quirks, the generic schema.org reader otherwise.
        // This file knows about no platform in particular.
        const adapter = adapterForDocument(location.href, document);
        if (!adapter) return;

        const identity = adapter.extractIdentity(document);
        if (!identity) return;

        const context = adapter.extractContext(document);

        // Terms extraction is optional per adapter and advisory-only; a throw
        // here must not cost the identity report.
        let terms;
        try {
          terms = adapter.extractTerms?.(document);
        } catch {
          terms = undefined;
        }

        if (!gate.shouldSend(location.href, reportFingerprint(identity, context, terms))) return;

        // Resolved here, where the adapter that claimed the page is known. The
        // worker cannot redo this: the generic adapter answers from the DOM.
        const canonical = adapter.canonicalize(new URL(location.href)) ?? undefined;

        const message: ListingDetectedMessage = {
          type: 'LISTING_DETECTED',
          vector: identity,
          url: location.href,
          canonical,
          ...(terms === undefined ? {} : { terms }),
          context,
        };
        void browser.runtime.sendMessage(message).catch(() => {
          // Worker asleep or panel closed — nothing to recover here.
        });
      } catch (error) {
        console.error('[listingproof] extraction failed:', error);
      }
    };

    const scheduler = createSettleScheduler({
      settleMs: SETTLE_MS,
      maxWaitMs: MAX_WAIT_MS,
      run: report,
    });

    // The worker's per-tab state dies with it on MV3 eviction. When the panel
    // finds no state for this tab it asks for a fresh report, and the dedup
    // must not suppress it. Routed through the scheduler, not run directly:
    // the panel also pings tabs whose first read simply has not happened yet,
    // and an immediate extraction there would read a page mid-hydration —
    // the settle wait is the whole point of this file.
    browser.runtime.onMessage.addListener((message: ExtensionMessage) => {
      if (message.type === 'REREPORT') {
        gate.reset();
        scheduler.bump();
      }
      return undefined;
    });

    new MutationObserver(scheduler.bump).observe(document.documentElement, {
      childList: true,
      subtree: true,
    });
    scheduler.bump();
  },
});
