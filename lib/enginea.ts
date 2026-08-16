/**
 * Engine A — intra-page consistency. **The primary engine.**
 *
 * PLAN.md's headline risk is that archive coverage of Booking property pages is
 * ~0 retrospectively, so Engine B (history diffing) usually has nothing to say.
 * Engine A is the one that works on a first visit with zero archive coverage,
 * which is the normal case. It does that by playing the page against itself:
 * every hijacked listing carries at least one fossil of the property it used to
 * be, or one piece of neighbourhood copy that no longer matches the coordinates.
 *
 *   A1  URL slug vs displayed name   → RED     (fossilized history; YELLOW when
 *                                                the whole disagreement is one word)
 *   A2  claimed nearby landmarks vs coordinates → RED  (stolen neighbourhood copy)
 *   A3  breadcrumb city vs coordinates → YELLOW (weaker, localized, one call)
 *
 * Two invariants run through the whole module:
 *
 *  - **GRAY is first-class.** A check that could not run emits GRAY, never
 *    silence-that-reads-as-a-pass and never GREEN. For a trust tool the unsafe
 *    direction is anything that makes an unknown look verified, so every failure
 *    path here (no coordinates, no geocode, geocoder throwing, non-comparable
 *    scripts) resolves to GRAY or to nothing at all.
 *  - **No exception escapes `runEngineA`.** The inputs are attacker-authored
 *    page text and a network-backed geocoder; a throw would take the whole
 *    verdict down, which is strictly worse than a missing row.
 *
 * Pure of browser APIs: the only I/O is the injected `Geocoder`, so the tests
 * run against a Map with no network and no timers.
 *
 * Every sentence this engine speaks is authored once as a catalog key in
 * `lib/i18n/en/enginea.ts` and rendered here into English via `lib/msg.ts`, so
 * `title`/`detail`/`label` read exactly as before while the panel can redraw
 * the same keys in the user's language. Facts travel as params; the words
 * never do.
 */

import { haversineKm, median, type LatLng } from './geo';
import type { GeocodeResult, Geocoder } from './geocoder';
import type { IdentityVector } from './identity';
import type { MessageKey } from './i18n/keys';
import { english, msg } from './msg';
import type { PageContext, PoiMention } from './pagecontext';
import type { EvidenceLink, EvidenceValue, Signal, SignalSeverity } from './signals';
import {
  discriminatingTokenCount,
  normalizeForCompare,
  slugTokens,
  tokenOverlap,
  tokenize,
} from './text';

export interface EngineAInput {
  identity: IdentityVector;
  /**
   * `slug` from a CanonicalListing — locale-stripped, lowercased.
   *
   * Optional because it is a platform capability, not a given: Booking bakes the
   * property name into the URL, Airbnb's `/rooms/<id>` carries no name at all.
   * When it is absent A1 simply does not run — there is no fossil to read, and
   * inventing a comparison would either accuse everyone or nobody.
   */
  slug?: string;
  context: PageContext;
  geocoder: Geocoder;
}

// ---------------------------------------------------------------------------
// thresholds
// ---------------------------------------------------------------------------

/**
 * A1 fires RED below this slug→name token overlap.
 *
 * Measured over fixtures/live/ (12 real listings, ≥4 locales):
 *
 *   real hijack        0.000   alpine slug `l-39-horizon-des-alpes-…` wearing
 *                              the name "Paris Eiffel Residence"
 *   worst legitimate   0.500   slug `hotelbellevue_rimini` vs
 *                              "Hotel Bellevue by OasiGroup Hotels"
 *   next worst         0.667   `corpo-santo` vs "Corpo Santo Lisbon Historical Hotel"
 *   the other ten      1.000
 *
 * So the honest separation is [0.000] vs [0.500 … 1.000] and the threshold has
 * to live inside that gap. 0.25 is its midpoint: 2× headroom below the worst
 * legitimate listing, and a full quarter of the scale above the only hijack we
 * have measured.
 *
 * The quantization argues for the same number from a second direction. The
 * score is hits/denominator over discriminating name tokens, so the smallest
 * non-zero value a name of N tokens can produce is 1/N. With a strict `<` test,
 * 0.25 means: a name of ≤4 discriminating tokens must share *literally nothing*
 * with its slug to be accused (1/4 = 0.25 is not < 0.25), and only a long name
 * (≥5 tokens) of which exactly one is explained can trip it short of zero. That
 * is the behaviour we want — A1 accuses total disjointness, not weak agreement.
 *
 * Direction of error: a false positive here calls an honest hotel hijacked,
 * which is far worse than a miss (A2, A3 and Engine B all get their own shot),
 * so when in doubt this number moves down, not up.
 */
export const A1_MIN_SLUG_NAME_OVERLAP = 0.25;

/**
 * Identity-carrying words the name must contain before a low overlap is allowed
 * to propose RED. Below it the same mismatch is still reported, but as YELLOW.
 *
 * `tokenOverlap` returns a fraction, and a fraction hides its own sample size —
 * lib/text.ts says so in the header of the function A1 calls, and exports
 * `discriminatingTokenCount` specifically so A1 can weight by it. "Hotel
 * Astoria" has exactly one word that carries identity, so its score is 0.00 or
 * 1.00 with nothing in between: the entire accusation rests on one word being
 * absent from the slug. That is real evidence, but it is not the same quantity
 * of evidence as six words all missing, and PLAN.md turns any single RED into
 * the whole verdict.
 *
 * Two is the value the corpus permits: every measured legitimate name has ≥2
 * discriminating tokens (Strand Palace, Hotel Bellevue…, Corpo Santo…) and so
 * does the known hijack — "Paris Eiffel Residence" is paris + eiffel, with
 * "residence" dropped as a category word — so the hijack still reaches RED and
 * the calibration above is untouched. Three would silence it.
 *
 * The downgrade is YELLOW and deliberately not GRAY: lib/score.ts discards GRAY
 * rows before deciding, so a complete-identity page whose only flag was greyed
 * out comes back GREEN. Turning thin evidence of a rename into a clean bill of
 * health is the one outcome this product must never produce; YELLOW keeps the
 * observation in front of the user and still corroborates other engines.
 */
export const A1_MIN_DISCRIMINATING_NAME_TOKENS = 2;

/**
 * Adjacent name words the concatenation pass will glue together before
 * comparing them with the slug. Mirrors `MAX_JOIN_RUN` in lib/text.ts, which is
 * the same measurement of the same platform habit ("strandpalace",
 * "nhcollection"): two or three words glued is normal, four is slack, and the
 * cap is what keeps the pass linear in the length of an attacker-authored name.
 */
export const A1_MAX_JOINED_WORDS = 4;

