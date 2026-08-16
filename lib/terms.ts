/**
 * Booking-terms advisories: parking honesty, cancellation cost, payment method.
 *
 * These are deliberately NOT part of the tampering verdict. The verdict answers
 * one question — "is this listing what it claims to be?" — and its credibility
 * rests on never being diluted. A hotel with an expensive cancellation policy
 * is not a fraud, and calling it one would burn the trust the RED verdict
 * needs. So terms produce a separate panel section of advisories: things worth
 * checking before booking, stated plainly, never folded into the verdict.
 *
 * The one deliberate overlap: a request to pay the full amount up front by
 * bank transfer is the classic monetisation step of a hijacked listing — the
 * scammer needs irreversible, off-platform payment. It still does not move the
 * verdict (plenty of small legitimate properties take transfers), but its
 * advisory is worded at maximum strength and explains exactly why it matters.
 *
 * Like everything else: adapters extract per-platform facts into
 * `ListingTerms`; the rules below are platform-independent; missing facts mean
 * "could not check", stated honestly, never a silent pass.
 *
 * The advisory prose is authored as catalog keys plus facts (see `lib/msg.ts`)
 * so the panel can say all this in the user's language; `english()` renders the
 * same sentence here, which keeps `title`/`detail` exactly what every non-panel
 * consumer already reads without storing a second copy of the words.
 */
import { english, msg } from './msg';
import type { LocalizedText } from './signals';

/** What a platform's page states about parking. All fields optional: unknown ≠ no. */
export interface ParkingTerms {
  /** The page advertises parking as free. */
  advertisedFree?: boolean;
  /**
   * Where the parking actually is: private on-site, or public street/nearby
   * parking the property neither owns nor can promise.
   */
  kind?: 'private' | 'public';
  /** True when the page says no reservation is possible for the parking. */
  reservable?: boolean;
  /** The page's own parking sentence, quoted as evidence. */
  quote?: string;
}

export interface CancellationTerms {
  /** At least one displayed rate has a free-cancellation window. */
  freeOptionAvailable?: boolean;
  /** Every displayed rate is non-refundable. */
  allNonRefundable?: boolean;
  /** Stated cancellation fee, when the page prints one. */
  fee?: { amount: number; currency: string };
  quote?: string;
}

export interface PaymentTerms {
  /** The page requests payment by bank transfer / wire. */
  bankTransferRequested?: boolean;
  /** The page requests prepayment of the full amount before arrival. */
  fullPrepaymentRequired?: boolean;
  quote?: string;
}

/** Per-platform extraction result. Adapters fill what their markup supports. */
export interface ListingTerms {
  parking?: ParkingTerms;
  cancellation?: CancellationTerms;
  payment?: PaymentTerms;
}

export type TermsSeverity = 'warn' | 'notice';

export interface TermsAdvisory {
  id: 'T.parking' | 'T.cancellation' | 'T.payment';
  severity: TermsSeverity;
  /** English; derived from `titleMsg`, never authored twice. */
  title: string;
  /** English; derived from `detailMsg`. */
  detail: string;
  /** Translatable sources of `title`/`detail`; the panel renders these. */
  titleMsg?: LocalizedText;
  detailMsg?: LocalizedText;
  /**
   * Verbatim page text backing the advisory, when the adapter captured it.
   * Never keyed and never translated: it is the page's own sentence, and
   * rewording a quote would destroy the thing that makes it evidence.
   */
  quote?: string;
}

export interface TermsReport {
  advisories: TermsAdvisory[];
  /** Checks that could not run for lack of data — shown as honest gaps. */
  unchecked: Array<'parking' | 'cancellation' | 'payment'>;
}

/**
 * Cancellation-fee thresholds, per currency, approximating "more than ~US$100".
 *
 * Deliberately coarse and deliberately static: the point is to flag an
 * expensive cancellation, not to do currency conversion, and a fee near the
 * line is not meaningfully different on either side of it. Rates are rounded
 * from 2026 levels; a currency not listed produces NO fee advisory rather than
 * a wrong one (unknown is never treated as over the line).
 */
export const CANCELLATION_FEE_THRESHOLDS: Readonly<Record<string, number>> = {
  USD: 100,
  EUR: 95,
  GBP: 80,
  CHF: 90,
  ILS: 370,
  JPY: 15_000,
  BRL: 550,
  AUD: 155,
  CAD: 140,
  PLN: 400,
  CZK: 2_300,
  SEK: 1_050,
  NOK: 1_050,
  DKK: 700,
};

