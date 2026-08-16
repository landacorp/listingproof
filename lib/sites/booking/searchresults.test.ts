// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { bookingAdapter } from './index';
import {
  assessSearchHtml,
  buildSearchResultsUrl,
  extractReviewNumbers,
  parseSearchResults,
} from './searchresults';

// vitest runs with the project root as cwd (import.meta.url is not a file:
// URL under the jsdom environment).
const FIXTURE_DIR = join(process.cwd(), 'fixtures/live-search');
const FIXTURE_TIMEOUT = 30_000; // jsdom parses ~1.7 MB per fixture

function readFixture(file: string): string {
  return readFileSync(join(FIXTURE_DIR, file), 'utf8');
}

function parseFixture(file: string): Document {
  return new DOMParser().parseFromString(readFixture(file), 'text/html');
}

describe('buildSearchResultsUrl', () => {
  it('builds a dated latlong search with explicit occupancy', () => {
    const url = new URL(
      buildSearchResultsUrl({
        latitude: 48.8566,
        longitude: 2.3522,
        radiusKm: 5,
        checkin: '2026-09-10',
        checkout: '2026-09-12',
        adults: 2,
        rooms: 1,
        children: 0,
      }),
    );
    expect(url.origin + url.pathname).toBe('https://www.booking.com/searchresults.html');
    expect(url.searchParams.get('dest_type')).toBe('latlong');
    expect(url.searchParams.get('latitude')).toBe('48.8566');
    expect(url.searchParams.get('longitude')).toBe('2.3522');
    expect(url.searchParams.get('radius')).toBe('5');
    expect(url.searchParams.get('checkin')).toBe('2026-09-10');
    expect(url.searchParams.get('checkout')).toBe('2026-09-12');
    expect(url.searchParams.get('group_adults')).toBe('2');
    expect(url.searchParams.get('no_rooms')).toBe('1');
    expect(url.searchParams.get('group_children')).toBe('0');
  });

  it('omits dates unless both ends are given, and passes occupancy through', () => {
    const url = new URL(
      buildSearchResultsUrl({
        latitude: 43.7102,
        longitude: 7.262,
        radiusKm: 5,
        checkin: '2026-09-10',
        adults: 3,
        rooms: 2,
        children: 1,
      }),
    );
    expect(url.searchParams.has('checkin')).toBe(false);
    expect(url.searchParams.has('checkout')).toBe(false);
    expect(url.searchParams.get('radius')).toBe('5');
    expect(url.searchParams.get('group_adults')).toBe('3');
    expect(url.searchParams.get('no_rooms')).toBe('2');
    expect(url.searchParams.get('group_children')).toBe('1');
  });
});

describe('assessSearchHtml', () => {
  const card = '<div data-testid="property-card"><a href="/hotel/fr/le-petit.html">x</a></div>';

  it('classifies a page of property cards as results', () => {
    const html = `<html><title>Booking.com: hotels in Paris</title>${card.repeat(7)}</html>`;
    const assessment = assessSearchHtml(html);
    expect(assessment.verdict).toBe('results');
    expect(assessment.propertyCards).toBe(7);
    expect(assessment.hotelLinks).toBe(7);
    expect(assessment.title).toBe('Booking.com: hotels in Paris');
    expect(assessment.challengeMarkers).toEqual([]);
  });

  it('classifies the Akamai challenge stub as challenge', () => {
    // Shape recorded from a live challenge body (2026-08-14, HTTP 202).
    const html =
      '<html><head><title></title>' +
      '<script src="https://www.booking.com/__challenge_h78I/d8c1/a18a/challenge.js"></script>' +
      '</head><body><div id="challenge-container"></div></body></html>';
    const assessment = assessSearchHtml(html);
    expect(assessment.verdict).toBe('challenge');
    expect(assessment.challengeMarkers).toEqual([
      '__challenge_',
      'challenge-container',
      'challenge.js',
    ]);
    expect(assessment.propertyCards).toBe(0);
    expect(assessment.title).toBeNull();
  });

  it('prefers results over challenge when both markers appear', () => {
    const html = `<html>${card.repeat(3)}<script>var s='challenge.js'</script></html>`;
    expect(assessSearchHtml(html).verdict).toBe('results');
  });

  it('returns other for a page that is neither', () => {
    const assessment = assessSearchHtml('<html><title>Sign in</title><p>robot?</p></html>');
    expect(assessment.verdict).toBe('other');
    expect(assessment.hotelLinks).toBe(0);
  });

  it('treats a link-list without cards as results only at five or more links', () => {
    const links = (n: number) => '<a href="https://www.booking.com/hotel/fr/x.html">y</a>'.repeat(n);
    expect(assessSearchHtml(links(4)).verdict).toBe('other');
    expect(assessSearchHtml(links(5)).verdict).toBe('results');
  });
});

