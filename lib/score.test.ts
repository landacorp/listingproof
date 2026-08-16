import { describe, expect, it } from 'vitest';
import {
  LLM_UNSUPPORTED_CAP,
  MIN_DETERMINISTIC_SUPPORT_FOR_LLM_RED,
  DETERMINISTIC_ENGINES,
  score,
  type ScoreContext,
} from './score';
import { en } from './i18n/en';
import { english } from './msg';
import type { Signal, Verdict } from './signals';

// Signal literals, built by hand — the scorer must be testable without any
// engine present, and a test that borrows an engine's output would silently
// track that engine's bugs.

/** A2: median distance to the page's own "nearby" attractions is absurd. */
const A2_RED: Signal = {
  id: 'A2',
  engine: 'A',
  severity: 'RED',
  title: 'Claimed address is 437 km from the attractions this page calls nearby',
  detail: 'Median distance over 6 geocoded POIs vs the geocoded address.',
};

/** A1: slug and displayed name share no tokens. */
const A1_RED: Signal = {
  id: 'A1',
  engine: 'A',
  severity: 'RED',
  title: 'URL slug and displayed name have nothing in common',
  detail: 'Token overlap 0.00 between the fossilized slug and the current name.',
};

/** A3: breadcrumb city disagrees with the JSON-LD coordinates. */
const A3_YELLOW: Signal = {
  id: 'A3',
  engine: 'A',
  severity: 'YELLOW',
  title: 'Breadcrumb city does not match the published coordinates',
  detail: 'Breadcrumb says Rimini; coordinates land in Riccione.',
};

/** A1 on a thin slug: weak overlap, reported but not asserted as a hijack. */
const A1_YELLOW: Signal = {
  id: 'A1',
  engine: 'A',
  severity: 'YELLOW',
  title: 'URL slug and displayed name barely overlap',
  detail: 'The slug is two tokens long, so the comparison carries little weight.',
};

/** An Engine A check that could not run at all. */
const A2_GRAY: Signal = {
  id: 'A2',
  engine: 'A',
  severity: 'GRAY',
  title: 'Could not geocode the claimed address',
  detail: 'Nominatim returned no result; the POI comparison was skipped.',
};

/** A second unrunnable Engine A check, for the "two GRAYs" cases. */
const A3_GRAY: Signal = {
  id: 'A3',
  engine: 'A',
  severity: 'GRAY',
  title: 'The page carried no breadcrumb trail',
  detail: 'Nothing to compare the published coordinates against.',
};

const L2_RED: Signal = {
  id: 'L2',
  engine: 'L',
  severity: 'RED',
  title: 'Reviews describe a different property than the listing claims',
  detail: 'Judge found 4 contradictions between claimed identity and review text.',
};

const L3_RED: Signal = {
  id: 'L3',
  engine: 'L',
  severity: 'RED',
  title: 'Amenity bundle is economically impossible for this location',
  detail: 'Free airport shuttle + spa + free private parking as a central-Paris B&B.',
};

const L2_YELLOW: Signal = {
  id: 'L2',
  engine: 'L',
  severity: 'YELLOW',
  title: 'Reviews hint at a different property type',
  detail: 'Two of eight snippets mention apartments; the listing claims a hotel.',
};

const L1_GRAY: Signal = {
  id: 'L1',
  engine: 'L',
  severity: 'GRAY',
  title: 'Local model unreachable, semantic checks skipped',
  detail: 'localhost:11434 refused the connection.',
};

const COMPLETE: ScoreContext = { identityComplete: true };
const INCOMPLETE: ScoreContext = { identityComplete: false };

describe('score — precedence table', () => {
  // Exhaustive over {no deterministic signal, GRAY, YELLOW, RED} ×
  // {no LLM signal, GRAY, YELLOW, RED}, evaluated under both values of
  // identityComplete. The last two columns are the point of the table: in every
  // cell where a *deterministic* rule fired, identityComplete is irrelevant —
  // rules 1–3 all outrank rule 4. It decides every other cell, including every
  // cell where Engine L fired alone: an untrusted signal with nothing
  // deterministic behind it counts for nothing, so each of those rows reads
  // exactly like the row above it with the LLM column emptied.
  it.each<[string, Signal[], Signal[], Verdict, Verdict, boolean]>([
    // [name, deterministic, llm, verdict when complete, when incomplete, llmCapped]
    ['nothing at all', [], [], 'GREEN', 'GRAY', false],
    ['LLM GRAY only', [], [L1_GRAY], 'GREEN', 'GRAY', false],
    // Rule 2: an uncorroborated untrusted flag is advisory, not a proposal the
    // scorer weighs — the verdict is identical to 'nothing at all'. llmCapped
    // is how the panel says the model spoke and was not counted.
    ['LLM YELLOW only', [], [L2_YELLOW], 'GREEN', 'GRAY', true],
    ['LLM RED only', [], [L2_RED], 'GREEN', 'GRAY', true],

    ['deterministic GRAY only', [A2_GRAY], [], 'GREEN', 'GRAY', false],
    ['deterministic GRAY + LLM GRAY', [A2_GRAY], [L1_GRAY], 'GREEN', 'GRAY', false],
    // A deterministic check that could not run is not support, so these two
    // rows are the two LLM-only rows again: nothing deterministic fired.
    ['deterministic GRAY + LLM YELLOW', [A2_GRAY], [L2_YELLOW], 'GREEN', 'GRAY', true],
    ['deterministic GRAY + LLM RED', [A2_GRAY], [L2_RED], 'GREEN', 'GRAY', true],

    ['deterministic YELLOW only', [A3_YELLOW], [], 'YELLOW', 'YELLOW', false],
    ['deterministic YELLOW + LLM GRAY', [A3_YELLOW], [L1_GRAY], 'YELLOW', 'YELLOW', false],
    ['deterministic YELLOW + LLM YELLOW', [A3_YELLOW], [L2_YELLOW], 'YELLOW', 'YELLOW', false],
    // Rule 2: promotion. One deterministic YELLOW is enough support.
    ['deterministic YELLOW + LLM RED', [A3_YELLOW], [L2_RED], 'RED', 'RED', false],

    ['deterministic RED only', [A2_RED], [], 'RED', 'RED', false],
    ['deterministic RED + LLM GRAY', [A2_RED], [L1_GRAY], 'RED', 'RED', false],
    ['deterministic RED + LLM YELLOW', [A2_RED], [L2_YELLOW], 'RED', 'RED', false],
    ['deterministic RED + LLM RED', [A2_RED], [L2_RED], 'RED', 'RED', false],
  ])('%s', (_name, det, llm, whenComplete, whenIncomplete, llmCapped) => {
    const signals = [...det, ...llm];
    expect(score(signals, COMPLETE).verdict).toBe(whenComplete);
    expect(score(signals, INCOMPLETE).verdict).toBe(whenIncomplete);
    expect(score(signals, COMPLETE).llmCapped).toBe(llmCapped);
    expect(score(signals, INCOMPLETE).llmCapped).toBe(llmCapped);
  });
});

