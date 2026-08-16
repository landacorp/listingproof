import { describe, expect, it } from 'vitest';
import {
  discriminatingTokenCount,
  nameSimilarity,
  normalizeForCompare,
  slugTokens,
  tokenize,
  tokenOverlap,
} from './text';

/**
 * Thresholds are asserted, not assumed. These constants are the contract
 * between this module and Engine A1 / Engine B: if a folding rule regresses,
 * a real fixture pair crosses one of them and this file fails.
 */

/**
 * Every legitimate slug/name pair in fixtures/live/ must score at least this.
 * The worst honest pair in the corpus is `hotelbellevue_rimini` vs "Hotel
 * Bellevue by OasiGroup Hotels" at exactly 0.50 — the name grew a brand suffix
 * the slug predates. A1's RED threshold must sit strictly below this.
 */
const LEGIT_MIN = 0.5;

/**
 * The one real in-the-wild hijack in the corpus scores 0.00 (nothing in
 * "Paris Eiffel Residence" is explained by an Alpine slug). Allowing 0.05
 * leaves room for float dust without letting a partial match through.
 */
const HIJACK_MAX = 0.05;

/**
 * A legitimate rename keeps a recognizable core: "Hotel Ibis Paris Nord" →
 * "ibis Paris Nord 18eme" scores 0.70. The weakest legitimate case measured
 * here is a short name gaining a long brand suffix ("Hotel Bellevue" → "Hotel
 * Bellevue by OasiGroup Hotels", 0.565), because Dice is length-sensitive.
 * Engine B's rule fires *below* its threshold, so the threshold has to clear
 * that floor — 0.55 asserted here, ~0.45 recommended for B.
 *
 * Note the margin: 0.565 against a 0.55 floor is 1.5 points, thinner than
 * anything else in this file. That is a real property of Dice on short names,
 * not slack in the test, and it is why B's threshold is recommended at 0.45
 * rather than at the midpoint of the measured spread.
 */
const RENAME_MIN = 0.55;

/**
 * An identity swap shares only incidental letter pairs: the alpine → Paris
 * hijack scores 0.256. Anything at or below 0.35 is "different property".
 */
const SWAP_MAX = 0.35;

// ---------------------------------------------------------------------------