/**
 * Shortest glued spelling the one-character tolerance below may be applied to,
 * in code points.
 *
 * The tolerance is a fraction of the string it forgives, and that fraction is
 * what has to stay small: at six characters one edit is a sixth of the
 * evidence, at four it is a quarter, at three it merges "duo" with "due". The
 * corpus (63 real Booking slug/name pairs, see `concatenatedSpellings`) needs
 * it at eight — `lecolise` against "Le Colisée" — so six is two characters of
 * headroom below the only measured case while still refusing the short glues
 * where a single letter *is* the identity.
 */
export const A1_MIN_CONCATENATION_CHARS = 6;

/**
 * Most tokens per side the concatenation pass will look at.
 *
 * `IdentityVector.name` is page-supplied and unbounded (lib/diff.ts caps it at
 * MAX_NAME_CHARS_COMPARED for the same reason), and this pass compares every
 * glued run of one side against every glued run of the other. Forty is four
 * times the longest name in the corpus (10 tokens) and keeps a hostile name
 * from turning a rescue into a stall. Truncating can only withhold credit — the
 * safe direction, since the pass exists to *withdraw* accusations.
 */
export const A1_MAX_TOKENS_JOINED = 40;

/**
 * Most geocoder calls A2 will spend on one page.
 *
 * Nominatim's usage policy is 1 req/s, so each landmark costs a second of wall
 * clock. Six is the point where the marginal landmark stops changing a median
 * that already has five samples, and a listing page is not worth 40 seconds of
 * a user waiting for a verdict.
 */
export const A2_MAX_GEOCODE_CALLS = 6;

/**
 * Landmarks that must geocode successfully before A2 says anything at all.
 *
 * Below this, A2 is GRAY: "we could not verify the geography." Never RED off
 * one or two landmarks — Nominatim resolving "Central Park" to the one in Cape
 * Town is a routine event, and a single bad geocode must not condemn a listing.
 * Three is the smallest sample where a median has a real middle and one outlier
 * cannot own it.
 */
export const A2_MIN_GEOCODED_POIS = 3;

/**
 * A2(a): median real distance from the listing's coordinates to the landmarks
 * the page itself advertises as nearby, above which the landmarks are simply
 * not in the same place as the property. From PLAN.md.
 *
 * 50 km is deliberately enormous compared with a real "what's nearby" list
 * (0.1–5 km) — it has to survive the airport rows Booking mixes in, imprecise
 * geocodes of parks and districts, and legitimately remote countryside
 * properties. The hijack case it is aimed at misses by hundreds of km.
 */
export const A2_MAX_MEDIAN_DISTANCE_KM = 50;

/**
 * A2(b): median absolute gap between the distance the page *states* for a
 * landmark and the distance actually measured from the listing's coordinates.
 *
 * This is the sharpest first-visit signal available, because it is a direct
 * self-contradiction rather than a plausibility judgement: the page says
 * "Eiffel Tower — 250 m" while its own coordinates put it 437 km away. Same
 * 50 km as (a) for the same reason — a gap that large cannot be geocoder noise
 * or an imprecisely centred landmark.
 */
export const A2_MAX_MEDIAN_DISCREPANCY_KM = 50;

/**
 * Landmarks that must carry a stated distance before A2(b) — the
 * self-contradiction test — has a median worth reading.
 *
 * Same number and same reasoning as A2_MIN_GEOCODED_POIS, but a separate
 * constant because it counts a different thing: a page can supply six geocodable
 * landmarks and print a distance next to only one of them, and one printed
 * number must not be able to drive a RED any more than one geocode can.
 */
export const A2_MIN_STATED_FOR_DISCREPANCY = 3;

/**
 * A3: distance between the place the breadcrumb trail files this property under
 * and the listing's coordinates, above which the trail and the map disagree.
 * YELLOW, not RED, per PLAN.md — a breadcrumb can legitimately name a
 * metropolitan area, a district or the nearest notable town, so this rule is
 * the least certain of the three.
 */
export const A3_MAX_CITY_DISTANCE_KM = 50;

/**
 * Shortest breadcrumb trail A3 will read a place out of. A trail this short
 * cannot survive dropping its site root and still leave two nested levels, so
 * the check simply does not run.
 */
export const A3_MIN_BREADCRUMB_DEPTH = 4;

/**
 * Levels of the trail put into one geocoder query, counting from the most
 * specific end.
 *
 * The trail is a nested hierarchy — country › region › city › district — and
 * the old rule tried to pick the ONE entry that was the city, positionally
 * (second-to-last). Measured over fixtures/live/, that assumption is wrong on 8
 * of 13 trails: French, German, Spanish, Italian, Dutch, British and Japanese
 * trails all carry a district below the city ("Paris › 6e arr.", "Berlin ›
 * Friedrichshain-Kreuzberg", "Rimini › Marina Centro"), and the rule read the
 * district. Geocoded bare, a district is exactly the kind of name that resolves
 * into the wrong hierarchy: "6e arr." + country=FR answers with a hamlet in
 * Alsace 371 km from the listing, "8th arr." with Lyon's 8th arrondissement
 * 400 km from a Paris hotel, "Marina Centro" with a seafront 163 km down the
 * coast. Three confident YELLOWs against three honest listings.
 *
 * So the query stops guessing which level is the city and hands the geocoder
 * the qualified path instead — "Marina Centro, Rimini, Emilia-Romagna" — which
 * is the disambiguation the provider needs and could not invent. Measured
 * against the same corpus, that answers within 5 km of every listing whose
 * trail resolves at all, and no longer needs to know which level it landed on:
 * at a 50 km threshold, city and district are the same answer.
 *
 * Three levels, not more: a fourth adds the country, which the `countrycodes`
 * hint already carries, and — because the consistency guard below asks whether
 * the ANSWER repeats a level we supplied — a country in the slice would satisfy
 * that guard for free (every French answer ends in "France") and quietly
 * disable it. Three is also the widest slice that never reached back into the
 * navigation entries ("Home", "Hotels") on any measured trail.
 */
export const A3_MAX_QUERY_LEVELS = 3;

/**
 * Nested levels the trail must supply before A3 asks anything at all.
 *
 * One level is a bare token — the shape that produced the Lyon answer — and
 * for the shortest trails it is the country, whose centroid is hundreds of
 * kilometres from most honest properties. Two is the point where the query
 * carries its own disambiguation ("Lisboa, Portugal") and the guard has an
 * ancestor to check.
 */
export const A3_MIN_QUERY_LEVELS = 2;