describe('buildSearchResultsUrl category filter', () => {
  const base = { latitude: 43.7, longitude: 7.26, radiusKm: 5, adults: 2, rooms: 1, children: 0 };

  it('spells categories as semicolon-joined ht_id pairs in nflt', () => {
    const url = new URL(
      buildSearchResultsUrl({ ...base, categories: ['hotel', 'apartment', 'holiday-home'] }),
    );
    // Codes from the live filter sidebar (fixtures/live-search, 2026-08-14).
    expect(url.searchParams.get('nflt')).toBe('ht_id=204;ht_id=201;ht_id=220');
  });

  it('omits nflt entirely without categories', () => {
    expect(new URL(buildSearchResultsUrl(base)).searchParams.has('nflt')).toBe(false);
    expect(
      new URL(buildSearchResultsUrl({ ...base, categories: [] })).searchParams.has('nflt'),
    ).toBe(false);
  });

  it('spells the price sort hint as order=price, absent otherwise', () => {
    expect(
      new URL(buildSearchResultsUrl({ ...base, sortHint: 'price' })).searchParams.get('order'),
    ).toBe('price');
    expect(new URL(buildSearchResultsUrl(base)).searchParams.has('order')).toBe(false);
  });

  it('maps our language codes to Booking lang values, dropping unknown ones', () => {
    expect(
      new URL(buildSearchResultsUrl({ ...base, language: 'ru' })).searchParams.get('lang'),
    ).toBe('ru');
    expect(
      new URL(buildSearchResultsUrl({ ...base, language: 'zh' })).searchParams.get('lang'),
    ).toBe('zh-cn');
    expect(
      new URL(buildSearchResultsUrl({ ...base, language: 'xx' })).searchParams.has('lang'),
    ).toBe(false);
  });
});

describe('extractReviewNumbers', () => {
  it('reads the English block shape', () => {
    expect(extractReviewNumbers('Scored 8.3 8.3Very Good 15 reviews')).toEqual({
      score: 8.3,
      count: 15,
    });
    expect(extractReviewNumbers('Scored 10 10Exceptional 1 review')).toEqual({
      score: 10,
      count: 1,
    });
  });

  it('reads a decimal-comma locale without English anchors', () => {
    expect(extractReviewNumbers('Bewertet mit 8,3 8,3Sehr gut 124 Bewertungen')).toEqual({
      score: 8.3,
      count: 124,
    });
  });

  it('reads thousands-grouped counts in either convention', () => {
    expect(extractReviewNumbers('Scored 9.1 9.1Superb 2,847 reviews')).toEqual({
      score: 9.1,
      count: 2847,
    });
    expect(extractReviewNumbers('9,1 9,1Fabelhaft 2.847 Bewertungen')).toEqual({
      score: 9.1,
      count: 2847,
    });
  });

  it('never invents a count from a lone score', () => {
    expect(extractReviewNumbers('8,3')).toEqual({ score: 8.3 });
    expect(extractReviewNumbers('Scored 9')).toEqual({ score: 9 });
    expect(extractReviewNumbers('no numbers here')).toEqual({});
  });
});

describe('parseSearchResults', () => {
  it(
    'reads all 25 cards from the worker-fetched Nice results',
    () => {
      const cards = parseSearchResults(parseFixture('fr-nice-latlong-dated.worker.html'));
      expect(cards).toHaveLength(25);

      // Ground truth recorded at capture time (2026-08-14) via the scratch
      // inspector; frozen with the fixture, does not drift with the live site.
      expect(cards[0]).toMatchObject({
        name: 'Elegant Riviera Studio in Central Nice',
        canonicalUrl: 'https://www.booking.com/hotel/fr/elegant-riviera-studio-in-central-nice.html',
        priceText: '₪ 1,109', // NBSP in the page, normalized to a plain space
        reviewScore: 10,
        reviewCount: 1,
        address: 'Nice',
        distanceText: '4.8 m from map center',
      });
      expect(cards[0].thumbnailUrl?.startsWith('https://cf.bstatic.com/')).toBe(true);

      // 6 of the 25 Nice cards have no review block at all — absent, not zero.
      expect(cards[1].name).toBe('Studio lumineux avec balcon Quartier Libération');
      expect(cards[1].reviewScore).toBeUndefined();
      expect(cards[1].reviewCount).toBeUndefined();

      for (const card of cards) {
        expect(card.name).toBeTruthy();
        expect(card.url).toMatch(/^https:\/\//);
        expect(card.canonicalUrl).toBeTruthy();
      }

      // Coordinates ride in the page's embedded state, joined by URL slug —
      // exact values recorded at capture time, present for every card.
      expect(cards[0].latitude).toBe(43.7101728);
      expect(cards[0].longitude).toBe(7.2619532);
      expect(cards.filter((c) => c.latitude !== undefined && c.longitude !== undefined)).toHaveLength(
        25,
      );
    },
    FIXTURE_TIMEOUT,
  );

  it(
    'reads the same card shape out of a real-tab DOM capture',
    () => {
      const cards = parseSearchResults(parseFixture('fr-paris-latlong-dated.tab.html'));
      expect(cards).toHaveLength(25);
      expect(cards[0].name).toBe('Lavie Maison - Rivoli & Louvre');
      expect(cards[0].canonicalUrl?.endsWith('/hotel/fr/lavie-maison-rivoli-amp-louvre.html')).toBe(
        true,
      );
      expect(cards.filter((c) => c.latitude !== undefined && c.longitude !== undefined)).toHaveLength(
        25,
      );
    },
    FIXTURE_TIMEOUT,
  );

  it('finds no cards in the Akamai challenge stub', () => {
    expect(parseSearchResults(parseFixture('challenge-202.html'))).toEqual([]);
    expect(assessSearchHtml(readFixture('challenge-202.html')).verdict).toBe('challenge');
  });
});

describe('booking adapter search wiring', () => {
  it('exposes the search trio, reducing the assessment to its verdict', () => {
    expect(bookingAdapter.buildSearchUrl).toBe(buildSearchResultsUrl);
    expect(bookingAdapter.parseSearchResults).toBe(parseSearchResults);
    const html = '<div data-testid="property-card"><a href="/hotel/fr/x.html">x</a></div>';
    expect(bookingAdapter.assessSearchHtml?.(html)).toBe('results');
  });
});
