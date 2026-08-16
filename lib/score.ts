/**
 * The scorer — the single place where Engine A (intra-page consistency) and
 * Engine L (local LLM) signals become one verdict. Everything upstream
 * *proposes*; this module *disposes*.
 *
 * Three invariants hold by construction here, and each is pinned by a test:
 *
 *  1. RED is never produced without at least one deterministic (Engine A)
 *     signal of RED or YELLOW severity. That is the prompt-injection bound from
 *     PLAN.md: page content is attacker-authored, so a page that talks the local
 *     model into screaming still cannot manufacture a RED on its own.
 *  2. A GRAY-severity signal never improves a verdict and never worsens it past
 *     GREEN — but it is always carried into `signals` and always named in
 *     `reasons`. "We could not check" and "we checked and it is fine" are
 *     different answers and the panel must be able to say which one it is.
 *  3. Missing, partial or uninterpretable input is never scored as agreement.
 *     Every way of failing to understand the input lands on GRAY, never GREEN.
 *
 * What GREEN means now that there is no history check. The archive comparison
 * (Engine B) has been removed from the product, so a verdict rests on what can
 * be read from the live page alone: Engine A's three intra-page rules, plus an
 * Engine L reading that is capped and cannot move a verdict by itself. GREEN is
 * therefore the narrow claim "every rule that could run passed" — never "this
 * listing has been checked against its own past", which nothing in this product
 * does any more. `coverage` is the only place that says *which* of the rules
 * could run, which is why it is emitted whenever the caller can describe the
 * page's inputs and why `score.reason.coverage` states the shortfall out loud
 * on any verdict where some check did not run. A page where almost nothing was
 * checkable must not read like a page that passed everything.
 *
 * Direction of the asymmetry: a false GREEN is the worst outcome this product
 * can produce and a false RED is the second worst. Where the two pull against
 * each other, this module refuses to *accuse* on evidence it cannot stand
 * behind, but it never lets that refusal become a clean bill of health.
 *
 * Every sentence this module produces — each verdict reason, each coverage
 * label and detail — is authored as a catalog key plus facts (`lib/msg.ts`),
 * and its English is derived from that key rather than written beside it, so
 * the two can never drift. `reasonMsgs` is index-aligned with `reasons`.
 *
 * One contract the panel has to honour: a reason that quotes a signal's own
 * title carries `{id}` and `{title}` params, where `title` is the English the
 * engine authored. The panel must look the signal up in `result.signals` by
 * that `id` and refill `title` from its `titleMsg`, or a translated panel will
 * wrap a translated sentence around an English clause.
 *
 * Pure module: no browser APIs, no I/O, no clock. Input is not mutated.
 */

import type { MessageKey } from './i18n/keys';
import { english, msg } from './msg';
import type {
  CheckCoverage,
  CheckStatus,
  LocalizedText,
  ScoreResult,
  Signal,
  SignalEngine,
  SignalSeverity,
  Verdict,
} from './signals';
import type { SiteCapabilities } from './sites/types';

/** What this page actually supplied, for the coverage report. */
export interface CoverageInputs {
  /** The canonical URL carried a name-derived slug for A1 to read. */
  hasSlug: boolean;
  /** Nearby landmarks the page listed (Engine A2's input). */
  poiCount: number;
  /** Breadcrumb entries the page carried (Engine A3's input). */
  breadcrumbCount: number;
  hasCoordinates: boolean;
  hasAddress: boolean;
}

/** Facts the scorer needs that are not themselves signals. */
export interface ScoreContext {
  /** The live identity had the fields the deterministic rules need. */
  identityComplete: boolean;
  /**
   * The adapter's declared capabilities. Lets the coverage report distinguish
   * "this platform cannot support the check" from "this page lacked the data"
   * — without it, a platform where A1/A3 never run scores the same confident
   * GREEN as a fully-checked page and nothing on the panel says so.
   */
  capabilities?: SiteCapabilities;
  /** When present, the result carries a per-check coverage report. */
  inputs?: CoverageInputs;
}