describe('score — Engine A is the only deterministic engine left', () => {
  // The archive comparison (Engine B) has been removed from the product. What
  // that costs is real and is asserted below; what it must NOT cost is the
  // prompt-injection bound, so the trusted set is pinned here rather than left
  // to whatever a stale message happens to claim.

  it('trusts Engine A and nothing else', () => {
    expect([...DETERMINISTIC_ENGINES]).toEqual(['A']);
  });

  it('treats a stale Engine B signal as untrusted, not as trusted by inertia', () => {
    // An evicted worker's old published state, or a client that has not caught
    // up, can still carry a `B.*` row. It must be weighed like any other
    // unrecognised source: on its own it moves nothing.
    const stale = { ...A2_RED, id: 'B.geo', engine: 'B' } as unknown as Signal;
    expect(score([stale], COMPLETE).verdict).toBe('GREEN');
    // …and it is not silently dropped either — the row and its disclosure both
    // survive, because an ignored RED is a false GREEN.
    const result = score([stale], COMPLETE);
    expect(result.signals).toEqual([stale]);
    expect(result.reasons.some((r) => r.includes('B.geo') && r.includes('untrusted'))).toBe(true);
  });

  it('does not let a stale Engine B row corroborate an Engine L RED', () => {
    const stale = { ...A3_YELLOW, id: 'B.name', engine: 'B' } as unknown as Signal;
    const result = score([stale, L2_RED], COMPLETE);
    expect(result.verdict).not.toBe('RED');
    expect(result.verdict).toBe('GREEN');
    expect(result.llmCapped).toBe(true);
  });
});

describe('score — rule 1: a deterministic RED is final', () => {
  it.each<[string, Signal[]]>([
    ['A1', [A1_RED]],
    ['A2', [A2_RED]],
    ['both rules at once', [A1_RED, A2_RED]],
  ])('%s alone sets RED', (_name, signals) => {
    expect(score(signals, COMPLETE).verdict).toBe('RED');
  });

  it('outranks rule 4 — a deterministic RED stands even when identity is incomplete', () => {
    // Reading enough of the page to prove a hijack is not the same as reading
    // all of it. A partial read that finds a RED is still a RED.
    expect(score([A2_RED], INCOMPLETE).verdict).toBe('RED');
  });
});

describe('score — rule 2: Engine L proposes, the scorer disposes', () => {
  // The rule in one sentence: an untrusted signal counts for nothing unless a
  // deterministic rule independently fired. Not "counts for less" — for
  // nothing. Engine L reads the description *and the guest reviews*, and
  // reviews are written by strangers, so any verdict Engine L can reach alone
  // is a verdict a stranger can inflict on an honest hotel by writing one. That
  // is why an uncorroborated L finding is not capped to YELLOW but discarded
  // from the arithmetic entirely, and why PLAN.md M6 ("the injection corpus
  // must never flip a verdict") is only literally true under this rule.

  it('an L-only RED leaves the verdict exactly where it was, and sets llmCapped', () => {
    // The verdict must equal the one this listing gets with the L row absent.
    // With nothing else in the input, that is GREEN — not YELLOW. A YELLOW here
    // would be the reputation attack described above, delivered.
    const result = score([L2_RED], COMPLETE);
    expect(result.verdict).toBe(score([], COMPLETE).verdict);
    expect(result.verdict).toBe('GREEN');
    expect(result.llmCapped).toBe(true);
    // Uncounted is not unseen: the row still reaches the evidence table and the
    // reasons, so the panel can show what the model said and that it was not
    // acted on.
    expect(result.signals).toEqual([L2_RED]);
    expect(result.reasons.some((r) => r.includes('L2'))).toBe(true);
  });

  it('the same L RED does promote once a deterministic flag fired independently', () => {
    // The sibling of the case above, and the whole reason Engine L is not
    // decorative. Support need not be RED: a deterministic YELLOW is exactly
    // the case where the machine-checkable rules saw something they could not
    // adjudicate alone, which is where a semantic reading adds information.
    const result = score([A3_YELLOW, L2_RED], COMPLETE);
    expect(result.verdict).toBe('RED');
    expect(result.llmCapped).toBe(false);
    // And it really is the L row doing the work here — without it, YELLOW.
    expect(score([A3_YELLOW], COMPLETE).verdict).toBe('YELLOW');
  });

  it('ignores an entire Engine L flood — volume is not corroboration', () => {
    // The injection-corpus shape: a page that talks the model into firing
    // everything it has. Three untrusted rows are still zero deterministic
    // rows, and the answer is the answer the model-off run would have given.
    const result = score([L2_RED, L3_RED, L2_YELLOW], COMPLETE);
    expect(result.verdict).toBe(score([], COMPLETE).verdict);
    expect(result.verdict).toBe('GREEN');
    expect(result.llmCapped).toBe(true);
  });

  it('promotes an L RED when a deterministic RED is present (verdict was RED regardless)', () => {
    const result = score([A2_RED, L2_RED], COMPLETE);
    expect(result.verdict).toBe('RED');
    expect(result.llmCapped).toBe(false);
  });

  it('does not promote on deterministic GRAY — a check that could not run is not support', () => {
    // Two GRAYs are two rules that produced no evidence, so the L RED stands
    // uncorroborated and contributes nothing.
    const result = score([A2_GRAY, A3_GRAY, L2_RED], COMPLETE);
    expect(result.verdict).toBe('GREEN');
    expect(result.llmCapped).toBe(true);
  });

  it('does not promote on another L signal — L cannot corroborate L', () => {
    // One untrusted source speaking twice is one untrusted source. Neither row
    // counts, so the pair moves the verdict by nothing at all.
    const result = score([L2_YELLOW, L3_RED], COMPLETE);
    expect(result.verdict).toBe('GREEN');
    expect(result.llmCapped).toBe(true);
  });

  it('sets llmCapped for an uncounted L YELLOW too, not only an uncounted L RED', () => {
    // llmCapped means "Engine L flagged and we did not count it". A discarded
    // YELLOW is exactly as much of a withheld finding as a discarded RED, and
    // the L rows sitting in the evidence table would otherwise read as rows
    // that were weighed.
    const result = score([L2_YELLOW, L1_GRAY], COMPLETE);
    expect(result.llmCapped).toBe(true);
    expect(result.verdict).toBe('GREEN');
  });

  it('leaves llmCapped false when Engine L was counted, or had nothing to say', () => {
    // Engine L reported only that it could not run — nothing was set aside.
    expect(score([L1_GRAY], COMPLETE).llmCapped).toBe(false);
    // Engine L was silent altogether.
    expect(score([A2_RED], COMPLETE).llmCapped).toBe(false);
    expect(score([], COMPLETE).llmCapped).toBe(false);
    // Engine L flagged *and had support*, so it counted. False whether or not
    // it changed the answer: the promoted RED below did change it, the YELLOW
    // below did not, and neither was withheld.
    expect(score([A3_YELLOW, L2_RED], COMPLETE).llmCapped).toBe(false);
    expect(score([A3_YELLOW, L2_YELLOW], COMPLETE).llmCapped).toBe(false);
  });

  it('takes exactly MIN_DETERMINISTIC_SUPPORT_FOR_LLM_RED standing flags before L counts', () => {
    // Pins the constant to the behaviour: one fewer flag than the threshold and
    // the L RED moves nothing; exactly the threshold and it promotes to RED.
    expect(MIN_DETERMINISTIC_SUPPORT_FOR_LLM_RED).toBe(1);
    expect(score([L2_RED], COMPLETE).verdict).toBe('GREEN');
    expect(score([A3_YELLOW, L2_RED], COMPLETE).verdict).toBe('RED');
  });
});