/**
 * Overlap above which a trailing breadcrumb is read as the property's own row
 * rather than as a place.
 *
 * Platforms end the trail differently, and both shapes are in the corpus:
 * Booking appends a marketing string that repeats the property name ("Warwick
 * New York (Hotel) (US) Deals"), while other trails simply stop at the city
 * ("… › Greater London › London"). Dropping a fixed last entry would throw away
 * the city on the second shape, so the last entry is dropped only when it
 * explains at least half of the property name's identifying words — measured:
 * 0.8–1.0 for every marketing string in the corpus, 0.33 for the city entry of
 * the trail that ends at one.
 */
export const A3_MIN_PROPERTY_NAME_OVERLAP = 0.5;

/**
 * Landmark names shorter than this are not worth a geocoder call: an initialism
 * or a stray fragment resolves to something arbitrary, and an arbitrary
 * coordinate is worse than a missing one here. Counted in code points so a
 * two-character CJK place name survives.
 */
export const A2_MIN_POI_NAME_CHARS = 3;

/**
 * Ceiling on how many POI rows are even considered for selection. `pagecontext`
 * already caps its extraction, but Engine L (PLAN.md L1) can also feed this
 * list, and page-derived arrays get an explicit bound before they are walked.
 */
export const A2_MAX_POI_CANDIDATES = 40;

// ---------------------------------------------------------------------------
// entry point
// ---------------------------------------------------------------------------

/**
 * Run A1, A2 and A3 over one page. Rules execute in order and their geocoder
 * calls are serialized: the real Nominatim client is behind a 1 req/s limiter,
 * so issuing them in parallel would only queue them anyway, and sequential
 * execution keeps signal order deterministic for the panel and the tests.
 *
 * Returns every signal that fired, including GRAY ones — the evidence table
 * shows what could not be checked as well as what failed.
 */
export async function runEngineA(input: EngineAInput): Promise<Signal[]> {
  const signals: Signal[] = [];

  const a1 = guardSync('A1', 'enginea.checkFailed.title.slugVsName', () => runA1(input));
  if (a1) signals.push(a1);

  const a2 = await guard('A2', 'enginea.checkFailed.title.landmarkGeography', () => runA2(input));
  if (a2) signals.push(a2);

  const a3 = await guard('A3', 'enginea.checkFailed.title.breadcrumbCity', () => runA3(input));
  if (a3) signals.push(a3);

  return signals;
}

// ---------------------------------------------------------------------------
// A1 — slug vs displayed name
// ---------------------------------------------------------------------------

/** Does this token contain any Latin letter? See `runA1`. */
const HAS_LATIN = /\p{Script=Latin}/u;

/**
 * A1: the URL slug is fossilized history. Booking derives it from the property
 * name when the listing is created and never rewrites it on rename, so a slug
 * that shares nothing with the displayed name is evidence the listing was
 * repurposed — the loudest signal available on a first visit.
 *
 * Comparison is script-bound (see the note in lib/text.ts): a Latin slug and a
 * name written in another script share no tokens, and `tokenOverlap` returns 0
 * for that, which is indistinguishable from a hijack. So the name is reduced to
 * its Latin-script tokens first. If none remain the rule is GRAY — not
 * comparable — rather than RED. On the measured corpus every name is Latin, so
 * this filter is a no-op there and the calibration above is unaffected; it only
 * ever suppresses an accusation, never manufactures one.
 *
 * The comparison is word-by-word, which is exactly what a slug that ran the
 * name together defeats — see `concatenatedSpellings`, which repairs that
 * before the score is read.
 *
 * A low score is then read together with the amount of evidence behind it
 * (A1_MIN_DISCRIMINATING_NAME_TOKENS):
 *
 *   ≥2 identity words, none explained by the slug   → RED
 *    1 identity word, unexplained                   → YELLOW  (thin, still shown)
 *    0 identity words (the name is "The Hotel")     → GRAY    (nothing to judge)
 */
function runA1({ identity, slug }: EngineAInput): Signal | undefined {
  // No slug at all means the platform's URLs carry no name (Airbnb's
  // `/rooms/<id>`). That is a missing signal, not a failed check.
  if (slug === undefined) return undefined;
  const slugToks = slugTokens(slug);
  const nameToks = tokenize(identity.name);

  // Nothing to compare on one side or the other: no slug, or a name that is
  // pure punctuation/numbers. Silence, not a score — there is no observation.
  if (slugToks.length === 0 || nameToks.length === 0) return undefined;

  const latinNameToks = nameToks.filter((token) => HAS_LATIN.test(token));
  if (latinNameToks.length === 0) {
    return {
      id: 'A1',
      engine: 'A',
      severity: 'GRAY',
      ...prose('enginea.a1.notComparable.title', 'enginea.a1.notComparable.detail'),
      values: [
        row('enginea.value.urlSlug', slug),
        row('enginea.value.displayedName', identity.name),
      ],
    };
  }

  // A slug that ran the name's words together explains the name perfectly and
  // matches none of its words, so the concatenation pass runs first and the
  // score is read off the repaired comparison.
  const spellings = concatenatedSpellings(slugToks, latinNameToks);
  const overlap = tokenOverlap(
    spellings.length === 0 ? slugToks : slugToks.concat(spellings),
    latinNameToks,
  );
  if (overlap >= A1_MIN_SLUG_NAME_OVERLAP) return undefined;

  // How much of the name actually carries identity. Category words ("hotel",
  // "residence") are already outside `tokenOverlap`'s denominator; this is the
  // size of that denominator, i.e. how many words the accusation rests on.
  const identityWords = discriminatingTokenCount(latinNameToks);

  const values: EvidenceValue[] = [
    row('enginea.value.urlSlug', slug),
    row('enginea.value.displayedName', identity.name),
    row('enginea.value.slugWords', slugToks.join(', ')),
    row('enginea.value.nameWordsCompared', latinNameToks.join(', ')),
    // The check compares the words *and* the run-together spellings, so the
    // table shows both. Reaching this line means neither agreed: these two
    // strings are the concatenation test the reader can redo by eye.
    row('enginea.value.slugRunTogether', slugToks.join('')),
    row('enginea.value.nameRunTogether', latinNameToks.join('')),
    proseRow('enginea.value.overlap', 'enginea.value.overlapFlagged', {
      overlap: overlap.toFixed(2),
      threshold: A1_MIN_SLUG_NAME_OVERLAP.toFixed(2),
    }),
    row('enginea.value.identityWords', String(identityWords)),
  ];

  if (identityWords === 0) {
    return {
      id: 'A1',
      engine: 'A',
      severity: 'GRAY',
      ...prose('enginea.a1.noIdentityWords.title', 'enginea.a1.noIdentityWords.detail'),
      values,
    };
  }

  const thin = identityWords < A1_MIN_DISCRIMINATING_NAME_TOKENS;
  const severity: SignalSeverity = thin ? 'YELLOW' : 'RED';

  // Thin and full are separate sentences, not a stem plus a bolted-on clause:
  // the qualification belongs wherever the reader's language puts it.
  return {
    id: 'A1',
    engine: 'A',
    severity,
    ...(thin
      ? prose('enginea.a1.titleThin', 'enginea.a1.detailThin')
      : prose('enginea.a1.title', 'enginea.a1.detail')),
    values,
  };
}

