/**
 * Reading the reviews a page served: what stands out, how old it is, and how
 * small a slice of the truth it is.
 *
 * `lib/reviews.ts` states the contract and why it is narrow. This module is
 * what the panel calls, and everything it does is bounded by four measurements
 * taken on this repo's corpus (12 live fixtures, 125 featured reviews). They
 * are worth restating here, because each one killed a feature that would
 * otherwise have looked reasonable:
 *
 *  1. CURATION. The page serves ~10 reviews and picks good ones: 88% score 8
 *     or better, and the featured mean beats the property's own aggregate on 9
 *     of 12 fixtures. So this module never aggregates and never concludes. It
 *     computes that gap per page and prints it, because a shop window that
 *     admits it is a shop window is more use than a statistic.
 *
 *  2. THE WINDOW. Median review age 59 days, p90 232 days, and NOTHING in the
 *     corpus between one and two years. "It was a scam five years ago" is not
 *     observable in this data at all. So there is no recency weighting, no
 *     decay curve and no validity score: past about eight months there are no
 *     observations to fit anything to, and a curve drawn through nothing is
 *     decoration that would launder a guess into a number on screen. Ages are
 *     reported as facts and the panel states the window out loud.
 *
 *  3. KEYWORDS FIND NOTHING, AND MATCH EVERYTHING. Zero true positives in 125
 *     reviews. Worse, naive substring matching was 100% wrong: French `vol`
 *     ("theft") matched Dutch *volgende*, Italian *volta*, Spanish *Volvería*;
 *     and scanning raw HTML matched the platform's own furniture ("so our
 *     Fraud team can investigate"). Hence three hard rules below — match whole
 *     tokens, never substrings; scan extracted review text, never markup; and
 *     ship a term only if it is unambiguous in EVERY language we scan.
 *
 *  4. ELEVEN LANGUAGES. Reviews arrive in whatever language the guest browses
 *     in; English-only terms would cover 31% of the corpus. And the per-review
 *     `lang` tag is the platform's guess, not a fact. So the term list is one
 *     multilingual set applied to every review regardless of its tag — which
 *     is only safe because of rule 3's cross-language test — and `lang` is
 *     used solely to report how many reviews fell outside the terms we have.
 *
 * A match is a POINTER, never a conclusion. Every one carries the sentence it
 * was found in, verbatim, so the reader can dismiss it in two seconds. Nothing
 * here feeds the verdict (see DECISIONS.md: Engine L cannot move a verdict
 * alone, and this module is weaker evidence than Engine L).
 *
 * Pure module: no DOM, no network, no chrome.*, no clock — `now` is passed in.
 */

import type { ReviewItem, ReviewSet } from './reviews';
import { normalizeForCompare } from './text';
// Type-only, and deliberately from the catalog file itself: it makes a typo in
// a key a compile error here without dragging the merged catalog (and every
// translated locale JSON behind it) into the worker bundle. `import type` is
// erased, so this costs nothing at runtime — the same trade `lib/i18n/keys.ts`
// documents. Once `lib/i18n/en.ts` merges `reviewsMessages`, `ReviewsText`
// becomes structurally assignable to `LocalizedText` with no change here.
import type { reviewsMessages } from './i18n/en/reviews';

// ---------------------------------------------------------------------------
// message plumbing
// ---------------------------------------------------------------------------

export type ReviewsMessageKey = keyof typeof reviewsMessages;

/**
 * A sentence this module authored, as a catalog key plus the facts to fill in.
 *
 * The module returns keys, never rendered English: it runs in the worker,
 * which has no business knowing what language the panel is drawing in, and a
 * rendered string cannot be re-rendered when the reader switches language.
 * Same shape as `LocalizedText` in `lib/signals.ts` on purpose.
 */
export interface ReviewsText {
  key: ReviewsMessageKey;
  params?: Record<string, string | number>;
}

function text(key: ReviewsMessageKey, params?: Record<string, string | number>): ReviewsText {
  return params === undefined ? { key } : { key, params };
}

// ---------------------------------------------------------------------------
// what counts as low
// ---------------------------------------------------------------------------

/**
 * A review is surfaced as low-scoring at or below half of the platform's own
 * maximum — 5/10, 2.5/5 — after normalisation.
 *
 * Chosen against the corpus rather than from taste. The page's own selection
 * runs 88% at 8 or better, so a score at half the scale is not "a bit below
 * average", it is a guest refusing to endorse the place in a set the platform
 * curated to be flattering. Half-scale is also the one line that means the
 * same thing on every scale, which matters when Booking publishes out of 10
 * and Airbnb out of 5.
 *
 * It is deliberately stricter than "below average" on a 1–5 scale, whose true
 * midpoint is 3 (= 6/10): this list exists to surface clear negatives, and a
 * three-star "it was fine" is not one.
 *
 * The raw pair the platform published travels with every surfaced review and
 * is what the panel prints. 1 out of 5 and 2 out of 10 normalise to the same
 * number and are not the same claim, and the guest chose one of them.
 */