describe('score — rule 3: anything left over that is YELLOW', () => {
  it.each<[string, Signal[]]>([
    ['a single deterministic YELLOW', [A3_YELLOW]],
    ['two deterministic YELLOWs', [A3_YELLOW, A1_YELLOW]],
    // An untrusted YELLOW reaches rule 3 only in deterministic company; on its
    // own it is not a proposal the scorer weighs at all (next case).
    ['an LLM YELLOW alongside a deterministic one', [A3_YELLOW, L2_YELLOW]],
    ['YELLOWs mixed with GRAYs', [A3_YELLOW, A2_GRAY, L1_GRAY]],
  ])('%s → YELLOW', (_name, signals) => {
    expect(score(signals, COMPLETE).verdict).toBe('YELLOW');
  });

  it('a lone LLM YELLOW does not reach rule 3 at all', () => {
    // Rule 3 collects "any remaining YELLOW *proposal*", and an uncorroborated
    // untrusted row is not one. This is the case the injection corpus attacks:
    // a planted review is the cheapest way to make a model say something, so a
    // YELLOW reachable from review text alone is a YELLOW anyone can buy.
    const result = score([L2_YELLOW], COMPLETE);
    expect(result.verdict).toBe('GREEN');
    expect(result.llmCapped).toBe(true);
  });

  it('never adds YELLOWs up into a RED, however many of them fire', () => {
    // There is no escalation rule left. The archive engine owned the only one
    // (a rename plus a second mutation), and with it gone the sole route from
    // YELLOW to RED is an Engine L RED that a deterministic flag corroborates.
    // Two deterministic YELLOWs are still one YELLOW verdict.
    expect(score([A3_YELLOW, A1_YELLOW], COMPLETE).verdict).toBe('YELLOW');
    expect(score([A3_YELLOW, A1_YELLOW, L2_YELLOW], COMPLETE).verdict).toBe('YELLOW');
  });
});

describe('score — rule 4: GRAY is first-class, and never a pass', () => {
  it('empty input with a complete identity is GREEN', () => {
    expect(score([], COMPLETE).verdict).toBe('GREEN');
  });

  it('empty input with an incomplete identity is GRAY, not GREEN', () => {
    expect(score([], INCOMPLETE).verdict).toBe('GRAY');
  });

  it('GRAY-only input does not beat GREEN when the identity was complete', () => {
    // An unrunnable check is not a flag. The verdict stays GREEN, but the
    // reasons must not let it pass unmentioned — asserted below.
    const result = score([A2_GRAY, A3_GRAY, L1_GRAY], COMPLETE);
    expect(result.verdict).toBe('GREEN');
  });

  it('GRAY-only input with an incomplete identity is GRAY', () => {
    expect(score([A2_GRAY, A3_GRAY, L1_GRAY], INCOMPLETE).verdict).toBe('GRAY');
  });
});

describe('score — returned signals', () => {
  it('returns every input signal, GRAY included, in order', () => {
    const input = [A2_GRAY, A3_YELLOW, L1_GRAY, A1_YELLOW];
    const result = score(input, COMPLETE);
    expect(result.signals).toEqual(input);
    expect(result.signals.map((s) => s.id)).toEqual(['A2', 'A3', 'L1', 'A1']);
  });

  it('returns a copy, and does not mutate the caller array', () => {
    const input = [A3_YELLOW, A2_GRAY];
    const result = score(input, COMPLETE);
    expect(result.signals).not.toBe(input);
    result.signals.push(A2_RED);
    expect(input).toHaveLength(2);
  });

  it('returns an empty signal list for an empty input', () => {
    expect(score([], COMPLETE).signals).toEqual([]);
  });
});

