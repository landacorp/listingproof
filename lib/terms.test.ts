import { describe, expect, it } from 'vitest';
import {
  CANCELLATION_FEE_THRESHOLDS,
  evaluateTerms,
  type ListingTerms,
} from './terms';

/**
 * The advisories are consumer warnings on legitimate listings, which makes
 * their false-positive direction almost as sensitive as the verdict's: a panel
 * that cries "warning" on every hotel teaches the user to close the panel.
 * Every rule therefore fires only on affirmative evidence, and unknown is
 * always "could not check", never a warning and never a pass.
 */

const ids = (t: ListingTerms | undefined) => evaluateTerms(t).advisories.map((a) => a.id);

describe('unknown is never a warning and never a pass', () => {
  it.each([
    ['no terms at all', undefined],
    ['empty object', {}],
    ['all sections empty', { parking: {}, cancellation: {}, payment: {} }],
  ] as const)('%s → no advisories, everything unchecked', (_name, terms) => {
    const report = evaluateTerms(terms as ListingTerms | undefined);
    expect(report.advisories).toEqual([]);
    expect(report.unchecked.sort()).toEqual(['cancellation', 'parking', 'payment']);
  });

  it('a checked section leaves the unchecked list', () => {
    const report = evaluateTerms({ parking: { advertisedFree: true, kind: 'private' } });
    expect(report.unchecked).not.toContain('parking');
    expect(report.unchecked).toContain('cancellation');
    expect(report.unchecked).toContain('payment');
  });
});

describe('T.parking — free parking the property cannot promise', () => {
  it('fires when free parking turns out to be public', () => {
    const report = evaluateTerms({
      parking: { advertisedFree: true, kind: 'public', reservable: false, quote: 'Free public parking is possible at a location nearby (reservation is not needed).' },
    });
    expect(report.advisories).toHaveLength(1);
    const advisory = report.advisories[0];
    expect(advisory.id).toBe('T.parking');
    expect(advisory.severity).toBe('notice');
    expect(advisory.detail).toMatch(/may simply not be available/i);
    expect(advisory.quote).toContain('reservation is not needed');
  });

  it('mentions the street/unreservable nature only when stated', () => {
    const stated = evaluateTerms({ parking: { advertisedFree: true, kind: 'public', reservable: false } });
    expect(stated.advisories[0].detail).toMatch(/cannot be reserved/);
    const unstated = evaluateTerms({ parking: { advertisedFree: true, kind: 'public' } });
    expect(unstated.advisories[0].detail).not.toMatch(/cannot be reserved/);
  });

  it.each([
    ['private free parking', { advertisedFree: true, kind: 'private' }],
    ['paid parking, honestly labelled', { advertisedFree: false, kind: 'public' }],
    ['free parking of unknown kind', { advertisedFree: true }],
  ] as const)('stays silent on %s', (_name, parking) => {
    expect(ids({ parking: parking as ListingTerms['parking'] })).toEqual([]);
  });
});

describe('T.cancellation — money committed from the start', () => {
  it('fires when every rate is non-refundable', () => {
    const report = evaluateTerms({ cancellation: { allNonRefundable: true } });
    expect(report.advisories[0].id).toBe('T.cancellation');
    expect(report.advisories[0].severity).toBe('warn');
    expect(report.advisories[0].title).toMatch(/non-refundable/i);
  });

  it('fires when no free-cancellation option exists', () => {
    expect(ids({ cancellation: { freeOptionAvailable: false } })).toEqual(['T.cancellation']);
  });

  it('fires on a fee above the ~$100 line, and names the amount', () => {
    const report = evaluateTerms({
      cancellation: { freeOptionAvailable: true, fee: { amount: 450, currency: 'ILS' } },
    });
    expect(report.advisories[0].id).toBe('T.cancellation');
    expect(report.advisories[0].detail).toContain('450 ILS');
  });

  it.each([
    ['a free option exists', { freeOptionAvailable: true }],
    ['fee under the line', { freeOptionAvailable: true, fee: { amount: 40, currency: 'USD' } }],
    ['fee exactly at the line', { freeOptionAvailable: true, fee: { amount: 100, currency: 'USD' } }],
    // An unlisted currency must not warn: unknown is never over the line.
    ['fee in an unknown currency', { freeOptionAvailable: true, fee: { amount: 1_000_000, currency: 'XTS' } }],
  ] as const)('stays silent when %s', (_name, cancellation) => {
    expect(ids({ cancellation: cancellation as ListingTerms['cancellation'] })).toEqual([]);
  });

  it('thresholds approximate US$100 in every listed currency', () => {
    // Coarse by design, but an entry drifting an order of magnitude from $100
    // would make the rule meaningless in that currency.
    for (const [currency, threshold] of Object.entries(CANCELLATION_FEE_THRESHOLDS)) {
      expect(threshold, currency).toBeGreaterThan(0);
    }
    expect(CANCELLATION_FEE_THRESHOLDS.USD).toBe(100);
  });
});

describe('T.payment — irreversible money movement', () => {
  it('fires at full strength on bank transfer of the whole amount', () => {
    const report = evaluateTerms({
      payment: { bankTransferRequested: true, fullPrepaymentRequired: true, quote: 'The property will contact you with bank transfer instructions.' },
    });
    const advisory = report.advisories[0];
    expect(advisory.id).toBe('T.payment');
    expect(advisory.severity).toBe('warn');
    expect(advisory.title).toMatch(/full prepayment by bank transfer/i);
    // The wording must say why it matters AND stay honest about legitimacy.
    expect(advisory.detail).toMatch(/no chargeback|irreversible/i);
    expect(advisory.detail).toMatch(/proves nothing/i);
  });

  it('fires on a transfer request even without full prepayment', () => {
    const report = evaluateTerms({ payment: { bankTransferRequested: true } });
    expect(report.advisories[0].severity).toBe('warn');
    expect(report.advisories[0].title).toMatch(/^Payment by bank transfer/);
  });

  it('full prepayment by card is a notice, not a fraud-adjacent warning', () => {
    const report = evaluateTerms({
      payment: { bankTransferRequested: false, fullPrepaymentRequired: true },
    });
    expect(report.advisories[0].severity).toBe('notice');
    expect(report.advisories[0].detail).not.toMatch(/scam|fraud/i);
  });

  it('stays silent when neither is requested', () => {
    expect(ids({ payment: { bankTransferRequested: false, fullPrepaymentRequired: false } })).toEqual([]);
  });
});

describe('advisories never claim to be the verdict', () => {
  it('no advisory uses verdict vocabulary', () => {
    const everything: ListingTerms = {
      parking: { advertisedFree: true, kind: 'public', reservable: false },
      cancellation: { allNonRefundable: true },
      payment: { bankTransferRequested: true, fullPrepaymentRequired: true },
    };
    for (const advisory of evaluateTerms(everything).advisories) {
      // The tampering verdict's words must stay the verdict's alone, or a
      // parking note reads as a fraud accusation.
      expect(`${advisory.title} ${advisory.detail}`).not.toMatch(/\b(RED|GREEN|YELLOW|GRAY|tampering|hijack)\b/);
    }
  });
});
