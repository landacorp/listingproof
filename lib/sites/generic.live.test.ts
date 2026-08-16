// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { adapterForDocument } from './registry';

/**
 * The generic adapter against REAL third-party sites.
 *
 * Every other generic test builds its documents by hand, which proves the
 * reader handles the shapes we thought of. These two pages are hotel-chain
 * sites nobody wrote a line of code for — Premier Inn (UK) and Accor (FR) —
 * and they are the evidence for the product's boldest claim: that a listing
 * site with standard schema.org markup works with no per-site adapter at all.
 *
 * They also cost nothing to keep honest. If a chain changes its markup, this
 * suite says so before a user does.
 */

const DIR = join(process.cwd(), 'fixtures/live-generic');

function parse(file: string): Document {
  return new DOMParser().parseFromString(readFileSync(join(DIR, file), 'utf8'), 'text/html');
}

interface Expected {
  file: string;
  url: string;
  name: string;
  country: string;
  lat: number;
  lng: number;
  reviewScore: number;
  reviewScoreMax: number;
  reviewCount: number;
  breadcrumbHead: string[];
  minPhotos: number;
}

/** Measured from the captured pages. */
const FIXTURES: Expected[] = [
  {
    file: 'gb-premierinn-county-hall.html',
    url: 'https://www.premierinn.com/gb/en/hotels/england/greater-london/london/london-county-hall.html',
    name: 'London County Hall',
    country: 'GB',
    lat: 51.502641,
    lng: -0.118106,
    reviewScore: 4.4,
    reviewScoreMax: 5,
    reviewCount: 11992,
    breadcrumbHead: ['Home', 'Hotel Directory', 'England'],
    minPhotos: 5,
  },
  {
    file: 'fr-accor-1393.html',
    url: 'https://all.accor.com/hotel/1393/index.en.shtml',
    name: 'Ibis Nancy Centre Stanislas - ALL',
    country: 'FR',
    lat: 48.693687,
    lng: 6.191901,
    reviewScore: 4.7,
    reviewScoreMax: 5,
    reviewCount: 1256,
    breadcrumbHead: ['Hotels', 'Europe', 'France'],
    minPhotos: 1,
  },
];

describe('the generic adapter reads real sites nobody wrote code for', () => {
  it.each(FIXTURES.map((f) => [f.file, f] as const))('%s', (_f, fixture) => {
    const doc = parse(fixture.file);
    const adapter = adapterForDocument(fixture.url, doc);

    // No bespoke adapter claims these hosts, so the fallback has to.
    expect(adapter?.id).toBe('generic');

    const identity = adapter!.extractIdentity(doc)!;
    expect(identity.name).toBe(fixture.name);
    expect(identity.country).toBe(fixture.country);
    expect(identity.lat).toBeCloseTo(fixture.lat, 4);
    expect(identity.lng).toBeCloseTo(fixture.lng, 4);
    expect(identity.reviewScore).toBeCloseTo(fixture.reviewScore, 2);
    // The scale must travel with the score: both these chains rate out of 5,
    // Booking out of 10, and nothing downstream may compare them raw.
    expect(identity.reviewScoreMax).toBe(fixture.reviewScoreMax);
    expect(identity.reviewCount).toBe(fixture.reviewCount);
    expect(identity.photoUrls.length).toBeGreaterThanOrEqual(fixture.minPhotos);
    expect(identity.address.length).toBeGreaterThan(0);

    const context = adapter!.extractContext(doc);
    expect(context.breadcrumbs.slice(0, 3)).toEqual(fixture.breadcrumbHead);
    // Breadcrumb labels must be place names, never the URLs schema.org puts in
    // the sibling `item` field — Engine A3 geocodes one of these.
    for (const crumb of context.breadcrumbs) {
      expect(crumb).not.toMatch(/^https?:\/\//);
    }
  }, 30_000);

  /**
   * Real markup is wrong in ways synthetic tests never are.
   *
   * Premier Inn publishes `addressLocality: "Belvedere Road"` — a street — and
   * puts the actual city in `addressRegion`. The adapter reports what the site
   * says, which is the correct behaviour for a reader; the protection lives
   * downstream, where `lib/diff.ts` keeps a name-only town comparison at YELLOW
   * precisely because fields like this are unreliable and get corrected.
   */
  it('faithfully reports a mislabelled locality rather than second-guessing it', () => {
    const doc = parse('gb-premierinn-county-hall.html');
    const identity = adapterForDocument(FIXTURES[0].url, doc)!.extractIdentity(doc)!;
    expect(identity.city).toBe('Belvedere Road');
    // …and the street it really is stays visible in the address, so a reader of
    // the evidence table can see the site's mistake for themselves.
    expect(identity.address).toContain('Belvedere Road');
  }, 30_000);

  /**
   * Premier Inn publishes five schema.org `Review` nodes on the same lodging
   * node as its aggregate — the standard place, read with no per-site code.
   * Accor publishes none, and the difference between the two is exactly what
   * `availability` has to keep honest: both adapters looked, one page served
   * reviews and the other did not.
   */
  it('reads the individual reviews a chain publishes in standard markup', () => {
    const doc = parse('gb-premierinn-county-hall.html');
    const reviewSet = adapterForDocument(FIXTURES[0].url, doc)!.extractContext(doc).reviewSet!;

    expect(reviewSet.availability).toBe('in-page');
    expect(reviewSet.items).toHaveLength(5);
    // 4.4 of 5 as published, 8.8 of 10 as the contract carries it.
    expect(reviewSet.summary).toEqual({ score: 8.8, total: 11992 });

    // Ground truth read straight out of the capture's JSON-LD.
    const first = reviewSet.items[0];
    expect(first.rawScore).toEqual({ value: 4, max: 5 });
    expect(first.score).toBe(8);
    expect(first.reviewedAt).toBe(Date.parse('2026-08-09T07:23:53-0400'));
    expect(first.positive?.startsWith('This hotel was a fabulous location')).toBe(true);

    for (const item of reviewSet.items) {
      expect(item.rawScore!.max).toBe(5);
      expect(item.score).toBeLessThanOrEqual(10);
      expect(item.positive!.length).toBeGreaterThan(0);
    }
  }, 30_000);

  it('says a page served no reviews without saying the property has none', () => {
    const doc = parse('fr-accor-1393.html');
    const reviewSet = adapterForDocument(FIXTURES[1].url, doc)!.extractContext(doc).reviewSet!;

    expect(reviewSet.items).toEqual([]);
    // `in-page` because this adapter does read `Review` nodes: the emptiness is
    // this page's answer, not a gap in what we looked at. The aggregate the
    // page DOES publish travels alongside, so a reader can see that 1,256
    // people reviewed it and none of those reviews are on the page.
    expect(reviewSet.availability).toBe('in-page');
    expect(reviewSet.summary).toEqual({ score: 9.4, total: 1256 });
  }, 30_000);

  it('never claims a destination id it does not have', () => {
    // No generic site exposes a language-independent town key, and pretending
    // otherwise would let the diff make an exact claim from a localized string.
    for (const fixture of FIXTURES) {
      const doc = parse(fixture.file);
      const identity = adapterForDocument(fixture.url, doc)!.extractIdentity(doc)!;
      expect(identity.destinationId).toBeUndefined();
      expect(identity.platform).toBe('generic');
    }
  }, 30_000);
});
