import { describe, expect, it } from 'vitest';
import { circleToQuery } from '../../lib/areasearch';
import {
  DEFAULT_SORT,
  OCCUPANCY_BOUNDS,
  defaultStayDates,
  explainQueryRefusal,
  findByKey,
  httpUrl,
  priceValue,
  readStayDates,
  outsideAreaLine,
  selectionKey,
  sortCards,
  resultsStatus,
  reviewLine,
} from './controller';

/** A comfortably valid circle (central Paris) for tests varying other inputs. */
const PARIS = { latitude: 48.8566, longitude: 2.3522, radiusKm: 3 };

describe('defaultStayDates', () => {
  it('is today+30 to today+32', () => {
    expect(defaultStayDates(new Date(2026, 7, 14))).toEqual({
      checkin: '2026-09-13',
      checkout: '2026-09-15',
    });
  });

  it('rolls over month and year boundaries with zero-padding', () => {
    expect(defaultStayDates(new Date(2026, 11, 15))).toEqual({
      checkin: '2027-01-14',
      checkout: '2027-01-16',
    });
  });
});

describe('readStayDates', () => {
  it('treats both dates empty as an undated search', () => {
    expect(readStayDates('', '')).toEqual({ kind: 'undated' });
  });

  it('refuses one date without the other instead of silently searching undated', () => {
    expect(readStayDates('2026-09-13', '')).toEqual({
      kind: 'refused',
      messageKey: 'search.dates.setBothOrClear',
    });
    expect(readStayDates('', '2026-09-15').kind).toBe('refused');
  });

  it('refuses check-out on or before check-in', () => {
    expect(readStayDates('2026-09-15', '2026-09-13')).toEqual({
      kind: 'refused',
      messageKey: 'search.dates.checkoutAfterCheckin',
    });
    expect(readStayDates('2026-09-13', '2026-09-13').kind).toBe('refused');
  });

  it('passes a valid pair through', () => {
    expect(readStayDates('2026-09-13', '2026-09-15')).toEqual({
      kind: 'dated',
      checkin: '2026-09-13',
      checkout: '2026-09-15',
    });
  });
});

describe('explainQueryRefusal', () => {
  const OCC = { adults: 2, rooms: 1, children: 0 };

  it('names a circle with no radius', () => {
    expect(explainQueryRefusal({ ...PARIS, radiusKm: 0 }, OCC)).toMatch(/no radius/);
  });

  it('names geometry that is not a circle at all', () => {
    expect(explainQueryRefusal({ ...PARIS, radiusKm: Number.NaN }, OCC)).toMatch(/not a valid circle/);
  });

  it('names a centre past the world edge', () => {
    expect(explainQueryRefusal({ ...PARIS, longitude: 181 }, OCC)).toMatch(/off the world map/);
  });

  it('names the out-of-bounds occupancy field', () => {
    expect(explainQueryRefusal(PARIS, { ...OCC, adults: 31 })).toBe(
      'Adults must be a whole number from 1 to 30.',
    );
    expect(explainQueryRefusal(PARIS, { ...OCC, children: 11 })).toBe(
      'Children must be a whole number from 0 to 10.',
    );
    expect(explainQueryRefusal(PARIS, { ...OCC, rooms: Number.NaN })).toBe(
      'Rooms must be a whole number from 1 to 30.',
    );
    expect(explainQueryRefusal(PARIS, { ...OCC, adults: 2.5 })).toMatch(/^Adults/);
  });

  it('still answers something honest when it cannot tell', () => {
    expect(explainQueryRefusal(PARIS, OCC)).toMatch(/did not anticipate/);
  });
});