describe('normalizeForCompare', () => {
  it.each([
    ['lowercases', 'Strand Palace', 'strand palace'],
    ['strips combining diacritics', 'Hôtel Le Régent Paris', 'hotel le regent paris'],
    ['strips Spanish accents', 'Catalonia La Boquería', 'catalonia la boqueria'],
    ['strips Greek accents', 'Ξενοδοχείο Ηλέκτρα', 'ξενοδοχειο ηλεκτρα'],
    ['leaves unaccented Cyrillic alone', 'Гостиница Москва', 'гостиница москва'],
    // NFD does not touch these code points, but Booking's slugifier does.
    ['folds German sharp s', 'Straße des 17. Juni', 'strasse des 17 juni'],
    ['folds Polish crossed l', 'Hotel Bałtyk', 'hotel baltyk'],
    ['folds Danish slashed o', 'Ørnen Hotell', 'ornen hotell'],
    ['folds ligatures', 'Cœur & Æsir', 'coeur aesir'],
    // Stroke and accent on the same letter: only folding *after* decomposition
    // reaches the stroke, since NFKD leaves ǿ as ø + accent.
    ['folds a stroke carrying an accent', 'Ǿrnen Hotell', 'ornen hotell'],
    // NFKD of ϒ (U+03D2) produces an UPPERCASE Υ from lowercase input; without
    // the second lowercasing pass this would never match its own slug.
    ['lowercases what decomposition uppercases', 'ϒhotel', 'υhotel'],
    // Japanese pages carry full-width Latin and half-width katakana.
    ['folds full-width Latin', 'ＴＯＫＹＵ', 'tokyu'],
    ['folds half-width katakana', 'ﾎﾃﾙ', 'ホテル'],
    // The voicing mark decomposes out of the half-width form and has to
    // recompose, or this spelling would not match the full-width one.
    ['recomposes half-width voicing marks', 'ﾎﾞ', 'ボ'],
    // Vowel signs are spacing marks, not letters, so a \p{L}\p{N} filter would
    // turn each one into a space and shatter the word into fragments the
    // tokenizer then discards as single characters.
    ['keeps vowel signs attached to their letter', 'होटल राज', 'होटल राज'],
    ['collapses punctuation to single spaces', "L'Horizon des Alpes", 'l horizon des alpes'],
    ['collapses runs of punctuation', 'NH Collection — Flower Market', 'nh collection flower market'],
    ['collapses and trims whitespace', '  NH \t Collection\nAmsterdam  ', 'nh collection amsterdam'],
    ['keeps digits', 'ibis Paris Nord 18eme', 'ibis paris nord 18eme'],
    ['empty string stays empty', '', ''],
    ['whitespace only becomes empty', '   \t ', ''],
    ['punctuation only becomes empty', '--- / ---', ''],
  ])('%s', (_name, input, expected) => {
    expect(normalizeForCompare(input)).toBe(expected);
  });

  it('is insensitive to the input normal form', () => {
    // "Hotel" with a circumflex, typed as precomposed U+00F4 and as o + U+0302.
    // Written as escapes because the two spellings are indistinguishable on
    // screen, and the expected value is spelled out — comparing the two
    // results to each other would also pass for a function returning a
    // constant.
    const precomposed = 'H\u00F4tel';
    const decomposed = 'Ho\u0302tel';
    expect(precomposed).not.toBe(decomposed);
    expect(normalizeForCompare(precomposed)).toBe('hotel');
    expect(normalizeForCompare(decomposed)).toBe('hotel');
  });

  it.each([
    // Marks outside the Latin/Greek/Cyrillic diacritic block are part of the
    // spelling, not decoration. Stripping all of \p{M} collapses each of these
    // pairs into one string — two different properties reported as the same
    // one, which is the single error this tool exists to prevent.
    ['Japanese voicing marks', 'ホテルハト', 'ホテルバト'],
    ['Devanagari vowel signs', 'होटल राज', 'हटल रज'],
  ])('keeps %s, so two different names stay different', (_name, a, b) => {
    expect(normalizeForCompare(a)).not.toBe(normalizeForCompare(b));
    expect(nameSimilarity(a, b)).toBeLessThan(1);
  });

  it.each([
    ['a Latin name with diacritics and punctuation', 'Hôtel  Le Régent — Paris'],
    ['half-width katakana with a voicing mark', 'ﾎﾞ'],
    ['Devanagari', 'होटल राज'],
    ['Hangul', '서울호텔'],
    ['full-width Latin', 'ＴＯＫＹＵ'],
  ])('is idempotent for %s', (_name, input) => {
    // Values are folded more than once downstream (tokenize normalizes, and so
    // does the defensive pass inside tokenOverlap), so a second application has
    // to be a no-op or a score would depend on how often a value was folded.
    const once = normalizeForCompare(input);
    expect(normalizeForCompare(once)).toBe(once);
  });
});

// ---------------------------------------------------------------------------

