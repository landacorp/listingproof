// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseStatedDistanceKm, reviewTexts } from './pagecontext';
import { decodeEntities, extractPageContext, readEmbeddedReviews } from './sites/booking/pagecontext';
import type { ReviewItem } from './reviews';

const FIXTURE_DIR = join(process.cwd(), 'fixtures/live');

function parseFixture(file: string): Document {
  return new DOMParser().parseFromString(readFileSync(join(FIXTURE_DIR, file), 'utf8'), 'text/html');
}

describe('parseStatedDistanceKm', () => {
  it.each([
    ['250 m', 0.25],
    ['400m', 0.4],          // ja: no space
    ['2,2 km', 2.2],        // de/fr/es/it: comma decimal separator
    ['1.2 km', 1.2],
    ['300 μ.', 0.3],        // el: Greek metres with abbreviation dot
    ['5 χλμ', 5],           // el: Greek kilometres
    ['750 м', 0.75],        // Cyrillic metres
    ['3 км', 3],
    ['0 m', 0],
    ['2 mi', 3.218688],     // never read miles as metres
  ])('%s → %s km', (input, expected) => {
    expect(parseStatedDistanceKm(input)).toBeCloseTo(expected, 6);
  });

  it.each([['Museum of Modern Art'], [''], ['nearby'], ['—']])(
    'returns undefined for %s rather than 0',
    (input) => {
      // 0 would read as "on the premises", the opposite of "unknown".
      expect(parseStatedDistanceKm(input)).toBeUndefined();
    },
  );
});

describe('extractPageContext on live fixtures', () => {
  interface Expected {
    breadcrumbHead: string[];
    firstPoi: { name: string; statedDistanceKm: number; category: string };
    minPois: number;
  }

  const FIXTURES: Record<string, Expected> = {
    'us-the-warwick-new-york.html': {
      breadcrumbHead: ['Home', 'Hotels', 'United States'],
      firstPoi: { name: 'Museum of Modern Art', statedDistanceKm: 0.25, category: 'Top attractions' },
      minPois: 15,
    },
    'de-schulz-berlin-wall.de.html': {
      breadcrumbHead: ['Startseite', 'Hotels', 'Deutschland'],
      firstPoi: { name: 'Alexanderplatz', statedDistanceKm: 2.2, category: 'Top-Attraktionen' },
      minPois: 15,
    },
    'gr-electra-metropolis.el.html': {
      breadcrumbHead: ['Αρχική σελίδα', 'Ξενοδοχεία', 'Ελλάδα'],
      firstPoi: { name: 'Πλατεία Συντάγματος', statedDistanceKm: 0.3, category: 'Κορυφαία αξιοθέατα' },
      minPois: 15,
    },
    'jp-shibuya-excel-tokyu.ja.html': {
      breadcrumbHead: ['ホーム', 'ホテル', '日本'],
      firstPoi: { name: '古代エジプト美術館', statedDistanceKm: 0.4, category: '人気スポット' },
      minPois: 15,
    },
  };

  it.each(Object.entries(FIXTURES))('%s', (file, expected) => {
    const context = extractPageContext(parseFixture(file));

    expect(context.breadcrumbs.slice(0, 3)).toEqual(expected.breadcrumbHead);
    expect(context.pois.length).toBeGreaterThanOrEqual(expected.minPois);
    expect(context.pois[0]).toEqual(expected.firstPoi);

    // Every POI must be usable as a geocoder query: a name and, usually, a
    // claimed distance to contradict.
    for (const poi of context.pois) {
      expect(poi.name.length).toBeGreaterThan(0);
      if (poi.statedDistanceKm !== undefined) {
        expect(poi.statedDistanceKm).toBeGreaterThanOrEqual(0);
        expect(poi.statedDistanceKm).toBeLessThan(1000);
      }
    }
    expect(context.pois.filter((p) => p.statedDistanceKm !== undefined).length)
      .toBeGreaterThanOrEqual(10);

    expect(context.description?.length ?? 0).toBeGreaterThan(100);
    expect(context.reviews.length).toBeGreaterThan(0);
  }, 30_000);

  it('strips the category chip from restaurant rows', () => {
    // Rows render as ["Restaurant", "Pret A Manger", "100 m"]; the name is the
    // node before the distance, not the leading chip.
    const context = extractPageContext(parseFixture('us-the-warwick-new-york.html'));
    const names = context.pois.map((p) => p.name);
    expect(names).toContain('Pret A Manger');
    expect(names).not.toContain('Restaurant');
  }, 30_000);
});