/** A concatenation of adjacent tokens, and how many of them went into it. */
interface JoinedRun {
  text: string;
  words: number;
}

/** Every concatenation of 1…A1_MAX_JOINED_WORDS adjacent tokens, in order. */
function joinedRuns(tokens: readonly string[]): JoinedRun[] {
  const runs: JoinedRun[] = [];
  const capped = tokens.slice(0, A1_MAX_TOKENS_JOINED);
  for (let i = 0; i < capped.length; i++) {
    let text = '';
    for (let j = i; j < capped.length && j - i < A1_MAX_JOINED_WORDS; j++) {
      text += capped[j];
      runs.push({ text, words: j - i + 1 });
    }
  }
  return runs;
}

/**
 * Levenshtein distance ≤ 1, decided without building a matrix.
 *
 * For a budget of exactly one edit the general algorithm collapses: strings of
 * equal length differ by at most one substitution, strings whose lengths differ
 * by one differ by at most one insertion, and anything further apart in length
 * cannot be reached. Both branches are a single scan, which is what lets this
 * run inside a nested loop over page-supplied text. Compared in code points, so
 * an astral-plane character costs one edit rather than two.
 */
function withinOneEdit(a: string, b: string): boolean {
  if (a === b) return true;
  // Ordered by code points, not by `String.length`: a name written in an astral
  // script can be the longer string by UTF-16 units and the shorter one by
  // characters, and the scan below is only sound with the true shorter side.
  const left = Array.from(a);
  const right = Array.from(b);
  const [short, long] = left.length <= right.length ? [left, right] : [right, left];
  if (long.length - short.length > 1) return false;

  if (long.length === short.length) {
    let differences = 0;
    for (let i = 0; i < short.length; i++) {
      if (short[i] !== long[i] && ++differences > 1) return false;
    }
    return true;
  }

  // One longer: the only way to reach it is by skipping a single character.
  let i = 0;
  let j = 0;
  let skipped = false;
  while (i < short.length && j < long.length) {
    if (short[i] === long[j]) {
      i++;
      j++;
      continue;
    }
    if (skipped) return false;
    skipped = true;
    j++;
  }
  return true;
}

/**
 * The name's own words, glued, wherever the slug spells them that way — the
 * repair for A1's one structural blind spot.
 *
 * A1 scores word against word, and the platform does not always publish words.
 * "Hôtel Le Colisée" is served at `/hotel/fr/lecolise.html`: the slug is the
 * name with the spaces and the accents taken out (and, here, one trailing
 * letter lost as well). Word-by-word, that slug explains nothing — one slug
 * token matching no name token, overlap 0.00 — and A1 accused a real hotel of
 * being a hijack on evidence that actually says the opposite. `tokenOverlap`
 * already credits the exact form of this ("strandpalace" ≡ Strand Palace); what
 * it cannot credit is the near miss, and the near miss is what the platform
 * produced.
 *
 * So: every run of adjacent NAME words is glued and compared against every
 * glued run of SLUG words, and a run the slug spells to within one character
 * (`withinOneEdit`) is handed back. `runA1` appends those
 * strings to the slug side, which lets the shared, tested `tokenOverlap` do the
 * crediting — it sees the run verbatim and credits every word inside it — with
 * no second scoring path to keep in step with the first.
 *
 * Three bounds keep this from becoming a way to disarm the rule, because a
 * comparison that forgives too much turns the fossil slug into a rubber stamp:
 *
 *  - **Only genuine concatenations.** The run must span ≥2 name words. The
 *    tolerance is for a missing separator, not for a misspelled word: a
 *    one-word "near match" is a different and much looser claim, and it is the
 *    one that costs detection (`parisien` would come to explain "Parisian",
 *    a different property, and clear it).
 *  - **One character, and only above A1_MIN_CONCATENATION_CHARS.** The budget
 *    is one edit, structurally — `withinOneEdit` is only decidable in a single
 *    scan because it is one — over six characters or more; below that a single
 *    letter is too much of the identity to give away. Each further edit
 *    multiplies the set of names a fossil slug could be said to explain, which
 *    is the detector being disarmed one character at a time.
 *  - **Both sides bounded** by A1_MAX_TOKENS_JOINED and A1_MAX_JOINED_WORDS.
 *
 * Measured over 63 real Booking slug/name pairs (12 property pages in ten
 * locales plus every result card in fixtures/live-search): 4 slugs carry no
 * separator at all, 3 pairs glue words exactly, and this pass changes the score
 * of exactly one legitimate pair besides Le Colisée — upward, 0.80 → 1.00, on a
 * listing that already passed. Run against all 3906 mismatched cross-pairs of
 * that corpus — every one of which is a different property, i.e. the shape A1
 * exists to catch — it moves not a single one across the threshold, and both
 * real in-the-wild hijacks stay at 0.000 with no run rescued: the nearest any
 * glued name run comes to any glued slug run is 3 edits for the alpine-slug
 * hijack and 11 for the gîte, against a budget of 1.
 */
function concatenatedSpellings(slugToks: string[], nameToks: string[]): string[] {
  const slugRuns = joinedRuns(slugToks).filter(
    (run) => Array.from(run.text).length >= A1_MIN_CONCATENATION_CHARS,
  );
  if (slugRuns.length === 0) return [];

  const spellings: string[] = [];
  for (const nameRun of joinedRuns(nameToks)) {
    if (nameRun.words < 2) continue;
    if (Array.from(nameRun.text).length < A1_MIN_CONCATENATION_CHARS) continue;
    // An exact match needs no help: tokenOverlap already credits it.
    if (slugRuns.some((slugRun) => slugRun.text !== nameRun.text && withinOneEdit(slugRun.text, nameRun.text))) {
      spellings.push(nameRun.text);
    }
  }
  return spellings;
}

// ---------------------------------------------------------------------------
// A2 — nearby landmarks vs coordinates
// ---------------------------------------------------------------------------

interface PoiMeasurement {
  name: string;
  /** Distance the page claims, km, when it printed one. */
  statedKm?: number;
  /** Distance actually measured from the listing's coordinates, km. */
  realKm: number;
  /** The geocoder's canonical name for what it matched — provenance. */
  matched: string;
}