export const LOW_SCORE_MAX = 5;

// ---------------------------------------------------------------------------
// trouble terms
// ---------------------------------------------------------------------------

export type TroubleCategory = 'fraud' | 'nonexistent' | 'misrepresented';

export interface TroubleTerm {
  /**
   * The phrase, already in the folded form `normalizeForCompare` produces:
   * lowercase, no diacritics, words separated by single spaces. A test pins
   * that, so an authoring slip (a stray accent, a capital) fails the build
   * instead of silently never matching.
   */
  readonly term: string;
  readonly category: TroubleCategory;
  /**
   * Which languages the term was authored for. PROVENANCE ONLY — every term
   * is applied to every review, because the per-review language tag is the
   * platform's guess. This field is for the report and for review of the list.
   */
  readonly langs: readonly string[];
}

/**
 * The terms, and — just as important — the ones deliberately absent.
 *
 * ADMISSION RULE: a term ships only if it is unambiguous in every language
 * this list covers (en, fr, es, pt, it, de, nl, el) and in the languages we
 * knowingly cannot scan. Where a word is a normal, innocent word somewhere
 * else, it is either dropped or lengthened until the ambiguity is gone. A
 * single-token term must be at least four characters — below that, accidental
 * agreement stops being evidence, the same floor `lib/text.ts` uses.
 *
 * REFUSED, each for a specific collision:
 *  - fr `vol` (theft/flight) — Dutch *vol* means "full", and a French guest's
 *    delayed *vol* is an aeroplane. Dropped outright rather than lengthened:
 *    theft in a room is a safety complaint, not evidence about whether the
 *    listing is the property it claims to be, so nothing of value is lost.
 *  - de `betrug` — also the past tense of *betragen*: "die Rechnung betrug 200
 *    Euro" ("the bill came to 200 euros") is a price remark, not a fraud
 *    claim. Replaced by forms that cannot be read that way (`betrogen`,
 *    `betruger`, `betrugsmasche`, `abzocke`).
 *  - es `timo` — Italian *timo* is thyme, Portuguese *timo* is the thymus.
 *  - pt `golpe` — Spanish *un golpe de suerte* is a stroke of luck.
 *  - es `estafa` and pt `burla` bare — Portuguese *estafa* is exhaustion,
 *    Spanish *burla* is mockery. Kept only in longer forms where the article
 *    settles the language (`una estafa`, `uma burla`) or where no other
 *    language has the word at all (`estafador`, `estafaron`).
 *
 * NOT COVERED AT ALL, and counted so the panel can say so:
 *  - Japanese. Written without word boundaries, so the only way to match is
 *    the substring scan that was 100% wrong. 詐欺 inside a longer compound is
 *    a fair match and 詐欺 inside a platform banner is not, and this module
 *    cannot tell them apart.
 *  - Turkish. Agglutinative: the fraud stem arrives welded to its suffixes
 *    (*dolandırıcılık*, *dolandırıldık*), so token equality misses it and a
 *    stem match is a substring match by another name.
 *
 * German compounds have the same problem in miniature (*Betrugsmasche* is one
 * token) and are handled the only honest way available: ship the compounds we
 * know, accept that we miss the ones we do not.
 */