describe('reviewTexts', () => {
  it('keeps both halves and the title, in that order', () => {
    expect(reviewTexts([{ title: 'Good', positive: 'Great bed', negative: 'Thin walls' }], 1000))
      .toEqual(['Good\nGreat bed\nThin walls']);
  });

  it('skips a review that carries a score but no words', () => {
    expect(reviewTexts([{ score: 9 }, { positive: 'Lovely' }], 1000)).toEqual(['Lovely']);
  });

  it('stops once the total budget is spent rather than trusting per-review caps', () => {
    const items: ReviewItem[] = Array.from({ length: 50 }, () => ({ positive: 'x'.repeat(100) }));
    const out = reviewTexts(items, 250);
    // Three: the budget is checked before each entry, so the one that crosses
    // it is admitted and the next is not.
    expect(out).toHaveLength(3);
  });
});

describe('the reviews Booking embeds but does not render', () => {
  /**
   * Counts and the aggregate, measured from the captured pages by parsing each
   * one's embedded Apollo store directly. Frozen with the fixtures.
   *
   * The number that matters is not `items` alone but `items` against `total`:
   * every one of these pages embeds ten reviews at most while claiming hundreds
   * or thousands, which is the "we saw 10 of 3,526" line the panel owes the
   * reader.
   */
  const EMBEDDED: Record<string, { items: number; score: number; total: number }> = {
    'de-schulz-berlin-wall.de.html': { items: 10, score: 8.6, total: 18572 },
    'es-catalonia-la-boqueria.es.html': { items: 10, score: 8.5, total: 3069 },
    'fr-hijack-gite-chassagne.en-gb.html': { items: 5, score: 4.2, total: 25 },
    'fr-hijack-paris-eiffel.en-gb.html': { items: 10, score: 8.1, total: 127 },
    'fr-le-regent-paris.fr.html': { items: 10, score: 8.6, total: 2194 },
    'gb-strandpalace.en-gb.html': { items: 10, score: 8.5, total: 17597 },
    'gr-electra-metropolis.el.html': { items: 10, score: 9.2, total: 5703 },
    'it-grand-rimini.it.html': { items: 10, score: 8.5, total: 924 },
    'it-hotelbellevue_rimini.en-us.html': { items: 10, score: 8.8, total: 4719 },
    'jp-shibuya-excel-tokyu.ja.html': { items: 10, score: 8.9, total: 3526 },
    'nl-nhcollection-flower-market.nl.html': { items: 10, score: 8.7, total: 5304 },
    'pt-corpo-santo.pt-pt.html': { items: 10, score: 9.6, total: 1406 },
    'us-the-warwick-new-york.html': { items: 10, score: 8.4, total: 7735 },
  };

  it.each(Object.entries(EMBEDDED))('%s', (file, expected) => {
    const context = extractPageContext(parseFixture(file));
    const reviewSet = context.reviewSet!;

    // Booking does embed individual reviews, so an empty list here would be a
    // statement about this page — never about the platform.
    expect(reviewSet.availability).toBe('in-page');
    expect(reviewSet.items).toHaveLength(expected.items);
    expect(reviewSet.summary?.score).toBeCloseTo(expected.score, 2);
    expect(reviewSet.summary?.total).toBe(expected.total);
    // The sample is a fraction of what the property claims, on every page.
    expect(reviewSet.items.length).toBeLessThanOrEqual(reviewSet.summary!.total!);

    for (const item of reviewSet.items) {
      expect(item.id).toMatch(/^\d+$/);
      // Booking rates out of 10 and the raw scale travels with the score, so
      // nothing downstream can put an 8/10 next to a 4/5 as if they matched.
      expect(item.score).toBeGreaterThanOrEqual(0);
      expect(item.score).toBeLessThanOrEqual(10);
      expect(item.rawScore).toEqual({ value: item.score, max: 10 });
      expect(item.reviewedAt).toBeGreaterThan(Date.parse('2020-01-01'));
      expect(item.reviewedAt).toBeLessThan(Date.parse('2030-01-01'));
      // Every review has words; an entity-escaped one would prove the decode
      // step was skipped, and the panel would print `L&#39;accès`.
      expect((item.positive ?? '') + (item.negative ?? '')).not.toBe('');
      expect(JSON.stringify(item)).not.toMatch(/&(?:#\d+|amp|quot|#x[0-9a-f]+);/i);
    }
    // Ids are the merge key for the two shapes the same review appears in; a
    // duplicate would mean the merge silently produced two of one review.
    expect(new Set(reviewSet.items.map((i) => i.id)).size).toBe(expected.items);
  }, 30_000);

  it('reads one review exactly as the page published it', () => {
    // Ground truth read straight out of the Warwick capture's Apollo store.
    const context = extractPageContext(parseFixture('us-the-warwick-new-york.html'));
    const first = context.reviewSet!.items[0];

    expect(first.id).toBe('5325782577');
    expect(first.score).toBe(5);
    expect(first.rawScore).toEqual({ value: 5, max: 10 });
    // Published as epoch SECONDS (1786412542); the contract is milliseconds.
    expect(first.reviewedAt).toBe(1786412542000);
    expect(first.title).toBe('I would not recommend');
    expect(first.lang).toBe('xu');
    expect(first.positive?.startsWith('The hotel with its marble and grand history')).toBe(true);
    // The half the rendered page never shows at all — and the half a
    // contradiction check most wants, since it is where guests say what was
    // wrong. 1,161 characters of it, none of it in the DOM.
    expect(first.negative?.length).toBe(1161);
    expect(first.negative?.startsWith('The mattress was lumpy')).toBe(true);
  }, 30_000);

  it('reads reviews from a page that renders none', () => {
    // The gîte capture has zero `featuredreview-text` nodes — the old scrape
    // came back empty and the panel had nothing to show — while embedding five
    // complete reviews against a claimed 25.
    const doc = parseFixture('fr-hijack-gite-chassagne.en-gb.html');
    expect(doc.querySelectorAll('[data-testid="featuredreview-text"]')).toHaveLength(0);

    const context = extractPageContext(doc);
    expect(context.reviewSet!.items).toHaveLength(5);
    expect(context.reviews).toHaveLength(5);
    expect(context.reviews.join('')).toContain('Superbe gîte en roulotte');
  }, 30_000);

  it('gives Engine L more text than the DOM ever rendered', () => {
    // The rendered snippet is the positive half clipped at ~250 characters. The
    // comparison is the point of the whole change, so it is asserted rather
    // than described.
    const doc = parseFixture('us-the-warwick-new-york.html');
    const rendered = Array.from(doc.querySelectorAll('[data-testid="featuredreview-text"]'))
      .map((el) => (el.textContent ?? '').trim());
    expect(rendered).toHaveLength(10);
    expect(Math.max(...rendered.map((t) => t.length))).toBeLessThan(260);

    const context = extractPageContext(doc);
    expect(context.reviews.join('').length).toBeGreaterThan(rendered.join('').length * 2);
    expect(context.reviews.some((t) => t.length > 500)).toBe(true);
  }, 30_000);

  it('decodes the entity escaping one of the two embedded shapes uses', () => {
    // `PropertyFeaturedReview` serves `L&#39;accès`; `FeaturedReview` serves the
    // same sentence raw. Undecoded, the two would not merge as one review, and
    // Engine L's quote grounding would fail on every French review.
    const context = extractPageContext(parseFixture('fr-le-regent-paris.fr.html'));
    const blob = context.reviews.join('\n');
    expect(blob).not.toContain('&#39;');
    expect(blob).toContain("L'accès à la prise");
  }, 30_000);
});

describe('extractPageContext on synthetic documents', () => {
  function docFromHtml(html: string): Document {
    return new DOMParser().parseFromString(html, 'text/html');
  }

  /** A page carrying an embedded cache, the way Booking serves one. */
  function apolloDoc(payload: unknown, extra = ''): Document {
    return docFromHtml(`<script type="application/json">${JSON.stringify(payload)}</script>${extra}`);
  }

  const PROJECTION = {
    __typename: 'PropertyFeaturedReview',
    reviewId: 42,
    reviewScore: 8,
    reviewedDate: 1786412542,
    textDetails: {
      __typename: 'TextDetails',
      title: 'Would return',
      positiveText: 'Great location &amp; friendly staff',
      negativeText: 'Thin walls',
      lang: 'en',
    },
  };
  const NORMALIZED = {
    __typename: 'FeaturedReview',
    id: 42,
    averageScore: 8,
    completed: 1786412542,
    title: '',
    positiveText: 'Great location & friendly staff',
    negativeText: 'Thin walls',
    language: 'en',
  };

  it('returns empty collections rather than throwing on a bare document', () => {
    const context = extractPageContext(docFromHtml('<p>nothing here</p>'));
    expect(context.breadcrumbs).toEqual([]);
    expect(context.pois).toEqual([]);
    expect(context.reviews).toEqual([]);
  });

  it('keeps a POI whose distance is unparseable, without inventing one', () => {
    const context = extractPageContext(docFromHtml(`
      <div data-testid="poi-block"><h3>Top attractions</h3>
        <ul><li><span>Mystery Landmark</span><span>nearby</span></li></ul>
      </div>`));
    expect(context.pois).toEqual([{ name: 'nearby', category: 'Top attractions' }]);
  });

  it('declares that it looked, on a page with no reviews at all', () => {
    // `in-page` with nothing in it is a claim about the PAGE. A consumer may
    // say "this page served no reviews"; it may never say "this platform
    // publishes none", which is a different platform's answer.
    const context = extractPageContext(docFromHtml('<p>nothing here</p>'));
    expect(context.reviewSet).toEqual({ availability: 'in-page', items: [] });
  });

  it('merges the two embedded shapes of one review into one', () => {
    // Same id, complementary content: the projection has the title, the
    // normalized entry has the unescaped text. Neither may blank the other.
    const context = extractPageContext(apolloDoc({ ROOT_QUERY: { r: [PROJECTION] }, 'FeaturedReview:42': NORMALIZED }));
    expect(context.reviewSet!.items).toEqual([{
      id: '42',
      score: 8,
      rawScore: { value: 8, max: 10 },
      reviewedAt: 1786412542000,
      title: 'Would return',
      lang: 'en',
      positive: 'Great location & friendly staff',
      negative: 'Thin walls',
    }]);
  });

  it('reads a review that arrives in only one of the two shapes', () => {
    // The gîte capture's actual situation: normalized entries, no projection.
    const context = extractPageContext(apolloDoc({ 'FeaturedReview:42': NORMALIZED }));
    expect(context.reviewSet!.items).toHaveLength(1);
    expect(context.reviewSet!.items[0].positive).toBe('Great location & friendly staff');
  });

  it('drops a review with no id rather than counting it twice', () => {
    // The id is the merge key. Without one, the same review arriving in both
    // shapes would be reported as two reviews — inflating the sample size,
    // which is the one number the honesty line depends on.
    const context = extractPageContext(apolloDoc({
      a: { __typename: 'FeaturedReview', positiveText: 'Anonymous praise' },
    }));
    expect(context.reviewSet!.items).toEqual([]);
  });

  it('drops an impossible score and an impossible date, keeping the words', () => {
    const context = extractPageContext(apolloDoc({
      a: {
        __typename: 'FeaturedReview',
        id: 7,
        averageScore: 9000,
        completed: 0,
        positiveText: 'Nice',
      },
    }));
    // Not a confident 9000, not a confident 1970 — absent, which is GRAY.
    expect(context.reviewSet!.items).toEqual([{ id: '7', positive: 'Nice' }]);
  });

  it('falls back to the rendered snippets when the embedded JSON will not parse', () => {
    const doc = docFromHtml(
      '<script type="application/json">{"positiveText": truncated…</script>' +
      '<div data-testid="featuredreview-text">Lovely stay by the river</div>',
    );
    const context = extractPageContext(doc);
    expect(context.reviews).toEqual(['Lovely stay by the river']);
    expect(context.reviewSet).toEqual({ availability: 'in-page', items: [] });
  });

  it('keeps the rest of the page context when the reviews are unreadable', () => {
    // A crafted blob must not be able to cost Engine A its breadcrumbs — that
    // would let a listing switch off the checks against itself.
    const doc = docFromHtml(
      '<script type="application/json">{"positiveText": nope</script>' +
      '<span data-testid="breadcrumb-item">Paris</span>',
    );
    expect(extractPageContext(doc).breadcrumbs).toEqual(['Paris']);
  });

  it('does not walk a hostile array to its end', () => {
    // A cap on output is not a cap on work. The buried review proves the scan
    // stopped, rather than a timing assertion that would be flaky under load.
    const buried = Array.from({ length: 5000 }, () => ({ positiveText: '' }));
    buried.push(NORMALIZED as unknown as { positiveText: string });
    const context = extractPageContext(apolloDoc({ list: buried }));
    expect(context.reviewSet!.items).toEqual([]);
  });

  it('does not descend forever into a nested blob', () => {
    let deep: unknown = NORMALIZED;
    for (let i = 0; i < 60; i++) deep = { nest: deep };
    expect(extractPageContext(apolloDoc(deep)).reviewSet!.items).toEqual([]);

    // …while the depth real markup uses is comfortably inside the bound.
    let shallow: unknown = NORMALIZED;
    for (let i = 0; i < 10; i++) shallow = { nest: shallow };
    expect(extractPageContext(apolloDoc(shallow)).reviewSet!.items).toHaveLength(1);
  });

  it('stops at the review cap however many the page embeds', () => {
    const many: Record<string, unknown> = {};
    for (let i = 0; i < 100; i++) many[`FeaturedReview:${i}`] = { ...NORMALIZED, id: i };
    expect(extractPageContext(apolloDoc({ store: many })).reviewSet!.items).toHaveLength(12);
  });

  it('bounds one hostile review instead of carrying a megabyte of it', () => {
    const context = extractPageContext(apolloDoc({
      a: { __typename: 'FeaturedReview', id: 1, positiveText: 'a'.repeat(500_000) },
    }));
    expect(context.reviewSet!.items[0].positive).toHaveLength(2000);
  });

  it('ignores a language tag that is not one', () => {
    const context = extractPageContext(apolloDoc({
      a: { __typename: 'FeaturedReview', id: 1, positiveText: 'Nice', language: 'x'.repeat(500) },
    }));
    expect(context.reviewSet!.items[0].lang).toBeUndefined();
  });

  it('reads the aggregate from JSON-LD, so panel and identity cannot disagree', () => {
    const doc = docFromHtml(
      '<script type="application/ld+json">' +
      JSON.stringify({ '@type': 'Hotel', aggregateRating: { ratingValue: '8.6', reviewCount: 2194 } }) +
      '</script>',
    );
    expect(extractPageContext(doc).reviewSet!.summary).toEqual({ score: 8.6, total: 2194 });
  });

  it('leaves the aggregate absent rather than reporting a confident zero', () => {
    const doc = docFromHtml(
      '<script type="application/ld+json">' +
      JSON.stringify({ '@type': 'Hotel', aggregateRating: { ratingValue: '', reviewCount: '' } }) +
      '</script>',
    );
    expect(extractPageContext(doc).reviewSet!.summary).toBeUndefined();
  });

  it('never lets an unparseable blob throw into the pipeline', () => {
    for (const payload of ['null', '[]', '{"positiveText":', '"positiveText"', '[[[[["positiveText"]]]]]']) {
      const doc = docFromHtml(`<script type="application/json">${payload}</script>`);
      expect(() => extractPageContext(doc)).not.toThrow();
      expect(readEmbeddedReviews(doc)).toEqual([]);
    }
  });
});

describe('decodeEntities', () => {
  it.each([
    ["L&#39;accès", "L'accès"],
    ['later &amp; later', 'later & later'],
    ['&quot;quoted&quot;', '"quoted"'],
    ['&lt;b&gt;', '<b>'],
    ['&#x41;&#x42;', 'AB'],
    ['no entities here', 'no entities here'],
  ])('%s → %s', (input, expected) => {
    expect(decodeEntities(input)).toBe(expected);
  });

  it.each([
    ['&notarealentity;'],
    ['&#0;'],
    ['&#1114112;'],   // beyond the last code point
    ['&#55296;'],     // a lone surrogate: valid to fromCodePoint, broken as text
  ])('leaves %s alone rather than producing something broken', (input) => {
    expect(decodeEntities(input)).toBe(input);
  });
});