/**
 * A2: the page prints its own claimed distance to each nearby landmark. Geocode
 * the landmarks, measure the real distance from the listing's own coordinates,
 * and take the median. A hijacked listing keeps the previous property's
 * neighbourhood copy, so the stated distances stay small while the real ones
 * are hundreds of kilometres.
 *
 * Two ways to fail, either one RED:
 *   (a) the landmarks are simply nowhere near the coordinates
 *       (median real distance > A2_MAX_MEDIAN_DISTANCE_KM), **and** the page
 *       does not itself admit they are far — see below;
 *   (b) the page contradicts itself (median |real − stated| >
 *       A2_MAX_MEDIAN_DISCREPANCY_KM).
 *
 * The gate on (a) is a deliberate false-positive guard beyond PLAN.md's
 * wording. A property whose landmark list really is 60 km out and which *says*
 * 60 km is self-consistent: it is a remote hotel describing itself honestly,
 * not a hijack. Firing (a) there would be a pure false positive, and it costs
 * nothing in detection, because a hijack's stolen copy states small distances
 * and therefore trips (b) instead. Self-consistency only silences (a) when it is
 * established on enough rows (A2_MIN_STATED_FOR_DISCREPANCY) and those rows are
 * a majority of the sample.
 */
async function runA2({ identity, context, geocoder }: EngineAInput): Promise<Signal | undefined> {
  const origin = coordinatesOf(identity);
  if (!origin) return noCoordinates('A2', 'enginea.noCoordinates.detail.landmarks');

  const selected = selectPois(context.pois);
  const measurements: PoiMeasurement[] = [];

  for (const poi of selected) {
    const match = await safeGeocode(geocoder, poi.name, identity.country);
    if (!match) continue;
    const realKm = haversineKm(origin, match);
    // NaN means the geocoder handed back something that is not a coordinate.
    // Drop it: an unmeasured landmark is unknown, and unknown is not agreement.
    if (!Number.isFinite(realKm)) continue;
    measurements.push({
      name: poi.name,
      statedKm: usableStatedKm(poi),
      realKm,
      matched: match.displayName,
    });
  }

  if (measurements.length < A2_MIN_GEOCODED_POIS) {
    return {
      id: 'A2',
      engine: 'A',
      severity: 'GRAY',
      ...prose('enginea.a2.unverified.title', 'enginea.a2.unverified.detail', {
        min: A2_MIN_GEOCODED_POIS,
      }),
      values: [
        listingCoordinates(origin),
        row('enginea.value.landmarksOnPage', String(context.pois.length)),
        row('enginea.value.landmarksLookedUp', String(selected.length)),
        row('enginea.value.landmarksLocated', String(measurements.length)),
      ],
    };
  }

  const realMedian = median(measurements.map((m) => m.realKm));
  const discrepancies = measurements
    .filter((m) => m.statedKm !== undefined)
    .map((m) => Math.abs(m.realKm - (m.statedKm as number)));
  const discrepancyMedian =
    discrepancies.length >= A2_MIN_STATED_FOR_DISCREPANCY ? median(discrepancies) : undefined;

  const contradicted =
    discrepancyMedian !== undefined && discrepancyMedian > A2_MAX_MEDIAN_DISCREPANCY_KM;

  // Self-consistency may only silence (a) when the rows that demonstrate it are
  // most of the sample. A page that prints honest distances for three landmarks
  // and stays silent about three others that are 500 km away has not explained
  // itself — a minority of vouching rows must not cover the rows they say
  // nothing about. Strict majority, so a 3-of-6 split still fires.
  const selfConsistent =
    discrepancyMedian !== undefined &&
    discrepancyMedian <= A2_MAX_MEDIAN_DISCREPANCY_KM &&
    2 * discrepancies.length > measurements.length;
  const displaced =
    realMedian !== undefined && realMedian > A2_MAX_MEDIAN_DISTANCE_KM && !selfConsistent;

  if (!contradicted && !displaced) return undefined;

  const values: EvidenceValue[] = [
    listingCoordinates(origin),
    proseRow('enginea.value.landmarksLocated', 'enginea.value.landmarksLocatedOf', {
      located: measurements.length,
      lookedUp: selected.length,
    }),
    distanceRow('enginea.value.medianRealDistance', realMedian),
  ];
  if (discrepancyMedian !== undefined) {
    values.push(distanceRow('enginea.value.medianGap', discrepancyMedian));
  }
  for (const m of measurements) values.push(measurementRow(m));

  return {
    id: 'A2',
    engine: 'A',
    severity: 'RED',
    ...(contradicted
      ? prose('enginea.a2.contradicted.title', 'enginea.a2.contradicted.detail')
      : prose('enginea.a2.displaced.title', 'enginea.a2.displaced.detail')),
    values,
    links: [mapLink(origin)],
  };
}

/**
 * Choose which landmarks are worth the geocoder budget.
 *
 * Landmarks that come with a stated distance go first: they enable A2(b), the
 * self-contradiction test, which is both the sharpest signal and the one immune
 * to a property being legitimately remote. Page order is preserved inside each
 * group, which matters — Booking prints the true neighbourhood first and the
 * "closest airports" block last, so taking from the front biases the sample
 * toward landmarks that should be genuinely close.
 *
 * Duplicates are folded out before spending calls on them.
 */
function selectPois(pois: readonly PoiMention[]): PoiMention[] {
  const seen = new Set<string>();
  const withStated: PoiMention[] = [];
  const withoutStated: PoiMention[] = [];

  for (const poi of pois.slice(0, A2_MAX_POI_CANDIDATES)) {
    const name = poi.name.trim();
    if (Array.from(name).length < A2_MIN_POI_NAME_CHARS) continue;
    const key = normalizeForCompare(name);
    if (key.length === 0 || seen.has(key)) continue;
    seen.add(key);
    if (usableStatedKm(poi) === undefined) withoutStated.push(poi);
    else withStated.push(poi);
  }

  // `concat`, not spread: these arrays are page-length and the house rule is
  // never to spread one (RangeError at ~100k elements on hostile input).
  return withStated.concat(withoutStated).slice(0, A2_MAX_GEOCODE_CALLS);
}

/**
 * The page's stated distance, when it is a number we can subtract. A negative
 * or non-finite value is a parse artefact; treating it as 0 would read as "on
 * site" and could suppress a discrepancy, so it becomes "not stated" instead.
 */
function usableStatedKm(poi: PoiMention): number | undefined {
  const stated = poi.statedDistanceKm;
  if (stated === undefined || !Number.isFinite(stated) || stated < 0) return undefined;
  return stated;
}

