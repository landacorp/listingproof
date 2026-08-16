// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { extractBookingTerms } from './terms';
import { evaluateTerms } from '../../terms';

const LIVE_DIR = join(process.cwd(), 'fixtures/live');

function parseFixture(file: string): Document {
  return new DOMParser().parseFromString(readFileSync(join(LIVE_DIR, file), 'utf8'), 'text/html');
}

describe('parking extraction from the Apollo cache (locale-invariant)', () => {
  it.each([
    // Measured from the corpus with a standalone probe before this module
    // existed — the enums, not the localized labels, are the ground truth.
    ['fr-hijack-paris-eiffel.en-gb.html', { advertisedFree: true, kind: 'private' }],
    ['fr-hijack-gite-chassagne.en-gb.html', { advertisedFree: true, kind: 'private' }],
    ['it-hotelbellevue_rimini.en-us.html', { advertisedFree: false }],
    ['us-the-warwick-new-york.html', { advertisedFree: false }],
    // The Spanish capture proves locale-invariance: PUBLIC + CHARGES_MAY_APPLY
    // enums are read from a page whose visible text is Spanish.
    ['es-catalonia-la-boqueria.es.html', { advertisedFree: false }],
  ])('%s', (file, expected) => {
    const terms = extractBookingTerms(parseFixture(file));
    expect(terms.parking).toBeDefined();
    expect(terms.parking?.advertisedFree).toBe(expected.advertisedFree);
    if ('kind' in expected) expect(terms.parking?.kind).toBe(expected.kind);
  }, 30_000);

  it('free private parking raises no advisory', () => {
    const terms = extractBookingTerms(parseFixture('fr-hijack-paris-eiffel.en-gb.html'));
    const report = evaluateTerms(terms);
    expect(report.advisories.map((a) => a.id)).not.toContain('T.parking');
  }, 30_000);

  it('a page with no parking facility reports unknown, not "no parking"', () => {
    const doc = new DOMParser().parseFromString('<html lang="en"><body></body></html>', 'text/html');
    expect(extractBookingTerms(doc).parking).toBeUndefined();
  });
});

describe('bank-transfer detection in the fine print', () => {
  it('finds the demand on the real hijack, with the page quoted as evidence', () => {
    // The hijacked listing itself carries the classic monetisation sentence.
    const terms = extractBookingTerms(parseFixture('fr-hijack-paris-eiffel.en-gb.html'));
    expect(terms.payment?.bankTransferRequested).toBe(true);
    expect(terms.payment?.fullPrepaymentRequired).toBe(true);
    expect(terms.payment?.quote).toMatch(/bank transfer/i);

    const report = evaluateTerms(terms);
    const advisory = report.advisories.find((a) => a.id === 'T.payment');
    expect(advisory?.severity).toBe('warn');
    expect(advisory?.title).toMatch(/full prepayment by bank transfer/i);
  }, 30_000);

  it('reports transfers as NOT requested on an honest listing with readable fine print', () => {
    const terms = extractBookingTerms(parseFixture('us-the-warwick-new-york.html'));
    expect(terms.payment?.bankTransferRequested).toBe(false);
    expect(evaluateTerms(terms).advisories.map((a) => a.id)).not.toContain('T.payment');
  }, 30_000);

  it('a language outside the dictionary yields unknown, never a silent pass', () => {
    const doc = new DOMParser().parseFromString(
      `<html lang="ko"><body><div data-testid="property-section--content">
         <p>도착 전 은행 송금으로 결제해야 합니다. 예약 후 안내를 드립니다.</p>
       </div></body></html>`,
      'text/html',
    );
    const terms = extractBookingTerms(doc);
    expect(terms.payment).toBeUndefined();
    expect(evaluateTerms(terms).unchecked).toContain('payment');
  });

  it.each([
    ['de', 'Die Zahlung vor Anreise per Banküberweisung ist erforderlich.'],
    ['fr', "Le paiement avant l'arrivée par virement bancaire est obligatoire."],
    ['es', 'Se requiere el pago por adelantado mediante transferencia bancaria.'],
    ['ja', '到着前に銀行振込でのお支払いが必要です。'],
  ])('reads the %s form of the demand', (lang, sentence) => {
    const doc = new DOMParser().parseFromString(
      `<html lang="${lang}"><body><div data-testid="property-section--content">
         <p>${sentence} Additional context text to pass the length filter of the scanner.</p>
       </div></body></html>`,
      'text/html',
    );
    const terms = extractBookingTerms(doc);
    expect(terms.payment?.bankTransferRequested, `${lang} not detected`).toBe(true);
    expect(terms.payment?.fullPrepaymentRequired, `${lang} prepayment not detected`).toBe(true);
  });
});

describe('cancellation on a dateless page', () => {
  it('is honestly unknown — rate policies only load once dates are chosen', () => {
    const terms = extractBookingTerms(parseFixture('us-the-warwick-new-york.html'));
    expect(terms.cancellation).toBeUndefined();
    expect(evaluateTerms(terms).unchecked).toContain('cancellation');
  }, 30_000);

  it('reads per-rate freeCancellation flags when a rate table is present', () => {
    const doc = new DOMParser().parseFromString(
      `<html lang="en"><body><script>var apollo = {"rooms":[
         {\\"block\\":{\\"freeCancellation\\":false}},{\\"block\\":{\\"freeCancellation\\":false}}
       ]};</script></body></html>`.replace(/\\\\/g, '\\'),
      'text/html',
    );
    const terms = extractBookingTerms(doc);
    expect(terms.cancellation?.allNonRefundable).toBe(true);
    const report = evaluateTerms(terms);
    expect(report.advisories.find((a) => a.id === 'T.cancellation')?.severity).toBe('warn');
  });

  it('one refundable rate among many is enough to stay silent', () => {
    const doc = new DOMParser().parseFromString(
      `<html lang="en"><body><script>var apollo = {"a":{"freeCancellation":false},"b":{"freeCancellation":true}};</script></body></html>`,
      'text/html',
    );
    const terms = extractBookingTerms(doc);
    expect(terms.cancellation?.freeOptionAvailable).toBe(true);
    expect(evaluateTerms(terms).advisories.map((a) => a.id)).not.toContain('T.cancellation');
  });
});
