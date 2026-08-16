import { describe, expect, it } from 'vitest';
import { addMonths, clickDay, inRange, monthMatrix, nightsBetween, type DateRange } from './rangecal';

describe('clickDay', () => {
  it('starts a range from an empty selection', () => {
    expect(clickDay({}, '2026-09-13')).toEqual({ checkin: '2026-09-13' });
  });

  it('completes the range on a later day', () => {
    expect(clickDay({ checkin: '2026-09-13' }, '2026-09-15')).toEqual({
      checkin: '2026-09-13',
      checkout: '2026-09-15',
    });
  });

  it('restarts on the same day instead of a zero-night stay', () => {
    expect(clickDay({ checkin: '2026-09-13' }, '2026-09-13')).toEqual({ checkin: '2026-09-13' });
  });

  it('restarts on an earlier day instead of an inverted range', () => {
    expect(clickDay({ checkin: '2026-09-13' }, '2026-09-10')).toEqual({ checkin: '2026-09-10' });
  });

  it('starts over from a complete range', () => {
    const complete: DateRange = { checkin: '2026-09-13', checkout: '2026-09-15' };
    expect(clickDay(complete, '2026-09-20')).toEqual({ checkin: '2026-09-20' });
  });

  it('never mutates its input', () => {
    const range: DateRange = { checkin: '2026-09-13' };
    clickDay(range, '2026-09-15');
    expect(range).toEqual({ checkin: '2026-09-13' });
  });
});

describe('monthMatrix', () => {
  it('lays out September 2026 (starts on a Tuesday) Monday-first', () => {
    const weeks = monthMatrix(2026, 8);
    expect(weeks).toHaveLength(5);
    for (const week of weeks) expect(week).toHaveLength(7);
    // Monday column is empty before a Tuesday 1st.
    expect(weeks[0]).toEqual([
      null,
      '2026-09-01',
      '2026-09-02',
      '2026-09-03',
      '2026-09-04',
      '2026-09-05',
      '2026-09-06',
    ]);
    // 30 days: the last week holds Mon 28 – Wed 30, then padding.
    expect(weeks[4]).toEqual(['2026-09-28', '2026-09-29', '2026-09-30', null, null, null, null]);
  });

  it('gives leap-year February 2028 its 29th day', () => {
    const weeks = monthMatrix(2028, 1);
    const days = weeks.flat().filter((cell) => cell !== null);
    expect(days).toHaveLength(29);
    expect(days[0]).toBe('2028-02-01');
    expect(days[28]).toBe('2028-02-29');
  });

  it('pads a month that starts on Monday with no leading blanks', () => {
    // June 2026 starts on a Monday.
    expect(monthMatrix(2026, 5)[0]?.[0]).toBe('2026-06-01');
  });
});

describe('addMonths', () => {
  it('steps within a year', () => {
    expect(addMonths(2026, 8, 1)).toEqual({ year: 2026, month0: 9 });
    expect(addMonths(2026, 8, -1)).toEqual({ year: 2026, month0: 7 });
  });

  it('carries forward across a year boundary', () => {
    expect(addMonths(2026, 11, 1)).toEqual({ year: 2027, month0: 0 });
    expect(addMonths(2026, 10, 3)).toEqual({ year: 2027, month0: 1 });
  });

  it('borrows backward across a year boundary', () => {
    expect(addMonths(2026, 0, -1)).toEqual({ year: 2025, month0: 11 });
    expect(addMonths(2026, 1, -14)).toEqual({ year: 2024, month0: 11 });
  });
});

describe('nightsBetween', () => {
  it('counts a two-night stay', () => {
    expect(nightsBetween('2026-09-13', '2026-09-15')).toBe(2);
  });

  it('counts one night', () => {
    expect(nightsBetween('2026-09-13', '2026-09-14')).toBe(1);
  });

  it('counts across a month boundary and a leap day', () => {
    expect(nightsBetween('2026-09-28', '2026-10-02')).toBe(4);
    expect(nightsBetween('2028-02-28', '2028-03-01')).toBe(2);
  });
});

describe('inRange', () => {
  const range: DateRange = { checkin: '2026-09-13', checkout: '2026-09-16' };

  it('is true strictly between the endpoints', () => {
    expect(inRange('2026-09-14', range)).toBe(true);
    expect(inRange('2026-09-15', range)).toBe(true);
  });

  it('excludes the endpoints themselves', () => {
    expect(inRange('2026-09-13', range)).toBe(false);
    expect(inRange('2026-09-16', range)).toBe(false);
  });

  it('is false outside the range', () => {
    expect(inRange('2026-09-12', range)).toBe(false);
    expect(inRange('2026-09-17', range)).toBe(false);
  });

  it('is false while the range is incomplete or empty', () => {
    expect(inRange('2026-09-14', { checkin: '2026-09-13' })).toBe(false);
    expect(inRange('2026-09-14', {})).toBe(false);
  });
});