/**
 * One landmark's row. The label is the landmark's own name as the page printed
 * it, so it carries no catalog key — translating a place name would be a lie
 * about what the page says.
 */
function measurementRow(m: PoiMeasurement): EvidenceValue {
  // Both distances are finite by construction — `runA2` drops any landmark
  // whose measured distance is not, and `usableStatedKm` refuses a stated one
  // that is not — so the numbers here always format as numbers.
  const real = kmNumber(m.realKm);
  const valueMsg =
    m.statedKm === undefined
      ? msg('enginea.value.landmarkRow.noDistance', { real, matched: m.matched })
      : msg('enginea.value.landmarkRow.stated', {
          real,
          stated: kmNumber(m.statedKm),
          matched: m.matched,
        });
  return { label: m.name, value: english(valueMsg), valueMsg };
}

// ---------------------------------------------------------------------------
// A3 — breadcrumb place vs coordinates
// ---------------------------------------------------------------------------

/** One trail lookup: what we asked, what came back, how far away it is. */
interface TrailLookup {
  /** Exactly the string handed to the geocoder — what the evidence table prints. */
  query: string;
  match: GeocodeResult;
  /** Finite by construction; `locateTrail` drops anything else. */
  distanceKm: number;
}

/**
 * A3: the breadcrumb trail is the platform's own filing of this property —
 * country › region › city › district. If the place that trail describes is a
 * long way from the coordinates the same page publishes, one of the two is
 * inherited from a different listing. YELLOW: weaker evidence than A1/A2, and
 * normally one geocoder call.
 *
 * The trail is localized — "Home"/"Startseite"/"Αρχική σελίδα"/"ホーム" — so
 * nothing here matches place names against a word list. What it does instead is
 * ask the geocoder about the *path* rather than about one entry of it (see
 * A3_MAX_QUERY_LEVELS), because picking a single entry is what this rule used to
 * do and it is what broke it: the trail "Accueil › Hôtels › France ›
 * Île-de-France › Paris › 6e arr." has its city one level further up than
 * "… › Ελλάδα › Αττική › Αθήνα" does, and a rule reading a fixed position read
 * "8th arr." out of a Paris hotel's trail, geocoded it bare, and was answered
 * with Lyon's 8th arrondissement 400 km away. Nothing on that page contradicted
 * anything; the lookup did.
 *
 * Hence the second half of the rule, which matters more than the query: a
 * geocoder answer is not automatically evidence. Before A3 will accuse a page,
 * the answer has to look like the place we asked about — see `trailIsEchoedBy`
 * — and when it does not, the trail is asked one level wider in a lookup that
 * may only CLEAR the listing, never condemn it (`clearedByWiderTrail`). Every
 * path where the geography could not be established honestly ends in GRAY.
 */
async function runA3({ identity, context, geocoder }: EngineAInput): Promise<Signal | undefined> {
  const levels = breadcrumbPlaces(context.breadcrumbs, identity.name);
  if (!levels) return undefined;

  const origin = coordinatesOf(identity);
  if (!origin) return noCoordinates('A3', 'enginea.noCoordinates.detail.breadcrumbCity');

  const query = placeQuery(levels);
  const found = await locateTrail(geocoder, query, identity.country, origin);

  // The trail and the map agree. Nothing to report — and no second call.
  if (found && found.distanceKm <= A3_MAX_CITY_DISTANCE_KM) return undefined;

  if (found && trailIsEchoedBy(found.match.displayName, levels)) {
    return {
      id: 'A3',
      engine: 'A',
      severity: 'YELLOW',
      ...prose('enginea.a3.title', 'enginea.a3.detail'),
      values: [
        ...trailEvidence(found, origin),
        proseRow('enginea.value.distanceApart', 'enginea.value.distanceApartFlagged', {
          distance: kmNumber(found.distanceKm),
          threshold: A3_MAX_CITY_DISTANCE_KM,
        }),
      ],
      links: [mapLink(origin)],
    };
  }

  // Either nothing came back, or what came back is far away AND names a place
  // this trail never mentions. Both are facts about the lookup rather than
  // about the listing, so neither may accuse it. Ask the same trail one level
  // wider — an answer there can exonerate the page, and nothing more.
  if (await clearedByWiderTrail(geocoder, levels, identity.country, origin)) return undefined;

  return found === undefined
    ? {
        id: 'A3',
        engine: 'A',
        severity: 'GRAY',
        ...prose('enginea.a3.unresolved.title', 'enginea.a3.unresolved.detail'),
        values: [row('enginea.value.breadcrumbCity', query), listingCoordinates(origin)],
      }
    : {
        id: 'A3',
        engine: 'A',
        severity: 'GRAY',
        ...prose('enginea.a3.inconsistent.title', 'enginea.a3.inconsistent.detail'),
        // The plain distance row, not the "(flagged above 50 km)" one: this
        // measurement is being reported precisely because it is not trusted,
        // and dressing it as a threshold breach would read as the accusation
        // this branch exists to withhold.
        values: [
          ...trailEvidence(found, origin),
          distanceRow('enginea.value.distanceApart', found.distanceKm),
        ],
      };
}

/**
 * The rows every A3 outcome that reached the geocoder shows: what we asked,
 * what the provider answered, and where the listing says it is.
 *
 * The first row is the query verbatim. It used to be the single token the rule
 * had picked, which was already the whole story — the user in the bug report
 * was shown "8th arr." and a display name in Lyon and could see the check had
 * gone wrong. Printing anything other than the exact string we sent would take
 * that away.
 */
function trailEvidence(found: TrailLookup, origin: LatLng): EvidenceValue[] {
  return [
    row('enginea.value.breadcrumbCity', found.query),
    row(
      'enginea.value.cityLocatedAt',
      `${formatPoint(found.match)} — ${found.match.displayName}`,
    ),
    listingCoordinates(origin),
  ];
}

/** Geocode one trail query and measure it. Unusable answers are `undefined`. */
async function locateTrail(
  geocoder: Geocoder,
  query: string,
  country: string | undefined,
  origin: LatLng,
): Promise<TrailLookup | undefined> {
  const match = await safeGeocode(geocoder, query, country);
  if (!match) return undefined;
  const distanceKm = haversineKm(origin, match);
  return Number.isFinite(distanceKm) ? { query, match, distanceKm } : undefined;
}