export function evaluateTerms(terms: ListingTerms | undefined): TermsReport {
  const advisories: TermsAdvisory[] = [];
  const unchecked: TermsReport['unchecked'] = [];

  // --- parking: "free parking" that the property cannot actually promise ----
  const parking = terms?.parking;
  if (!parking || parking.advertisedFree === undefined) {
    unchecked.push('parking');
  } else if (parking.advertisedFree && parking.kind === 'public') {
    const unreservable = parking.reservable === false;
    // Two whole sentences rather than one with "street" and "that cannot be
    // reserved" spliced in: the insertions change the sentence's shape, and a
    // shape is a key chosen here, not a fragment handed to a translator.
    const titleMsg = msg('terms.parking.title');
    const detailMsg = msg(
      unreservable ? 'terms.parking.detailUnreservable' : 'terms.parking.detail',
    );
    advisories.push({
      id: 'T.parking',
      severity: 'notice',
      title: english(titleMsg),
      detail: english(detailMsg),
      titleMsg,
      detailMsg,
      ...(parking.quote === undefined ? {} : { quote: parking.quote }),
    });
  }

  // --- cancellation: locked in from the moment of booking -------------------
  const cancellation = terms?.cancellation;
  if (
    !cancellation ||
    (cancellation.freeOptionAvailable === undefined &&
      cancellation.allNonRefundable === undefined &&
      cancellation.fee === undefined)
  ) {
    unchecked.push('cancellation');
  } else {
    const fee = cancellation.fee;
    const threshold = fee ? CANCELLATION_FEE_THRESHOLDS[fee.currency.toUpperCase()] : undefined;
    const expensiveFee = fee !== undefined && threshold !== undefined && fee.amount > threshold;

    if (cancellation.allNonRefundable || cancellation.freeOptionAvailable === false || expensiveFee) {
      const titleMsg = msg(
        cancellation.allNonRefundable
          ? 'terms.cancellation.titleNonRefundable'
          : 'terms.cancellation.title',
      );
      // The sentence that names the fee is a key of its own, not this one plus
      // a clause. The figure travels twice: `amount` already grouped, which is
      // what the English rendering interpolates, and `amountValue` raw, so a
      // panel can group it in the reader's own locale (15 000, 15.000) instead
      // of shipping English digit grouping inside a translated sentence. The
      // key's text uses `{amount}` alone, so the raw one is inert here — which
      // is exactly what lets the English stay frozen while the panel improves.
      const detailMsg =
        fee && expensiveFee
          ? msg('terms.cancellation.detailWithFee', {
              amount: fee.amount.toLocaleString('en-US'),
              amountValue: fee.amount,
              currency: fee.currency,
            })
          : msg('terms.cancellation.detail');
      advisories.push({
        id: 'T.cancellation',
        severity: 'warn',
        title: english(titleMsg),
        detail: english(detailMsg),
        titleMsg,
        detailMsg,
        ...(cancellation.quote === undefined ? {} : { quote: cancellation.quote }),
      });
    }
  }

  // --- payment: irreversible, off-platform money movement -------------------
  const payment = terms?.payment;
  if (!payment || (payment.bankTransferRequested === undefined && payment.fullPrepaymentRequired === undefined)) {
    unchecked.push('payment');
  } else if (payment.bankTransferRequested) {
    const fullAmount = payment.fullPrepaymentRequired === true;
    // "the whole amount up front by transfer" vs "a transfer" is an English
    // object phrase mid-sentence — the one thing a param must never carry. Two
    // sentences, two keys, each translatable as a whole.
    const titleMsg = msg(
      fullAmount ? 'terms.payment.transferFullTitle' : 'terms.payment.transferTitle',
    );
    const detailMsg = msg(
      fullAmount ? 'terms.payment.transferFullDetail' : 'terms.payment.transferDetail',
    );
    advisories.push({
      id: 'T.payment',
      severity: 'warn',
      title: english(titleMsg),
      detail: english(detailMsg),
      titleMsg,
      detailMsg,
      ...(payment.quote === undefined ? {} : { quote: payment.quote }),
    });
  } else if (payment.fullPrepaymentRequired) {
    const titleMsg = msg('terms.payment.prepaymentTitle');
    const detailMsg = msg('terms.payment.prepaymentDetail');
    advisories.push({
      id: 'T.payment',
      severity: 'notice',
      title: english(titleMsg),
      detail: english(detailMsg),
      titleMsg,
      detailMsg,
      ...(payment.quote === undefined ? {} : { quote: payment.quote }),
    });
  }

  return { advisories, unchecked };
}
