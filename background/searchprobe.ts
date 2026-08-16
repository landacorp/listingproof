/**
 * Map-area search, phase (a): the worker half of the live probe.
 *
 * The question under test is precisely "can THE SERVICE WORKER fetch
 * `searchresults.html`?" — so the fetch must run here, not in the probe page
 * (an extension page shares the cookie jar but not the answer the feature
 * needs). The probe page sends `SEARCH_PROBE_FETCH`; this listener performs
 * one fetch and returns transport facts plus a coarse assessment and the raw
 * body for capture.
 *
 * Never shipped: `entrypoints/background.ts` calls `registerSearchProbe()`
 * only under `import.meta.env.MODE === 'search-probe'`, and the message type
 * is deliberately kept out of the `ExtensionMessage` union so production
 * message handling never learns it exists.
 */

import { browser } from 'wxt/browser';
import { assessSearchHtml, type SearchHtmlAssessment } from '../lib/sites/booking/searchresults';

export interface SearchProbeFetchMessage {
  type: 'SEARCH_PROBE_FETCH';
  url: string;
  credentials: 'omit' | 'include';
}

export interface SearchProbeFetchResult {
  ok: boolean;
  /** Distinguishes "server answered" from "fetch itself threw" (CORS, DNS, timeout). */
  error?: string;
  status?: number;
  redirected?: boolean;
  finalUrl?: string;
  headers?: Record<string, string>;
  assessment?: SearchHtmlAssessment;
  /** Raw body, returned for capture-server upload by the probe page. */
  html?: string;
  elapsedMs: number;
}

const PROBE_FETCH_TIMEOUT_MS = 30_000;

/** Response headers worth recording as bot-defense evidence. */
const HEADERS_OF_INTEREST = ['content-type', 'content-length', 'server', 'via', 'x-cache'];

async function probeFetch(message: SearchProbeFetchMessage): Promise<SearchProbeFetchResult> {
  const started = Date.now();
  try {
    const response = await fetch(message.url, {
      credentials: message.credentials,
      // The warm phase re-fetches URLs near the one a real tab just loaded;
      // no-store keeps the HTTP cache from manufacturing a false pass.
      cache: 'no-store',
      // Accept is CORS-safelisted (no preflight) and matches a navigation
      // more closely than fetch's default */*.
      headers: { Accept: 'text/html,application/xhtml+xml' },
      signal: AbortSignal.timeout(PROBE_FETCH_TIMEOUT_MS),
    });
    const html = await response.text();
    const headers: Record<string, string> = {};
    for (const name of HEADERS_OF_INTEREST) {
      const value = response.headers.get(name);
      if (value !== null) headers[name] = value;
    }
    return {
      ok: true,
      status: response.status,
      redirected: response.redirected,
      finalUrl: response.url,
      headers,
      assessment: assessSearchHtml(html),
      html,
      elapsedMs: Date.now() - started,
    };
  } catch (error) {
    return { ok: false, error: String(error), elapsedMs: Date.now() - started };
  }
}

/** Register the probe listener. Call only under `--mode search-probe`. */
export function registerSearchProbe(): void {
  browser.runtime.onMessage.addListener(
    (message: { type?: string }, _sender: unknown, sendResponse: (r?: unknown) => void) => {
      if (message.type !== 'SEARCH_PROBE_FETCH') return undefined;
      void probeFetch(message as SearchProbeFetchMessage).then(sendResponse);
      return true;
    },
  );
}
