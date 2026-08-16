/**
 * Site adapters: the only place a specific listing platform is known about.
 *
 * Everything above this boundary — the diff rules, the scorer, Engine A, Engine
 * L, the panel — works on an `IdentityVector` and knows nothing about who
 * published it. Adding a platform means adding an adapter, not touching an
 * engine.
 *
 * The contract is shaped by how differently platforms behave. Two examples that
 * drove it:
 *
 *  - Booking bakes the property name into the URL slug at listing creation, and
 *    the slug survives renames. That fossil is Engine A1's entire basis. Airbnb
 *    URLs are `/rooms/<numeric id>` and carry no name at all, so A1 has nothing
 *    to work with there. An adapter therefore declares whether its URLs are
 *    name-bearing rather than every engine guessing.
 *  - Booking's JSON-LD puts the street in `addressLocality` and omits `geo`
 *    entirely; Airbnb's is clean schema.org with top-level coordinates. A
 *    generic reader handles the second case and would silently mis-read the
 *    first, so a platform can override as much or as little as it needs.
 */
import type { AreaSearchQuery } from '../areasearch';
import type { IdentityVector } from '../identity';
import type { PageContext } from '../pagecontext';
import type { ListingTerms } from '../terms';

/** What an adapter's URLs and markup can support, so engines can skip cleanly. */
export interface SiteCapabilities {
  /**
   * True when the URL encodes the property name (a slug), making it a record of
   * what the listing used to be called. Engine A1 runs only for these.
   */
  nameBearingUrl: boolean;
  /**
   * True when the platform exposes a stable, language-independent key for the
   * town. Lets the diff compare places exactly instead of comparing localized
   * names, which is how an honest listing gets accused of having moved.
   */
  destinationId: boolean;
  /** True when the page lists nearby landmarks with claimed distances (Engine A2). */
  nearbyLandmarks: boolean;
}

/** A listing URL reduced to the parts that identify it. */
export interface CanonicalListing {
  /** Adapter id that produced this, e.g. `booking`, `airbnb`, `generic`. */
  platform: string;
  /** Locale-stripped canonical page URL. */
  canonicalUrl: string;
  /** Scheme-less prefix for archive `matchType=prefix` queries. */
  cdxPrefix: string;
  /**
   * Name-derived URL segment, when the platform has one. Absent on platforms
   * whose URLs are opaque ids — which is not a failure, just a missing signal.
   */
  slug?: string;
  /** Platform's own listing id, when the URL carries one. */
  listingId?: string;
  /** Two-letter country segment, where the URL encodes one. */
  countryCode?: string;
  /** Locale suffix the input URL carried, if any. */
  locale?: string;
}

export interface ExtractOptions {
  /** Injectable clock for deterministic tests. */
  now?: () => Date;
}

export interface SiteAdapter {
  /** Stable id, used in canonical listings and in evidence provenance. */
  readonly id: string;
  /** Human name for the panel, e.g. "Booking.com". */
  readonly label: string;
  /**
   * The platform's front door, e.g. "https://www.booking.com". Optional; the
   * search page links it when the platform's bot check needs a real visit to
   * clear. Platform URLs live here, never in entrypoints.
   */
  readonly homepage?: string;
  readonly capabilities: SiteCapabilities;

  /** Chrome match patterns this adapter wants the content script to run on. */
  readonly matchPatterns: readonly string[];

  /** True when this adapter recognises the URL as one of its listing pages. */
  handles(url: URL): boolean;

  /** Parse a listing URL into its canonical identity, or null if not a listing page. */
  canonicalize(url: URL): CanonicalListing | null;

  /** Read the listing's claimed identity from a rendered document. */
  extractIdentity(doc: Document, options?: ExtractOptions): IdentityVector | null;

  /** Read secondary page content: breadcrumbs, landmarks, description, reviews. */
  extractContext(doc: Document): PageContext;

  /**
   * Reduce a photo URL to the platform-stable identity of the image, so the
   * same picture served at a different size or from a different CDN host
   * compares equal. Return null for anything that is not a listing photo.
   */
  normalizePhotoUrl(url: string): string | null;

  /**
   * Read the listing's booking terms — parking, cancellation, payment method —
   * for the consumer advisories. Optional: a platform whose markup does not
   * expose them simply leaves the panel saying "could not check". Facts only;
   * the rules live in `lib/terms.ts`.
   */
  extractTerms?(doc: Document): ListingTerms;

  /**
   * Spell an area query in this platform's search-URL dialect. Optional: only
   * platforms with a map-area search implement it. The worker calls this with
   * a validated query and fetches the result — pages never hand the worker a
   * URL, so the search fetch cannot become a fetch-anything proxy.
   */
  buildSearchUrl?(query: AreaSearchQuery): string;

  /**
   * Classify a fetched search-results body without a DOM: real results, the
   * platform's bot challenge, or something else. Runs in the worker (which
   * has no DOMParser) to label the outcome honestly before the page parses.
   */
  assessSearchHtml?(html: string): SearchFetchOutcome;

  /**
   * Read result cards out of a rendered (or DOMParser-parsed) search-results
   * document. Optional, paired with `buildSearchUrl`. Facts only, partial by
   * design: a card missing its name or URL is skipped, not invented.
   */
  parseSearchResults?(doc: Document): SearchResultCard[];
}

/** What a search fetch actually returned, in platform-neutral terms. */
export type SearchFetchOutcome = 'results' | 'challenge' | 'other';

/**
 * One card from a platform's search results. Texts are kept as the page
 * printed them (`priceText`, `distanceText`) — phase (b) lists results, it
 * does not yet interpret money or measure distances.
 */
export interface SearchResultCard {
  /** Property name as the card shows it. */
  name: string;
  /** Absolute link target of the card, tracking params and all. */
  url: string;
  /** The platform-canonical listing URL, when the card URL canonicalizes. */
  canonicalUrl?: string;
  /** Price as printed, e.g. "€ 1,109" — currency symbol included. */
  priceText?: string;
  /** Review score as a number, e.g. 8.3. */
  reviewScore?: number;
  reviewCount?: number;
  /** Neighbourhood / town line as printed. */
  address?: string;
  /** Distance from map centre as printed, e.g. "150 m from map center". */
  distanceText?: string;
  thumbnailUrl?: string;
  /**
   * The property's own position, when the results page embeds one (set as a
   * pair or not at all). Powers result markers on the search map.
   */
  latitude?: number;
  longitude?: number;
}
