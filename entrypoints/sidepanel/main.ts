import { browser } from 'wxt/browser';
import { render } from './render';
import { createPanelController } from './controller';
import { mountLanguagePicker } from './langpicker';
import type { TabActivation } from './controller';
import type { ExtensionMessage } from '../../lib/messages';
import { activateLanguage, applyTranslations } from '../../lib/i18n';
import { createSettingsStore } from '../../background/settings';

/**
 * Side panel wiring. Rendering lives in `./render.ts` and tab correlation in
 * `./controller.ts`; this file only connects them to the browser.
 */

/**
 * The version, and the way into the map search page.
 *
 * The map search is deliberately unadvertised: it is a side quest next to the
 * panel's one job, and a link for it sat in the panel competing for attention
 * with the verdict. Five presses on the version opens it. Discoverability is
 * the point being traded away — anyone who needs it can be told, and nobody
 * who does not will ever find it by accident.
 *
 * The run resets after a pause, so five presses spread over a session do not
 * accumulate into a surprise navigation.
 */
const MAP_SEARCH_PRESSES = 5;
const PRESS_RUN_TIMEOUT_MS = 1500;

const versionButton = document.getElementById('version');
if (versionButton) {
  versionButton.textContent = `v${browser.runtime.getManifest().version}`;
  let presses = 0;
  let runTimer: ReturnType<typeof setTimeout> | undefined;
  versionButton.addEventListener('click', () => {
    presses += 1;
    clearTimeout(runTimer);
    if (presses < MAP_SEARCH_PRESSES) {
      runTimer = setTimeout(() => (presses = 0), PRESS_RUN_TIMEOUT_MS);
      return;
    }
    presses = 0;
    // A side panel cannot host the map, so it opens as its own tab — the
    // same place the old link sent it.
    void browser.tabs.create({ url: browser.runtime.getURL('/search.html') });
  });
}

/**
 * The language picker, between the wordmark and the version.
 *
 * The panel is the surface most users ever open, so the language lives here as
 * well as on the options and search pages; all three write the same setting and
 * every open page picks the change up through `storage.onChanged`.
 */
const languageSelect = document.getElementById('language');
if (languageSelect instanceof HTMLSelectElement) {
  mountLanguagePicker(languageSelect, {
    // save() sanitises: an unsupported code is stored (and applied) as English.
    save: async (language) => (await createSettingsStore().save({ language })).language,
    apply: (language) => applyLanguage(language),
  });
}

/**
 * The newest REQUEST_STATE round trip. `start()` fires its state request
 * without awaiting it, so this is the only handle on "the render start()
 * asked for has landed" — see `applyLanguage` below.
 */
let statePending: Promise<unknown> = Promise.resolve();

const controller = createPanelController({
  requestState: (tabId) => {
    const request = browser.runtime.sendMessage({ type: 'REQUEST_STATE', tabId });
    statePending = request.catch(() => undefined);
    return request;
  },
  queryActive: async () => {
    // In a side panel, `currentWindow` is the window hosting the panel.
    //
    // Ids only, and deliberately: `tabs.query` needs no permission, but the
    // `url`/`title` it would otherwise carry need the `tabs` one — Chrome's
    // "Read your browsing history" — and the panel has never wanted them. It
    // follows a NUMBER. `npm run probe:perm` confirms in a real browser that
    // `id` and `windowId` still arrive with `tabs` gone and `url` blank; do
    // not start reading `tab.url` here, it would be silently empty.
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    return { tabId: tab?.id, windowId: tab?.windowId };
  },
  requestRereport: (tabId) => {
    // Rejects when the tab runs no content script (not a listing page).
    void browser.tabs.sendMessage(tabId, { type: 'REREPORT' }).catch(() => {});
  },
  render: (state) => render(state),
});

browser.runtime.onMessage.addListener((message: ExtensionMessage) => {
  controller.onMessage(message);
  return undefined;
});

browser.tabs.onActivated.addListener((info: TabActivation) => {
  controller.onTabActivated(info);
});

/**
 * The language this panel is showing, or is on its way to showing.
 *
 * Claimed the moment an application is REQUESTED rather than when it lands, so
 * that the panel's own storage write — the picker above saves before applying —
 * echoes back through `storage.onChanged` to a listener that already knows
 * about it and does nothing. Without that, every switch made in the panel would
 * run twice: once for the picker, once for the echo of its own write.
 */
let activeLanguage: string | undefined;

/**
 * Language applications are numbered and queued. `controller.start()` re-requests
 * the tab's state asynchronously and has no supersession guard of its own, so two
 * rapid switches — or a switch that races the first start — could otherwise run
 * their round trips concurrently and let the older one's response paint last,
 * leaving the panel in the language the user just moved away from.
 *
 * Each application claims a generation, waits behind the previous one, and drops
 * out if a newer one has claimed a generation meanwhile. Only one start/refresh
 * cycle is ever in flight, and only the newest application reaches it.
 */
let languageGeneration = 0;
let languageApplied: Promise<void> = Promise.resolve();

function applyLanguage(language: string): Promise<void> {
  const generation = ++languageGeneration;
  activeLanguage = language;
  const application = languageApplied.then(async () => {
    if (generation !== languageGeneration) return; // a newer switch superseded this one
    activateLanguage(language);
    applyTranslations(document);
    // The picker follows a change made anywhere — the options page, the search
    // page, this panel's own control — because the setting is one value and
    // three views of it that disagree are three bugs waiting to be reported.
    if (languageSelect instanceof HTMLSelectElement) languageSelect.value = language;
    await controller.start();
    // start() resolves once it has *fired* its state request; wait for that
    // round trip too, so the next queued application cannot overlap this render.
    await statePending;
  });
  // One failed application must not wedge every later switch behind a rejected
  // queue; the caller still sees the error on the promise returned here.
  languageApplied = application.catch(() => {});
  return application;
}

// Language is activated before the first render (the listeners above render
// nothing until start() resolves the active tab, so no English flashes by).
void (async () => {
  const settings = await createSettingsStore().load();
  await applyLanguage(settings.language);
})();

// A language change on the options or search page applies here LIVE: the
// panel often sits open beside the page where the user switched, and an
// English panel next to a Russian page reads as a bug. start() re-requests
// the tab's state, which re-renders everything through the new catalog.
//
// Only a change of LANGUAGE may do that. The whole settings object lives under
// one storage key, and the search page rewrites it on every filter touch — a
// calendar day, a category, an occupancy step. Restarting the panel's state
// cycle (and pinging REREPORT) once per keystroke-sized preference write is
// work nobody asked for, so every write that leaves the language alone is
// ignored here.
browser.storage.onChanged.addListener((changes: Record<string, unknown>, area: string) => {
  if (area !== 'local' || !('settings' in changes)) return;
  void (async () => {
    const settings = await createSettingsStore().load();
    if (settings.language === activeLanguage) return;
    await applyLanguage(settings.language);
  })();
});
