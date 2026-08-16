/**
 * Geocoder contract. The Nominatim implementation lives in
 * `background/geocode.ts` (network + rate limiting + cache); Engine A depends
 * only on this interface so it can be tested against a fake without touching
 * the network or waiting on a 1 req/s limiter.
 */
import type { LatLng } from './geo';

export interface GeocodeResult extends LatLng {
  /** Provider's canonical name for the match, shown as evidence in the panel. */
  displayName: string;
  /** Provider's own confidence/importance, when supplied. */
  importance?: number;
}

export interface GeocodeOptions {
  /** ISO-2 country hint; narrows ambiguous landmark names to the right country. */
  countryCode?: string;
}

export interface Geocoder {
  /** Resolve a free-text place to coordinates. Null means "no match", not an error. */
  geocode(query: string, options?: GeocodeOptions): Promise<GeocodeResult | null>;
}