export const TROUBLE_TERMS: readonly TroubleTerm[] = [
  // --- fraud: the guest says they were defrauded ---------------------------
  { term: 'scam', category: 'fraud', langs: ['en'] },
  { term: 'scams', category: 'fraud', langs: ['en'] },
  { term: 'scammed', category: 'fraud', langs: ['en'] },
  { term: 'scammer', category: 'fraud', langs: ['en'] },
  { term: 'scammers', category: 'fraud', langs: ['en'] },
  { term: 'fraud', category: 'fraud', langs: ['en'] },
  { term: 'fraudulent', category: 'fraud', langs: ['en'] },
  { term: 'arnaque', category: 'fraud', langs: ['fr'] },
  { term: 'arnaques', category: 'fraud', langs: ['fr'] },
  { term: 'escroquerie', category: 'fraud', langs: ['fr'] },
  { term: 'escroc', category: 'fraud', langs: ['fr'] },
  { term: 'frauduleux', category: 'fraud', langs: ['fr'] },
  // A cognate shared by four of the languages we scan, with the same meaning
  // in all four — which is the good kind of collision: a mislabelled review
  // still reads correctly.
  { term: 'fraude', category: 'fraud', langs: ['fr', 'es', 'pt', 'nl'] },
  { term: 'una estafa', category: 'fraud', langs: ['es'] },
  { term: 'estafador', category: 'fraud', langs: ['es'] },
  { term: 'estafadores', category: 'fraud', langs: ['es'] },
  { term: 'estafaron', category: 'fraud', langs: ['es'] },
  { term: 'uma burla', category: 'fraud', langs: ['pt'] },
  { term: 'vigarista', category: 'fraud', langs: ['pt'] },
  { term: 'vigaristas', category: 'fraud', langs: ['pt'] },
  { term: 'estelionato', category: 'fraud', langs: ['pt'] },
  { term: 'fraudulento', category: 'fraud', langs: ['pt', 'es'] },
  { term: 'truffa', category: 'fraud', langs: ['it'] },
  { term: 'truffati', category: 'fraud', langs: ['it'] },
  { term: 'truffatore', category: 'fraud', langs: ['it'] },
  { term: 'frode', category: 'fraud', langs: ['it'] },
  { term: 'betrogen', category: 'fraud', langs: ['de'] },
  { term: 'betruger', category: 'fraud', langs: ['de'] },
  { term: 'betrugsmasche', category: 'fraud', langs: ['de'] },
  { term: 'abzocke', category: 'fraud', langs: ['de'] },
  { term: 'abgezockt', category: 'fraud', langs: ['de'] },
  { term: 'oplichting', category: 'fraud', langs: ['nl'] },
  { term: 'oplichter', category: 'fraud', langs: ['nl'] },
  { term: 'oplichters', category: 'fraud', langs: ['nl'] },
  { term: 'opgelicht', category: 'fraud', langs: ['nl'] },
  { term: 'απατη', category: 'fraud', langs: ['el'] },
  { term: 'απατης', category: 'fraud', langs: ['el'] },
  { term: 'απατες', category: 'fraud', langs: ['el'] },

  // --- nonexistent: the address, the property, or an advertised facility ---
  // Phrases, not words. "Exist" alone is a normal word everywhere; "does not
  // exist" is three tokens in a row that only line up when someone is saying
  // a thing was not there. The category message warns that WHAT was not there
  // is for the reader to decide from the quote — it is often a lift or a pool.
  { term: 'does not exist', category: 'nonexistent', langs: ['en'] },
  { term: 'did not exist', category: 'nonexistent', langs: ['en'] },
  // Apostrophes are not letters, so "doesn't" tokenises to `doesn` + `t`;
  // the term is authored the same way and matches through the same rule.
  { term: 'doesn t exist', category: 'nonexistent', langs: ['en'] },
  { term: 'didn t exist', category: 'nonexistent', langs: ['en'] },
  { term: 'never existed', category: 'nonexistent', langs: ['en'] },
  { term: 'no such address', category: 'nonexistent', langs: ['en'] },
  { term: 'existe pas', category: 'nonexistent', langs: ['fr'] },
  { term: 'existait pas', category: 'nonexistent', langs: ['fr'] },
  { term: 'no existe', category: 'nonexistent', langs: ['es'] },
  { term: 'no existia', category: 'nonexistent', langs: ['es'] },
  { term: 'nao existe', category: 'nonexistent', langs: ['pt'] },
  { term: 'nao existia', category: 'nonexistent', langs: ['pt'] },
  { term: 'non esiste', category: 'nonexistent', langs: ['it'] },
  { term: 'non esisteva', category: 'nonexistent', langs: ['it'] },
  { term: 'existiert nicht', category: 'nonexistent', langs: ['de'] },
  { term: 'existierte nicht', category: 'nonexistent', langs: ['de'] },
  { term: 'bestaat niet', category: 'nonexistent', langs: ['nl'] },
  { term: 'bestond niet', category: 'nonexistent', langs: ['nl'] },
  { term: 'δεν υπαρχει', category: 'nonexistent', langs: ['el'] },

  // --- misrepresented: what was there is not what was advertised -----------
  { term: 'not as described', category: 'misrepresented', langs: ['en'] },
  { term: 'nothing like the photos', category: 'misrepresented', langs: ['en'] },
  { term: 'nothing like the pictures', category: 'misrepresented', langs: ['en'] },
  { term: 'completely different property', category: 'misrepresented', langs: ['en'] },
  { term: 'ne correspond pas', category: 'misrepresented', langs: ['fr'] },
  { term: 'rien a voir avec les photos', category: 'misrepresented', langs: ['fr'] },
  { term: 'no se corresponde', category: 'misrepresented', langs: ['es'] },
  { term: 'nao corresponde', category: 'misrepresented', langs: ['pt'] },
  { term: 'non corrisponde', category: 'misrepresented', langs: ['it'] },
  { term: 'nicht wie beschrieben', category: 'misrepresented', langs: ['de'] },
  { term: 'niet zoals beschreven', category: 'misrepresented', langs: ['nl'] },
  { term: 'δεν ανταποκρινεται', category: 'misrepresented', langs: ['el'] },
];

