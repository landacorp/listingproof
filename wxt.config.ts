import { defineConfig } from 'wxt';
import { BOOKING_SEARCH_RESULTS_PATTERN, LISTING_MATCH_PATTERNS } from './lib/sites/patterns';

/**
 * Map-area search probe: `npm run probe:search` (= `wxt --mode search-probe`)
 * builds the searchprobe entrypoint, which exists ONLY in that mode — `wxt
 * build`/`wxt zip` run in mode "production" and carry no probe tooling
 * (scripts/assert-probe-free.mjs enforces it). The searchresults host
 * permission the probe once monopolised ships for real since phase (b) —
 * the map search page uses it.
 */
const SEARCH_PROBE_MODE = 'search-probe';

/**
 * Permission probe: `npm run probe:perm` (= `wxt --mode perm-probe`), same
 * one-mode gate as above. It measures what a worker holding no `tabs`
 * permission can still see of a tab — see `background/permprobe.ts`.
 * `PROBE_WITH_TABS=1 npm run probe:perm` builds the identical probe WITH the
 * permission, which is the control that makes a blank field evidence.
 */
const PERM_PROBE_MODE = 'perm-probe';

/** Probe entrypoints and the one mode each is allowed to exist in. */
const PROBE_MODES: Record<string, string> = {
  searchprobe: SEARCH_PROBE_MODE,
  permprobe: PERM_PROBE_MODE,
};

export default defineConfig({
  hooks: {
    // WXT 0.20 has no per-entrypoint mode gate (include/exclude filter by
    // browser only), so a probe page is skipped here for every mode except its
    // own. The "skipped" warning WXT logs on normal builds is expected.
    'entrypoints:resolved': (wxt, entrypoints) => {
      for (const entrypoint of entrypoints) {
        const probeMode = PROBE_MODES[entrypoint.name];
        if (probeMode !== undefined && wxt.config.mode !== probeMode) entrypoint.skipped = true;
      }
    },
    /**
     * The permission probe runs on a DEV build (that is the only way to launch
     * a browser with the extension in it), and WXT's dev build adds `tabs` to
     * the manifest for its own extension-reload client. The first probe run
     * caught that only because the report prints the manifest it actually ran
     * under — otherwise it would have measured a permission it was supposed to
     * be measuring the absence of, and reported a clean pass.
     *
     * So take it back out for the probe's own mode. Left alone everywhere else:
     * production never had it, and `npm run dev` still needs WXT's reloading.
     */
    'build:manifestGenerated': (wxt, manifest) => {
      if (wxt.config.mode !== PERM_PROBE_MODE || process.env.PROBE_WITH_TABS === '1') return;
      manifest.permissions = (manifest.permissions ?? []).filter(
        (permission) => permission !== 'tabs',
      );
    },
  },
  manifest: (env) => ({
    name: 'ListingProof',
    description:
      'Checks an accommodation listing for contradictions on the page itself, and shows the evidence.',
    // Listing pages the content script reads. They come from
    // lib/sites/patterns.ts, which a test keeps in step with the site adapters
    // — so a permission here always traces back to an adapter that needs it.
    host_permissions: [
      ...LISTING_MATCH_PATTERNS,
      'https://nominatim.openstreetmap.org/*',
      'http://localhost:11434/*',
      // Map-area search (phase b): the worker fetches one page of Booking
      // search results per explicit user search. Same host as /hotel/* above,
      // so Chrome's per-host install warning is unchanged and updates roll
      // out without a re-approval disable. The probe (phase a) proved the
      // fetch; scripts/assert-probe-free.mjs still bars the probe TOOLING
      // from production builds.
      BOOKING_SEARCH_RESULTS_PATTERN,
    ],
    // `offscreen` gives the service worker a DOMParser for the listing pages it
    // fetches itself — the map search page's "check this result without opening
    // it" path — since MV3 workers have none;
    // `scripting` lets the options page register the content script on sites
    // the user grants at runtime.
    //
    // `tabs` is deliberately NOT here. Chrome shows it to the user as "Read
    // your browsing history", which is the loudest line an install dialog can
    // carry and an unreasonable price for what it actually bought: two guards
    // that needed to know whether the page behind a verdict was still there.
    // Both now learn that from a `runtime.connect` port the page itself holds
    // (`lib/presence.ts`) and from the content script reporting its own
    // `location` — neither of which needs a permission, and both of which see
    // MORE than `Tab.url` could (a reload; a departure to a host no permission
    // covers). The rest of the `chrome.tabs` surface this extension uses —
    // `query` for ids and window ids, `onActivated`, `onRemoved`, `create`,
    // `sendMessage` — never required the permission; `npm run probe:perm`
    // measures that in a real browser rather than trusting the documentation.
    permissions: [
      'storage',
      'sidePanel',
      'offscreen',
      'scripting',
      // The probe's CONTROL run only, never a build anyone ships:
      // `PROBE_WITH_TABS=1 npm run probe:perm` grants the permission so the
      // ordinary run's blank fields can be attributed to its absence rather
      // than to a broken probe.
      ...(env.mode === PERM_PROBE_MODE && process.env.PROBE_WITH_TABS === '1' ? ['tabs'] : []),
    ],
    // The pool user grants draw from — nothing here is requested at install
    // (optional permissions carry no install warning). The generic schema.org
    // adapter only ever runs on a site after the user names it on the options
    // page and the browser grants that one origin.
    optional_host_permissions: ['*://*/*'],
    icons: {
      16: 'icon/16.png',
      32: 'icon/32.png',
      48: 'icon/48.png',
      128: 'icon/128.png',
    },
    // A toolbar action is what opens the side panel (background.ts sets
    // openPanelOnActionClick); without it the panel is only reachable from
    // Chrome's side-panel menu.
    action: {
      default_title: 'ListingProof — check this listing',
    },
  }),
});