/**
 * The nested places a breadcrumb trail names, general to specific, or undefined
 * when the trail does not carry enough of them to ask a safe question.
 *
 * Three things are taken out, and each one is a measured shape rather than a
 * guess about this or that platform:
 *
 *  - **The first entry.** Index 0 of a breadcrumb trail is the way back to the
 *    top of the site ("Home", "Startseite", "ホーム", "Hotels"). It is a link,
 *    not a place, in all 15 live trails measured.
 *  - **Entries that carry no identifying word.** The category rows platforms
 *    put under the root — "Hotels", "Hôtels", "Hoteles", "Ξενοδοχεία",
 *    "ホテル" — are exactly the words `lib/text.ts` already knows carry no
 *    identity, so they are dropped without a locale-specific list. A real place
 *    keeps at least one discriminating token ("Le Havre" → havre).
 *  - **A trailing row that names the property**, but only when the trail can
 *    spare it (see A3_MIN_PROPERTY_NAME_OVERLAP). Booking ends with a marketing
 *    string; other trails end at the city itself. When dropping it would leave
 *    the query thinner than one qualified path, it is kept: a junk level makes
 *    a query the geocoder answers with nothing, which is GRAY, while dropping a
 *    city promotes a region centroid into the comparison — measured 130 km from
 *    Rimini, 256 km from Manhattan — which is a false accusation.
 *
 * Parenthesised qualifiers are dropped from each level ("New York State (NY)" →
 * "New York State"): they disambiguate for humans and are noise to a geocoder.
 */
function breadcrumbPlaces(breadcrumbs: readonly string[], name: string): string[] | undefined {
  if (breadcrumbs.length < A3_MIN_BREADCRUMB_DEPTH) return undefined;

  const levels = breadcrumbs.slice(1).map(cleanLevel).filter(isPlaceLevel);
  const last = levels[levels.length - 1];
  const kept =
    last !== undefined && levels.length > A3_MAX_QUERY_LEVELS && namesTheProperty(last, name)
      ? levels.slice(0, -1)
      : levels;

  const capped = kept.slice(-A3_MAX_QUERY_LEVELS);
  return capped.length >= A3_MIN_QUERY_LEVELS ? capped : undefined;
}

