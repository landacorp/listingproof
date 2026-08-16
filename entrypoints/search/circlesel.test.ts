import { describe, expect, it } from 'vitest';
import { haversineKm } from '../../lib/geo';
import { formatRadius, partitionByRadius, radiusKmBetween } from './circlesel';

describe('radiusKmBetween', () => {
  it('is the project distance function, not a second one', () => {
    const centre = { lat: 48.8566, lng: 2.3522 };
    const edge = { lat: 48.9, lng: 2.4 };
    expect(radiusKmBetween(centre, edge)).toBe(haversineKm(centre, edge));
  });

  it('is zero for a click that never moved', () => {
    expect(radiusKmBetween({ lat: 48.85, lng: 2.35 }, { lat: 48.85, lng: 2.35 })).toBe(0);
  });

  it('answers NaN for an unusable point rather than a plausible number', () => {
    expect(radiusKmBetween({ lat: Number.NaN, lng: 2.35 }, { lat: 48.85, lng: 2.35 })).toBeNaN();
  });
});

describe('formatRadius', () => {
  it('reads in whole metres below a kilometre', () => {
    expect(formatRadius(0.45, 'en')).toEqual({ key: 'search.radius.metres', value: '450' });
    expect(formatRadius(0.0004, 'en')).toEqual({ key: 'search.radius.metres', value: '0' });
  });

  it('reads in kilometres with one decimal from a kilometre up', () => {
    expect(formatRadius(2.34, 'en')).toEqual({ key: 'search.radius.km', value: '2.3' });
    expect(formatRadius(60, 'en')).toEqual({ key: 'search.radius.km', value: '60.0' });
  });

  it('picks the unit after rounding, so 999.6 m is never "1,000 m"', () => {
    expect(formatRadius(0.9996, 'en')).toEqual({ key: 'search.radius.km', value: '1.0' });
    expect(formatRadius(0.9994, 'en')).toEqual({ key: 'search.radius.metres', value: '999' });
  });

  it('formats the digits for the reader, not for English', () => {
    // A Russian panel gets a Russian decimal separator; the unit word is the
    // caller's job (the key), so nothing here is hardcoded English.
    expect(formatRadius(2.34, 'ru').value).toBe('2,3');
    expect(formatRadius(2.34, 'de').value).toBe('2,3');
  });

  it('never renders NaN or a negative distance', () => {
    expect(formatRadius(Number.NaN, 'en')).toEqual({ key: 'search.radius.metres', value: '0' });
    expect(formatRadius(-5, 'en')).toEqual({ key: 'search.radius.metres', value: '0' });
  });
});

describe('partitionByRadius', () => {
  /** A 10 km circle over central Paris. */
  const DRAWN = { latitude: 48.8566, longitude: 2.3522, radiusKm: 10 };
  const at = (name: string, latitude: number, longitude: number) => ({ name, latitude, longitude });
  const kmFromCentre = (lat: number, lng: number) =>
    haversineKm({ lat: DRAWN.latitude, lng: DRAWN.longitude }, { lat, lng });

  it('keeps cards inside the circle and drops the ones beyond it', () => {
    const near = at('near', 48.87, 2.36);
    const far = at('far', 48.54, 2.66); // the Melun case: ~42 km from the centre
    expect(kmFromCentre(near.latitude, near.longitude)).toBeLessThan(10);
    expect(kmFromCentre(far.latitude, far.longitude)).toBeGreaterThan(10);
    expect(partitionByRadius(DRAWN, [near, far])).toEqual({ inside: [near], outside: [far] });
  });

  it('counts the centre and the edge as inside — the circle is inclusive', () => {
    const centre = at('centre', DRAWN.latitude, DRAWN.longitude);
    const onEdge = { name: 'edge', latitude: DRAWN.latitude, longitude: DRAWN.longitude };
    const exact = { ...DRAWN, radiusKm: kmFromCentre(48.9, 2.3522) };
    const north = at('north', 48.9, 2.3522);
    expect(partitionByRadius(DRAWN, [centre, onEdge]).outside).toEqual([]);
    expect(partitionByRadius(exact, [north]).outside).toEqual([]);
  });

  it('drops a card just past the radius in any direction', () => {
    const tight = { ...DRAWN, radiusKm: 1 };
    const cards = [at('n', 48.88, 2.3522), at('s', 48.83, 2.3522), at('e', 48.8566, 2.39)];
    for (const card of cards) {
      expect(kmFromCentre(card.latitude, card.longitude)).toBeGreaterThan(1);
    }
    expect(partitionByRadius(tight, cards).inside).toEqual([]);
  });

  it('keeps a card with no coordinates — absence is not proof of being outside', () => {
    // The real shape: a parsed card whose coordinates the page did not find.
    const nowhere: { name: string; latitude?: number; longitude?: number } = { name: 'nowhere' };
    const halfKnown = { name: 'half', latitude: 48.9 };
    const result = partitionByRadius(DRAWN, [nowhere, halfKnown]);
    expect(result.inside).toEqual([nowhere, halfKnown]);
    expect(result.outside).toEqual([]);
  });

  it('keeps a card whose coordinates are not finite rather than guessing', () => {
    const broken = at('broken', Number.NaN, 2.35);
    const infinite = at('infinite', 48.86, Number.POSITIVE_INFINITY);
    expect(partitionByRadius(DRAWN, [broken, infinite]).outside).toEqual([]);
  });

  it('keeps a card whose coordinates haversineKm refuses to trust', () => {
    // Finite, but outside the range geo.ts will read (a field mix-up, not a
    // position): haversineKm answers NaN and the card stays rather than being
    // dropped on the strength of a number nobody believes.
    const bogus = at('bogus', 48.86, 1000001882.32);
    expect(partitionByRadius(DRAWN, [bogus]).outside).toEqual([]);
  });

  it('keeps everything when the circle itself proves nothing', () => {
    const cards = [at('a', 48.86, 2.35), at('b', 10, 10)];
    const clicked = { ...DRAWN, radiusKm: 0 };
    expect(partitionByRadius(clicked, cards)).toEqual({ inside: cards, outside: [] });
    const broken = { ...DRAWN, radiusKm: Number.NaN };
    expect(partitionByRadius(broken, cards)).toEqual({ inside: cards, outside: [] });
    const nowhere = { ...DRAWN, latitude: Number.NaN };
    expect(partitionByRadius(nowhere, cards)).toEqual({ inside: cards, outside: [] });
  });

  it('preserves the platform order within each side', () => {
    const cards = [
      at('a', 48.86, 2.35),
      at('b', 10, 10),
      at('c', 48.87, 2.36),
      at('d', 20, 20),
    ];
    const result = partitionByRadius(DRAWN, cards);
    expect(result.inside.map((card) => card.name)).toEqual(['a', 'c']);
    expect(result.outside.map((card) => card.name)).toEqual(['b', 'd']);
  });

  it('answers empty sides for no cards at all', () => {
    expect(partitionByRadius(DRAWN, [])).toEqual({ inside: [], outside: [] });
  });
});
