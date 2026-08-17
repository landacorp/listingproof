/**
 * "Is the page that produced this state still there?" — answered by a port,
 * not by a URL.
 *
 * Two guards in this extension need that answer, and both used to get it by
 * reading `Tab.url` from the service worker, which costs the `tabs` permission
 * — the one Chrome shows the user as "Read your browsing history", on a product
 * whose whole claim is that it does not overreach:
 *
 *   - the focus-check publish guard (`background/focuslisting.ts`): a check
 *     takes seconds, and a verdict published afterwards must not land on a tab
 *     whose page has moved on;
 *   - the navigation drop (`background/tabstate.ts`): a tab that left the page
 *     its verdict describes must stop showing that verdict.
 *
 * A long-lived `runtime.connect` port answers both, better and for free. Every
 * page that can own per-tab state — the listing content script, the map search
 * page — opens one. A document that is destroyed (navigation, reload, close,
 * crash) has its port disconnected by the browser itself, so "gone" is a fact
 * reported by the renderer rather than a URL comparison inferred by the worker.
 * `runtime.connect` needs no permission at all, and `port.sender.tab.id` is
 * filled in by the browser, so the tab identity is trustworthy without one.
 *
 * Ports beat URLs on the merits too, not only on permissions:
 *   - a RELOAD of the map search page destroys the results the user was
 *     looking at, but leaves the URL identical — the old guard called that
 *     "still the asking page" and would publish a verdict for a result that no
 *     longer exists on screen. A new document is a new port, so it does not;
 *   - a single-page app rewriting its own address while standing still keeps
 *     one document and one port, so the "did that URL change load a new
 *     document?" heuristic (`changeInfo.status`, which Chrome never promised)
 *     disappears entirely;
 *   - a page the extension holds no host permission for is invisible to
 *     `Tab.url` even WITH the `tabs` permission removed as the only
 *     alternative — but its port disconnects like any other.
 *
 * Both halves here are pure and injectable so the whole mechanism is testable
 * without a browser; `entrypoints/background.ts` wires the registry to
 * `runtime.onConnect`, and the two client pages wire `createPresenceClient` to
 * `runtime.connect`.
 */

/**
 * Port name. Ports are shared with anything else that may `runtime.connect`
 * one day, so presence ports identify themselves and the worker ignores the
 * rest.
 */
export const PRESENCE_PORT_NAME = 'listingproof-page-presence';

/** The sliver of `chrome.runtime.Port` either half of this module touches. */
export interface PresencePort {
  onDisconnect: { addListener(listener: () => void): void };
}

// ---------------------------------------------------------------------------
// Page side
// ---------------------------------------------------------------------------

export interface PresenceClient {
  /**
   * Make sure this page is announced. Idempotent, and safe to call often — it
   * connects only when there is no live port.
   */
  ensure(): void;
}

/**
 * Announce this page to the worker, lazily and re-connectably.
 *
 * Lazily, because a connected port keeps an MV3 service worker alive past its
 * 30-second idle timeout: the port is opened when the page has something the
 * worker will hold state about, not merely because the page exists.
 *
 * Re-connectably, because Chrome tears every port down when it eventually
 * retires the worker anyway. That is harmless — the worker's per-tab state
 * died with it — but the page must be able to announce itself again alongside
 * the next report, or the state created by that report would have no presence
 * behind it. Callers therefore invoke `ensure()` on the same path that creates
 * state, which keeps the invariant this module exists for: STATE FOR A TAB
 * IMPLIES A LIVE PORT FROM THE PAGE THAT PRODUCED IT.
 *
 * A `connect` that throws (worker gone mid-teardown) leaves the client
 * unconnected and retryable rather than propagating: presence is a guard, and
 * failing to arm it must never cost the report it rides along with.
 */
export function createPresenceClient(connect: () => PresencePort): PresenceClient {
  let port: PresencePort | undefined;
  return {
    ensure(): void {
      if (port !== undefined) return;
      try {
        const opened = connect();
        port = opened;
        opened.onDisconnect.addListener(() => {
          // Only clear the handle if it is still this port's: a disconnect
          // that arrives after a reconnect must not discard the live one.
          if (port === opened) port = undefined;
        });
      } catch {
        port = undefined;
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Worker side
// ---------------------------------------------------------------------------

export interface PresenceRegistry {
  /**
   * A page connected from this tab. Returns the token that identifies THIS
   * page instance — a later page in the same tab gets a different one.
   */
  arrived(tabId: number): number;
  /**
   * That page's port disconnected. Answers whether the tab genuinely lost its
   * page: `false` when a newer page has already claimed the tab, which is what
   * a full-document navigation looks like when the new document's connect
   * beats the old document's disconnect.
   */
  left(tabId: number, token: number): boolean;
  /** The page currently connected from this tab, or undefined for none. */
  token(tabId: number): number | undefined;
}

/**
 * Who is connected from each tab.
 *
 * Tokens rather than a boolean, because "some page is connected from this tab"
 * is the wrong question. The user can leave the map search page and come back
 * to it while a check started by the FIRST visit is still in the air; that
 * check's answer belongs to a page that no longer exists, even though its tab
 * has a perfectly live port. Comparing the token captured when the check was
 * accepted against the token connected when it is ready is the same
 * supersession rule `background/tabstate.ts` applies to its runs.
 */
export function createPresenceRegistry(): PresenceRegistry {
  const connected = new Map<number, number>();
  let counter = 0;
  return {
    arrived(tabId: number): number {
      const token = ++counter;
      connected.set(tabId, token);
      return token;
    },
    left(tabId: number, token: number): boolean {
      if (connected.get(tabId) !== token) return false;
      connected.delete(tabId);
      return true;
    },
    token: (tabId: number) => connected.get(tabId),
  };
}
