/**
 * The `tabs`-permission probe: the worker half.
 *
 * The question is whether the two guards that used to read `Tab.url` can
 * survive without the `tabs` permission — the one Chrome renders in the
 * install dialog as "Read your browsing history", the most alarming line on a
 * product whose whole pitch is that it does not overreach.
 *
 * It has to be measured in a REAL browser, and it has to be measured HERE, in
 * the service worker, because that is where the guards live and because the
 * rule Chrome applies is about the calling extension's permissions, not about
 * the API. Unit tests use fake tab APIs and would pass while the real guard
 * silently broke; that failure mode is the entire risk this probe exists to
 * retire.
 *
 * What it measures, with `tabs` REMOVED from the manifest:
 *   - `tabs.query` / `tabs.get` on a tab whose host the extension DOES hold a
 *     permission for (a listing page): is `url` filled in?
 *   - `tabs.onUpdated`: does `changeInfo.url` arrive when such a tab
 *     navigates (driven with `tabs.update`)?
 *   - the same pair on the extension's OWN page (`search.html`), whose tab a
 *     focus check publishes onto;
 *   - the same pair on a tab the extension holds NO permission for — expected
 *     blank, and that expectation is the point: it is where a user leaves a
 *     listing for, and it is invisible either way;
 *   - `tabs.query` ids and window ids, which the side panel needs and which
 *     nothing should gate.
 *
 * And, alongside, the REPLACEMENT under the same real conditions: every
 * `runtime.onConnect` / `onDisconnect` for a presence port is logged with the
 * step it happened during, so the log shows the content script's port
 * disconnecting exactly when a listing tab navigates — the signal the new
 * guards are built on.
 *
 * Run it with `PROBE_WITH_TABS=1` to build the same probe WITH the permission:
 * the two runs together are what make a blank field evidence of the permission
 * rather than evidence of a broken probe.
 *
 * Never shipped: `entrypoints/background.ts` calls `registerPermProbe()` only
 * under `import.meta.env.MODE === 'perm-probe'`, the page entrypoint is built
 * only in that mode, and `scripts/assert-probe-free.mjs` fails the build if any
 * of it reaches production.
 */

import { browser } from 'wxt/browser';
import { PRESENCE_PORT_NAME } from '../lib/presence';

export interface PermProbeRunMessage {
  type: 'PERM_PROBE_RUN';
}

/** What `tabs.get`/`tabs.query` actually handed back for one tab. */
export interface TabFacts {
  tabId?: number;
  windowId?: number;
  /** The whole question: did Chrome fill `Tab.url` in, or scrub it? */
  urlVisible: boolean;
  url?: string;
  titleVisible: boolean;
  pendingUrlVisible: boolean;
  error?: string;
}

export interface ProbeStep {
  step: string;
  /** What the step was trying to establish, in the report itself. */
  asks: string;
  facts?: TabFacts;
  note?: string;
}

/** One `tabs.onUpdated` delivery, recorded verbatim. */
export interface UpdateEventRecord {
  duringStep: string;
  tabId: number;
  /** Every key Chrome actually put in changeInfo — the raw answer. */
  keys: string[];
  url?: string;
  status?: string;
}

/** One presence-port lifecycle event: the replacement guard's raw signal. */
export interface PortEventRecord {
  duringStep: string;
  event: 'connect' | 'disconnect';
  name: string;
  tabId?: number;
  /** `sender.url`, which is the messaging channel's own field, not `Tab.url`. */
  senderUrl?: string;
}

export interface PermProbeReport {
  builtWithTabsPermission: boolean;
  manifestPermissions: string[];
  steps: ProbeStep[];
  updateEvents: UpdateEventRecord[];
  portEvents: PortEventRecord[];
  finishedAt: string;
}

/**
 * Two real listing pages the extension DOES hold a host permission for, and
 * which the content script therefore runs on — so the same navigation
 * measures URL visibility and presence-port behaviour at once. Two page loads,
 * spaced politely; the URLs come from the capture manifests, so nothing new is
 * being crawled.
 */
const LISTING_A = 'https://www.booking.com/hotel/fr/le-regent-paris.fr.html';
const LISTING_B = 'https://www.booking.com/hotel/gb/strandpalace.en-gb.html';
/** A host no permission covers. IANA's page exists for exactly this. */
const NON_HOST = 'https://example.com/';

const LOAD_TIMEOUT_MS = 45_000;
/** Politeness gap between consecutive third-party page loads. */
const STEP_GAP_MS = 2_500;