describe('tokenize', () => {
  it.each([
    ['plain Latin name', 'Strand Palace', ['strand', 'palace']],
    ['folds diacritics', 'Catalonia La Boquería', ['catalonia', 'la', 'boqueria']],
    // The orphaned "l" of L'Horizon is noise on both sides of the comparison.
    ['drops single characters', "L'Horizon des Alpes", ['horizon', 'des', 'alpes']],
    ['drops pure numbers', 'Hotel 2000', ['hotel']],
    ['keeps alphanumeric tokens', 'ibis Paris Nord 18eme', ['ibis', 'paris', 'nord', '18eme']],
    // "B&B" survives only as two single letters, which the drop rule removes —
    // otherwise every listing would share a token with every other.
    ['reduces B&B to nothing', 'B&B Hotel Milano', ['hotel', 'milano']],
    ['keeps two-letter brand tokens', 'NH Collection Amsterdam', ['nh', 'collection', 'amsterdam']],
    // A Greek property whose displayed name Booking writes in Latin — the
    // common case, and the only one the slug can ever match.
    ['Latin name of a Greek property', 'Electra Metropolis', ['electra', 'metropolis']],
    ['Greek script is not shredded', 'Ξενοδοχείο Ηλέκτρα', ['ξενοδοχειο', 'ηλεκτρα']],
    ['Cyrillic script is not shredded', 'Гостиница Москва', ['гостиница', 'москва']],
    // Japanese has no spaces: the kanji/kana boundary is the only split we get.
    ['splits Japanese at script boundaries', '渋谷エクセルホテル東急', ['渋谷', 'エクセルホテル', '東急']],
    ['drops single-character particles', 'ホテルの東京', ['ホテル', '東京']],
    // Each syllable is a letter plus a spacing mark; dropping the marks would
    // leave two-fragment debris instead of two words.
    ['keeps a Devanagari word in one piece', 'होटल राज', ['होटल', 'राज']],
    ['empty string yields no tokens', '', []],
    ['punctuation only yields no tokens', ' -- , -- ', []],
  ])('%s', (_name, input, expected) => {
    expect(tokenize(input)).toEqual(expected);
  });
});

// ---------------------------------------------------------------------------

describe('slugTokens', () => {
  it.each([
    ['hyphen separated', 'the-warwick-new-york', ['the', 'warwick', 'new', 'york']],
    ['underscore separated', 'hotelbellevue_rimini', ['hotelbellevue', 'rimini']],
    ['single concatenated token', 'strandpalace', ['strandpalace']],
    ['concatenated brand plus location', 'nhcollection-amsterdam-flower-market',
      ['nhcollection', 'amsterdam', 'flower', 'market']],
    // Booking slugifies the HTML-escaped name, so the apostrophe of L'Horizon
    // arrives as the bare digits of `&#39;`. Both "l" and "39" must vanish.
    ['drops the "39" apostrophe artefact', 'l-39-horizon-des-alpes-le-petit-bornand-les-glieres',
      ['horizon', 'des', 'alpes', 'le', 'petit', 'bornand', 'les', 'glieres']],
    ['empty slug yields no tokens', '', []],
  ])('%s', (_name, slug, expected) => {
    expect(slugTokens(slug)).toEqual(expected);
  });

  it('drops every purely numeric segment', () => {
    expect(slugTokens('hotel-39-2024-milano')).toEqual(['hotel', 'milano']);
  });
});

// ---------------------------------------------------------------------------

/**
 * The real corpus: every (slug, displayed name) pair in fixtures/live/,
 * transcribed from fixtures/live/manifest.json and the ground truth in
 * lib/extract.test.ts. These are the numbers Engine A1's threshold is tuned
 * against, so each expected score is spelled out rather than only bounded.
 */
const LEGIT_CORPUS: ReadonlyArray<readonly [string, string, string, number]> = [
  ['de', 'schulz-berlin-wall-at-the-east-side-gallery',
    'Schulz Hotel Berlin Wall at the East Side Gallery', 1],
  ['es', 'catalonia-la-boqueria', 'Catalonia La Boquería', 1],
  ['fr', 'le-regent-paris', 'Hôtel Le Regent Paris', 1],
  // Concatenated slug, spaced name — the single biggest false-positive risk.
  ['gb', 'strandpalace', 'Strand Palace', 1],
  ['gr', 'electra-metropolis', 'Electra Metropolis', 1],
  // "hotel" must not count against the score in either direction.
  ['it', 'grand-rimini', 'Grand Hotel Rimini', 1],
  // Name grew a brand suffix ("by OasiGroup Hotels") the slug predates;
  // "bellevue" is only reachable through the hotel+bellevue concatenation.
  ['it', 'hotelbellevue_rimini', 'Hotel Bellevue by OasiGroup Hotels', 1 / 2],
  ['jp', 'shibuya-excel-tokyu', 'Shibuya Excel Hotel Tokyu', 1],
  ['nl', 'nhcollection-amsterdam-flower-market', 'NH Collection Amsterdam Flower Market', 1],
  // Name carries city + descriptor the slug never had.
  ['pt', 'corpo-santo', 'Corpo Santo Lisbon Historical Hotel', 2 / 3],
  ['us', 'the-warwick-new-york', 'Warwick New York', 1],
];

