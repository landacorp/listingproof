/**
 * Offscreen document: the extension's only HTML parser.
 *
 * MV3 service workers have no DOM, so `DOMParser` is unavailable exactly where
 * fetched HTML arrives (the worker is the only context allowed to fetch
 * cross-origin). Rather than maintain a second, DOM-free extractor for
 * worker-fetched pages — two parsers that must agree is a bug factory — the
 * HTML is shipped here and run through the same `extractIdentity` the content
 * script uses on live pages, chosen by the same adapter registry. One caller:
 * listing pages the worker fetched for a focused search result
 * (PARSE_LISTING_HTML).
 *
 * Either way the HTML is attacker-influenced and, unlike a content script,
 * this document runs at extension origin. It is therefore parsed inert:
 * DOMParser builds a detached document that never executes script, loads no
 * subresources and is never attached to this page.
 */
import { browser } from 'wxt/browser';
import { adapterForDocument } from '../../lib/sites/registry';
import type { IdentityVector } from '../../lib/identity';
import type { ExtensionMessage } from '../../lib/messages';
import type { PageContext } from '../../lib/pagecontext';
import type { ListingTerms } from '../../lib/terms';

/** Reply to PARSE_LISTING_HTML. A null vector means "not extractable". */
export interface ParseListingHtmlResponse {
  vector: IdentityVector | null;
  /** Present exactly when `vector` is. */
  context?: PageContext;
  terms?: ListingTerms;
  error?: string;
}

browser.runtime.onMessage.addListener(
  (
    message: ExtensionMessage,
    _sender: unknown,
    sendResponse: (r: ParseListingHtmlResponse) => void,
  ) => {
    if (message.type === 'PARSE_LISTING_HTML') {
      try {
        const doc = new DOMParser().parseFromString(message.html, 'text/html');
        const adapter = adapterForDocument(message.url, doc);
        // The bytes are the live page, fetched moments ago, so the
        // `{kind: 'live'}` and capturedAt the extractor stamps itself are
        // already the truth.
        const vector = adapter?.extractIdentity(doc) ?? null;
        if (adapter === undefined || vector === null) {
          sendResponse({ vector: null });
          return true;
        }
        const context = adapter.extractContext(doc);
        // Terms extraction is optional per adapter and advisory-only; a throw
        // here must not cost the identity (same rule as the content script).
        let terms: ListingTerms | undefined;
        try {
          terms = adapter.extractTerms?.(doc);
        } catch {
          terms = undefined;
        }
        sendResponse({ vector, context, ...(terms === undefined ? {} : { terms }) });
      } catch (error) {
        sendResponse({ vector: null, error: String(error) });
      }
      return true;
    }

    return undefined;
  },
);
