import { browser } from 'wxt/browser';
import { createAreaSearchHandler } from '../background/areasearch';
import { createFocusListingHandler, type ParsedListing } from '../background/focuslisting';
import { createNominatimGeocoder } from '../background/geocode';
import { createOllamaClient } from '../background/llm/ollama';
import { analyzeFirstPass, refineWithLlm } from '../background/pipeline';
import { createSettingsStore } from '../background/settings';
import { createTabStates } from '../background/tabstate';
import { registerSearchProbe } from '../background/searchprobe';
import { createGeocodeCache, purgeRetiredCaches } from '../background/storage';
import type { ExtensionMessage } from '../lib/messages';
import type { ParseListingHtmlResponse } from './offscreen/main';

/**
 * Service worker: the only context that touches the network.
 *
 * State is per-tab and in-memory only (see `background/tabstate.ts`). Nothing
 * about which listings the user viewed is ever persisted — a durable visit log
 * would turn a tool people install because they distrust a listing into a
 * record of every listing they distrusted. Persistent storage holds API
 * responses (geocodes) and nothing else.
 */

const OFFSCREEN_PATH = 'offscreen.html';

/**
 * MV3 service workers have no DOM. HTML the worker fetched itself is parsed in
 * an offscreen document, which is created lazily and left alive for the
 * session — creating one per page would serialize behind repeated startup cost.
 */
