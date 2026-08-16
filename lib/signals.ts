/**
 * Shared verdict/signal contracts. Every engine (A intra-page, L local LLM)
 * emits `Signal`s; `lib/score.ts` is the single place they combine into a
 * `Verdict`.
 *
 * Design rule from PLAN.md: GRAY is first-class. Missing data must never be
 * scored as GREEN — "we could not check" and "we checked and it is fine" are
 * different answers and the panel says which one it is.
 */

// Type-only, and deliberately from `./i18n/keys` rather than `./i18n`: this
// module is imported by pure logic and by the service worker, and an erased
// import costs nothing where pulling in the locale catalogs would cost plenty.
import type { MessageKey } from './i18n/keys';

export type Verdict = 'GREEN' | 'YELLOW' | 'RED' | 'GRAY';

/** Which engine produced a signal. L is untrusted and influence-capped. */
export type SignalEngine = 'A' | 'L';

/**
 * Severity a rule *proposes*. The scorer disposes: an L-signal proposing RED
 * is capped to YELLOW unless a deterministic (Engine A) flag also fired.
 */
export type SignalSeverity = 'RED' | 'YELLOW' | 'GRAY';

/**
 * A translatable sentence: the catalog key the engines authored it as, plus
 * the values to fill in. `lib/msg.ts` renders it — in English at
 * construction time (so `title`/`detail` below are always the English the
 * tests and non-panel consumers expect) and in the user's language when the
 * panel draws it. One source of truth, so the two can never drift.
 *
 * Params carry FACTS, never sentences: distances, names, counts, dates.
 *
 * `key` is a `MessageKey`, not a string: a mistyped or renamed key would
 * otherwise compile, ship, and show the reader a raw dotted key in place of a
 * sentence — in every language at once, with no test to catch it.
 */
export interface LocalizedText {
  key: MessageKey;
  params?: Record<string, string | number>;
}

/** One labelled value shown in the evidence table (provenance per row). */
export interface EvidenceValue {
  label: string;
  value: string;
  /** Translatable form of `label`; the panel prefers it when present. */
  labelMsg?: LocalizedText;
  /**
   * Translatable form of `value`, for values that are OUR prose rather than
   * the page's data ("no distance stated", "437.0 km away — page says …").
   * A value that is a page quote, a coordinate or a number stays raw: it is
   * evidence, and evidence is not rewritten.
   */
  valueMsg?: LocalizedText;
}

/** A linkable proof (a map, a geocode result). */
export interface EvidenceLink {
  label: string;
  href: string;
  labelMsg?: LocalizedText;
}

export interface Signal {
  /** Stable rule id: 'A1', 'A2', 'A3', 'L1'… */
  id: string;
  engine: SignalEngine;
  severity: SignalSeverity;
  /** One-line human statement of what fired. English; derived from `titleMsg`. */
  title: string;
  /** What was compared, in plain language. English; derived from `detailMsg`. */
  detail: string;
  /** Translatable sources of `title`/`detail`; the panel renders these. */
  titleMsg?: LocalizedText;
  detailMsg?: LocalizedText;
  /** The concrete values behind the claim — never assert without showing. */
  values?: EvidenceValue[];
  links?: EvidenceLink[];
}

/**
 * Why a check did or did not run. Distinct from `SignalSeverity` on purpose:
 * a check that never ran produces no signal, so without this record a page
 * where almost nothing was checkable scores the same confident GREEN as a
 * fully-checked one — the panel needs to say which it is.
 */
export type CheckStatus =
  /** The check had its inputs and executed (it may or may not have fired). */
  | 'checked'
  /** This platform cannot support the check at all (adapter capability). */
  | 'not-applicable'
  /** Applicable in principle, but this page lacked the data it needs. */
  | 'no-data';

/** One entry of the verdict's coverage: a check, and whether it ran here. */
export interface CheckCoverage {
  /** Stable check id: 'A1', 'A2', 'A3'. */
  id: string;
  /** Human name of the check. English; derived from `labelMsg`. */
  label: string;
  status: CheckStatus;
  /** Why it did not run, when it did not. English; derived from `detailMsg`. */
  detail?: string;
  /** Translatable sources of `label`/`detail`; the panel renders these. */
  labelMsg?: LocalizedText;
  detailMsg?: LocalizedText;
}

export interface ScoreResult {
  verdict: Verdict;
  /** All signals considered, including GRAY ones, for the evidence table. */
  signals: Signal[];
  /** Short reasons behind the verdict, most important first (English). */
  reasons: string[];
  /** Translatable sources of `reasons`, index-aligned with it. */
  reasonMsgs?: LocalizedText[];
  /** True when an L-proposed RED was capped for lack of deterministic support. */
  llmCapped: boolean;
  /**
   * Which checks ran on this page and which could not — the difference
   * between "checked and clean" and "unchecked". Absent only in states
   * produced before this field existed (an evicted worker's old publish).
   */
  coverage?: CheckCoverage[];
}