describe('score — reasons', () => {
  it('orders reasons by what drove the verdict, then support, then gaps', () => {
    // One of everything the scorer can still say: a deterministic RED, a
    // promoted LLM RED, a leftover deterministic YELLOW, and an unrunnable check.
    const result = score([A2_RED, A1_YELLOW, L2_RED, L1_GRAY], COMPLETE);

    expect(result.verdict).toBe('RED');
    expect(result.reasons).toHaveLength(4);
    expect(result.reasons[0]).toMatch(/^RED from deterministic rule A2:/);
    expect(result.reasons[1]).toMatch(/^RED from LLM rule L2:/);
    expect(result.reasons[1]).toContain('promoted');
    expect(result.reasons[2]).toMatch(/^YELLOW from deterministic rule A1:/);
    expect(result.reasons[3]).toContain('Could not check: L1');
  });

  it('names the driving rule first for a plain deterministic RED', () => {
    const result = score([A1_RED], COMPLETE);
    expect(result.reasons[0]).toContain('A1');
    expect(result.reasons[0]).toContain('RED');
  });

  it('reports both uncounted LLM proposals, then the verdict, then the gaps', () => {
    // A deterministic YELLOW can never coexist with an uncounted L row — it
    // would be support, and the L rows would count — so nothing here fired that
    // the scorer weighs, and the verdict is the model-off one. Both L rows are
    // still named, strongest first, before the verdict line; the check that
    // could not run comes last, because a gap is the least urgent thing a
    // reader needs.
    const capped = score([A2_GRAY, L2_YELLOW, L3_RED], COMPLETE);
    expect(capped.verdict).toBe('GREEN');
    expect(capped.llmCapped).toBe(true);
    expect(capped.reasons).toHaveLength(4);
    // An uncounted L row must not open "YELLOW from …" above a GREEN banner —
    // that is the panel contradicting itself. It says what it is instead.
    expect(capped.reasons[0]).toMatch(/^L2 \(LLM\) flagged:/);
    expect(capped.reasons[0]).toContain('noted, not counted');
    expect(capped.reasons[1]).toMatch(/^L3 \(LLM\) proposed RED/);
    expect(capped.reasons[2]).toContain('GREEN');
    expect(capped.reasons[3]).toContain('Could not check: A2');
  });

  it('explains an uncounted L RED in words, not just in the llmCapped flag', () => {
    const result = score([L2_RED], COMPLETE);
    // The verdict did not move, so the words are the only place a reader learns
    // that a semantic check screamed and was disregarded.
    expect(result.verdict).toBe('GREEN');
    expect(result.reasons[0]).toContain('L2');
    expect(result.reasons[0]).toContain('no deterministic rule to corroborate');
    expect(result.reasons[0]).toContain('Page text alone cannot move the verdict');
    // And it must not describe itself as capped at YELLOW: under the current
    // contract an uncorroborated L RED is discarded, not held one step down.
    expect(result.reasons[0]).toContain('noted, not counted');
    expect(result.reasons[0]).not.toContain(`capped at ${LLM_UNSUPPORTED_CAP}`);
  });

  it('states the GREEN case plainly, and claims no more than it checked', () => {
    const result = score([], COMPLETE);
    expect(result.reasons[0]).toContain('GREEN');
    expect(result.reasons).toHaveLength(1);
    // GREEN is "every rule that could run passed" — never a claim that this
    // listing was compared against its own past. Nothing in this product does
    // that any more, so no reason may imply it.
    expect(result.reasons[0]).toMatch(/every rule that could run passed/);
  });

  it('never claims a history comparison happened, on any verdict', () => {
    // The one wording regression that would matter after the archive engine was
    // removed: a sentence left behind that still talks about captures, archives
    // or a listing's own history would be the panel asserting a check that no
    // longer exists. ("corroborate" is deliberately not in this list — Engine L
    // corroboration is about deterministic rules, not about the past.)
    const banned = /archiv|snapshot|capture|wayback|\bhistory\b|its own past/i;
    const inputs: Signal[][] = [[], [A2_RED], [A3_YELLOW], [L2_RED], [A2_GRAY, L1_GRAY]];
    for (const signals of inputs) {
      for (const context of [COMPLETE, INCOMPLETE]) {
        for (const reason of score(signals, context).reasons) {
          expect(reason, reason).not.toMatch(banned);
        }
      }
    }
    // …and the catalog this module draws from carries no such sentence either,
    // so a key that is not emitted today cannot be revived tomorrow with the
    // old claim still inside it.
    for (const [key, text] of Object.entries(en)) {
      if (!key.startsWith('score.')) continue;
      expect(text, `${key}: ${text}`).not.toMatch(banned);
    }
  });

  it('states the GRAY case as "not checked", not "clean"', () => {
    const result = score([], INCOMPLETE);
    expect(result.reasons[0]).toContain('GRAY');
    expect(result.reasons[0]).toContain('not checked');
  });

  it('always names GRAY signals even when the verdict is GREEN', () => {
    const result = score([A2_GRAY, L1_GRAY], COMPLETE);
    expect(result.verdict).toBe('GREEN');
    const gapLine = result.reasons.find((r) => r.startsWith('Could not check:'));
    expect(gapLine).toBeDefined();
    expect(gapLine).toContain('A2');
    expect(gapLine).toContain('L1');
  });

  it('discloses an incomplete identity on a RED or YELLOW too, not only on GRAY', () => {
    // Rules 1–3 outrank rule 4, so a partial page read can still produce a
    // verdict — but the reader must not be shown a confident-looking RED with
    // no hint that half the fields were missing. The severity of the finding
    // and the completeness of the evidence are separate facts.
    // [A3_YELLOW, L2_RED] rather than [L2_RED]: an L RED on its own does not
    // produce a verdict of its own, so it cannot exercise this rule — see the
    // case below for where it lands instead.
    for (const signals of [[A2_RED], [A3_YELLOW], [A3_YELLOW, L2_RED], [A1_YELLOW]]) {
      const result = score(signals, INCOMPLETE);
      expect(result.verdict).not.toBe('GRAY');
      expect(result.reasons.some((r) => /incomplete/i.test(r))).toBe(true);
    }
  });

  it('discloses it on the GRAY an uncounted LLM flag leaves behind, too', () => {
    // An L-only input scores as an empty one, so on an incomplete identity it
    // lands on GRAY — "we could not check", which is the honest answer when the
    // only thing that fired was a source we do not act on. The incompleteness
    // is carried by the GRAY line itself rather than the separate disclosure.
    const result = score([L2_RED], INCOMPLETE);
    expect(result.verdict).toBe('GRAY');
    expect(result.llmCapped).toBe(true);
    expect(result.reasons.some((r) => /incomplete/i.test(r))).toBe(true);
    expect(result.reasons.some((r) => r.includes('L2'))).toBe(true);
  });

  it('does not claim an incomplete identity when the identity was complete', () => {
    for (const signals of [[], [A2_RED], [A3_YELLOW], [L2_RED]]) {
      expect(score(signals, COMPLETE).reasons.some((r) => /incomplete/i.test(r))).toBe(false);
    }
  });
});