let offscreenReady: Promise<void> | undefined;
function ensureOffscreen(): Promise<void> {
  offscreenReady ??= (async () => {
    const runtime = browser.runtime as unknown as {
      getContexts?: (f: { contextTypes: string[] }) => Promise<unknown[]>;
    };
    const existing = await runtime.getContexts?.({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
    if (existing && existing.length > 0) return;
    await (
      browser as unknown as {
        offscreen: {
          createDocument(o: { url: string; reasons: string[]; justification: string }): Promise<void>;
        };
      }
    ).offscreen.createDocument({
      url: OFFSCREEN_PATH,
      reasons: ['DOM_PARSER'],
      justification: 'Parse a listing page fetched from a search result to analyse it.',
    });
  })().catch((error) => {
    offscreenReady = undefined; // let a later attempt retry
    throw error;
  });
  return offscreenReady;
}

/** Live-listing parse for the focus-listing path. */
async function parseListingHtmlOffscreen(
  html: string,
  url: string,
): Promise<ParsedListing | null> {
  await ensureOffscreen();
  const response = (await browser.runtime.sendMessage({
    type: 'PARSE_LISTING_HTML',
    html,
    url,
  })) as ParseListingHtmlResponse | undefined;
  if (response?.vector == null || response.context === undefined) return null;
  return {
    vector: response.vector,
    context: response.context,
    ...(response.terms === undefined ? {} : { terms: response.terms }),
  };
}

/**
 * Only the extension's own pages may trigger the credentialed search fetches.
 * Content scripts share the runtime.sendMessage channel but run inside
 * attacker-facing tabs — their sender.url is the page's, not a
 * chrome-extension:// one (ROADMAP P1's sender-validation rule, applied to
 * these handlers from birth).
 */
function isExtensionPageSender(senderUrl: string | undefined): boolean {
  return senderUrl !== undefined && senderUrl.startsWith(browser.runtime.getURL('/'));
}

const geocoder = createNominatimGeocoder({ cache: createGeocodeCache() });
const settingsStore = createSettingsStore();
// One instance so the search rate limit is global to the worker — a handler
// per message would each bring its own politeness budget.
const areaSearch = createAreaSearchHandler();

const pipelineDeps = { geocoder };

const tabs = createTabStates({
  analyze: async (message) => analyzeFirstPass(message, pipelineDeps),
  refine: async (message, outcome) => {
    // Settings are read per run, not at worker startup: a change on the options
    // page must apply to the next analysis, and MV3 gives this worker no
    // lifetime a "read once" could safely span anyway.
    const settings = await settingsStore.load();
    return refineWithLlm(message, outcome, {
      ...pipelineDeps,
      llm: {
        client: createOllamaClient({ endpoint: settings.ollamaEndpoint }),
        // One preferred model serves both Engine L roles; empty means Engine L
        // probes what is installed and picks for itself.
        ...(settings.ollamaModel
          ? { models: { extractor: settings.ollamaModel, judge: settings.ollamaModel } }
          : {}),
      },
    });
  },
  sendState: (tabId, state) => {
    // The panel may not be open; a rejected send is expected, not an error.
    void browser.runtime.sendMessage({ type: 'STATE', tabId, state }).catch(() => {});
  },
});

// One instance for the same reason as `areaSearch`: the politeness budget is
// global to the worker. The synthesized detection enters the ordinary per-tab
// pipeline, so the verdict reaches the panel as the search tab's STATE.
const focusListing = createFocusListingHandler({
  parseListingHtml: parseListingHtmlOffscreen,
  onListingDetected: (detected, tabId) => tabs.handleListingDetected(detected, tabId),
  // A check takes seconds and publishes onto the search tab. This is how that
  // path knows the tab is still the page that asked — a closed tab rejects,
  // which the handler reads as "gone" and publishes nothing.
  tabUrl: async (tabId) => (await browser.tabs.get(tabId)).url,
});

export default defineBackground(() => {
  // Map-area search phase (a): under `npm run probe:search` only, register
  // the probe fetch listener and open the probe page. MODE is statically
  // replaced at build time, so production builds contain neither branch.
  if (import.meta.env.MODE === 'search-probe') {
    registerSearchProbe();
    browser.runtime.onInstalled.addListener(() => {
      void browser.tabs.create({ url: `${browser.runtime.getURL('/searchprobe.html')}?auto=1` });
    });
  }

  // An update from a version that still had the archive check leaves its two
  // caches sitting in a quota nothing will ever reclaim them from.
  browser.runtime.onInstalled.addListener((details: { reason?: string }) => {
    if (details.reason === 'update') void purgeRetiredCaches();
  });

  // No toolbar action is declared, so opening the panel from the extension icon
  // is wired here rather than in the manifest.
  const sidePanel = (browser as unknown as {
    sidePanel?: { setPanelBehavior(o: { openPanelOnActionClick: boolean }): Promise<void> };
  }).sidePanel;
  void sidePanel?.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

  browser.runtime.onMessage.addListener(
    (
      message: ExtensionMessage,
      sender: { tab?: { id?: number }; url?: string },
      sendResponse: (response?: unknown) => void,
    ) => {
      switch (message.type) {
        case 'LISTING_DETECTED': {
          const tabId = sender.tab?.id;
          if (tabId === undefined) return undefined;
          void tabs.handleListingDetected(message, tabId);
          return undefined;
        }
        case 'REQUEST_STATE': {
          // The explicit-tab path answers synchronously: the response is
          // sent before any broadcast published after the request arrived,
          // so of the two messages the panel can receive, the later one
          // always carries the newer state and the panel may render
          // whichever arrives last.
          if (message.tabId !== undefined) {
            sendResponse({
              tabId: message.tabId,
              state: tabs.get(message.tabId) ?? { phase: 'idle' },
            });
            return true;
          }
          // The panel could not resolve its own active tab. Answer for the
          // focused window's, and say which tab that was so the panel can
          // adopt it and stop dropping broadcasts about it.
          void (async () => {
            const [active] = await browser.tabs.query({ active: true, currentWindow: true });
            const current = active?.id === undefined ? undefined : tabs.get(active.id);
            sendResponse({ tabId: active?.id, state: current ?? { phase: 'idle' } });
          })();
          return true;
        }
        case 'SEARCH_AREA_FETCH': {
          // Gate rationale at `isExtensionPageSender`.
          if (!isExtensionPageSender(sender.url)) {
            sendResponse({ ok: false, error: 'refused: caller is not an extension page' });
            return true;
          }
          // `handle` never rejects; every failure arrives as `{ok: false}`.
          void areaSearch.handle(message).then(sendResponse);
          return true;
        }
        case 'SEARCH_FOCUS_LISTING': {
          // Gate rationale at `isExtensionPageSender`.
          if (!isExtensionPageSender(sender.url)) {
            sendResponse({ ok: false, error: 'refused: caller is not an extension page' });
            return true;
          }
          // The search page is a real tab page, so sender.tab is set — and
          // its id is where the verdict publishes. Without one there is no
          // panel state to write and the fetch would be work nobody sees.
          const tabId = sender.tab?.id;
          if (tabId === undefined) {
            sendResponse({ ok: false, error: 'refused: no tab to publish state to' });
            return true;
          }
          // `handle` never rejects; every failure arrives as `{ok: false}`.
          void focusListing.handle(message, tabId).then(sendResponse);
          return true;
        }
        default:
          return undefined;
      }
    },
  );

  // Drop per-tab state when the tab goes away, so nothing outlives the visit.
  browser.tabs.onRemoved.addListener((tabId: number) => tabs.drop(tabId));

  // ...and when the tab navigates elsewhere, for the same reason P0-1 existed:
  // a panel must never show a verdict for something the tab is not. The
  // focus-check path publishes a listing's analysis as the SEARCH tab's state
  // by design, and that state would otherwise survive the tab navigating away
  // from the search page entirely.
  //
  // "Navigated elsewhere" is the whole difficulty, and it is decided in
  // `tabstate.ts` where the tab's current verdict lives — this listener only
  // reports where the tab is. Two shapes arrive here:
  //
  //  - `changeInfo.url`: the address changed. Chrome does not say whether a new
  //    document loaded, but it does attach `status` to the events that belong
  //    to a real load, so its absence is (heuristically) a History-API rewrite —
  //    passed along as a hint that only ever protects state, never drops it.
  //  - `status: 'loading'` with no url: a reload, or a load whose URL Chrome
  //    reported separately. A reload of a real listing page is harmless (the
  //    content script re-reports), but a reload of the SEARCH page leaves a
  //    focus-check verdict on screen for results that no longer exist — so ask
  //    the tab where it is and run the same comparison.
  browser.tabs.onUpdated.addListener(
    (tabId: number, changeInfo: { url?: string; status?: string }) => {
      if (changeInfo.url !== undefined) {
        tabs.dropIfNavigatedAway(tabId, changeInfo.url, {
          sameDocument: changeInfo.status === undefined,
        });
        return;
      }
      if (changeInfo.status !== 'loading') return;
      const before = tabs.get(tabId);
      if (before === undefined) return;
      void browser.tabs.get(tabId).then((tab: { url?: string }) => {
        // A fresh report can land while that lookup is out; it owns the tab now
        // and its state is about the page that is actually loading.
        if (tabs.get(tabId) !== before) return;
        tabs.dropIfNavigatedAway(tabId, tab.url);
      }, () => {});
    },
  );
});