describe('OCCUPANCY_BOUNDS stays pinned to lib/areasearch', () => {
  // The lib does not export its occupancy bounds, so the controller carries a
  // copy. These cases fail the moment the lib's real acceptance moves.
  const cases = [
    { field: 'adults', bounds: OCCUPANCY_BOUNDS.adults },
    { field: 'rooms', bounds: OCCUPANCY_BOUNDS.rooms },
    { field: 'children', bounds: OCCUPANCY_BOUNDS.children },
  ] as const;

  for (const { field, bounds } of cases) {
    it(`${field}: lib accepts [${bounds.min}, ${bounds.max}] and refuses just outside`, () => {
      const base = { adults: 2, rooms: 1, children: 0 };
      expect(circleToQuery(PARIS, { ...base, [field]: bounds.min })).not.toBeNull();
      expect(circleToQuery(PARIS, { ...base, [field]: bounds.max })).not.toBeNull();
      expect(circleToQuery(PARIS, { ...base, [field]: bounds.min - 1 })).toBeNull();
      expect(circleToQuery(PARIS, { ...base, [field]: bounds.max + 1 })).toBeNull();
    });
  }
});

describe('resultsStatus', () => {
  it('is honest about zero', () => {
    expect(resultsStatus(0, true)).toBe('0 places found in this area.');
  });

  it('mentions dates only on a dated search', () => {
    expect(resultsStatus(25, true)).toBe('25 places found — prices are for your dates.');
    expect(resultsStatus(25, false)).toBe('25 places found.');
  });

  it('uses the singular for one place', () => {
    expect(resultsStatus(1, false)).toBe('1 place found.');
  });

  it('uses the singular dated variant too (plural and datedness are separate keys)', () => {
    expect(resultsStatus(1, true)).toBe('1 place found — prices are for your dates.');
  });
});

describe('outsideAreaLine', () => {
  it('says nothing when the platform stayed inside the circle', () => {
    expect(outsideAreaLine(0)).toBe('');
    // A negative count is nonsense, not a sentence to render.
    expect(outsideAreaLine(-1)).toBe('');
  });

  it('names a single dropped result in the singular', () => {
    expect(outsideAreaLine(1)).toBe(
      '1 result the platform returned lay outside the drawn area and is not listed.',
    );
  });

  it('counts several dropped results', () => {
    expect(outsideAreaLine(12)).toBe(
      '12 results the platform returned lay outside the drawn area and are not listed.',
    );
  });
});

describe('reviewLine', () => {
  it('joins score and count', () => {
    expect(reviewLine(8.3, 15)).toBe('8.3 · 15 reviews');
  });

  it('uses the singular for one review', () => {
    expect(reviewLine(8.3, 1)).toBe('8.3 · 1 review');
  });

  it('shows the score alone when the count is missing', () => {
    expect(reviewLine(8.3)).toBe('8.3');
  });
});

describe('httpUrl', () => {
  it('admits http and https', () => {
    expect(httpUrl('https://www.example.com/hotel/x.html?a=1')).toBe(
      'https://www.example.com/hotel/x.html?a=1',
    );
    expect(httpUrl('http://example.com/')).toBe('http://example.com/');
  });

  it('refuses javascript:, data: and other schemes', () => {
    expect(httpUrl('javascript:alert(1)')).toBeNull();
    expect(httpUrl('data:text/html,<script>1</script>')).toBeNull();
    expect(httpUrl('chrome-extension://abc/x.html')).toBeNull();
  });

  it('refuses relative and unparseable values, and undefined', () => {
    expect(httpUrl('/hotel/fr/x.html')).toBeNull();
    expect(httpUrl('not a url')).toBeNull();
    expect(httpUrl(undefined)).toBeNull();
  });
});

describe('priceValue', () => {
  it('reads digits regardless of currency symbol or grouping', () => {
    expect(priceValue('₪ 10,450')).toBe(10450);
    expect(priceValue('€ 1.234')).toBe(1234);
    expect(priceValue('US$99')).toBe(99);
  });

  it('refuses to invent a number', () => {
    expect(priceValue(undefined)).toBeNull();
    expect(priceValue('—')).toBeNull();
    expect(priceValue('')).toBeNull();
  });
});