/** The in-the-wild hijack candidate: Alpine slug, central-Paris identity. */
const HIJACK_SLUG = 'l-39-horizon-des-alpes-le-petit-bornand-les-glieres';
const HIJACK_NAME = 'Paris Eiffel Residence';

describe('tokenOverlap on the live fixture corpus', () => {
  it.each(LEGIT_CORPUS)('%s/%s explains its name', (_cc, slug, name, expected) => {
    const score = tokenOverlap(slugTokens(slug), tokenize(name));
    expect(score).toBeCloseTo(expected, 5);
    expect(score).toBeGreaterThanOrEqual(LEGIT_MIN);
  });

  it('scores the real hijack at zero', () => {
    const score = tokenOverlap(slugTokens(HIJACK_SLUG), tokenize(HIJACK_NAME));
    expect(score).toBe(0);
    expect(score).toBeLessThanOrEqual(HIJACK_MAX);
  });

  it('separates the hijack from every legitimate pair by a wide margin', () => {
    const legit = LEGIT_CORPUS.map(([, slug, name]) => tokenOverlap(slugTokens(slug), tokenize(name)));
    const hijack = tokenOverlap(slugTokens(HIJACK_SLUG), tokenize(HIJACK_NAME));
    expect(Math.min(...legit) - hijack).toBeGreaterThanOrEqual(LEGIT_MIN - HIJACK_MAX);
  });
});

