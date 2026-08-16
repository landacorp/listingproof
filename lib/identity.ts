/**
 * Core data contract. An IdentityVector is one observation of a listing's
 * claimed identity, from the live page or from an archive snapshot.
 *
 * Platform-independent by design: a site adapter fills it in from whatever
 * markup its platform uses, and every engine downstream reads only this. Adding
 * a platform never changes this shape.
 *
 * Missing fields mean "unknown" (GRAY input), never "ok".
 */
export interface IdentityVector {
  /** Adapter that produced this observation: `booking`, `airbnb`, `generic`… */
  platform?: string;
  /** The platform's own id for this listing. */
  listingId?: string;
  name: string;
  address: string;
  city?: string;
  /**
   * The platform's internal destination key for the town — Booking's `ufi`, or
   * whatever equivalent another site exposes. Stable across languages.
   *
   * `city` cannot do this job: it is the town's name in the page's own
   * language, so the same hotel captured in two locales carries two different
   * strings. Comparing those is how a diff engine accuses an honest listing of
   * having moved. Where both sides carry a destination id, that is the
   * comparison to make.
   */
  destinationId?: string;
  country?: string;
  lat?: number;
  lng?: number;
  reviewCount?: number;
  reviewScore?: number;
  /**
   * Top of the platform's rating scale — 10 on Booking, 5 on Airbnb. Without it
   * a diff comparing 9.2 against 4.6 would read a rescale as a collapse in
   * reputation, so scores are only ever compared after normalising by this.
   */
  reviewScoreMax?: number;
  photoUrls: string[];
  propertyType?: string;
  capturedAt: string;
  source:
    | { kind: 'live' }
    | { kind: 'archive'; provider: 'wayback' | 'archivetoday'; timestamp: string };
}
