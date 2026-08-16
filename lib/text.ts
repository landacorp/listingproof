/**
 * Text normalization and fuzzy comparison for property names and URL slugs.
 *
 * Two consumers, both false-positive-critical:
 *  - Engine A1 compares the URL slug against the displayed name. The slug is
 *    fossilized history — Booking derives it from the name when the listing is
 *    created and never rewrites it — so a slug that no longer explains the
 *    name is evidence of a rename, the loudest first-visit hijack signal we
 *    have.
 *  - Engine B compares a live name against an archived one (`nameSimilarity`).
 *
 * A false positive here accuses an honest hotel of being hijacked, which is
 * much worse than missing one hijack (A2/A3/B still get a shot at it). Every
 * judgment call below therefore leans toward "these two strings agree":
 * aggressive folding, generic-word stopping, and two rescue passes for the
 * ways Booking mangles names into slugs. The measured separation over
 * fixtures/live/ is wide enough to afford that generosity:
 *
 *   legitimate pairs   0.50 … 1.00   (worst: slug `hotelbellevue_rimini`
 *                                     vs "Hotel Bellevue by OasiGroup Hotels")
 *   real hijack        0.00          (alpine slug vs "Paris Eiffel Residence")
 *
 * so an A1 threshold near 0.35 has headroom on both sides. `lib/text.test.ts`
 * asserts the whole corpus stays on the correct side of those numbers, so a
 * regression in the folding rules fails loudly rather than silently shifting
 * the verdict distribution.
 *
 * Known limitations for callers, both of which A1 must handle before reading a
 * score as evidence:
 *  - Comparison is script-bound. A Latin slug and a name written in a
 *    non-Latin script share no tokens, so `tokenOverlap` returns 0 —
 *    indistinguishable from a real hijack. Booking slugs are always Latin, so
 *    "name has no Latin tokens" is GRAY (not comparable), not a flag.
 *    Transliteration is out of scope for v1.
 *  - A score is a fraction, not an amount of evidence. "The Grand Hotel" has
 *    exactly one discriminating token, so it scores 0.00 or 1.00 with nothing
 *    in between; a single-token disagreement is a much weaker basis for RED
 *    than the same fraction over six tokens. A1 should weight by how many
 *    tokens were actually available (see `discriminatingTokenCount`).
 *
 * Pure module: no DOM, no network, no chrome.*.
 */

// ---------------------------------------------------------------------------
// normalization
// ---------------------------------------------------------------------------

/**
 * Latin letters that carry their "diacritic" inside the code point, so Unicode
 * decomposition leaves them untouched. Booking's slugifier transliterates them
 * anyway, so without this map slug `hotel-baltyk` vs name "Hotel Bałtyk" reads
 * as a rename. Only the lowercase forms are needed — folding happens after
 * lowercasing.
 */
const LATIN_FOLD: Record<string, string> = {
  ß: 'ss',
  ø: 'o',
  æ: 'ae',
  œ: 'oe',
  ł: 'l',
  đ: 'd',
  ð: 'd',
  þ: 'th',
  ħ: 'h',
  ŧ: 't',
  ı: 'i',
  ĸ: 'k',
};
const LATIN_FOLD_RE = /[ßøæœłđðþħŧıĸ]/g;

/**
 * Combining marks to strip, deliberately narrower than `\p{M}`.
 *
 * U+0300–U+036F is exactly the set of marks a Latin, Greek or Cyrillic letter
 * decomposes into — verified by decomposing every code point of those three
 * scripts, not assumed — so nothing we need folded escapes. `\p{M}` would also
 * take Japanese voicing marks (ガ → カ), Devanagari vowel signs (होटल → हटल)
 * and Hebrew/Arabic points, each of which merges names that are genuinely
 * different. Booking's slug is Latin and matches none of those scripts either
 * way, so the only effect of the wider strip would be to make two different
 * properties look like one — the failure this whole tool exists to catch.
 */
const COMBINING_DIACRITICS_RE = /[\u0300-\u036f]+/gu;