describe('score — degrades instead of throwing, and always downward', () => {
  // The scorer runs in the background worker on values that crossed a
  // runtime.sendMessage boundary, where the type checker's guarantees end. Each
  // case below is malformed input; every one of them must land on GRAY, because
  // the only outcome worse than an unhelpful verdict is a reassuring wrong one.

  it('treats a signal whose severity it cannot read as unchecked, not as clean', () => {
    const garbled = { ...A3_YELLOW, severity: 'critical' } as unknown as Signal;
    const result = score([garbled], COMPLETE);
    expect(result.verdict).toBe('GRAY');
    expect(result.reasons.some((r) => r.startsWith('Could not check:'))).toBe(true);
    expect(result.signals).toEqual([garbled]);
  });

  it('never lets an unreadable severity count as a flag', () => {
    // The subtler half: a "severity" of nonsense must not slip through a
    // `severity !== 'GRAY'` test and become the support that lets an untrusted
    // signal count.
    const garbled = { ...A3_YELLOW, severity: 'sev1' } as unknown as Signal;
    // Not support. The L RED therefore counts for nothing, and the verdict is
    // the one the garbled row produces alone — GRAY, because a severity this
    // module cannot weigh means the pipeline is broken, and broken is never
    // GREEN. (It is not YELLOW either: nothing the scorer trusts proposed one.)
    expect(score([garbled], COMPLETE).verdict).toBe('GRAY');
    expect(score([garbled, L2_RED], COMPLETE).verdict).toBe('GRAY');
    expect(score([garbled, L2_RED], COMPLETE).llmCapped).toBe(true);
  });

  it('treats an unrecognised engine as untrusted, not as deterministic', () => {
    // An engine name this module does not know arrives over the message
    // boundary. It must be weighed like Engine L, not like Engine A — so on its
    // own it moves nothing, exactly as an L RED moves nothing.
    const alien = { ...A2_RED, engine: 'X' } as unknown as Signal;
    const result = score([alien], COMPLETE);
    expect(result.verdict).toBe(score([], COMPLETE).verdict);
    expect(result.verdict).toBe('GREEN');
    // …but it is not Engine L, so the L-specific contract flag stays honest:
    // llmCapped is a statement about the local model, not about untrusted input
    // in general, and the panel must not attribute this row to the model.
    expect(result.llmCapped).toBe(false);
    // Which leaves `reasons` as the *only* channel still carrying this row. The
    // verdict did not move and llmCapped stayed down, so if the sentence goes
    // too, a RED from an engine we simply have not heard of has been discarded
    // in silence and the panel renders a clean GREEN over it — the "an ignored
    // RED is a false GREEN" failure this module's own header warns about. The
    // Engine L cases have llmCapped as a second channel; this one does not, so
    // the disclosure is asserted here rather than assumed.
    expect(result.signals).toEqual([alien]);
    // 'A2' because the alien row is a copy of A2_RED wearing an unknown engine;
    // 'untrusted' rather than 'LLM' because it is not the local model.
    expect(result.reasons.some((r) => r.startsWith('A2 (untrusted) proposed RED'))).toBe(true);
  });

  it('does not make an unrecognised engine invisible either — it promotes on support', () => {
    // The other half of "untrusted, not ignored". Given the deterministic
    // support an L RED would need, an unknown engine's RED promotes exactly as
    // an L RED does; dropping such a signal instead would be a false GREEN over
    // a real finding from an engine this module simply has not heard of.
    const alien = { ...A2_RED, engine: 'X' } as unknown as Signal;
    const supported = score([A3_YELLOW, alien], COMPLETE);
    expect(supported.verdict).toBe('RED');
    expect(supported.llmCapped).toBe(false);
    // Named as "untrusted" rather than "LLM" — it is not Engine L.
    expect(supported.reasons.some((r) => r.startsWith('RED from untrusted rule A2:'))).toBe(true);
  });

  it('does not accept an unrecognised engine as deterministic support', () => {
    const alien = { ...A3_YELLOW, engine: 'X' } as unknown as Signal;
    // Two untrusted rows are still zero deterministic rows: neither counts, so
    // the pair scores as an empty input. In particular the alien YELLOW does
    // not promote the L RED, which is the failure this guards against.
    const both = score([alien, L2_RED], COMPLETE);
    expect(both.verdict).not.toBe('RED');
    expect(both.verdict).toBe('GREEN');
    // Engine L still spoke and was still not counted, so the flag is set even
    // though the other uncounted row belongs to some other engine.
    expect(both.llmCapped).toBe(true);
    // Both discarded rows are still named — the alien YELLOW under the neutral
    // "untrusted" label, the L RED under "LLM". Uncounted is not unsaid, and for
    // the alien row these words are the whole of its disclosure.
    expect(both.reasons.some((r) => r.includes('A3') && r.includes('untrusted'))).toBe(true);
    expect(both.reasons.some((r) => r.includes('L2') && r.includes('LLM'))).toBe(true);
  });

  it('answers GRAY when handed something that is not a list of signals', () => {
    for (const bad of [undefined, null, 'RED', 42, { length: 3 }]) {
      const result = score(bad as unknown as Signal[], COMPLETE);
      expect(result.verdict).toBe('GRAY');
      expect(result.signals).toEqual([]);
      expect(result.reasons.length).toBeGreaterThan(0);
    }
  });

  it('answers GRAY when handed no context at all', () => {
    for (const bad of [undefined, null, {}, { identityComplete: 'yes' }]) {
      const result = score([], bad as unknown as ScoreContext);
      expect(result.verdict).toBe('GRAY');
      expect(result.reasons.length).toBeGreaterThan(0);
    }
  });

  it('still reports a deterministic RED when the context is missing', () => {
    // Degrading must not silence real evidence, only refuse to bless it.
    expect(score([A2_RED], undefined as unknown as ScoreContext).verdict).toBe('RED');
  });

  it('never returns a verdict with no reason at all, however malformed the input', () => {
    const inputs: unknown[] = [[], [A2_RED], [A1_YELLOW], [L2_RED], [A2_GRAY], undefined, 'x'];
    const contexts: unknown[] = [COMPLETE, INCOMPLETE, undefined, {}];
    for (const signals of inputs) {
      for (const ctx of contexts) {
        const result = score(signals as Signal[], ctx as ScoreContext);
        expect(result.reasons.length).toBeGreaterThan(0);
        expect(['RED', 'YELLOW', 'GREEN', 'GRAY']).toContain(result.verdict);
      }
    }
  });
});

