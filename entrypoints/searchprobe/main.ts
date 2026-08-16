/**
 * Map-area search, phase (a): the probe orchestrator (mode-gated entrypoint;
 * built only under `wxt --mode search-probe`, so nothing here ships).
 *
 * Sequence, designed to answer ROADMAP's two open questions in one run:
 *
 *   1. COLD — worker fetches a dated latlong search with an empty cookie jar
 *      (the dev profile is a fresh temp dir every launch), `omit` then
 *      `include` credentials.
 *   2. WARM-TAB — open the same search in a real tab and read its DOM via
 *      `scripting.executeScript`. This both warms the cookie jar (the in-page
 *      challenge JS runs and sets its cookies) and directly tests ROADMAP's
 *      fallback plan ("open the search in a real tab and read it with the
 *      content script").
 *   3. WARM — worker fetches again, `omit`/`include`, plus an undated
 *      variant. Warm fetches use different coordinates and dates than the
 *      tab, and the worker fetch is `cache: 'no-store'`, so the HTTP cache
 *      cannot manufacture a false pass.
 *
 * Every body and a JSON summary are POSTed to the fixture capture server
 * (`scripts/capture-server.mjs`, 127.0.0.1:8787) when it is running, so the
 * probe is fully observable from the repo without touching the browser.
 */

import { browser } from 'wxt/browser';
import { buildSearchResultsUrl } from '../../lib/sites/booking/searchresults';
import { assessSearchHtml } from '../../lib/sites/booking/searchresults';
import type { SearchProbeFetchResult } from '../../background/searchprobe';

const CAPTURE_SERVER = 'http://127.0.0.1:8787/';
/** Politeness gap between consecutive requests to Booking. */
const STEP_GAP_MS = 2_500;
/** Extra settle time after the warm tab reports `complete`, for challenge JS + hydration. */
const WARM_TAB_SETTLE_MS = 10_000;
const WARM_TAB_LOAD_TIMEOUT_MS = 45_000;

/** Paris, dated — the shape the feature would issue. Used cold and for the warm tab. */
const PARIS_DATED = buildSearchResultsUrl({
  latitude: 48.8566,
  longitude: 2.3522,
  radiusKm: 5,
  checkin: '2026-09-10',
  checkout: '2026-09-12',
  adults: 2,
  rooms: 1,
  children: 0,
});
/** Nice, different dates — warm-jar worker fetches that can never be tab cache hits. */
const NICE_DATED = buildSearchResultsUrl({
  latitude: 43.7102,
  longitude: 7.262,
  radiusKm: 5,
  checkin: '2026-09-17',
  checkout: '2026-09-19',
  adults: 2,
  rooms: 1,
  children: 0,
});
const NICE_UNDATED = buildSearchResultsUrl({
  latitude: 43.7102,
  longitude: 7.262,
  radiusKm: 5,
  adults: 2,
  rooms: 1,
  children: 0,
});

interface StepRecord {
  step: string;
  url: string;
  result: SearchProbeFetchResult;
}

const rows = document.getElementById('rows') as HTMLElement;
const table = document.getElementById('table') as HTMLTableElement;
const log = document.getElementById('log') as HTMLElement;