/** Primary language subtags the term list covers, for the coverage count. */
export const SCANNED_LANGUAGES: ReadonlySet<string> = new Set(
  TROUBLE_TERMS.flatMap((entry) => entry.langs),
);

/** Category → the sentence that frames what a match in it does and does not mean. */
const CATEGORY_KEY: Readonly<Record<TroubleCategory, ReviewsMessageKey>> = {
  fraud: 'reviews.match.fraud',
  nonexistent: 'reviews.match.nonexistent',
  misrepresented: 'reviews.match.misrepresented',
};

// ---------------------------------------------------------------------------
// tokenisation with source offsets
// ---------------------------------------------------------------------------

/**
 * A folded word, and where it came from in the untouched source.
 *
 * The offsets are the whole point: matching happens on folded text so that
 * "Betrüger" and "betruger" are the same word, but the QUOTE has to come back
 * from the original characters. Evidence that has been lowercased and stripped
 * of its accents is no longer the guest's sentence.
 */
interface Token {
  readonly start: number;
  readonly end: number;
  readonly folded: string;
}

/** Runs of letters, digits and combining marks. Punctuation separates words. */
const WORD_RE = /[\p{L}\p{N}\p{M}]+/gu;

function tokensOf(raw: string): Token[] {
  const tokens: Token[] = [];
  for (const match of raw.matchAll(WORD_RE)) {
    const start = match.index ?? 0;
    const end = start + match[0].length;
    const folded = normalizeForCompare(match[0]);
    if (folded.length === 0) continue;
    // Folding can split one source run into several tokens (compatibility
    // decomposition turns ½ into 1⁄2, whose fraction slash is not a letter).
    // Each piece keeps the offsets of the run it came from, so a quote is
    // still cut from real characters.
    for (const piece of folded.split(' ')) {
      if (piece.length > 0) tokens.push({ start, end, folded: piece });
    }
  }
  return tokens;
}

/** The term list, tokenised once, by the same rules as the text it scans. */
const TERM_INDEX: ReadonlyArray<{ entry: TroubleTerm; tokens: readonly string[] }> =
  TROUBLE_TERMS.map((entry) => ({
    entry,
    tokens: tokensOf(entry.term).map((token) => token.folded),
  }));

/**
 * Text that still carries markup is refused rather than cleaned.
 *
 * The measured failure was a keyword scan over raw HTML matching the
 * platform's own furniture — "so our Fraud team can investigate" is Booking's
 * sentence, not a guest's, and quoting it back as evidence is worse than
 * finding nothing. Stripping tags here would paper over an extractor
 * regression; refusing the field and counting it makes the regression visible.
 */
function looksLikeMarkup(raw: string): boolean {
  return /<\s*[a-zA-Z!/]/.test(raw);
}

// ---------------------------------------------------------------------------
// quoting
// ---------------------------------------------------------------------------

/** Sentence enders across the scripts in the corpus, plus hard line breaks. */
const SENTENCE_END = /[.!?;\n\r。！？；]/;
/** Longest quote shown before it is windowed around the match. */
const MAX_QUOTE_CHARS = 220;
/** Characters kept either side of the match when a sentence is too long. */
const QUOTE_CONTEXT = 80;

function sentenceAround(
  raw: string,
  start: number,
  end: number,
): { quote: string; truncated: boolean } {
  let from = 0;
  for (let i = start - 1; i >= 0; i--) {
    if (SENTENCE_END.test(raw[i])) {
      from = i + 1;
      break;
    }
  }
  let to = raw.length;
  for (let i = end; i < raw.length; i++) {
    if (SENTENCE_END.test(raw[i])) {
      to = i + 1;
      break;
    }
  }

  const sentence = raw.slice(from, to).trim();
  if (sentence.length <= MAX_QUOTE_CHARS) return { quote: sentence, truncated: false };

  // One sentence, too long to print. Window it around the match and mark both
  // cuts, so a reader can see the quote is an excerpt rather than the whole of
  // what the guest said.
  const windowFrom = Math.max(from, start - QUOTE_CONTEXT);
  const windowTo = Math.min(to, end + QUOTE_CONTEXT);
  const head = windowFrom > from ? '…' : '';
  const tail = windowTo < to ? '…' : '';
  return { quote: `${head}${raw.slice(windowFrom, windowTo).trim()}${tail}`, truncated: true };
}

