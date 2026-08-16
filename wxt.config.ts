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

export default defineConfig({
  hooks: {
    // WXT 0.20 has no per-entrypoint mode gate (include/exclude filter by
    // browser only), so the probe page is skipped here for every mode except
    // its own. The "skipped" warning WXT logs on normal builds is expected.
    'entrypoints:resolved': (wxt, entrypoints) => {
      if (wxt.config.mode === SEARCH_PROBE_MODE) return;
      for (const entrypoint of entrypoints) {
        if (entrypoint.name === 'searchprobe') entrypoint.skipped = true;
      }
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
    // `tabs` lets the panel know which listing the active tab is showing;
    // `scripting` lets the options page register the content script on sites
    // the user grants at runtime.
    permissions: ['storage', 'sidePanel', 'offscreen', 'tabs', 'scripting'],
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
