// Tripwire for the store-build invariant: no map-search probe TOOLING may
// reach a production build — not the searchprobe page, not the worker's
// SEARCH_PROBE_FETCH listener (a credentialed fetch-any-URL primitive).
// The searchresults host permission itself ships since phase (b); see below.
//
// The invariant otherwise rests on three separately fragile mechanisms:
// Vite constant-folding `import.meta.env.MODE` plus Rollup tree-shaking the
// side-effect-free probe module, the `entrypoints:resolved` hook honouring
// `skipped`, and the manifest function's mode conditional. A review of the
// probe change demonstrated that a single top-level side effect added to
// background/searchprobe.ts ships the listener while build, tsc and tests
// all stay green — the same "ad-hoc checks miss things" lesson the scrubber
// header records. Hence a committed check, run after every `npm run build`
// and `npm run zip`.
//
// Phase (b) shipped search support for real (map page + searchresults host
// permission + SEARCH_AREA_FETCH), so the manifest check that once barred
// "searchresults" was consciously relaxed in that same commit — the probe
// TOOLING (searchprobe page, SEARCH_PROBE_FETCH listener) remains barred.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// fileURLToPath, not URL#pathname: the latter yields "/D:/…" on Windows,
// which fs resolves to a non-existent drive-doubled path (broke CI there).
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const OUT = join(ROOT, '.output/chrome-mv3');

/** Case-insensitive needles no production file may contain. */
const FORBIDDEN_EVERYWHERE = ['searchprobe', 'search_probe'];
/** Nothing manifest-specific is barred since phase (b); kept for the next probe. */
const FORBIDDEN_IN_MANIFEST = [];

const failures = [];

function walk(dir) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      walk(path);
      continue;
    }
    const lower = entry.toLowerCase();
    for (const needle of FORBIDDEN_EVERYWHERE) {
      if (lower.includes(needle)) failures.push(`file named for the probe: ${path}`);
    }
    if (/\.(?:js|html|css|json)$/.test(lower)) {
      const text = readFileSync(path, 'utf8').toLowerCase();
      for (const needle of FORBIDDEN_EVERYWHERE) {
        if (text.includes(needle)) failures.push(`"${needle}" inside ${path}`);
      }
      if (lower === 'manifest.json') {
        for (const needle of FORBIDDEN_IN_MANIFEST) {
          if (text.includes(needle)) failures.push(`"${needle}" in ${path}`);
        }
      }
    }
  }
}

try {
  walk(OUT);
} catch (error) {
  console.error(`assert-probe-free: cannot read ${OUT} — run the build first (${error})`);
  process.exit(1);
}

if (failures.length > 0) {
  console.error('assert-probe-free: PROBE CODE IN THE PRODUCTION BUILD:');
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log('assert-probe-free: production build carries no probe code');