/**
 * Fold a string down to the form both sides of a comparison can agree on:
 * lowercase, no Latin/Greek/Cyrillic diacritics, letters and digits separated
 * by single spaces.
 *
 * Compatibility decomposition (NFKD, not NFD) is deliberate: Japanese pages
 * carry full-width Latin ("ＴＯＫＹＵ") and half-width katakana ("ﾎﾃﾙ"), which
 * only compatibility folding maps onto their normal forms.
 *
 * The two passes that look redundant are not:
 *  - Lowercasing again after NFKD. Compatibility decomposition can *produce*
 *    uppercase from lowercase input (ϒ U+03D2 → Υ, and the modifier-letter
 *    capitals at U+1D2C+), which would otherwise survive and stop an honest
 *    name from matching its own slug.
 *  - Folding after decomposition, not before, so a letter carrying both a
 *    stroke and an accent still folds: ǿ → ø + acute → ø → o.
 *
 * The trailing recomposition matters twice: Korean decomposition explodes
 * Hangul syllables into jamo, which are letters and therefore survive
 * mark-stripping, and half-width katakana decomposes into base + U+3099, which
 * has to recompose (ﾎﾞ → ボ) to match the full-width spelling of the same name.
 * Marks are kept by the final character class for the same reason — they are
 * neither letters nor digits, so filtering on `\p{L}\p{N}` alone would delete
 * everything the narrowed strip above was careful to preserve.
 */
export function normalizeForCompare(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFKD')
    .toLowerCase()
    .replace(COMBINING_DIACRITICS_RE, '')
    .replace(LATIN_FOLD_RE, (c) => LATIN_FOLD[c] ?? c)
    .normalize('NFC')
    .replace(/[^\p{L}\p{N}\p{M}]+/gu, ' ')
    .trim();
}

// ---------------------------------------------------------------------------
// tokenization
// ---------------------------------------------------------------------------

type ScriptClass = 'latin' | 'greek' | 'cyrillic' | 'han' | 'hiragana' | 'katakana' | 'hangul' | 'other';

const SCRIPT_TESTS: ReadonlyArray<readonly [ScriptClass, RegExp]> = [
  ['latin', /\p{Script=Latin}/u],
  ['han', /\p{Script=Han}/u],
  ['hiragana', /\p{Script=Hiragana}/u],
  ['katakana', /\p{Script=Katakana}/u],
  ['hangul', /\p{Script=Hangul}/u],
  ['cyrillic', /\p{Script=Cyrillic}/u],
  ['greek', /\p{Script=Greek}/u],
];

/**
 * Script of a single character, or null for "neutral" characters (digits, the
 * katakana prolonged sound mark ー, and anything unclassified) which attach to
 * whatever run they appear in rather than starting a new one. That keeps
 * "18eme" and "ホテル" in one piece.
 */
function scriptOf(ch: string): ScriptClass | null {
  for (const [name, re] of SCRIPT_TESTS) {
    if (re.test(ch)) return name;
  }
  return null;
}

/**
 * Split a whitespace-free chunk at script boundaries.
 *
 * Japanese, Chinese and Korean names are written without spaces, so a pure
 * whitespace split hands the comparison one opaque blob. Alternating
 * kanji/kana runs are the classic poor-man's segmenter: "渋谷エクセルホテル東急"
 * becomes 渋谷 / エクセルホテル / 東急 — not morphologically correct (エクセル
 * and ホテル stay glued), but enough for tokens to be comparable, and it costs
 * nothing on Latin input. Intl.Segmenter would do better but its output varies
 * with the host's ICU build, and non-determinism in a scoring input is worse
 * than coarse tokens.
 */
function splitScriptRuns(chunk: string): string[] {
  const runs: string[] = [];
  let current = '';
  let currentScript: ScriptClass | null = null;

  for (const ch of chunk) {
    const script = scriptOf(ch);
    if (script !== null && currentScript !== null && script !== currentScript) {
      runs.push(current);
      current = '';
    }
    if (script !== null) currentScript = script;
    current += ch;
  }
  if (current.length > 0) runs.push(current);
  return runs;
}

/**
 * Tokens dropped everywhere: pure numbers and single characters.
 *
 * Both are noise a slug reliably invents — see `slugTokens` for the "39"
 * apostrophe quirk, and note that "B&B Hotel Milano" tokenizes to b / b /
 * hotel / milano, where the single letters would otherwise match anything.
 * Length is counted in code points so an astral-plane character is not
 * mistaken for two.
 */
function isUsableToken(token: string): boolean {
  if (Array.from(token).length < 2) return false;
  return !/^\p{N}+$/u.test(token);
}

/**
 * Unicode-aware word split of a display name. Diacritics, case and punctuation
 * are folded away first, so "Hôtel Le Régent" and "hotel le regent" tokenize
 * identically.
 */