/**
 * Which checks ran on this page, and why the rest could not. Engines emit no
 * signal for a check that ran and passed, so the signals array cannot answer
 * "how much of this page was actually checked" — this can.
 *
 * These are the deterministic rules, and with the history comparison gone they
 * are the whole of what the coverage report can speak for. Engine L is absent
 * on purpose: it never decides a verdict by itself, so listing it here would
 * pad the "n of m checks ran" fraction with a check whose outcome the scorer
 * does not act on.
 */
export function assessCoverage(context: ScoreContext): CheckCoverage[] {
  const inputs = context.inputs;
  if (!inputs) return [];
  const capabilities = context.capabilities;

  const a1 = check('A1', 'score.coverage.a1.label', 'checked');
  if (capabilities !== undefined && !capabilities.nameBearingUrl) {
    a1.status = 'not-applicable';
    explain(a1, 'score.coverage.a1.notApplicable');
  } else if (!inputs.hasSlug) {
    a1.status = 'no-data';
    explain(a1, 'score.coverage.a1.noSlug');
  }

  const a2 = check('A2', 'score.coverage.a2.label', 'checked');
  if (inputs.poiCount === 0) {
    if (capabilities !== undefined && !capabilities.nearbyLandmarks) {
      a2.status = 'not-applicable';
      explain(a2, 'score.coverage.a2.notApplicable');
    } else {
      a2.status = 'no-data';
      explain(a2, 'score.coverage.a2.noLandmarks');
    }
  } else if (!inputs.hasCoordinates && !inputs.hasAddress) {
    a2.status = 'no-data';
    explain(a2, 'score.coverage.a2.noLocation');
  }

  const a3 = check('A3', 'score.coverage.a3.label', 'checked');
  if (inputs.breadcrumbCount === 0) {
    a3.status = 'no-data';
    explain(a3, 'score.coverage.a3.noBreadcrumbs');
  } else if (!inputs.hasCoordinates) {
    a3.status = 'no-data';
    explain(a3, 'score.coverage.a3.noCoordinates');
  }

  return [a1, a2, a3];
}

/**
 * A coverage row whose English `label` is derived from its catalog key rather
 * than written beside it. The panel renders `labelMsg` in the reader's
 * language; every other consumer reads the English. One source of words.
 */
function check(id: string, labelKey: MessageKey, status: CheckStatus): CheckCoverage {
  const labelMsg = msg(labelKey);
  return { id, label: english(labelMsg), status, labelMsg };
}

/** Why the check could not run — same derivation, same guarantee. */
function explain(row: CheckCoverage, detailKey: MessageKey): void {
  const detailMsg = msg(detailKey);
  row.detailMsg = detailMsg;
  row.detail = english(detailMsg);
}

/**
 * Engines whose output is trusted enough to set RED on its own.
 *
 * Engine A reads machine-checkable facts — a slug, a coordinate pair, a
 * breadcrumb trail — and compares them with code. Its failure mode is a bug.
 * Engine L reads attacker-authored prose through a language model; its failure
 * mode is an adversary. That difference, not accuracy, is why the split exists:
 * a wrong A is a defect we can fix, a wrong L is a capability the page author
 * has.
 *
 * Anything *not* in this list is treated as untrusted, which is why the check
 * is written as a membership test rather than as `engine === 'L'`: a signal
 * that arrives over the message boundary with an engine this module does not
 * recognise must be capped, not ignored. An ignored RED is a false GREEN. That
 * now covers `'B'` too — the archive engine is gone, so a stale published state
 * or an out-of-date client that still emits one is treated as hearsay rather
 * than trusted by inertia.
 */
export const DETERMINISTIC_ENGINES: readonly SignalEngine[] = ['A'];

/** The untrusted engine named by PLAN.md. See DETERMINISTIC_ENGINES. */
export const UNTRUSTED_ENGINE: SignalEngine = 'L';