describe('sortCards', () => {
  const cards = [
    { name: 'b', priceText: '€ 300', reviewScore: 9 },
    { name: 'a', priceText: '€ 100', reviewScore: 7 },
    { name: 'noprice', reviewScore: 8 },
    { name: 'c', priceText: '€ 200' },
  ];

  it('sorts by price ascending, unpriced cards last in original order', () => {
    expect(sortCards(cards, 'price-asc').map((c) => c.name)).toEqual(['a', 'c', 'b', 'noprice']);
  });

  it('sorts by price descending', () => {
    expect(sortCards(cards, 'price-desc').map((c) => c.name)).toEqual(['b', 'c', 'a', 'noprice']);
  });

  it('sorts by rating descending, unrated cards last', () => {
    expect(sortCards(cards, 'rating-desc').map((c) => c.name)).toEqual(['b', 'noprice', 'a', 'c']);
  });

  it('keeps the platform order untouched and returns a copy', () => {
    const result = sortCards(cards, 'platform');
    expect(result.map((c) => c.name)).toEqual(['b', 'a', 'noprice', 'c']);
    expect(result).not.toBe(cards);
  });

  it('is stable on equal keys', () => {
    const tied = [
      { name: 'first', priceText: '€ 100' },
      { name: 'second', priceText: '€ 100' },
    ];
    expect(sortCards(tied, 'price-asc').map((c) => c.name)).toEqual(['first', 'second']);
  });

  it('defaults to cheapest first', () => {
    expect(DEFAULT_SORT).toBe('price-asc');
  });
});

describe('selectionKey', () => {
  it('prefers the canonical URL — the platform’s own name for the property', () => {
    expect(
      selectionKey({
        url: 'https://example.com/hotel/x.html?aid=123&label=tracking',
        canonicalUrl: 'https://example.com/hotel/x.html',
      }),
    ).toBe('https://example.com/hotel/x.html');
  });

  it('falls back to the card URL when canonicalization failed', () => {
    expect(selectionKey({ url: 'https://example.com/hotel/y.html?aid=9' })).toBe(
      'https://example.com/hotel/y.html?aid=9',
    );
  });

  it('gives two cards for the same property the same key despite differing tracking params', () => {
    const canonicalUrl = 'https://example.com/hotel/x.html';
    expect(selectionKey({ url: 'https://example.com/hotel/x.html?aid=1', canonicalUrl })).toBe(
      selectionKey({ url: 'https://example.com/hotel/x.html?aid=2', canonicalUrl }),
    );
  });
});

describe('findByKey', () => {
  const cards = [
    { name: 'b', url: 'https://example.com/b?aid=1', canonicalUrl: 'https://example.com/b' },
    { name: 'a', url: 'https://example.com/a' },
    { name: 'c', url: 'https://example.com/c' },
  ];

  it('finds the card a key refers to', () => {
    expect(findByKey(cards, 'https://example.com/a')?.name).toBe('a');
    expect(findByKey(cards, 'https://example.com/b')?.name).toBe('b');
  });

  it('follows the property, not the position, across a re-sort', () => {
    const resorted = [...cards].reverse();
    const key = selectionKey(cards[0] as (typeof cards)[number]);
    expect(findByKey(resorted, key)?.name).toBe('b');
  });

  it('answers null for a property the current results no longer list', () => {
    expect(findByKey(cards, 'https://example.com/gone')).toBeNull();
    expect(findByKey([], 'https://example.com/a')).toBeNull();
  });

  it('answers null for no selection at all', () => {
    expect(findByKey(cards, null)).toBeNull();
  });

  it('matches the card URL only when there is no canonical one to match first', () => {
    // 'b' is keyed by its canonical URL, so its raw (tracking) URL is not a key.
    expect(findByKey(cards, 'https://example.com/b?aid=1')).toBeNull();
  });

  it('takes the first of duplicate keys, the same card the marker map registers', () => {
    const dupes = [
      { name: 'first', url: 'https://example.com/same' },
      { name: 'second', url: 'https://example.com/same' },
    ];
    expect(findByKey(dupes, 'https://example.com/same')?.name).toBe('first');
  });
});
