/**
 * Date-range calendar logic, kept pure so it is testable without a DOM.
 *
 * The calendar UI in `main.ts` is one `<details>` popover with a month grid;
 * everything it needs to decide — what a click means, what a month looks
 * like, how far apart two days are — lives here as plain functions over ISO
 * `YYYY-MM-DD` strings. ISO strings compare lexicographically in date order,
 * so no Date parsing is needed for ordering, and all arithmetic runs in UTC
 * so a DST transition can never produce a 23- or 25-hour "day".
 */

/** A stay selection in progress: none, check-in only, or a complete range. */
export interface DateRange {
  checkin?: string;
  checkout?: string;
}

/**
 * What clicking a day does to the selection — the whole state machine:
 * with no check-in yet (or a complete range behind us) the click starts a
 * new range; with a check-in pending, a later day completes the range and a
 * click at-or-before the start restarts from the clicked day instead of
 * producing a zero- or negative-night stay.
 */
export function clickDay(range: DateRange, iso: string): DateRange {
  if (range.checkin === undefined || range.checkout !== undefined) {
    return { checkin: iso };
  }
  return iso > range.checkin ? { checkin: range.checkin, checkout: iso } : { checkin: iso };
}

/**
 * The month as rows of weeks, Monday-first, each cell an ISO date string or
 * null padding before the 1st and after the last day. `month0` is 0-based,
 * matching `Date`.
 */
export function monthMatrix(year: number, month0: number): (string | null)[][] {
  const daysInMonth = new Date(Date.UTC(year, month0 + 1, 0)).getUTCDate();
  // getUTCDay is Sunday-0; shift so Monday is column 0.
  const leadingBlanks = (new Date(Date.UTC(year, month0, 1)).getUTCDay() + 6) % 7;
  const cells: (string | null)[] = Array<string | null>(leadingBlanks).fill(null);
  const monthPart = String(month0 + 1).padStart(2, '0');
  for (let day = 1; day <= daysInMonth; day++) {
    cells.push(`${year}-${monthPart}-${String(day).padStart(2, '0')}`);
  }
  while (cells.length % 7 !== 0) cells.push(null);
  const weeks: (string | null)[][] = [];
  for (let start = 0; start < cells.length; start += 7) {
    weeks.push(cells.slice(start, start + 7));
  }
  return weeks;
}

/** Step the visible month, carrying across year boundaries in either direction. */
export function addMonths(
  year: number,
  month0: number,
  delta: number,
): { year: number; month0: number } {
  const total = year * 12 + month0 + delta;
  return { year: Math.floor(total / 12), month0: ((total % 12) + 12) % 12 };
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Whole nights between two ISO dates (checkout is exclusive, as in a stay). */
export function nightsBetween(checkin: string, checkout: string): number {
  return Math.round((Date.parse(checkout) - Date.parse(checkin)) / MS_PER_DAY);
}

/**
 * True for days strictly between the two endpoints of a complete range — the
 * cells the UI highlights as "inside the stay". The endpoints themselves are
 * styled separately, and an incomplete range has no inside.
 */
export function inRange(iso: string, range: DateRange): boolean {
  if (range.checkin === undefined || range.checkout === undefined) return false;
  return range.checkin < iso && iso < range.checkout;
}
