import { browser } from 'wxt/browser';
import { adapterForDocument } from '../lib/sites/registry';
import { LISTING_MATCH_PATTERNS } from '../lib/sites/patterns';
import { createReportGate, reportFingerprint } from '../lib/reportgate';
import { createSettleScheduler } from '../lib/settle';
import { PRESENCE_PORT_NAME, createPresenceClient } from '../lib/presence';
import type { ExtensionMessage, ListingDetectedMessage, PageMovedMessage } from '../lib/messages';

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
 *
 * Two things travel alongside the report, both so the worker never has to read
 * a URL out of the browser (which would cost the `tabs` permission — "Read
 * your browsing history"):
 *  - a presence port (`lib/presence.ts`), whose disconnection tells the worker
 *    this document is gone and its verdict must go with it;
 *  - `PAGE_MOVED`, this page's own `location.href` whenever it changes without
 *    a document load — the single-page-app navigation the port cannot see,
 *    because no new document is ever created.
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

    /**
     * This document's announcement to the worker. Connected lazily — from
     * `report()`, the one path that creates worker state — so a listing page
     * the user opens and never analyses does not hold an MV3 service worker
     * awake, and so the port comes back after Chrome retires the worker and
     * the panel asks for a fresh report.
     */
    const presence = createPresenceClient(() =>
      browser.runtime.connect({ name: PRESENCE_PORT_NAME }),
    );

    /**
     * The address this page last told the worker about. Reported on change
     * only, so the common case — a mutation burst at a standing URL — costs
     * one string comparison and no message at all.
     */
    let reportedLocation: string | undefined;

    const reportLocation = (): void => {
      if (location.href === reportedLocation) return;
      reportedLocation = location.href;
      const message: PageMovedMessage = { type: 'PAGE_MOVED', url: location.href };
      void browser.runtime.sendMessage(message).catch(() => {
        // Worker asleep: it holds no state to correct either.
      });
    };

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
        // Armed before the state it protects exists: from here on the worker
        // holds a verdict for this document, and must learn the moment this
        // document stops existing.
        presence.ensure();
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
    const rereport = (): void => {
      gate.reset();
      scheduler.bump();
    };

    browser.runtime.onMessage.addListener((message: ExtensionMessage) => {
      if (message.type === 'REREPORT') rereport();
      return undefined;
    });

    // Restored from the back/forward cache. Chrome closes extension ports to
    // let a page into that cache, so the worker saw this document depart and
    // dropped its verdict — but nothing here re-runs on the way back in
    // (`main()` does not, and an unchanged DOM mutates nothing), so the page
    // would sit there analysed-and-unreported until the user happened to
    // switch tabs. Report it again, and re-arm presence along with it.
    window.addEventListener('pageshow', (event) => {
      if ((event as PageTransitionEvent).persisted) rereport();
    });

    // A single-page-app navigation fires no load event and destroys no
    // document, so the address change is reported at the FIRST mutation of the
    // burst rather than behind the settle wait: extraction can afford to wait
    // for a page to finish rebuilding, but a verdict for the listing the user
    // just left cannot stay on screen for those two seconds. The check itself
    // is one string comparison per batch, alongside the bump already there.
    new MutationObserver(() => {
      reportLocation();
      scheduler.bump();
    }).observe(document.documentElement, { childList: true, subtree: true });

    // History-API navigations that touch nothing else (back/forward, an
    // anchor) fire these instead of mutating.
    for (const event of ['popstate', 'hashchange'] as const) {
      window.addEventListener(event, () => {
        reportLocation();
        scheduler.bump();
      });
    }

    scheduler.bump();
  },
});