function note(text: string): void {
  log.textContent += `${text}\n`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function renderRow(record: StepRecord): void {
  table.hidden = false;
  const { result } = record;
  const verdict = result.assessment?.verdict ?? 'error';
  const row = document.createElement('tr');
  const cells = [
    record.step,
    result.ok ? String(result.status) : (result.error ?? 'error'),
    String(result.assessment?.chars ?? '—'),
    String(result.assessment?.propertyCards ?? '—'),
    String(result.assessment?.hotelLinks ?? '—'),
    verdict,
    result.assessment?.title ?? '',
  ];
  for (const text of cells) {
    const cell = document.createElement('td');
    cell.textContent = text;
    row.appendChild(cell);
  }
  row.className = verdict;
  rows.appendChild(row);
}

async function upload(name: string, body: string): Promise<void> {
  try {
    await fetch(`${CAPTURE_SERVER}?name=${encodeURIComponent(name)}`, { method: 'POST', body });
  } catch {
    note(`capture server not reachable — ${name} not saved`);
  }
}

async function workerFetch(
  step: string,
  url: string,
  credentials: 'omit' | 'include',
  filePrefix: string,
): Promise<StepRecord> {
  const result = (await browser.runtime.sendMessage({
    type: 'SEARCH_PROBE_FETCH',
    url,
    credentials,
  })) as SearchProbeFetchResult;
  const record = { step, url, result };
  renderRow(record);
  if (result.html !== undefined) await upload(`${filePrefix}-${step}.html`, result.html);
  return record;
}

/** Open the search in a real tab, wait for load + settle, read its DOM, close it. */
async function warmTabCapture(url: string, filePrefix: string): Promise<StepRecord> {
  const tab = await browser.tabs.create({ url, active: false });
  const tabId = tab.id;
  if (tabId === undefined) throw new Error('warm tab has no id');
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      browser.tabs.onUpdated.removeListener(onUpdated);
      resolve(); // capture whatever state the tab reached
    }, WARM_TAB_LOAD_TIMEOUT_MS);
    function onUpdated(id: number, info: { status?: string }): void {
      if (id === tabId && info.status === 'complete') {
        clearTimeout(timer);
        browser.tabs.onUpdated.removeListener(onUpdated);
        resolve();
      }
    }
    browser.tabs.onUpdated.addListener(onUpdated);
  });
  await sleep(WARM_TAB_SETTLE_MS);

  const started = Date.now();
  let result: SearchProbeFetchResult;
  try {
    const [injection] = await browser.scripting.executeScript({
      target: { tabId },
      func: () => ({
        html: `<!DOCTYPE html>\n${document.documentElement.outerHTML}`,
        url: location.href,
        title: document.title,
      }),
    });
    const captured = injection?.result as { html: string; url: string } | undefined;
    if (captured === undefined) throw new Error('executeScript returned nothing');
    result = {
      ok: true,
      finalUrl: captured.url,
      assessment: assessSearchHtml(captured.html),
      html: captured.html,
      elapsedMs: Date.now() - started,
    };
  } catch (error) {
    result = { ok: false, error: String(error), elapsedMs: Date.now() - started };
  }
  await browser.tabs.remove(tabId).catch(() => {});
  const record = { step: 'warm-tab-dom', url, result };
  renderRow(record);
  if (result.html !== undefined) await upload(`${filePrefix}-warm-tab-dom.html`, result.html);
  return record;
}

// Cold-ness is a property of the BROWSER LAUNCH (the dev profile is a fresh
// temp dir), not of a run: the first run's warm-tab step warms the jar for
// the rest of the session. So only run 1 may honestly label its opening
// fetches "cold"; later runs say "rerun" and suffix their artifacts with the
// run number instead of overwriting run 1's evidence. The button is disabled
// while a run is in flight so sequences can never interleave.
let running = false;
let runCount = 0;
const runButton = document.getElementById('run') as HTMLButtonElement;

async function run(): Promise<void> {
  if (running) return;
  running = true;
  runButton.disabled = true;
  runCount += 1;
  const coldLabel = runCount === 1 ? 'cold' : 'rerun';
  const filePrefix = runCount === 1 ? 'probe' : `probe-r${runCount}`;
  try {
    rows.textContent = '';
    log.textContent = '';
    note(`probe run ${runCount} started`);
    const records: StepRecord[] = [];

    records.push(await workerFetch(`${coldLabel}-omit`, PARIS_DATED, 'omit', filePrefix));
    await sleep(STEP_GAP_MS);
    records.push(await workerFetch(`${coldLabel}-include`, PARIS_DATED, 'include', filePrefix));
    await sleep(STEP_GAP_MS);

    note('opening warm tab…');
    records.push(await warmTabCapture(PARIS_DATED, filePrefix));
    await sleep(STEP_GAP_MS);

    records.push(await workerFetch('warm-omit', NICE_DATED, 'omit', filePrefix));
    await sleep(STEP_GAP_MS);
    records.push(await workerFetch('warm-include', NICE_DATED, 'include', filePrefix));
    await sleep(STEP_GAP_MS);
    records.push(await workerFetch('warm-undated-include', NICE_UNDATED, 'include', filePrefix));

    const summary = records.map(({ step, url, result }) => ({
      step,
      url,
      ok: result.ok,
      error: result.error,
      status: result.status,
      redirected: result.redirected,
      finalUrl: result.finalUrl,
      headers: result.headers,
      elapsedMs: result.elapsedMs,
      assessment:
        result.assessment === undefined
          ? undefined
          : { ...result.assessment, title: result.assessment.title ?? null },
    }));
    // The capture server only accepts *.html names; the summary is JSON regardless.
    await upload(`${filePrefix}-summary.json.html`, JSON.stringify(summary, null, 2));
    note(`probe run ${runCount} finished`);
  } finally {
    running = false;
    runButton.disabled = false;
  }
}

runButton.addEventListener('click', () => void run());
if (new URLSearchParams(location.search).get('auto') === '1') void run();
