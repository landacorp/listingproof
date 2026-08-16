import { LISTING_MATCH_PATTERNS } from './sites/patterns';

/**
 * Turning "a site the user typed" into a Chrome match pattern, and knowing
 * which hosts the manifest already covers.
 *
 * Pure on purpose: the options page owns the actual `permissions.request` and
 * `scripting.registerContentScripts` calls and injects them into its
 * controller; everything here is decidable without a browser and is tested
 * that way. This is the seam DECISIONS.md reserved when the generic adapter
 * shipped with no match patterns of its own — covering "any site" honestly
 * means the user names the site and grants it, not an all-URLs install-time
 * permission on a privacy tool.
 */

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

/**
 * Normalise user input — a bare domain, a pasted listing URL, with or without
 * scheme — to the host a grant should target. `www.` is stripped so the grant
 * covers the whole site, not one alias of it. Returns null when the input
 * does not name an http(s) host.
 */
export function parseGrantHost(input: string): string | null {
  const trimmed = input.trim();
  if (trimmed === '') return null;
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  const host = url.hostname.replace(/^www\./, '');
  // A hostname with no dot is a typo or an intranet name, not a listing site.
  if (host === '' || !host.includes('.')) return null;
  return host;
}

/**
 * The match pattern a grant for this host requests and registers.
 * `*.host` matches the host itself and every subdomain; an IP literal cannot
 * take a subdomain wildcard, so it is matched exactly.
 */
export function originPatternFor(host: string): string {
  return IPV4.test(host) ? `*://${host}/*` : `*://*.${host}/*`;
}

/**
 * True when the manifest's own content-script patterns already run on this
 * host — granting it again would inject the script twice on listing pages.
 */
export function coveredByBuiltIn(host: string): boolean {
  return LISTING_MATCH_PATTERNS.some((pattern) => {
    const domain = pattern.split('/')[2]?.replace(/^\*\./, '');
    if (domain === undefined) return false;
    return host === domain || host.endsWith(`.${domain}`);
  });
}
