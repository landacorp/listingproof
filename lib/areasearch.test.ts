import { describe, expect, it } from 'vitest';
import { circleToQuery, MAX_RADIUS_KM, validateAreaSearchQuery } from './areasearch';

/** A known-good dated query; individual tests break one field at a time. */
const VALID = {
  latitude: 43.7102,
  longitude: 7.262,
  radiusKm: 5,
  checkin: '2026-09-17',
  checkout: '2026-09-19',
  adults: 2,
  rooms: 1,
  children: 0,
};

describe('validateAreaSearchQuery', () => {
  it('round-trips a valid dated query', () => {
    expect(validateAreaSearchQuery(VALID)).toEqual(VALID);
  });

  it('round-trips a valid undated query without inventing date keys', () => {
    const { checkin: _ci, checkout: _co, ...undated } = VALID;
    const result = validateAreaSearchQuery(undated);
    expect(result).toEqual(undated);
    expect(result).not.toHaveProperty('checkin');
    expect(result).not.toHaveProperty('checkout');
  });

  it('rejects non-objects', () => {
    expect(validateAreaSearchQuery(null)).toBeNull();
    expect(validateAreaSearchQuery(undefined)).toBeNull();
    expect(validateAreaSearchQuery('43.7,7.2')).toBeNull();
  });

  it('rejects coordinates out of bounds or non-finite', () => {
    expect(validateAreaSearchQuery({ ...VALID, latitude: 90.0001 })).toBeNull();
    expect(validateAreaSearchQuery({ ...VALID, latitude: -90.0001 })).toBeNull();
    expect(validateAreaSearchQuery({ ...VALID, longitude: 180.0001 })).toBeNull();
    expect(validateAreaSearchQuery({ ...VALID, longitude: -180.0001 })).toBeNull();
    expect(validateAreaSearchQuery({ ...VALID, latitude: Number.NaN })).toBeNull();
    expect(validateAreaSearchQuery({ ...VALID, longitude: '7.262' })).toBeNull();
    // The poles themselves are in bounds — refused values, not clamped ones.
    expect(validateAreaSearchQuery({ ...VALID, latitude: 90 })).not.toBeNull();
  });

  it('rejects a zero radius and anything past the cap', () => {
    expect(validateAreaSearchQuery({ ...VALID, radiusKm: 0 })).toBeNull();
    expect(validateAreaSearchQuery({ ...VALID, radiusKm: MAX_RADIUS_KM + 0.001 })).toBeNull();
    expect(validateAreaSearchQuery({ ...VALID, radiusKm: MAX_RADIUS_KM })).not.toBeNull();
  });

  it('rejects non-integer or out-of-range occupancy counts', () => {
    expect(validateAreaSearchQuery({ ...VALID, adults: 2.5 })).toBeNull();
    expect(validateAreaSearchQuery({ ...VALID, adults: 0 })).toBeNull();
    expect(validateAreaSearchQuery({ ...VALID, rooms: 1.5 })).toBeNull();
    expect(validateAreaSearchQuery({ ...VALID, rooms: 0 })).toBeNull();
    expect(validateAreaSearchQuery({ ...VALID, children: 0.5 })).toBeNull();
    expect(validateAreaSearchQuery({ ...VALID, children: -1 })).toBeNull();
    expect(validateAreaSearchQuery({ ...VALID, children: 0 })).not.toBeNull();
  });

  it('rejects one-sided dates', () => {
    const { checkout: _co, ...checkinOnly } = VALID;
    const { checkin: _ci, ...checkoutOnly } = VALID;
    expect(validateAreaSearchQuery(checkinOnly)).toBeNull();
    expect(validateAreaSearchQuery(checkoutOnly)).toBeNull();
  });

  it('rejects malformed dates and checkin at or after checkout', () => {
    expect(validateAreaSearchQuery({ ...VALID, checkin: '17-09-2026' })).toBeNull();
    expect(validateAreaSearchQuery({ ...VALID, checkin: VALID.checkout })).toBeNull();
    expect(
      validateAreaSearchQuery({ ...VALID, checkin: '2026-09-19', checkout: '2026-09-17' }),
    ).toBeNull();
  });
});