// ---------------------------------------------------------------------------
// matching
// ---------------------------------------------------------------------------

export type ReviewField = 'title' | 'positive' | 'negative';

const FIELD_KEY: Readonly<Record<ReviewField, ReviewsMessageKey>> = {
  title: 'reviews.field.title',
  positive: 'reviews.field.positive',
  negative: 'reviews.field.negative',
};

export interface TroubleMatch {
  category: TroubleCategory;
  /** The catalog term that matched, folded — the reason, not a conclusion. */
  term: string;
  /** Languages the term was authored for. Provenance; see `TroubleTerm`. */
  termLangs: readonly string[];
  /** Which half of the review it was found in. */
  field: ReviewField;
  /**
   * The guest's own sentence around the match, verbatim. Never keyed, never
   * translated, never reworded: a rewritten quote is not evidence.
   */
  quote: string;
  /** True when the sentence was too long to print whole and was windowed. */
  truncated: boolean;
  /** What a match in this category does and does not mean. */
  categoryMsg: ReviewsText;
  /** Where in the review it was found. */
  fieldMsg: ReviewsText;
}

/** Matches shown per review. More than a few is noise, not more evidence. */
const MAX_MATCHES_PER_REVIEW = 3;

function matchesInField(raw: string, field: ReviewField): TroubleMatch[] {
  const tokens = tokensOf(raw);
  const hits: Array<{ start: number; end: number; entry: TroubleTerm }> = [];

  for (const { entry, tokens: termTokens } of TERM_INDEX) {
    const length = termTokens.length;
    if (length === 0 || length > tokens.length) continue;
    for (let i = 0; i + length <= tokens.length; i++) {
      let matched = true;
      for (let j = 0; j < length; j++) {
        if (tokens[i + j].folded !== termTokens[j]) {
          matched = false;
          break;
        }
      }
      if (matched) hits.push({ start: tokens[i].start, end: tokens[i + length - 1].end, entry });
    }
  }

  // Earliest first, longest first on a tie, then drop anything overlapping a
  // hit already kept: one stretch of text is one pointer, however many terms
  // happen to cover it.
  hits.sort((a, b) => a.start - b.start || b.end - a.end);
  const kept: typeof hits = [];
  for (const hit of hits) {
    if (kept.some((other) => hit.start < other.end && other.start < hit.end)) continue;
    kept.push(hit);
  }

  return kept.map((hit) => {
    const { quote, truncated } = sentenceAround(raw, hit.start, hit.end);
    return {
      category: hit.entry.category,
      term: hit.entry.term,
      termLangs: hit.entry.langs,
      field,
      quote,
      truncated,
      categoryMsg: text(CATEGORY_KEY[hit.entry.category]),
      fieldMsg: text(FIELD_KEY[field]),
    };
  });
}

// ---------------------------------------------------------------------------
// scores and ages
// ---------------------------------------------------------------------------

/** A usable score, and the platform's own pair when that is what produced it. */
interface ScoreReading {
  /** 0–10, for comparing against the threshold and for ordering. */
  normalised: number;
  /** The published pair, present only when it was usable. For display. */
  pair?: { value: number; max: number };
}

/**
 * The score to judge by, and the numbers to print.
 *
 * Derived from the platform's own pair when there is one, because `value` and
 * `max` are the primitive facts and `score` is somebody's arithmetic on them —
 * if an adapter ever forgets to normalise a 5-point scale, deriving here reads
 * 4.5/5 as 9.0 instead of flagging a happy guest as a low scorer.
 *
 * A nonsense pair (max ≤ 0, a negative value, a value above its own maximum)
 * is neither repaired nor shown: the reading falls back to `score`, and `pair`
 * stays absent so nothing downstream can quote "-1 out of 10" at a reader as
 * though the guest had written it.
 */
function readScore(item: ReviewItem): ScoreReading | undefined {
  const raw = item.rawScore;
  if (
    raw !== undefined &&
    Number.isFinite(raw.value) &&
    Number.isFinite(raw.max) &&
    raw.max > 0 &&
    raw.value >= 0 &&
    raw.value <= raw.max
  ) {
    return { normalised: (raw.value / raw.max) * 10, pair: raw };
  }
  const score = item.score;
  if (score !== undefined && Number.isFinite(score) && score >= 0 && score <= 10) {
    return { normalised: score };
  }
  return undefined;
}

const MS_PER_DAY = 86_400_000;
const DAYS_PER_MONTH = 30.44;
const DAYS_PER_YEAR = 365.25;
/** Below this, an age is stated in days; the corpus median is 59. */
const DAYS_AS_DAYS = 60;
/**
 * Below this, an age is stated in months. A plain 365 rather than the 365.25
 * used for the arithmetic: a review a year old to the day should read "1 year
 * ago", not "12 months ago", and the quarter-day only exists to keep the
 * decimal honest once we are counting years.
 */