describe('tokenOverlap matching rules', () => {
  it.each([
    // [name, slugTokens, nameTokens, expected]
    ['a slug token equal to two joined name tokens credits both',
      ['strandpalace'], ['strand', 'palace'], 1],
    ['joining works mid-slug too',
      ['nhcollection', 'amsterdam'], ['nh', 'collection', 'amsterdam'], 1],
    ['joining works in the mirror direction',
      ['nh', 'collection', 'amsterdam'], ['nhcollection', 'amsterdam'], 1],
    ['three-token concatenation still joins',
      ['grandhotelrimini'], ['grand', 'hotel', 'rimini'], 1],
    // The slug glues a category word onto a name that no longer says it.
    ['a name token contained in a slug token is explained',
      ['hotelbellevue', 'rimini'], ['bellevue'], 1],
    ['a truncated slug token still explains a longer name token',
      ['casa'], ['casadelmar'], 1],
    // The pair below brackets MIN_SUBSTRING_MATCH. Deliberately non-generic
    // tokens: with "inn"/"innsbruck" the short token is a category word, so it
    // leaves the denominator and the assertion holds whatever the length floor
    // is — a test that cannot fail is not a test.
    ['containment at exactly four characters counts',
      ['casadelmar'], ['casa', 'zzz'], 1 / 2],
    ['containment below four characters does not',
      ['casadelmar'], ['cas', 'zzz'], 0],
    // The floor counts characters, not UTF-16 units, so a two-character word
    // scores the same whichever plane its characters live in. Rare kanji are
    // surrogate pairs: measuring `.length` would make the second row qualify
    // (4 units) while the first, the same length in characters, does not.
    ['two BMP characters are below the floor',
      ['東京都庁'], ['東京'], 0],
    ['two astral characters are below the same floor',
      ['𠀋𠀌𠀍'], ['𠀋𠀌'], 0],
    ['generic words are ignored on both sides',
      ['grand', 'rimini'], ['grand', 'hotel', 'rimini'], 1],
    ['extra location words in the slug cost nothing',
      ['electra', 'metropolis', 'athens', 'syntagma'], ['electra', 'metropolis'], 1],
    ['unexplained name tokens lower the score proportionally',
      ['corpo', 'santo'], ['corpo', 'santo', 'lisbon'], 2 / 3],
    ['completely unrelated tokens score zero',
      ['horizon', 'alpes', 'glieres'], ['paris', 'eiffel'], 0],
    // Defensive re-normalization. Each of these scores 0 without it, so the
    // rows fail if the folding pass inside tokenOverlap is dropped.
    ['raw slug casing is folded before matching',
      ['Strand', 'PALACE'], ['strand', 'palace'], 1],
    ['raw name casing and diacritics still match',
      ['catalonia', 'la', 'boqueria'], ['Catalonia', 'La', 'Boquería'], 1],
    // Without the re-split this scores 0.5: "collection" survives on the
    // substring rescue, "nh" is too short to be rescued.
    ['a token holding two words is re-split',
      ['nh collection'], ['nh', 'collection'], 1],
  ])('%s', (_name, slug, name, expected) => {
    expect(tokenOverlap(slug, name)).toBeCloseTo(expected, 5);
  });

  it.each([
    ['both sides empty', [], []],
    ['empty slug', [], ['strand', 'palace']],
    ['empty name', ['strandpalace'], []],
    ['slug of unusable tokens only', ['l', '39'], ['strand', 'palace']],
    ['name of unusable tokens only', ['strandpalace'], ['l', '39']],
  ])('returns 0 (not 1) when %s — unknown is not agreement', (_name, slug, name) => {
    expect(tokenOverlap(slug, name)).toBe(0);
  });

  it.each([
    ['a pure number', ['39'], ['39']],
    ['a single letter', ['l'], ['l']],
    ['both kinds together', ['l', '39'], ['39', 'l']],
  ])('does not read %s appearing on both sides as agreement', (_name, slug, name) => {
    // This is the debris an HTML-escaped apostrophe and a house number leave
    // behind (`l-39-horizon-...`). Two unrelated listings share it routinely,
    // so a raw caller passing untokenized arrays must not get 1.00 out of it —
    // the direction that would silently suppress a hijack.
    expect(tokenOverlap(slug, name)).toBe(0);
  });

  it.each([
    // MAX_JOIN_RUN is 4. Real names cannot isolate the cap because the
    // substring rescue quietly covers for it, so these use two-letter tokens:
    // too short for containment, leaving the join rule as the only way to
    // score. Both directions of the join are checked.
    ['four slug tokens join', ['ab', 'cd', 'ef', 'gh', 'ij'], ['abcdefgh'], 1],
    ['five slug tokens do not', ['ab', 'cd', 'ef', 'gh', 'ij'], ['abcdefghij'], 0],
    ['four name tokens join', ['abcdefgh'], ['ab', 'cd', 'ef', 'gh'], 1],
    ['five name tokens do not', ['abcdefghij'], ['ab', 'cd', 'ef', 'gh', 'ij'], 0],
  ])('%s', (_name, slug, name, expected) => {
    expect(tokenOverlap(slug, name)).toBeCloseTo(expected, 5);
  });

  it('does not mutate either argument', () => {
    // Callers reuse these arrays to build the evidence table; a score must not
    // rewrite the values it is about to be displayed next to.
    const slug = slugTokens('nhcollection-amsterdam');
    const name = tokenize('NH Collection Amsterdam');
    const slugBefore = [...slug];
    const nameBefore = [...name];
    tokenOverlap(slug, name);
    expect(slug).toEqual(slugBefore);
    expect(name).toEqual(nameBefore);
  });

  it('is deliberately asymmetric: the slug may carry words the name omits', () => {
    const slug = slugTokens('strandpalace-london');
    const name = tokenize('Strand Palace');
    // Correct direction: everything in the name is explained.
    expect(tokenOverlap(slug, name)).toBe(1);
    // Swapped: "london" is now an unexplained name token. Documents that
    // argument order is load-bearing (slug first, name second).
    expect(tokenOverlap(name, slug)).toBeCloseTo(0.5, 5);
  });

  it('falls back to all tokens when the name is entirely generic', () => {
    // Nothing discriminating to measure; dividing by zero content tokens would
    // be worse than measuring the generic ones.
    expect(tokenOverlap(slugTokens('the-hotel'), tokenize('The Hotel'))).toBe(1);
    expect(tokenOverlap(slugTokens('grand-rimini'), tokenize('The Hotel'))).toBe(0);
  });

  it('stays within 0..1 for every corpus pair', () => {
    for (const [, slug, name] of LEGIT_CORPUS) {
      const score = tokenOverlap(slugTokens(slug), tokenize(name));
      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThanOrEqual(1);
    }
  });

  it('scores a Greek-script name against a Latin slug as 0 — documented limitation', () => {
    // Booking slugs are always transliterated to Latin, so a name in another
    // script shares no tokens and looks exactly like a hijack. A1 must check
    // for comparable scripts and go GRAY instead of reading this 0 as evidence.
    expect(tokenOverlap(slugTokens('electra-metropolis'), tokenize('Ηλέκτρα Μητρόπολις'))).toBe(0);
  });
});