export function tokenize(s: string): string[] {
  const normalized = normalizeForCompare(s);
  if (normalized.length === 0) return [];

  const tokens: string[] = [];
  for (const chunk of normalized.split(' ')) {
    for (const run of splitScriptRuns(chunk)) {
      if (isUsableToken(run)) tokens.push(run);
    }
  }
  return tokens;
}

/**
 * Tokens of a Booking property slug (the `slug` field of a CanonicalListing).
 *
 * Booking slugifies the *HTML-escaped* name, so an apostrophe arrives as the
 * bare digits of its numeric character reference `&#39;`:
 * `l-39-horizon-des-alpes-le-petit-bornand-les-glieres` is "L'Horizon des
 * Alpes, Le Petit-Bornand-les-Glières". Both halves of that artefact — the
 * orphaned "l" and the numeric "39" — are dropped by the shared token rules,
 * which is the whole reason those rules exist: left in, "39" would be an
 * unmatchable token on the slug side and, worse, a matchable one on the name
 * side for any listing whose name contains a number.
 */
export function slugTokens(slug: string): string[] {
  return tokenize(slug.replace(/[-_]+/g, ' '));
}

// ---------------------------------------------------------------------------
// generic (non-discriminating) words
// ---------------------------------------------------------------------------

/**
 * Words that carry no identity: a hijacker can keep them while replacing the
 * property entirely, and Booking's slug and the displayed name disagree about
 * them constantly ("grand-rimini" vs "Grand Hotel Rimini"). Counting them
 * would punish honest listings in both directions, so they are excluded from
 * the score's denominator.
 *
 * Deliberately conservative: only accommodation-category nouns, a few
 * contentless descriptors, and function words. Words that look generic but
 * routinely carry identity are NOT here — "palace" (Strand Palace), "grand"
 * (Grand Hotel Rimini), "villa", "house", "park". Entries are already folded
 * (no diacritics, lowercase).
 */
const GENERIC_TOKENS: ReadonlySet<string> = new Set([
  // accommodation categories, incl. the locales in fixtures/live/
  'hotel', 'hotels', 'hotell', 'hoteles', 'hoteis', 'otel', 'hostal', 'hostel',
  'hostels', 'motel', 'inn', 'resort', 'resorts', 'residence', 'residences',
  'residenz', 'residencia', 'residencial', 'apartment', 'apartments',
  'apartamento', 'apartamentos', 'appartement', 'appartements', 'aparthotel',
  'suites', 'guesthouse', 'pension', 'pensao', 'pousada', 'albergo',
  'albergue', 'gasthaus', 'gasthof', 'bnb', 'bed', 'breakfast', 'camping',
  'ryokan', 'ホテル', 'отель', 'гостиница', 'ξενοδοχειο',
  // contentless descriptors
  'historic', 'historical', 'boutique', 'luxury', 'deluxe', 'budget',
  // function words (articles/prepositions/conjunctions); single letters are
  // already dropped by the tokenizer
  'the', 'and', 'of', 'at', 'in', 'on', 'by', 'for', 'or',
  'de', 'del', 'della', 'delle', 'di', 'da', 'do', 'das', 'dos', 'du', 'des',
  'la', 'le', 'les', 'los', 'las', 'el', 'il', 'lo', 'gli', 'un', 'una',
  'une', 'um', 'uma', 'der', 'die', 'den', 'dem', 'ein', 'eine', 'und',
  'im', 'am', 'zum', 'zur', 'het', 'een', 'van', 'aan',
]);

// ---------------------------------------------------------------------------
// overlap
// ---------------------------------------------------------------------------

/**
 * How many adjacent tokens may be glued together when looking for a
 * concatenation match. Booking's slugs concatenate two or three words
 * ("strandpalace", "nhcollection"); four is slack, and the cap keeps the
 * search linear over hostile input.
 */
const MAX_JOIN_RUN = 4;

/**
 * Minimum length for the substring rescue pass, in code points. Below four
 * characters, accidental containment ("mar" inside "mardelplata") stops being
 * evidence. Counted in code points rather than UTF-16 units so a pair of
 * astral-plane characters is not mistaken for a four-character word.
 */
const MIN_SUBSTRING_MATCH = 4;