describe('score — invariants over every combination', () => {
  // Power set of a pool covering each engine × severity that matters, crossed
  // with both contexts: 2^8 × 2 = 512 cases. The table above pins the intended
  // answers; this pins the properties that must hold no matter what an engine —
  // or an attacker-authored page driving Engine L — emits.
  const POOL: Signal[] = [
    A2_RED,
    A3_YELLOW,
    A1_YELLOW,
    A2_GRAY,
    A3_GRAY,
    L2_RED,
    L2_YELLOW,
    L1_GRAY,
  ];

  /**
   * Deterministic flags that are still standing: Engine A, actually fired. This
   * is the set the Engine L rule turns on — untrusted signals count if and only
   * if it is non-empty — so the invariants below are written against it.
   *
   * Spelled out from the literal 'A' rather than imported from the module: an
   * invariant that moves when the implementation moves proves nothing.
   */
  const standingDeterministic = (set: Signal[]): Signal[] =>
    set.filter((s) => s.engine === 'A' && (s.severity === 'RED' || s.severity === 'YELLOW'));

  const CONTEXTS: ScoreContext[] = [{ identityComplete: true }, { identityComplete: false }];

  const cases: Array<{ signals: Signal[]; context: ScoreContext }> = [];
  for (let mask = 0; mask < 1 << POOL.length; mask += 1) {
    const signals = POOL.filter((_, i) => (mask & (1 << i)) !== 0);
    for (const context of CONTEXTS) cases.push({ signals, context });
  }

  it('never produces RED without standing deterministic evidence behind it', () => {
    // The prompt-injection bound. If this ever fails, page text has been given
    // the power to set the strongest verdict the tool can render. The bound is
    // asserted against a literal, not against the module's own constant: an
    // invariant that moves when the implementation moves proves nothing.
    for (const { signals, context } of cases) {
      const result = score(signals, context);
      if (result.verdict !== 'RED') continue;
      expect(standingDeterministic(signals).length).toBeGreaterThan(0);
    }
  });

  it('never lets an untrusted signal be the difference between YELLOW and RED', () => {
    // Engine L may corroborate a RED it proposed itself (rule 2). What it must
    // never do is tip a verdict it did not propose: strip every L signal that
    // is not itself a RED proposal and each RED must survive unchanged.
    for (const { signals, context } of cases) {
      const result = score(signals, context);
      if (result.verdict !== 'RED') continue;
      const withoutHearsay = signals.filter((s) => s.engine !== 'L' || s.severity === 'RED');
      expect(score(withoutHearsay, context).verdict).toBe('RED');
    }
  });

  it('drops untrusted signals out of the verdict entirely when nothing deterministic fired', () => {
    // The rule as a property over the whole power set: with no standing Engine A
    // flag, deleting every untrusted row leaves the verdict untouched — not
    // lowered by a step, untouched. Reviews are third-party text; if this ever
    // fails, a stranger who plants one can move the verdict on a listing whose
    // owner did nothing wrong, which is PLAN.md M6's injection corpus working
    // as an attack rather than failing as one.
    for (const { signals, context } of cases) {
      if (standingDeterministic(signals).length > 0) continue;
      const withoutUntrusted = signals.filter((s) => s.engine !== 'L');
      expect(score(signals, context).verdict).toBe(score(withoutUntrusted, context).verdict);
    }
  });

  it('reports every untrusted flag in reasons, counted or not', () => {
    // The counterweight to the invariant above, and the difference between
    // "counts for nothing" and "is dropped". Once an uncounted flag leaves the
    // verdict untouched, `reasons` is the only place a reader learns the model
    // spoke at all — and for an untrusted engine that is not L, llmCapped does
    // not light up either, so it is the only place, full stop.
    for (const { signals, context } of cases) {
      const result = score(signals, context);
      const untrustedFlags = signals.filter(
        (s) => s.engine !== 'A' && (s.severity === 'RED' || s.severity === 'YELLOW'),
      );
      for (const s of untrustedFlags) {
        // Anchored on the id *and* the engine label, so the "Could not check:"
        // line — which lists ids too — cannot satisfy this by accident.
        const label = s.engine === 'L' ? 'LLM' : 'untrusted';
        expect(result.reasons.some((r) => r.includes(s.id) && r.includes(label))).toBe(true);
      }
      // One line per proposal, not one line per id: L2 appears in the pool at
      // two severities, and a per-id check alone would let the RED line stand in
      // for a dropped YELLOW one. Only untrusted rows are labelled this way, so
      // nothing else in `reasons` inflates the count.
      const labelled = result.reasons.filter((r) => r.includes('LLM') || r.includes('untrusted'));
      expect(labelled.length).toBeGreaterThanOrEqual(untrustedFlags.length);
    }
  });

  it('never lets an untrusted YELLOW be the marginal vote, in either direction', () => {
    // Stronger than the rule requires, and worth pinning because it falls out
    // of it. An untrusted YELLOW counts only when support exists — but support
    // *is* a standing deterministic RED or YELLOW, and either of those already
    // carries the verdict to at least YELLOW on its own. So there is nowhere in
    // the power set where an untrusted YELLOW changes the answer: deleting
    // every one of them is always a no-op. Only an untrusted RED (rule 2) can
    // ever move a verdict, and only upward from a flag someone else raised.
    for (const { signals, context } of cases) {
      const withoutHearsay = signals.filter((s) => s.engine !== 'L' || s.severity !== 'YELLOW');
      expect(score(withoutHearsay, context).verdict).toBe(score(signals, context).verdict);
    }
  });

  it('scores an Engine-L-only input exactly as it would score an empty one', () => {
    // PLAN.md M6 in its literal form: the injection corpus must never flip a
    // verdict. Not "never flips it to RED" — never flips it. Whatever a page
    // talks the local model into saying, the answer is the answer this listing
    // would have got with the model switched off, in every context.
    for (const context of CONTEXTS) {
      const modelOff = score([], context).verdict;
      for (const llmOnly of [
        [L2_RED],
        [L2_YELLOW],
        [L2_RED, L2_YELLOW],
        [L2_RED, L3_RED, L1_GRAY],
        [L1_GRAY],
      ]) {
        const result = score(llmOnly, context);
        expect(result.verdict).toBe(modelOff);
        expect(result.verdict).not.toBe('RED');
      }
    }
  });

  it('only reports llmCapped when Engine L flagged and nothing deterministic did', () => {
    // llmCapped is the panel's licence to say "the local model saw something we
    // did not count". Both halves of that sentence have to be true: Engine L
    // must have raised a flag, and there must have been no standing
    // deterministic flag — because with one, Engine L was counted, not capped.
    for (const { signals, context } of cases) {
      const result = score(signals, context);
      if (!result.llmCapped) continue;
      expect(signals.some((s) => s.engine === 'L' && s.severity !== 'GRAY')).toBe(true);
      expect(standingDeterministic(signals)).toHaveLength(0);
    }
  });

  it('reports llmCapped in exactly those cases and no others', () => {
    // The converse of the above, so the flag cannot go quietly missing. It is
    // not tied to a YELLOW verdict — an uncounted L flag usually leaves GREEN or
    // GRAY behind — nor to Engine L proposing RED specifically: a discarded
    // YELLOW is just as much a finding the user was not shown.
    for (const { signals, context } of cases) {
      const llmFlagged = signals.some(
        (s) => s.engine === 'L' && (s.severity === 'RED' || s.severity === 'YELLOW'),
      );
      const uncounted = llmFlagged && standingDeterministic(signals).length === 0;
      expect(score(signals, context).llmCapped).toBe(uncounted);
    }
  });

  it('never returns GREEN while any deterministic signal proposed RED or YELLOW', () => {
    // The dangerous direction for a trust tool: something looked wrong and the
    // panel said "verified". The bound covers Engine A only, deliberately —
    // GREEN alongside an uncounted Engine L flag is the point of the rule, not
    // a hole in it, and llmCapped is how the panel discloses it. What must
    // never happen is GREEN over a machine-checkable flag.
    for (const { signals, context } of cases) {
      const result = score(signals, context);
      if (result.verdict !== 'GREEN') continue;
      expect(signals.every((s) => s.engine === 'L' || s.severity === 'GRAY')).toBe(true);
      expect(context.identityComplete).toBe(true);
    }
  });

  it('never returns GREEN on an incomplete identity', () => {
    for (const { signals, context } of cases) {
      if (context.identityComplete) continue;
      expect(score(signals, context).verdict).not.toBe('GREEN');
    }
  });

  it('carries every input signal through, and names every GRAY one', () => {
    for (const { signals, context } of cases) {
      const result = score(signals, context);
      expect(result.signals).toEqual(signals);
      const grays = signals.filter((s) => s.severity === 'GRAY');
      if (grays.length === 0) continue;
      const gapLine = result.reasons.find((r) => r.startsWith('Could not check:'));
      expect(gapLine).toBeDefined();
      for (const g of grays) expect(gapLine).toContain(g.id);
    }
  });

  it('discloses an incomplete identity on every verdict, not just GRAY', () => {
    for (const { signals, context } of cases) {
      const result = score(signals, context);
      // Anchored on the two lines that carry the disclosure, so a signal title
      // that happens to contain the word cannot satisfy this by accident.
      const disclosed = result.reasons.some(
        (r) =>
          r.startsWith('Identity incomplete:') || r.includes('the live identity was incomplete'),
      );
      expect(disclosed).toBe(!context.identityComplete);
    }
  });

  it('is a pure function of its inputs', () => {
    for (const { signals, context } of cases) {
      const before = JSON.stringify(signals);
      const first = score(signals, context);
      const second = score(signals, context);
      expect(second).toEqual(first);
      expect(JSON.stringify(signals)).toBe(before);
    }
  });
});