// ---------------------------------------------------------------------------

describe('discriminatingTokenCount', () => {
  it.each([
    ['counts only identity-bearing tokens', 'Grand Hotel Rimini', 2],
    ['counts every content word', 'Schulz Hotel Berlin Wall at the East Side Gallery', 6],
    // "des" is a function word; the orphaned "l" never becomes a token.
    ['ignores what the tokenizer drops', "L'Horizon des Alpes", 2],
    ['is zero when the name is pure category words', 'The Hotel', 0],
    ['is zero for an empty name', '', 0],
  ])('%s', (_name, name, expected) => {
    expect(discriminatingTokenCount(tokenize(name))).toBe(expected);
  });

  it('tells a meaningful 1.00 apart from an empty one', () => {
    // Identical scores, opposite amounts of evidence. A1 reads the count to
    // decide whether a score is worth acting on; without it, "The Hotel" whose
    // slug happens to say "the-hotel" looks as verified as a full match.
    expect(tokenOverlap(slugTokens('the-hotel'), tokenize('The Hotel'))).toBe(1);
    expect(discriminatingTokenCount(tokenize('The Hotel'))).toBe(0);

    expect(tokenOverlap(slugTokens('strandpalace'), tokenize('Strand Palace'))).toBe(1);
    expect(discriminatingTokenCount(tokenize('Strand Palace'))).toBe(2);
  });

  it('agrees with the denominator tokenOverlap actually divides by', () => {
    // One unexplained token out of a known count, checked against the score.
    const name = tokenize('Corpo Santo Lisbon Historical Hotel');
    expect(discriminatingTokenCount(name)).toBe(3);
    expect(tokenOverlap(slugTokens('corpo-santo'), name)).toBeCloseTo(2 / 3, 5);
  });
});

// ---------------------------------------------------------------------------

describe('nameSimilarity is Dice over counted bigrams', () => {
  it.each([
    // Hand-computed from the definition 2·|A ∩ B| / (|A| + |B|) over bigram
    // multisets, so the numbers are independent of what the implementation
    // happens to return. Each row rules out a plausible wrong formula:
    // ('ab','abc') is 1.00 under shared/min and 0.50 under shared/max;
    // ('aaa','aa') is 1.00 if bigrams are de-duplicated into sets instead of
    // counted; ('abab','ab') is 1.00 under Jaccard-style containment.
    ['ab', 'abc', 2 / 3], //   {ab} vs {ab, bc}            → 2·1 / (1 + 2)
    ['abc', 'abcd', 4 / 5], // {ab, bc} vs {ab, bc, cd}    → 2·2 / (2 + 3)
    ['aaa', 'aa', 2 / 3], //   {aa: 2} vs {aa: 1}          → 2·1 / (2 + 1)
    ['abab', 'ab', 1 / 2], //  {ab: 2, ba: 1} vs {ab: 1}   → 2·1 / (3 + 1)
    ['ab', 'cd', 0], //        disjoint                    → 0
  ])('(%s, %s)', (a, b, expected) => {
    expect(nameSimilarity(a, b)).toBeCloseTo(expected, 10);
  });
});

