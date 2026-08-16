/**
 * Adapter registry: turns a URL into the adapter that understands it.
 *
 * Order matters. Bespoke adapters are tried first and the generic schema.org
 * reader is the fallback, so a platform with known markup quirks is never
 * handled by the reader that would misread them — but a platform nobody has
 * written an adapter for still works, as long as it publishes standard
 * lodging markup. That fallback is what makes "any listing site" true rather
 * than aspirational.
 */
import { airbnbAdapter } from './airbnb';
import { bookingAdapter } from './booking';
import { genericAdapter } from './generic';
import type { SiteAdapter } from './types';

/** Bespoke adapters, most specific first. The generic one is not in this list. */
export const SITE_ADAPTERS: readonly SiteAdapter[] = [bookingAdapter, airbnbAdapter];

/** Every adapter including the fallback, for enumeration (docs, manifest, tests). */
export const ALL_ADAPTERS: readonly SiteAdapter[] = [...SITE_ADAPTERS, genericAdapter];

/**
 * The adapter for a URL, or undefined when nothing recognises it as a listing.
 *
 * The generic adapter only claims a page when that page actually carries
 * lodging markup, which it cannot tell from the URL alone — so URL-only
 * resolution returns a bespoke adapter or nothing, and `adapterForDocument`
 * is what brings the fallback into play.
 */
export function adapterForUrl(url: string): SiteAdapter | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  return SITE_ADAPTERS.find((adapter) => adapter.handles(parsed));
}

/**
 * The adapter for a page: its own platform's, or the generic reader when the
 * document carries recognisable lodging markup.
 */
export function adapterForDocument(url: string, doc: Document): SiteAdapter | undefined {
  const bespoke = adapterForUrl(url);
  if (bespoke) return bespoke;
  return genericAdapter.extractIdentity(doc) ? genericAdapter : undefined;
}

/** Look an adapter up by its id, e.g. from a canonical listing's `platform`. */
export function adapterById(id: string | undefined): SiteAdapter | undefined {
  return id === undefined ? undefined : ALL_ADAPTERS.find((adapter) => adapter.id === id);
}

/** Match patterns every adapter wants, for the manifest and for documentation. */
export function allMatchPatterns(): string[] {
  return [...new Set(ALL_ADAPTERS.flatMap((a) => [...a.matchPatterns]))];
}