// ---------------------------------------------------------------------------
// Coverage — which checks ran, and why the rest could not (ROADMAP P0-3)
// ---------------------------------------------------------------------------

import { assessCoverage } from './score';

const FULL_INPUTS = {
  hasSlug: true,
  poiCount: 4,
  breadcrumbCount: 3,
  hasCoordinates: true,
  hasAddress: true,
} as const;

const BOOKING_CAPS = { nameBearingUrl: true, destinationId: true, nearbyLandmarks: true } as const;
const AIRBNB_CAPS = { nameBearingUrl: false, destinationId: false, nearbyLandmarks: true } as const;

function coverageById(context: ScoreContext) {
  return Object.fromEntries(assessCoverage(context).map((check) => [check.id, check]));
}

describe('coverage assessment', () => {
  it('reports every check as run on a fully-equipped page', () => {
    const checks = assessCoverage({
      identityComplete: true,
      capabilities: BOOKING_CAPS,
      inputs: { ...FULL_INPUTS },
    });
    expect(checks).toHaveLength(3);
    expect(checks.every((check) => check.status === 'checked')).toBe(true);
  });

  it('covers the deterministic rules and nothing that no longer runs', () => {
    // With the archive comparison gone, the coverage report speaks for Engine A
    // and only Engine A. A row for a check the product does not perform would
    // be worse than no row: it would pad the "n of m checks ran" fraction the
    // panel shows with a check nobody runs.
    const ids = assessCoverage({
      identityComplete: true,
      capabilities: BOOKING_CAPS,
      inputs: { ...FULL_INPUTS },
    }).map((check) => check.id);
    expect(ids).toEqual(['A1', 'A2', 'A3']);
  });

  it("A1 is 'not applicable' where the platform's URLs carry no name — the Airbnb case", () => {
    const byId = coverageById({
      identityComplete: true,
      capabilities: AIRBNB_CAPS,
      inputs: { ...FULL_INPUTS, hasSlug: false },
    });
    expect(byId.A1!.status).toBe('not-applicable');
  });

  it("A1 without capabilities but without a slug is 'no data', not 'not applicable'", () => {
    const byId = coverageById({
      identityComplete: true,
      inputs: { ...FULL_INPUTS, hasSlug: false },
    });
    expect(byId.A1!.status).toBe('no-data');
  });

  it("A2 distinguishes a platform that never lists landmarks from a page that didn't", () => {
    const noLandmarkPlatform = coverageById({
      identityComplete: true,
      capabilities: { ...BOOKING_CAPS, nearbyLandmarks: false },
      inputs: { ...FULL_INPUTS, poiCount: 0 },
    });
    expect(noLandmarkPlatform.A2!.status).toBe('not-applicable');

    const pageWithout = coverageById({
      identityComplete: true,
      capabilities: BOOKING_CAPS,
      inputs: { ...FULL_INPUTS, poiCount: 0 },
    });
    expect(pageWithout.A2!.status).toBe('no-data');
  });

  it('A3 needs both breadcrumbs and coordinates', () => {
    const noCrumbs = coverageById({
      identityComplete: true,
      inputs: { ...FULL_INPUTS, breadcrumbCount: 0 },
    });
    expect(noCrumbs.A3!.status).toBe('no-data');

    const noCoords = coverageById({
      identityComplete: true,
      inputs: { ...FULL_INPUTS, hasCoordinates: false },
    });
    expect(noCoords.A3!.status).toBe('no-data');
  });
});