describe('nameSimilarity', () => {
  it.each([
    ['identical strings', 'Strand Palace', 'Strand Palace', 1],
    ['case differences', 'STRAND PALACE', 'strand palace', 1],
    ['diacritic differences', 'Hôtel Le Régent Paris', 'Hotel Le Regent Paris', 1],
    ['punctuation and spacing differences', 'NH Collection — Flower Market', 'NH Collection Flower Market', 1],
    ['Greek accent differences', 'Ηλέκτρα Μητρόπολις', 'Ηλεκτρα Μητροπολις', 1],
    ['identical Japanese', '渋谷エクセルホテル東急', '渋谷エクセルホテル東急', 1],
    ['single identical character', 'A', 'a', 1],
    ['single differing character', 'A', 'B', 0],
    ['one-character vs longer', 'A', 'Strand Palace', 0],
    ['empty vs non-empty', '', 'Strand Palace', 0],
    ['both empty', '', '', 0],
    ['punctuation-only vs name', '---', 'Strand Palace', 0],
  ])('%s', (_name, a, b, expected) => {
    expect(nameSimilarity(a, b)).toBeCloseTo(expected, 5);
  });

  it.each([
    // Renames Booking sees constantly: words added, dropped or reordered
    // around a stable core. These must stay ABOVE Engine B's threshold.
    ['appended district', 'Hotel Ibis Paris Nord', 'ibis Paris Nord 18eme'],
    ['dropped category word', 'Strand Palace Hotel', 'Strand Palace'],
    ['appended category word', 'Corpo Santo', 'Corpo Santo Lisbon Hotel'],
    ['brand suffix added', 'Hotel Bellevue', 'Hotel Bellevue by OasiGroup Hotels'],
    ['localized spelling', 'Hôtel Le Regent Paris', 'Hotel Le Regent Paris Saint Germain'],
  ])('treats a legitimate rename (%s) as the same property', (_name, a, b) => {
    expect(nameSimilarity(a, b)).toBeGreaterThanOrEqual(RENAME_MIN);
  });

  it.each([
    ['the real hijack', "L'Horizon des Alpes", 'Paris Eiffel Residence'],
    ['unrelated hotels', 'Grand Hotel Rimini', 'Schulz Berlin Wall'],
    ['different scripts', '渋谷エクセルホテル東急', 'Paris Eiffel Residence'],
    ['same category, different identity', 'Catalonia La Boqueria', 'Warwick New York'],
  ])('treats an identity swap (%s) as a different property', (_name, a, b) => {
    expect(nameSimilarity(a, b)).toBeLessThanOrEqual(SWAP_MAX);
  });

  it.each([
    ['Hotel Ibis Paris Nord', 'ibis Paris Nord 18eme'],
    ["L'Horizon des Alpes", 'Paris Eiffel Residence'],
    ['Strand Palace', ''],
    ['渋谷エクセルホテル東急', 'Shibuya Excel Hotel Tokyu'],
  ])('is symmetric and bounded for (%s, %s)', (a, b) => {
    const forward = nameSimilarity(a, b);
    expect(nameSimilarity(b, a)).toBeCloseTo(forward, 10);
    expect(forward).toBeGreaterThanOrEqual(0);
    expect(forward).toBeLessThanOrEqual(1);
  });

  it('separates the legit rename from the hijack by a usable margin', () => {
    const rename = nameSimilarity('Hotel Ibis Paris Nord', 'ibis Paris Nord 18eme');
    const swap = nameSimilarity("L'Horizon des Alpes", 'Paris Eiffel Residence');
    expect(rename - swap).toBeGreaterThanOrEqual(RENAME_MIN - SWAP_MAX);
  });

  it('ignores decorative symbols in display names', () => {
    // Booking names carry star ratings, hearts and emoji. They are symbols,
    // not letters, so normalization drops them and they cannot move a score.
    expect(nameSimilarity('Hotel Milano ★★★', 'Hotel Milano')).toBe(1);
    expect(nameSimilarity('Hotel 🏨 Milano', 'Hotel 🏩 Milano')).toBe(1);
  });

  it('forms bigrams over code points, not UTF-16 units', () => {
    // Rare kanji live outside the BMP and are surrogate pairs. Splitting on
    // UTF-16 units would let two unrelated characters share half a bigram.
    expect(nameSimilarity('𠀋𠀌', '𠀋𠀍')).toBe(0);
  });
});