const DAYS_AS_MONTHS = 365;

/**
 * Whole days between a review and `now`, or nothing.
 *
 * A missing, non-finite, non-positive or FUTURE timestamp answers undefined
 * rather than a repaired number: a review dated next month is bad data, and
 * clamping it to "0 days ago" would invent the freshest possible review out of
 * the one input we know is wrong.
 */
function ageDaysOf(reviewedAt: number | undefined, now: number): number | undefined {
  if (reviewedAt === undefined || !Number.isFinite(reviewedAt) || reviewedAt <= 0) return undefined;
  const elapsed = now - reviewedAt;
  if (elapsed < 0) return undefined;
  return Math.floor(elapsed / MS_PER_DAY);
}

/** A number formatted for the English sentence; the raw twin travels beside it. */
function decimal(value: number): string {
  return value.toLocaleString('en-US', { maximumFractionDigits: 1 });
}

/**
 * An age as a short standalone phrase: days up to two months, then months,
 * then years to one decimal. No weighting is attached to it anywhere — see the
 * file header — it is a fact for the reader, printed at the coarseness the
 * data supports.
 */
export function ageText(days: number): ReviewsText {
  if (days <= 0) return text('reviews.age.dayZero', { count: 0, countValue: 0 });
  if (days < DAYS_AS_DAYS) {
    return days === 1
      ? text('reviews.age.dayOne', { count: 1, countValue: 1 })
      : text('reviews.age.dayMany', { count: days, countValue: days });
  }
  if (days < DAYS_AS_MONTHS) {
    const months = Math.round(days / DAYS_PER_MONTH);
    return months === 1
      ? text('reviews.age.monthOne', { count: 1, countValue: 1 })
      : text('reviews.age.monthMany', { count: months, countValue: months });
  }
  const years = Math.round((days / DAYS_PER_YEAR) * 10) / 10;
  return years === 1
    ? text('reviews.age.yearOne', { count: 1, countValue: 1 })
    : text('reviews.age.yearMany', { count: decimal(years), countValue: years });
}

// ---------------------------------------------------------------------------
// result
// ---------------------------------------------------------------------------

export interface FlaggedReview {
  /** Position in the served set — stable, and the only handle some pages give. */
  index: number;
  id?: string;
  /** 0–10, however the platform scaled it. For ordering, not for display. */
  score?: number;
  /** The platform's own pair. THIS is what the panel prints: 1/5 ≠ 2/10. */
  rawScore?: { value: number; max: number };
  /** True when the score sits at or below half the platform's maximum. */
  lowScore: boolean;
  /** The low-score sentence, present only when `lowScore`. */
  scoreMsg?: ReviewsText;
  reviewedAt?: number;
  /** Whole days old, absent when the page served no usable date. */
  ageDays?: number;
  /** The age as a phrase, or "date not given" when there is none. */
  ageMsg: ReviewsText;
  /** The language tag the platform declared, untouched. */
  lang?: string;
  /** False when that tag names a language the term list does not cover. */
  langScanned: boolean;
  /** Up to `MAX_MATCHES_PER_REVIEW`, each with its quote. */
  matches: TroubleMatch[];
  /** How many were found in total, so a cut list cannot pretend to be whole. */
  matchesFound: number;
}

export interface ReviewCounts {
  /** Reviews the page served and we read. */
  seen: number;
  /** Of those, how many carried any text to scan. */
  withText: number;
  withScore: number;
  withDate: number;
  lowScore: number;
  troubleMatched: number;
  /** Reviews surfaced for either reason. */
  flagged: number;
  /** Reviews whose declared language the term list does not cover. */
  uncoveredLanguage: number;
  /** Reviews the page served with no language tag at all. */
  undeclaredLanguage: number;
  /** Text fields refused because they still contained markup (extractor bug). */
  markupFields: number;
}

export interface ReviewWindow {
  /** Epoch ms of the oldest review served. */
  oldestAt: number;
  oldestAgeDays: number;
  oldestAgeMsg: ReviewsText;
  newestAt: number;
  newestAgeDays: number;
  newestAgeMsg: ReviewsText;
  /** Median age in whole days across the reviews that carried a date. */
  medianAgeDays: number;
}

export interface ReviewSample {
  /** Reviews the page actually served. */
  shown: number;
  /** Reviews the page CLAIMS exist, when it says. Usually far larger. */
  claimedTotal?: number;
  /** The page's published aggregate, 0–10. */
  aggregateScore?: number;
  /** Mean of the served scores, one decimal. The shop window's own average. */
  featuredMean?: number;
  /**
   * True when the served reviews average better than the property's own
   * aggregate — curation, measured on this page rather than assumed. It held
   * on 9 of 12 corpus fixtures; this reports which kind of page you are on.
   */
  featuredAboveAggregate?: boolean;
}

