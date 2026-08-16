/**
 * Guest reviews: what the page published, and what is worth pointing at.
 *
 * This is advisory, like `lib/terms.ts`, and for the same reason twice over.
 * Reviews are written by other people and SELECTED by the platform, so they
 * are neither the property's claim nor a neutral sample — Booking serves ten
 * of them and picks good ones (measured on this repo's corpus: 88% score 8
 * or better, and the featured mean beats the property's own aggregate on 9
 * of 12 fixtures). A verdict must never rest on that.
 *
 * What the panel can honestly do is show the reader what it found, say how
 * little it is, and let them judge. Two things are stated out loud rather
 * than smoothed over:
 *
 *   - the SAMPLE: "10 of 3,526 reviews, the ones the page chose to show".
 *   - the WINDOW: the oldest review we can see. A listing may have been
 *     reported as a scam years ago and we would not know, because the page
 *     does not serve reviews that old (corpus median age: 59 days).
 *
 * `lib/enginel.ts` remains the semantic reader; this module is deliberately
 * mechanical — scores, dates, and word matches shown with their quote — so
 * that everything it claims can be checked against the text beside it.
 */

/** One review as the page published it. Absent fields were not served. */
export interface ReviewItem {
  /** Platform-stable id, when the page carries one. */
  id?: string;
  /** Score normalised to 0–10, whatever scale the platform used. */
  score?: number;
  /** The scale the platform published, for the evidence row ("8/10", "4/5"). */
  rawScore?: { value: number; max: number };
  /** When the stay was reviewed. Epoch milliseconds. */
  reviewedAt?: number;
  /** The reviewer's own words. Booking splits them; both halves are kept. */
  positive?: string;
  negative?: string;
  title?: string;
  /** BCP-47-ish tag the platform declared. Per review, and not always right. */
  lang?: string;
}

/** What the page claims overall, for the "we saw N of M" honesty line. */
export interface ReviewSummary {
  /** Aggregate score the page publishes, 0–10. */
  score?: number;
  /** Total the page claims, which is nearly always far more than we can see. */
  total?: number;
}

export interface ReviewSet {
  items: ReviewItem[];
  summary?: ReviewSummary;
}