let currentStep = 'before-run';
const updateEvents: UpdateEventRecord[] = [];
const portEvents: PortEventRecord[] = [];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Read one tab through `tabs.get` and record exactly what came back. */
async function factsFor(tabId: number): Promise<TabFacts> {
  try {
    const tab = (await browser.tabs.get(tabId)) as {
      id?: number;
      windowId?: number;
      url?: string;
      title?: string;
      pendingUrl?: string;
    };
    return {
      ...(tab.id === undefined ? {} : { tabId: tab.id }),
      ...(tab.windowId === undefined ? {} : { windowId: tab.windowId }),
      // Chrome scrubs the field to undefined (older builds: the empty string)
      // rather than throwing, so both readings count as "not visible".
      urlVisible: tab.url !== undefined && tab.url !== '',
      ...(tab.url === undefined ? {} : { url: tab.url }),
      titleVisible: tab.title !== undefined && tab.title !== '',
      pendingUrlVisible: tab.pendingUrl !== undefined && tab.pendingUrl !== '',
    };
  } catch (error) {
    return {
      urlVisible: false,
      titleVisible: false,
      pendingUrlVisible: false,
      error: String(error),
    };
  }
}

/** Wait for a tab to finish loading, via the one changeInfo field nothing gates. */
async function waitForLoad(tabId: number): Promise<string> {
  return new Promise<string>((resolve) => {
    const timer = setTimeout(() => {
      browser.tabs.onUpdated.removeListener(onUpdated);
      resolve('timed out waiting for status=complete');
    }, LOAD_TIMEOUT_MS);
    function onUpdated(id: number, info: { status?: string }): void {
      if (id !== tabId || info.status !== 'complete') return;
      clearTimeout(timer);
      browser.tabs.onUpdated.removeListener(onUpdated);
      resolve('loaded');
    }
    browser.tabs.onUpdated.addListener(onUpdated);
  });
}

/** Open a tab, wait for it, and report what `tabs.get` can see of it. */
async function openAndInspect(
  step: string,
  asks: string,
  url: string,
): Promise<{ record: ProbeStep; tabId: number | undefined }> {
  currentStep = step;
  const tab = (await browser.tabs.create({ url, active: false })) as { id?: number };
  const tabId = tab.id;
  if (tabId === undefined) {
    return { record: { step, asks, note: 'created tab has no id' }, tabId: undefined };
  }
  const note = await waitForLoad(tabId);
  return { record: { step, asks, facts: await factsFor(tabId), note }, tabId };
}

/** Drive a tab elsewhere and report what the navigation exposed. */
async function navigateAndInspect(
  step: string,
  asks: string,
  tabId: number,
  url: string,
): Promise<ProbeStep> {
  currentStep = step;
  await browser.tabs.update(tabId, { url });
  const note = await waitForLoad(tabId);
  return { step, asks, facts: await factsFor(tabId), note };
}