export type ReviewNoteId =
  | 'sample'
  | 'curation'
  | 'window'
  | 'noDates'
  | 'language'
  | 'nothingFlagged'
  | 'limits';

/** An honest statement about the reading, for the panel to print as-is. */
export interface ReviewNote {
  id: ReviewNoteId;
  textMsg: ReviewsText;
}

export interface ReviewScan {
  /** Reviews worth a look: a low score, a term match, or both. Ordered. */
  flagged: FlaggedReview[];
  counts: ReviewCounts;
  /** Absent when no review carried a usable date — never faked. */
  window?: ReviewWindow;
  sample: ReviewSample;
  /** What the panel must say alongside all of the above. */
  notes: ReviewNote[];
}

function primaryLang(tag: string | undefined): string | undefined {
  if (tag === undefined) return undefined;
  const primary = tag.trim().toLowerCase().split(/[-_]/)[0];
  return primary.length === 0 ? undefined : primary;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]
    : Math.round((sorted[middle - 1] + sorted[middle]) / 2);
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

/**
 * Read a served review set: what stands out, how old it is, and how little of
 * the whole it is.
 *
 * `now` is a parameter and not `Date.now()` so the module stays pure and its
 * ages are testable across month and year boundaries without mocking a clock.
 *
 * The result is facts plus catalog keys. Nothing here is rendered English and
 * nothing here is a verdict.
 */
export function scanReviews(set: ReviewSet, now: number): ReviewScan {
  const items = set.items;
  const counts: ReviewCounts = {
    seen: items.length,
    withText: 0,
    withScore: 0,
    withDate: 0,
    lowScore: 0,
    troubleMatched: 0,
    flagged: 0,
    uncoveredLanguage: 0,
    undeclaredLanguage: 0,
    markupFields: 0,
  };

  const flagged: FlaggedReview[] = [];
  const ages: number[] = [];
  const dated: Array<{ at: number; days: number }> = [];
  const scores: number[] = [];

  items.forEach((item, index) => {
    const reading = readScore(item);
    const score = reading?.normalised;
    if (score !== undefined) {
      counts.withScore += 1;
      scores.push(score);
    }

    const ageDays = ageDaysOf(item.reviewedAt, now);
    if (ageDays !== undefined && item.reviewedAt !== undefined) {
      counts.withDate += 1;
      ages.push(ageDays);
      dated.push({ at: item.reviewedAt, days: ageDays });
    }

    const lang = primaryLang(item.lang);
    const langScanned = lang !== undefined && SCANNED_LANGUAGES.has(lang);
    if (lang === undefined) counts.undeclaredLanguage += 1;
    else if (!langScanned) counts.uncoveredLanguage += 1;

    const fields: Array<[ReviewField, string | undefined]> = [
      ['title', item.title],
      ['positive', item.positive],
      ['negative', item.negative],
    ];
    let hasText = false;
    const matches: TroubleMatch[] = [];
    for (const [field, raw] of fields) {
      if (raw === undefined || raw.trim().length === 0) continue;
      hasText = true;
      if (looksLikeMarkup(raw)) {
        counts.markupFields += 1;
        continue;
      }
      matches.push(...matchesInField(raw, field));
    }
    if (hasText) counts.withText += 1;

    const lowScore = score !== undefined && score <= LOW_SCORE_MAX;
    if (lowScore) counts.lowScore += 1;
    if (matches.length > 0) counts.troubleMatched += 1;
    if (!lowScore && matches.length === 0) return;

    // The sentence quotes the scale the guest actually used. With no usable
    // published pair it falls back to the normalised scale and says "out of
    // 10", so it never implies a scale we did not see.
    const shown =
      reading?.pair ?? (score === undefined ? undefined : { value: round1(score), max: 10 });

    flagged.push({
      index,
      ...(item.id === undefined ? {} : { id: item.id }),
      ...(score === undefined ? {} : { score: round1(score) }),
      ...(reading?.pair === undefined ? {} : { rawScore: reading.pair }),
      lowScore,
      ...(lowScore && shown !== undefined
        ? {
            scoreMsg: text('reviews.reason.lowScore', {
              score: decimal(shown.value),
              scoreValue: shown.value,
              max: shown.max,
            }),
          }
        : {}),
      ...(item.reviewedAt === undefined || ageDays === undefined
        ? {}
        : { reviewedAt: item.reviewedAt, ageDays }),
      ageMsg: ageDays === undefined ? text('reviews.age.unknown') : ageText(ageDays),
      ...(item.lang === undefined ? {} : { lang: item.lang }),
      langScanned,
      matches: matches.slice(0, MAX_MATCHES_PER_REVIEW),
      matchesFound: matches.length,
    });
  });

  counts.flagged = flagged.length;

  // Term matches first (a pointer at a sentence beats a bare number), then the
  // worst score, then the most recent, then page order. Fully deterministic:
  // a panel that reorders between two runs on the same page looks broken.
  flagged.sort((a, b) => {
    if ((b.matchesFound > 0 ? 1 : 0) !== (a.matchesFound > 0 ? 1 : 0)) {
      return (b.matchesFound > 0 ? 1 : 0) - (a.matchesFound > 0 ? 1 : 0);
    }
    const scoreA = a.score ?? Number.POSITIVE_INFINITY;
    const scoreB = b.score ?? Number.POSITIVE_INFINITY;
    if (scoreA !== scoreB) return scoreA - scoreB;
    const ageA = a.ageDays ?? Number.POSITIVE_INFINITY;
    const ageB = b.ageDays ?? Number.POSITIVE_INFINITY;
    if (ageA !== ageB) return ageA - ageB;
    return a.index - b.index;
  });

  const sample: ReviewSample = { shown: items.length };
  const total = set.summary?.total;
  if (total !== undefined && Number.isFinite(total) && total >= 0) sample.claimedTotal = total;
  const aggregate = set.summary?.score;
  const hasAggregate =
    aggregate !== undefined && Number.isFinite(aggregate) && aggregate >= 0 && aggregate <= 10;
  if (hasAggregate) sample.aggregateScore = aggregate;
  if (scores.length > 0) {
    const mean = round1(scores.reduce((sum, value) => sum + value, 0) / scores.length);
    sample.featuredMean = mean;
    if (hasAggregate) sample.featuredAboveAggregate = mean > aggregate;
  }

  let window: ReviewWindow | undefined;
  if (dated.length > 0) {
    const oldest = dated.reduce((worst, entry) => (entry.days > worst.days ? entry : worst));
    const newest = dated.reduce((best, entry) => (entry.days < best.days ? entry : best));
    window = {
      oldestAt: oldest.at,
      oldestAgeDays: oldest.days,
      oldestAgeMsg: ageText(oldest.days),
      newestAt: newest.at,
      newestAgeDays: newest.days,
      newestAgeMsg: ageText(newest.days),
      medianAgeDays: median(ages),
    };
  }

  return {
    flagged,
    counts,
    ...(window === undefined ? {} : { window }),
    sample,
    notes: buildNotes(counts, sample, window),
  };
}