describe('circleToQuery', () => {
  /** A 2 km circle over Nice; individual tests vary one field at a time. */
  const NICE = { latitude: 43.71, longitude: 7.26, radiusKm: 2 };

  it('carries the drawn centre and radius through unchanged', () => {
    // The point of drawing a circle: the shape queried IS the shape drawn.
    const query = circleToQuery(NICE);
    expect(query).not.toBeNull();
    expect(query?.latitude).toBe(43.71);
    expect(query?.longitude).toBe(7.26);
    expect(query?.radiusKm).toBe(2);
    // Occupancy defaults are the search form's: 2 adults, 1 room, no children.
    expect(query).toMatchObject({ adults: 2, rooms: 1, children: 0 });
  });

  it('returns null for a click rather than inflating it to the floor', () => {
    expect(circleToQuery({ ...NICE, radiusKm: 0 })).toBeNull();
    expect(circleToQuery({ ...NICE, radiusKm: -1 })).toBeNull();
  });

  it('returns null for non-finite geometry', () => {
    expect(circleToQuery({ ...NICE, radiusKm: Number.NaN })).toBeNull();
    expect(circleToQuery({ ...NICE, latitude: Number.NaN })).toBeNull();
    expect(circleToQuery({ ...NICE, longitude: Number.POSITIVE_INFINITY })).toBeNull();
  });

  it('returns null for a centre outside coordinate range', () => {
    expect(circleToQuery({ ...NICE, latitude: 95 })).toBeNull();
    expect(circleToQuery({ ...NICE, longitude: -181 })).toBeNull();
  });

  it('floors the radius at 500 m for a tiny drag', () => {
    expect(circleToQuery({ ...NICE, radiusKm: 0.004 })?.radiusKm).toBe(0.5);
    // Just above the floor is its own value, not the floor.
    expect(circleToQuery({ ...NICE, radiusKm: 0.6 })?.radiusKm).toBe(0.6);
  });

  it('caps the radius at the maximum for a huge drag', () => {
    expect(circleToQuery({ ...NICE, radiusKm: 500 })?.radiusKm).toBe(MAX_RADIUS_KM);
    expect(circleToQuery({ ...NICE, radiusKm: MAX_RADIUS_KM })?.radiusKm).toBe(MAX_RADIUS_KM);
  });

  it('passes dates through only when both ends are given', () => {
    const dated = circleToQuery(NICE, { checkin: '2026-09-17', checkout: '2026-09-19' });
    expect(dated).toMatchObject({ checkin: '2026-09-17', checkout: '2026-09-19' });
    const oneSided = circleToQuery(NICE, { checkin: '2026-09-17' });
    expect(oneSided).not.toBeNull();
    expect(oneSided).not.toHaveProperty('checkin');
  });
});

describe('category validation', () => {
  const base = { latitude: 43.7, longitude: 7.26, radiusKm: 5, adults: 2, rooms: 1, children: 0 };

  it('accepts known categories, deduplicated in order', () => {
    const query = validateAreaSearchQuery({
      ...base,
      categories: ['hotel', 'apartment', 'hotel'],
    });
    expect(query?.categories).toEqual(['hotel', 'apartment']);
  });

  it('refuses unknown categories rather than repairing', () => {
    expect(validateAreaSearchQuery({ ...base, categories: ['castle'] })).toBeNull();
    expect(validateAreaSearchQuery({ ...base, categories: 'hotel' })).toBeNull();
    expect(validateAreaSearchQuery({ ...base, categories: [204] })).toBeNull();
  });

  it('drops an empty selection instead of carrying []', () => {
    const query = validateAreaSearchQuery({ ...base, categories: [] });
    expect(query).not.toBeNull();
    expect(query?.categories).toBeUndefined();
  });

  it('circleToQuery passes categories through validation', () => {
    const circle = { latitude: 43.7, longitude: 7.26, radiusKm: 2 };
    expect(circleToQuery(circle, { categories: ['villa'] })?.categories).toEqual(['villa']);
    expect(circleToQuery(circle, { categories: [] })?.categories).toBeUndefined();
  });
});