function cleanLevel(raw: string): string {
  return raw.replace(/\([^()]*\)/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Two code points: enough for 東京, not enough to be a stray separator. */
function isPlaceLevel(level: string): boolean {
  if (Array.from(level).length < 2) return false;
  return discriminatingTokenCount(tokenize(level)) > 0;
}

/** Does this trail row repeat the property's own name rather than name a place? */
function namesTheProperty(level: string, name: string): boolean {
  const levelTokens = tokenize(level);
  const nameTokens = tokenize(name);
  if (levelTokens.length === 0 || nameTokens.length === 0) return false;
  return tokenOverlap(levelTokens, nameTokens) >= A3_MIN_PROPERTY_NAME_OVERLAP;
}

/**
 * The geocoder query for a set of levels: most specific first, as a place path
 * — "Marina Centro, Rimini, Emilia-Romagna". That is the order every geocoder
 * reads an address in, and the reverse of the order a breadcrumb trail is
 * written in.
 */
function placeQuery(levels: readonly string[]): string {
  return [...levels].reverse().join(', ');
}

/**
 * Does the answer look like the place we asked about?
 *
 * The consistency guard, and the reason a wrong geocode can no longer become an
 * accusation. A provider's `display_name` is the full administrative hierarchy
 * of what it matched, and the query carried the trail's own hierarchy, so the
 * two are directly comparable: if we asked with "Paris" and "Île-de-France" in
 * the query and the answer names Lyon, Rhône and Auvergne-Rhône-Alpes, the
 * provider did not answer our question. That is evidence the LOOKUP is wrong,
 * not that the listing is, and PLAN.md's first-class GRAY says an unreliable
 * lookup degrades to "could not check" rather than to a flag.
 *
 * Only the ancestors are checked, never the most specific level. The Lyon
 * answer repeats "8th arr." perfectly — matching the deepest token in the wrong
 * hierarchy is precisely how it went wrong — so accepting that as agreement
 * would accept the failure it is meant to catch. Every token of an ancestor
 * must be present, or "France" alone would vouch for "Île-de-France".
 *
 * Comparison runs through `lib/text.ts`'s tokenizer, so the trail's spelling
 * and the provider's fold together: "Ile de France" against "Île-de-France",
 * "Misericordia" against "Misericórdia". Measured over fixtures/live/, every
 * resolving trail passes this and the reported Lyon answer does not.
 */
function trailIsEchoedBy(displayName: string, levels: readonly string[]): boolean {
  const answer = new Set(tokenize(displayName));
  if (answer.size === 0) return false;
  return levels.slice(0, -1).some((level) => {
    const tokens = tokenize(level);
    return tokens.length > 0 && tokens.every((token) => answer.has(token));
  });
}

/**
 * Ask the same trail one level wider, and report only whether that clears the
 * listing.
 *
 * Reached when the specific query produced nothing usable — "6e arr., Paris,
 * Île-de-France" is a real trail and Nominatim has no such place — or produced
 * an answer the guard rejected. Dropping the deepest level asks about the city
 * instead ("Paris, Île-de-France"), which is the question A3 always wanted an
 * answer to, and on the reported page it answers 2.5 km from the listing: the
 * page is fine and the user should see nothing at all.
 *
 * Deliberately asymmetric. This lookup can exonerate but never accuse, because
 * it is built on the level ABOVE the one the trail actually specified, and
 * levels above a city get large fast: a query that fell back onto "New York
 * State" answers 256 km from Manhattan and one that fell back onto
 * "Emilia-Romagna" 130 km from Rimini. Believing those would manufacture
 * exactly the false accusation this whole rule is being repaired for, so a far
 * answer here buys nothing and A3 stays GRAY. Never runs below three levels,
 * where the level above is a country.
 */
async function clearedByWiderTrail(
  geocoder: Geocoder,
  levels: readonly string[],
  country: string | undefined,
  origin: LatLng,
): Promise<boolean> {
  if (levels.length <= A3_MIN_QUERY_LEVELS) return false;
  const wider = levels.slice(0, -1);
  const found = await locateTrail(geocoder, placeQuery(wider), country, origin);
  return found !== undefined && found.distanceKm <= A3_MAX_CITY_DISTANCE_KM;
}

// ---------------------------------------------------------------------------
// shared helpers
// ---------------------------------------------------------------------------

/**
 * A signal's prose, authored once. The sentences live in the catalog; this
 * renders the English the tests and every non-panel consumer read, and hands
 * the panel the same keys to render in the user's language. Params are the
 * detail's — no title in this engine interpolates anything.
 */
function prose(
  titleKey: MessageKey,
  detailKey: MessageKey,
  detailParams?: Record<string, string | number>,
): Pick<Signal, 'title' | 'detail' | 'titleMsg' | 'detailMsg'> {
  const titleMsg = msg(titleKey);
  const detailMsg = msg(detailKey, detailParams);
  return { title: english(titleMsg), detail: english(detailMsg), titleMsg, detailMsg };
}

/**
 * An evidence row whose value is evidence: a number, a coordinate, a quantity,
 * or words the page itself supplied. Only the label is keyed — rewriting what
 * we measured or what the page said would be rewriting the proof.
 */
function row(labelKey: MessageKey, value: string): EvidenceValue {
  const labelMsg = msg(labelKey);
  return { label: english(labelMsg), value, labelMsg };
}

/**
 * An evidence row whose value is a sentence *we* wrote around the facts —
 * "3 of 6 looked up", "0.00 (flagged below 0.25)". Both halves are keyed; the
 * facts travel as params.
 */
function proseRow(
  labelKey: MessageKey,
  valueKey: MessageKey,
  valueParams?: Record<string, string | number>,
): EvidenceValue {
  const valueMsg = msg(valueKey, valueParams);
  return { ...row(labelKey, english(valueMsg)), valueMsg };
}

/**
 * A row whose whole value is one distance. The number is the measurement and
 * travels as a param; "km" is a word and lives in the catalog with the rest of
 * them. A distance we could not compute is a different word again, so it is a
 * different key rather than a hole in this one.
 */
function distanceRow(labelKey: MessageKey, km: number | undefined): EvidenceValue {
  if (km === undefined || !Number.isFinite(km)) {
    return proseRow(labelKey, 'enginea.value.distanceUnknown');
  }
  return proseRow(labelKey, 'enginea.value.distanceKm', { km: kmNumber(km) });
}

/**
 * Half-width of the box around 0°N 0°E treated as "no coordinates", degrees.
 * ~0.1 m: tight enough that it can only ever catch an exact sentinel, wide
 * enough to survive a float round-trip through JSON or a DOM attribute.
 */
const NULL_ISLAND_EPSILON_DEG = 1e-6;

/**
 * The listing's own coordinates, or undefined. Absent or non-finite values are
 * the GRAY path for A2 and A3 — without an origin there is nothing to measure
 * from, and inventing one (null island, the city centroid) would fabricate a
 * result.
 *
 * (0, 0) is rejected as exactly that invention. It is the classic shape of a
 * coordinate that was never filled in — a zeroed field, a default struct, a
 * numeric coercion of something empty — and it sits in open water in the Gulf
 * of Guinea, where no property is. Measured from there, every real landmark on
 * the page lands thousands of kilometres away and A2 returns a confident RED
 * built entirely on a missing value. GRAY is the honest answer, and this is the
 * one coordinate where refusing to measure cannot cost a real detection.
 */
function coordinatesOf(identity: IdentityVector): LatLng | undefined {
  const { lat, lng } = identity;
  if (lat === undefined || lng === undefined) return undefined;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return undefined;
  if (Math.abs(lat) < NULL_ISLAND_EPSILON_DEG && Math.abs(lng) < NULL_ISLAND_EPSILON_DEG) {
    return undefined;
  }
  return { lat, lng };
}

/**
 * `detailKey` names the whole sentence, one per rule, rather than posting the
 * missing noun in as a fragment: "landmark geography" and "the breadcrumb
 * city" decline differently once the sentence is not English.
 */
function noCoordinates(id: string, detailKey: MessageKey): Signal {
  return {
    id,
    engine: 'A',
    severity: 'GRAY',
    ...prose('enginea.noCoordinates.title', detailKey),
  };
}

/**
 * A geocode that cannot throw. A provider that is down, rate-limited or
 * answering with garbage must degrade this engine to GRAY, never to RED and
 * never to an exception escaping into the verdict.
 */
async function safeGeocode(
  geocoder: Geocoder,
  query: string,
  country: string | undefined,
): Promise<GeocodeResult | null> {
  try {
    const countryCode = country?.trim();
    const result = await geocoder.geocode(
      query,
      countryCode ? { countryCode } : undefined,
    );
    return result ?? null;
  } catch {
    return null;
  }
}

/**
 * Run an async rule; an unexpected throw becomes GRAY rather than a lost
 * verdict. `failureTitleKey` names the whole "X could not be checked"
 * sentence — the rule's name is the subject of it, not a fragment glued on.
 */
async function guard(
  id: string,
  failureTitleKey: MessageKey,
  run: () => Promise<Signal | undefined>,
): Promise<Signal | undefined> {
  try {
    return await run();
  } catch {
    return checkFailed(id, failureTitleKey);
  }
}

/** `guard` for the rule that does no I/O. */
function guardSync(
  id: string,
  failureTitleKey: MessageKey,
  run: () => Signal | undefined,
): Signal | undefined {
  try {
    return run();
  } catch {
    return checkFailed(id, failureTitleKey);
  }
}

function checkFailed(id: string, titleKey: MessageKey): Signal {
  return {
    id,
    engine: 'A',
    severity: 'GRAY',
    ...prose(titleKey, 'enginea.checkFailed.detail'),
  };
}

/**
 * The number half of a distance in kilometres — just the digits. The unit is a
 * word, so it belongs in the catalog sentence that surrounds this
 * ('enginea.value.distanceKm', the landmark rows, the A3 aside), the way Engine
 * B already writes it. Gluing " km" on here would ship one untranslatable word
 * inside every measurement the panel prints.
 *
 * Precision is the precision the inputs support and no further: geocoders
 * resolve a landmark to a building or to a whole park, so a third decimal on
 * 437 km would be theatre. Sub-kilometre values keep two decimals because that
 * is the range Booking's own "250 m" claims live in.
 *
 * Takes a finite number, and every caller establishes that first: `distanceRow`
 * tests it and answers a translatable "unknown" instead, `runA3` has already
 * returned GRAY on a non-finite distance, and `measurementRow`'s two values are
 * filtered by `runA2` and `usableStatedKm`. A distance that may be missing is
 * `distanceRow`'s business, not this function's.
 */
function kmNumber(km: number): string {
  return km.toFixed(km < 1 ? 2 : 1);
}

/** ~1 m of precision; enough to paste into a map, short enough to read. */
function formatPoint(point: LatLng): string {
  return `${point.lat.toFixed(5)}, ${point.lng.toFixed(5)}`;
}

function listingCoordinates(origin: LatLng): EvidenceValue {
  return row('enginea.value.listingCoordinates', formatPoint(origin));
}

/** Linkable proof: the coordinates the listing itself published, on a map. */
function mapLink(origin: LatLng): EvidenceLink {
  const lat = origin.lat.toFixed(5);
  const lng = origin.lng.toFixed(5);
  const labelMsg = msg('enginea.link.map');
  return {
    label: english(labelMsg),
    labelMsg,
    href: `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lng}#map=14/${lat}/${lng}`,
  };
}