function buildNotes(
  counts: ReviewCounts,
  sample: ReviewSample,
  window: ReviewWindow | undefined,
): ReviewNote[] {
  const notes: ReviewNote[] = [];

  if (counts.seen === 0) {
    notes.push({ id: 'sample', textMsg: text('reviews.sample.none') });
    notes.push({ id: 'limits', textMsg: text('reviews.limits.advisory') });
    return notes;
  }

  notes.push({
    id: 'sample',
    textMsg:
      sample.claimedTotal === undefined
        ? text('reviews.sample.totalUnknown', { shown: sample.shown })
        : text('reviews.sample.ofTotal', {
            shown: sample.shown,
            total: sample.claimedTotal.toLocaleString('en-US'),
            totalValue: sample.claimedTotal,
          }),
  });

  if (
    sample.featuredAboveAggregate === true &&
    sample.featuredMean !== undefined &&
    sample.aggregateScore !== undefined
  ) {
    notes.push({
      id: 'curation',
      textMsg: text('reviews.curation.featuredHigher', {
        featured: decimal(sample.featuredMean),
        featuredValue: sample.featuredMean,
        overall: decimal(sample.aggregateScore),
        overallValue: sample.aggregateScore,
      }),
    });
  }

  notes.push(
    window === undefined
      ? { id: 'noDates', textMsg: text('reviews.window.noDates') }
      : { id: 'window', textMsg: text('reviews.window.oldest') },
  );

  if (counts.uncoveredLanguage > 0) {
    notes.push({
      id: 'language',
      textMsg:
        counts.uncoveredLanguage === 1
          ? text('reviews.language.uncoveredOne')
          : text('reviews.language.uncoveredMany', { count: counts.uncoveredLanguage }),
    });
  }

  if (counts.flagged === 0) {
    notes.push({ id: 'nothingFlagged', textMsg: text('reviews.none.flagged') });
  }

  notes.push({ id: 'limits', textMsg: text('reviews.limits.advisory') });
  return notes;
}