/**
 * Severity an uncorroborated Engine L RED collapses to.
 *
 * YELLOW and not GRAY: the model did see something, and a user who is told
 * "nothing to report" when a semantic check screamed is being under-informed.
 * YELLOW and not RED: PLAN.md's hard rule — "L-signals alone cap at YELLOW;
 * RED requires ≥1 deterministic flag."
 */
export const LLM_UNSUPPORTED_CAP: SignalSeverity = 'YELLOW';

/**
 * Deterministic RED-or-YELLOW signals required before an Engine L RED is
 * allowed to stand as RED.
 *
 * One, because one is the smallest number that changes the LLM's role from
 * *asserting* a hijack to *corroborating* one already visible in the
 * machine-checkable data — which is exactly the propose/dispose split. Two
 * would make Engine L nearly dead weight: two deterministic flags almost always
 * produce RED by themselves. Zero would hand the verdict to the page author.
 *
 * Note the support does not have to be RED. A single deterministic YELLOW is
 * enough, because a YELLOW is precisely the case where the deterministic rules
 * saw something they could not adjudicate alone — the one place a semantic
 * reading adds information rather than noise.
 */
export const MIN_DETERMINISTIC_SUPPORT_FOR_LLM_RED = 1;

/**
 * Combine signals into a verdict, in the precedence order of PLAN.md's
 * "Verdict model" and Engine L hard rules.
 *
 * Precedence, highest first:
 *   1. any trusted deterministic RED                        → RED
 *   2. an Engine L RED with deterministic support           → RED
 *      (without support it is capped, and `llmCapped` says so)
 *   3. any remaining YELLOW proposal                        → YELLOW
 *   4. nothing fired: input fully understood ? GREEN : GRAY
 *
 * `signals` comes back whole — GRAY rows included — because the evidence table
 * renders everything that was considered, not everything that was damning.
 *
 * Degrades rather than throws. The scorer runs in the background worker on
 * data that has crossed a `runtime.sendMessage` boundary, where the compiler's
 * guarantees stop; a malformed `signals` array, a missing context or a
 * severity string this module does not recognise all resolve to GRAY. Never to
 * GREEN, and never to an exception that would leave the panel with no verdict
 * at all.
 */