/**
 * Defensive re-normalization: callers should pass output of `tokenize` /
 * `slugTokens`, but `tokenOverlap` is exported and a raw array must not be
 * scored on different rules than a tokenized one. Running each element through
 * `tokenize` reuses the whole pipeline — folding, script splitting, and the
 * drop of single characters and pure numbers.
 *
 * That last part is the load-bearing one. Without it `tokenOverlap(['39'],
 * ['39'])` scores a confident 1.00, and `['a']` against `['a']` likewise: the
 * apostrophe and house-number debris that `isUsableToken` exists to remove
 * would come back as full agreement between two unrelated listings. Dropping
 * them can only empty a side, which `tokenOverlap` reports as 0 (unknown), not
 * as a match.
 */
function flattenTokens(tokens: string[]): string[] {
  const out: string[] = [];
  for (const token of tokens) {
    for (const piece of tokenize(token)) out.push(piece);
  }
  return out;
}

/** Every concatenation of 1…MAX_JOIN_RUN adjacent tokens. */
function joinedRuns(tokens: string[]): Set<string> {
  const runs = new Set<string>();
  for (let i = 0; i < tokens.length; i++) {
    let joined = '';
    for (let j = i; j < tokens.length && j - i < MAX_JOIN_RUN; j++) {
      joined += tokens[j];
      runs.add(joined);
    }
  }
  return runs;
}

/** One token contains the other, and the contained one is long enough to mean it. */
function substringMatch(a: string, b: string): boolean {
  const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
  return Array.from(shorter).length >= MIN_SUBSTRING_MATCH && longer.includes(shorter);
}

/**
 * How many tokens of a name actually carry identity — the size of the
 * denominator `tokenOverlap` divides by, before the all-generic fallback.
 *
 * Exported because a fraction hides its own sample size: 0.00 over one token
 * ("The Grand Hotel" whose slug says something else) and 0.00 over six are the
 * same number and nowhere near the same evidence. A1 needs the count to decide
 * whether a low score is worth a RED or only a GRAY, so it is computed here
 * rather than reimplemented against a copy of GENERIC_TOKENS. A count of 0
 * means the name is pure category words and says nothing about identity.
 */
export function discriminatingTokenCount(nameTokens: string[]): number {
  return flattenTokens(nameTokens).filter((token) => !GENERIC_TOKENS.has(token)).length;
}

/**
 * Fraction of the NAME that the SLUG explains, 0…1. **Not symmetric** — this
 * is containment (recall of the name), not Jaccard, because a slug legitimately
 * carries words the name omits: a location suffix Booking appends
 * ("...-le-petit-bornand-les-glieres"), a category word the displayed name
 * dropped. Penalizing the slug for extra tokens would flag half of Booking.
 *
 * Three ways a name token can be explained, all of them observed in
 * fixtures/live/:
 *  1. It appears in the slug verbatim (after folding: "boquería" ≡ "boqueria").
 *  2. It is part of a concatenation. Booking slugs frequently drop the
 *     separators — `strandpalace` for "Strand Palace", `nhcollection` for
 *     "NH Collection", `hotelbellevue` for "Hotel Bellevue" — so a slug token
 *     equal to a run of adjacent name tokens credits the whole run, and the
 *     mirror case (name token equal to a run of slug tokens) too. This single
 *     rule is the difference between 1.00 and 0.00 on the Strand Palace
 *     listing, and is the biggest false-positive risk in the product.
 *  3. It is contained in a slug token or vice versa, for the leftovers of the
 *     previous rule: slug `hotelbellevue` against a name that no longer says
 *     "Hotel", or a slug Booking truncated.
 *
 * Generic words (see GENERIC_TOKENS) are excluded from the denominator, so
 * "Grand Hotel Rimini" is judged on grand + rimini. They still take part in
 * matching — `hotel` is half of the `hotelbellevue` concatenation — they just
 * cannot be what the score is about. If the name is *entirely* generic ("The
 * Hotel") there is nothing discriminating to measure, and the denominator falls
 * back to all tokens rather than dividing by zero; `discriminatingTokenCount`
 * reports 0 for that case so the caller can tell it apart from a real 1.00.
 *
 * Either side empty returns 0. Unknown is not agreement: with no tokens there
 * is no evidence the slug explains anything, and the caller is expected to
 * treat "no comparable tokens" as GRAY rather than reading 0 as a hijack.
 *
 * Neither argument is mutated; both are re-tokenized into fresh arrays.
 * Argument order is load-bearing and cannot be type-checked — both sides are
 * `string[]` — so the asymmetry is pinned by a test.
 */