describe('coverage in the score result', () => {
  it('travels on the result when inputs were described', () => {
    const result = score([], {
      identityComplete: true,
      capabilities: BOOKING_CAPS,
      inputs: { ...FULL_INPUTS },
    });
    expect(result.verdict).toBe('GREEN');
    expect(result.coverage).toHaveLength(3);
    // Everything ran — no coverage caveat needed in the reasons.
    expect(result.reasons.join(' ')).not.toContain('Coverage:');
  });

  it('is absent for callers that did not describe their inputs', () => {
    const result = score([], { identityComplete: true });
    expect(result.coverage).toBeUndefined();
  });

  it('a GREEN reached with checks skipped says so in the reasons', () => {
    const result = score([], {
      identityComplete: true,
      capabilities: AIRBNB_CAPS,
      inputs: { ...FULL_INPUTS, hasSlug: false, breadcrumbCount: 0 },
    });
    expect(result.verdict).toBe('GREEN');
    const coverageReason = result.reasons.find((reason) => reason.startsWith('Coverage:'));
    // Only A2 could run: A1 is platform-inapplicable and A3 had no breadcrumbs.
    expect(coverageReason).toContain('1 of 3 checks ran');
  });

  it('a GREEN on a page where nothing could be checked still says so', () => {
    // The failure this report exists to prevent: with only three checks left,
    // a page that supplies none of their inputs would otherwise render the same
    // confident GREEN as a fully-checked one.
    const result = score([], {
      identityComplete: true,
      capabilities: BOOKING_CAPS,
      inputs: { hasSlug: false, poiCount: 0, breadcrumbCount: 0, hasCoordinates: false, hasAddress: false },
    });
    expect(result.verdict).toBe('GREEN');
    expect(result.reasons.find((reason) => reason.startsWith('Coverage:'))).toContain(
      '0 of 3 checks ran',
    );
    expect(result.coverage?.every((row) => row.status !== 'checked')).toBe(true);
  });
});

/**
 * Every sentence this module produces is authored as a catalog key plus facts,
 * and its English is *derived* from that key. These tests pin the derivation
 * rather than the words: the assertions above already fix the English, so what
 * is left to prove is that a translated panel says the same thing — which it
 * can only do if no reason and no coverage row carries prose the catalog does
 * not know about.
 */
describe('every sentence is translatable', () => {
  const alienRed = { ...A2_RED, engine: 'X' } as unknown as Signal;
  const alienYellow = { ...A3_YELLOW, engine: 'X' } as unknown as Signal;
  const garbled = { ...A3_YELLOW, severity: 'critical' } as unknown as Signal;

  /** The contexts and signal sets exercised elsewhere in this file, together. */
  const cases: Array<[Signal[], ScoreContext]> = [
    [[A2_RED, A1_YELLOW, L2_RED, L1_GRAY], COMPLETE],
    [[A3_YELLOW, L2_YELLOW], COMPLETE],
    [[L2_RED, L2_YELLOW], COMPLETE],
    [[alienRed, alienYellow], COMPLETE],
    [[A3_YELLOW, alienRed, alienYellow], COMPLETE],
    [[garbled], COMPLETE],
    [[A1_RED], INCOMPLETE],
    [[], COMPLETE],
    [[], INCOMPLETE],
    [
      [A3_YELLOW],
      {
        identityComplete: true,
        capabilities: AIRBNB_CAPS,
        inputs: { ...FULL_INPUTS, hasSlug: false, breadcrumbCount: 0 },
      },
    ],
    [undefined as never, undefined as never],
  ];

  it('pairs every reason with a catalog message that renders it', () => {
    for (const [signals, context] of cases) {
      const result = score(signals, context);
      expect(result.reasonMsgs).toHaveLength(result.reasons.length);
      result.reasonMsgs?.forEach((message, i) => {
        // A key the catalog lacks renders as the key itself, so this asserts
        // both that the key exists and that the English is derived from it.
        expect(en[message.key as keyof typeof en], `${message.key} not in en catalog`).toBeDefined();
        expect(english(message)).toBe(result.reasons[i]);
      });
    }
  });

  it('leaves no {slot} unfilled — a param the catalog wants must be supplied', () => {
    for (const [signals, context] of cases) {
      for (const reason of score(signals, context).reasons) {
        expect(reason, `unfilled slot in: ${reason}`).not.toMatch(/\{\w+\}/);
      }
    }
  });

  it('derives every coverage label and detail from the catalog too', () => {
    for (const [signals, context] of cases) {
      for (const check of score(signals, context).coverage ?? []) {
        expect(check.labelMsg).toBeDefined();
        expect(english(check.labelMsg!)).toBe(check.label);
        expect(en[check.labelMsg!.key as keyof typeof en]).toBeDefined();
        // A label is composed with a status word the panel translates itself,
        // so it must stay a standalone noun phrase — no trailing punctuation.
        expect(check.label).not.toMatch(/[.:;—-]$/);
        if (check.detail !== undefined) {
          expect(check.detailMsg).toBeDefined();
          expect(english(check.detailMsg!)).toBe(check.detail);
          expect(en[check.detailMsg!.key as keyof typeof en]).toBeDefined();
        } else {
          expect(check.detailMsg).toBeUndefined();
        }
      }
    }
  });

  it('never smuggles a verdict word through a param', () => {
    // A verdict word is part of the sentence that reports it, not a value in
    // it: shipped as a param it would render in English in every locale, and
    // in a cased language it would not decline with what it qualifies.
    const verdictWords = ['RED', 'YELLOW', 'GRAY', 'GREEN'];
    for (const [signals, context] of cases) {
      for (const message of score(signals, context).reasonMsgs ?? []) {
        for (const [name, value] of Object.entries(message.params ?? {})) {
          expect(verdictWords, `${message.key}.${name}`).not.toContain(String(value));
        }
      }
    }
  });

  it('never smuggles a whole sentence through a param', () => {
    // Params carry facts — ids, counts, a signal's own title. A param holding
    // a built sentence would be English no locale could ever replace.
    for (const [signals, context] of cases) {
      for (const message of score(signals, context).reasonMsgs ?? []) {
        for (const [name, value] of Object.entries(message.params ?? {})) {
          if (name === 'title') continue; // the engine's own line, refilled by the panel
          expect(String(value), `${message.key}.${name}`).not.toMatch(/[.!?] |—/);
        }
      }
    }
  });
});