export function score(signals: Signal[], context: ScoreContext): ScoreResult {
  // Copy up front. The caller keeps its array to build the evidence table and
  // must not be able to reach into a returned result and change what was
  // scored after the fact.
  const inputUsable = Array.isArray(signals);
  const all = inputUsable ? signals.slice() : [];

  // Defaults to the pessimistic value: a context that did not arrive is not a
  // context that said "everything is fine".
  const identityComplete = context?.identityComplete === true;

  // "Disposing" flags: deterministic and actually fired. GRAY is excluded
  // deliberately — a deterministic rule that could not run is not evidence of
  // anything, and must not become the support that promotes an LLM RED
  // (rule 2). This is invariant 3 applied to the scorer's own bookkeeping.
  const disposingFlags = all.filter((s) => isDeterministic(s) && isFlag(s));
  const disposingRed = disposingFlags.filter((s) => severityOf(s) === 'RED');
  const disposingYellow = disposingFlags.filter((s) => severityOf(s) === 'YELLOW');

  const untrusted = all.filter((s) => !isDeterministic(s));
  const untrustedRed = untrusted.filter((s) => severityOf(s) === 'RED');
  const untrustedYellow = untrusted.filter((s) => severityOf(s) === 'YELLOW');

  // Severity values this module cannot weigh mean the pipeline is broken. They
  // are reported, and they block GREEN — see rule 4.
  const uninterpretable = all.filter((s) => severityOf(s) === undefined);
  const unchecked = all.filter((s) => severityOf(s) === 'GRAY' || severityOf(s) === undefined);

  // Rule 2 — propose/dispose.
  //
  // An untrusted signal only counts at all when a deterministic rule
  // independently fired. Without that support it is advisory: it appears in the
  // evidence table and in the reasons, and it moves the verdict by nothing.
  //
  // This is stricter than "L alone caps at YELLOW", and deliberately so. Engine
  // L reads description and review text, and reviews are written by third
  // parties — so on an honest hotel's page an attacker can plant text that a
  // model will dutifully report. If an L finding could reach YELLOW on its own,
  // that plant would be a working reputation attack against a business that did
  // nothing wrong. PLAN.md's M6 acceptance criterion says the injection corpus
  // must never flip a verdict, and only this rule delivers that literally.
  //
  // What Engine L still buys, and why it is not decorative: its landmark
  // extraction (L1) feeds Engine A2, where the geocoder has to confirm every
  // place it proposed. That path is fully deterministic, so it can and does move
  // the verdict — on evidence a hallucination cannot fake.
  const untrustedHasSupport = disposingFlags.length >= MIN_DETERMINISTIC_SUPPORT_FOR_LLM_RED;
  const untrustedRedPromoted = untrustedRed.length > 0 && untrustedHasSupport;
  // The contract field is specifically about Engine L, so it is computed from
  // Engine L rather than from "untrusted" at large. True whenever Engine L
  // proposed a flag that was not allowed to count, so the panel can say so.
  const llmCapped =
    !untrustedHasSupport &&
    [...untrustedRed, ...untrustedYellow].some((s) => s.engine === UNTRUSTED_ENGINE);

  let verdict: Verdict;
  if (disposingRed.length > 0) {
    verdict = 'RED'; // rule 1
  } else if (untrustedRedPromoted) {
    verdict = 'RED'; // rule 2, promoted
  } else if (disposingYellow.length > 0 || (untrustedYellow.length > 0 && untrustedHasSupport)) {
    verdict = 'YELLOW'; // rule 3
  } else if (untrustedRed.length > 0 && untrustedHasSupport) {
    // rule 2, capped — an untrusted engine with deterministic support moves the
    // verdict exactly one step and no further. Unreachable while rule 2 above
    // promotes on the same condition; kept so that a future narrowing of
    // promotion cannot silently drop an untrusted RED to GREEN.
    verdict = LLM_UNSUPPORTED_CAP;
  } else if (!identityComplete || !inputUsable || uninterpretable.length > 0) {
    verdict = 'GRAY'; // rule 4 — we could not read the page, or our own input
  } else {
    verdict = 'GREEN'; // rule 4
  }

  // Reasons are ordered by what a reader needs first: what made the verdict,
  // then what else fired, then what could not be checked. Within a group,
  // signals keep the order the engines emitted them in.
  //
  // Each reason is authored once, as a catalog key plus facts, and pushed to
  // both arrays by `say()`: `reasonMsgs[i]` is what the panel renders in the
  // reader's language, `reasons[i]` is `english()` of that same message. The
  // two are index-aligned and cannot disagree, because the English is derived
  // rather than written a second time.
  const reasons: string[] = [];
  const reasonMsgs: LocalizedText[] = [];
  const say = (key: MessageKey, params?: Record<string, string | number>): void => {
    const message = msg(key, params);
    reasonMsgs.push(message);
    reasons.push(english(message));
  };

  for (const s of disposingRed) {
    say('score.reason.deterministicRed', about(s));
  }

  if (untrustedRedPromoted) {
    for (const s of untrustedRed) {
      say(engineVariant(s, 'score.reason.llmRedPromoted', 'score.reason.untrustedRedPromoted'), {
        ...about(s),
        support: formatIds(disposingFlags),
      });
    }
  }

  for (const s of disposingYellow) {
    say('score.reason.deterministicYellow', about(s));
  }

  for (const s of untrustedYellow) {
    // Only claim this made the verdict YELLOW when it actually could. Without
    // deterministic support it counted for nothing, and saying "YELLOW from
    // rule L3" above a GREEN banner would be the panel contradicting itself.
    say(
      untrustedHasSupport
        ? engineVariant(s, 'score.reason.llmYellow', 'score.reason.untrustedYellow')
        : engineVariant(
            s,
            'score.reason.llmFlaggedUncounted',
            'score.reason.untrustedFlaggedUncounted',
          ),
      about(s),
    );
  }

  if (!untrustedRedPromoted) {
    for (const s of untrustedRed) {
      say(
        engineVariant(
          s,
          'score.reason.llmProposedRedUncounted',
          'score.reason.untrustedProposedRedUncounted',
        ),
        { id: idOf(s) },
      );
    }
  }

  if (verdict === 'GREEN') {
    say('score.reason.green');
  } else if (verdict === 'GRAY') {
    say(
      !identityComplete
        ? 'score.reason.grayIdentityIncomplete'
        : 'score.reason.grayUninterpretable',
    );
  } else if (!identityComplete) {
    // Said out loud on RED and YELLOW too. The GRAY branch above already
    // carries it, but on any other verdict the incompleteness would otherwise
    // vanish from the panel entirely — and a verdict reached from half a page
    // is a different claim from one reached from all of it.
    say('score.reason.identityIncomplete');
  }

  if (unchecked.length > 0) {
    say('score.reason.couldNotCheck', { ids: formatIds(unchecked) });
  }

  if (!inputUsable) {
    say('score.reason.noSignals');
  }

  // The coverage report exists only when the caller could describe the page's
  // inputs; older callers (and old published states) simply omit it.
  const coverage = context?.inputs ? assessCoverage(context) : undefined;
  if (coverage) {
    const ran = coverage.filter((row) => row.status === 'checked').length;
    if (ran < coverage.length) {
      say('score.reason.coverage', { ran, total: coverage.length });
    }
  }

  return {
    verdict,
    signals: all,
    reasons,
    reasonMsgs,
    llmCapped,
    ...(coverage ? { coverage } : {}),
  };
}