export function tokenOverlap(slugSideTokens: string[], nameSideTokens: string[]): number {
  const slug = flattenTokens(slugSideTokens);
  const name = flattenTokens(nameSideTokens);
  if (slug.length === 0 || name.length === 0) return 0;

  let denominator = name
    .map((token, index) => ({ token, index }))
    .filter(({ token }) => !GENERIC_TOKENS.has(token))
    .map(({ index }) => index);
  if (denominator.length === 0) denominator = name.map((_, index) => index);

  const slugRuns = joinedRuns(slug);
  const matched = new Set<number>();

  // Rules 1 and 2 at once: any run of adjacent name tokens whose concatenation
  // is a run of adjacent slug tokens credits every token in that run. A run of
  // length one on both sides is plain equality.
  for (let i = 0; i < name.length; i++) {
    let joined = '';
    for (let j = i; j < name.length && j - i < MAX_JOIN_RUN; j++) {
      joined += name[j];
      if (slugRuns.has(joined)) {
        for (let k = i; k <= j; k++) matched.add(k);
      }
    }
  }

  // Rule 3, only for what is still unexplained.
  for (const [index, token] of name.entries()) {
    if (matched.has(index)) continue;
    if (slug.some((slugToken) => substringMatch(token, slugToken))) matched.add(index);
  }

  const hits = denominator.filter((index) => matched.has(index)).length;
  return hits / denominator.length;
}

// ---------------------------------------------------------------------------
// name similarity
// ---------------------------------------------------------------------------

/** Multiset of adjacent code-point pairs, counted (repeats carry signal). */
function bigramCounts(s: string): Map<string, number> {
  const chars = Array.from(s);
  const counts = new Map<string, number>();
  for (let i = 0; i + 1 < chars.length; i++) {
    const bigram = `${chars[i]}${chars[i + 1]}`;
    counts.set(bigram, (counts.get(bigram) ?? 0) + 1);
  }
  return counts;
}

/**
 * Sørensen–Dice similarity over character bigrams of the normalized strings,
 * 0…1. Used by Engine B to compare a live name against an archived one.
 *
 * Bigram Dice rather than edit distance because the realistic legitimate
 * change is words being added or dropped around a stable core — "Hotel Ibis
 * Paris Nord" → "ibis Paris Nord 18eme" (0.70) — which Levenshtein punishes in
 * proportion to the added length while Dice barely notices. An actual identity
 * swap has almost no shared substructure: "L'Horizon des Alpes" vs "Paris
 * Eiffel Residence" scores 0.26.
 *
 * Dice is still length-sensitive, and Engine B must budget for it: a short
 * name gaining a long suffix ("Hotel Bellevue" → "Hotel Bellevue by OasiGroup
 * Hotels") only reaches 0.565 despite being the same property, because the
 * denominator grows with the added text. Measured spread over the fixture
 * corpus is 0.565…1.00 for legitimate renames against 0.256 for an identity
 * swap, which puts a usable threshold around 0.45 — nearer the renames than
 * the midpoint, because the floor above is a real measurement of the honest
 * case while 0.256 is one sample of the dishonest one. PLAN.md already
 * requires a second flag before this rule alone can turn anything RED.
 *
 * Bigrams are counted, not set-deduplicated, so a repeated word contributes
 * repeatedly, and pairs are formed over code points so surrogate pairs are not
 * split down the middle. Symbols (star ratings, emoji) are dropped by
 * normalization and cannot move the score either way — as are the differences
 * between two names that normalize identically, which is why the equality
 * shortcut below is a shortcut and not a special case.
 *
 * Symmetric by construction: the numerator is a multiset intersection and the
 * denominator a sum, so argument order never matters (unlike `tokenOverlap`).
 *
 * Strings of one character have no bigrams at all, so Dice is undefined and
 * they score 0 unless they are equal. Empty input is 0 on both sides — two
 * listings with no name is not evidence they are the same listing.
 */
export function nameSimilarity(a: string, b: string): number {
  const left = normalizeForCompare(a);
  const right = normalizeForCompare(b);
  if (left.length === 0 || right.length === 0) return 0;
  if (left === right) return 1;
  if (Array.from(left).length < 2 || Array.from(right).length < 2) return 0;

  const leftCounts = bigramCounts(left);
  const rightCounts = bigramCounts(right);

  let shared = 0;
  let leftTotal = 0;
  for (const [bigram, count] of leftCounts) {
    leftTotal += count;
    shared += Math.min(count, rightCounts.get(bigram) ?? 0);
  }
  let rightTotal = 0;
  for (const count of rightCounts.values()) rightTotal += count;

  return (2 * shared) / (leftTotal + rightTotal);
}