async function runProbe(callerTabId: number | undefined): Promise<PermProbeReport> {
  const manifest = browser.runtime.getManifest() as { permissions?: string[] };
  const manifestPermissions = manifest.permissions ?? [];
  const steps: ProbeStep[] = [];

  // 1. What the side panel does to find the tab it must follow. Ids and window
  //    ids only — if these are gated, the panel cannot work at all.
  currentStep = 'query-active';
  try {
    const [active] = (await browser.tabs.query({ active: true, currentWindow: true })) as {
      id?: number;
      windowId?: number;
      url?: string;
      title?: string;
    }[];
    steps.push({
      step: 'query-active',
      asks: 'tabs.query({active,currentWindow}) — does it still yield id + windowId, and does it yield url?',
      facts: {
        ...(active?.id === undefined ? {} : { tabId: active.id }),
        ...(active?.windowId === undefined ? {} : { windowId: active.windowId }),
        urlVisible: active?.url !== undefined && active.url !== '',
        ...(active?.url === undefined ? {} : { url: active.url }),
        titleVisible: active?.title !== undefined && active.title !== '',
        pendingUrlVisible: false,
      },
    });
  } catch (error) {
    steps.push({ step: 'query-active', asks: 'tabs.query active tab', note: String(error) });
  }

  // 2. The blunt version: across every open tab, how many URLs are readable?
  currentStep = 'query-all';
  try {
    const all = (await browser.tabs.query({})) as { url?: string }[];
    const withUrl = all.filter((tab) => tab.url !== undefined && tab.url !== '').length;
    steps.push({
      step: 'query-all',
      asks: 'tabs.query({}) — how much of the open-tab list is readable at all?',
      note: `${all.length} tabs, ${withUrl} with a readable url`,
    });
  } catch (error) {
    steps.push({ step: 'query-all', asks: 'tabs.query({})', note: String(error) });
  }

  // 3. The extension's OWN page — the search page's case, and the one the
  //    focus-check guard used to depend on.
  if (callerTabId !== undefined) {
    currentStep = 'own-probe-page';
    steps.push({
      step: 'own-probe-page',
      asks: "tabs.get on the extension's own page — is a chrome-extension:// URL self-visible?",
      facts: await factsFor(callerTabId),
    });
  }

  // 4-6. A host-permitted listing tab: opened, navigated to another listing,
  //      then off to a host no permission covers.
  const opened = await openAndInspect(
    'listing-open',
    'tabs.get on a tab whose host IS permitted — is url visible without `tabs`?',
    LISTING_A,
  );
  steps.push(opened.record);
  const listingTabId = opened.tabId;

  if (listingTabId !== undefined) {
    await sleep(STEP_GAP_MS);
    steps.push(
      await navigateAndInspect(
        'listing-navigate-permitted',
        'tabs.onUpdated on a permitted→permitted navigation — does changeInfo.url arrive?',
        listingTabId,
        LISTING_B,
      ),
    );

    await sleep(STEP_GAP_MS);
    steps.push(
      await navigateAndInspect(
        'listing-navigate-unpermitted',
        'the departure that matters: a listing tab leaving for a host with NO permission',
        listingTabId,
        NON_HOST,
      ),
    );

    currentStep = 'listing-close';
    await browser.tabs.remove(listingTabId).catch(() => {});
  }

  // 7-8. The extension's own search page, opened and navigated: the exact tab
  //      a focus-check verdict publishes onto.
  const search = await openAndInspect(
    'search-page-open',
    "tabs.get on a freshly opened extension page — the focus-check guard's actual subject",
    browser.runtime.getURL('/search.html'),
  );
  steps.push(search.record);
  if (search.tabId !== undefined) {
    steps.push(
      await navigateAndInspect(
        'search-page-navigate',
        'tabs.onUpdated on an extension page navigating — does changeInfo.url arrive?',
        search.tabId,
        `${browser.runtime.getURL('/search.html')}?probe=moved`,
      ),
    );
    currentStep = 'search-page-close';
    await browser.tabs.remove(search.tabId).catch(() => {});
  }

  currentStep = 'done';
  return {
    builtWithTabsPermission: manifestPermissions.includes('tabs'),
    manifestPermissions,
    steps,
    updateEvents,
    portEvents,
    finishedAt: new Date().toISOString(),
  };
}

/**
 * Register the probe's recorders and its run listener. Call only under
 * `--mode perm-probe`.
 *
 * The recorders go on at worker startup, before anything is driven, so the
 * content script's own port connection on the first listing load is captured
 * rather than missed.
 */
export function registerPermProbe(): void {
  browser.tabs.onUpdated.addListener((tabId: number, changeInfo: { url?: string; status?: string }) => {
    // Recorded by KEY as well as by field: what the probe is really asking is
    // which properties Chrome chose to put in the object at all, and a typed
    // read of two of them would hide the answer.
    const delivered = changeInfo as unknown as Record<string, unknown>;
    updateEvents.push({
      duringStep: currentStep,
      tabId,
      keys: Object.keys(delivered),
      ...(typeof changeInfo.url === 'string' ? { url: changeInfo.url } : {}),
      ...(typeof changeInfo.status === 'string' ? { status: changeInfo.status } : {}),
    });
  });

  browser.runtime.onConnect.addListener(
    (port: {
      name: string;
      sender?: { tab?: { id?: number }; url?: string };
      onDisconnect: { addListener(listener: () => void): void };
    }) => {
      if (port.name !== PRESENCE_PORT_NAME) return;
      const record = (event: 'connect' | 'disconnect'): void => {
        portEvents.push({
          duringStep: currentStep,
          event,
          name: port.name,
          ...(port.sender?.tab?.id === undefined ? {} : { tabId: port.sender.tab.id }),
          ...(port.sender?.url === undefined ? {} : { senderUrl: port.sender.url }),
        });
      };
      record('connect');
      port.onDisconnect.addListener(() => record('disconnect'));
    },
  );

  browser.runtime.onMessage.addListener(
    (
      message: { type?: string },
      sender: { tab?: { id?: number } },
      sendResponse: (response?: unknown) => void,
    ) => {
      if (message.type !== 'PERM_PROBE_RUN') return undefined;
      void runProbe(sender.tab?.id).then(sendResponse);
      return true;
    },
  );
}