/** Severities this module knows how to weigh; anything else is a pipeline bug. */
const KNOWN_SEVERITIES: readonly SignalSeverity[] = ['RED', 'YELLOW', 'GRAY'];

/** The signal's severity, or undefined when it is not one this module weighs. */
function severityOf(signal: Signal): SignalSeverity | undefined {
  const severity = signal?.severity;
  return KNOWN_SEVERITIES.includes(severity) ? severity : undefined;
}

/** A signal that actually fired — GRAY and uninterpretable rows are neither. */
function isFlag(signal: Signal): boolean {
  const severity = severityOf(signal);
  return severity === 'RED' || severity === 'YELLOW';
}

function isDeterministic(signal: Signal): boolean {
  return DETERMINISTIC_ENGINES.includes(signal?.engine);
}

/**
 * How an untrusted signal is named in `reasons` — as a choice between two
 * catalog keys, not as a word passed into one.
 *
 * "LLM" and "untrusted" are part of the sentence, not values in it: shipped as
 * a param they would arrive in every locale as an English word wedged into
 * translated prose, and in a cased language they would not decline with the
 * noun they modify. Two keys is what "a structurally different sentence is a
 * different key" means in practice.
 */
function engineVariant(signal: Signal, llmKey: MessageKey, untrustedKey: MessageKey): MessageKey {
  return signal?.engine === UNTRUSTED_ENGINE ? llmKey : untrustedKey;
}

/**
 * The facts every signal-quoting reason interpolates: the rule id, and the
 * signal's own one-line title.
 *
 * `title` is the one param that is prose rather than a datum, and it is here
 * because there is nowhere better for it: the sentence wraps a statement the
 * *engine* authored, so the scorer cannot key it. What it passes is the
 * English rendering, which keeps `english()` a whole sentence for the tests
 * and every non-panel consumer. The panel then refills the slot from the
 * signal's own `titleMsg` in the reader's language — `id` is how it finds the
 * signal in `result.signals` — so no English survives into a translated panel
 * and the words still live in exactly one place.
 */
function about(signal: Signal): Record<string, string> {
  return { id: idOf(signal), title: titleOf(signal) };
}

function idOf(signal: Signal): string {
  return signal?.id || '(unidentified rule)';
}

function titleOf(signal: Signal): string {
  return signal?.title || '(no description given)';
}

function formatIds(signals: Signal[]): string {
  return signals.map(idOf).join(', ');
}
