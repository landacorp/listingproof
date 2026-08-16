import { describe, expect, it } from 'vitest';
import { reviewsMessages } from './i18n/en/reviews';
import type { ReviewItem, ReviewSet } from './reviews';
import {
  ageText,
  LOW_SCORE_MAX,
  scanReviews,
  SCANNED_LANGUAGES,
  TROUBLE_TERMS,
  type ReviewScan,
  type ReviewsText,
} from './reviewscan';
import { normalizeForCompare } from './text';

/**
 * The measured history this suite exists to keep buried.
 *
 * A keyword scan over 125 corpus reviews found zero true positives, and every
 * match it did produce was wrong: French `vol` inside Dutch *volgende*,
 * Italian *volta*, Spanish *Volvería*, and — scanning raw HTML — the
 * platform's own "so our Fraud team can investigate". So the collision cases
 * are pinned as NON-matches first, before anything is asserted about what does
 * match: a regression that makes the scanner louder is the failure mode that
 * costs an honest property its reputation.
 */

const NOW = Date.UTC(2026, 7, 16); // 2026-08-16, the corpus's reference day
const DAY = 86_400_000;
const daysAgo = (days: number): number => NOW - days * DAY;

const review = (item: Partial<ReviewItem>): ReviewItem => ({ ...item });
const setOf = (...items: ReviewItem[]): ReviewSet => ({ items });
const scanText = (text: string, lang?: string): ReviewScan =>
  scanReviews(setOf(review(lang === undefined ? { negative: text } : { negative: text, lang })), NOW);
const matchesFor = (text: string, lang?: string): ReviewScan['flagged'][number]['matches'] =>
  scanText(text, lang).flagged[0]?.matches ?? [];

// ---------------------------------------------------------------------------
// the collisions, pinned as silence
// ---------------------------------------------------------------------------

describe('the words that made the naive scanner 100% wrong', () => {
  it.each([
    // The four substring collisions that killed `vol` as a term.
    ['nl', 'De volgende keer boeken we hier weer.'],
    ['it', "Ci torneremo un'altra volta, davvero bello."],
    ['es', 'Volvería sin dudarlo, todo perfecto.'],
    ['nl', 'Het ontbijt was heerlijk en de kamer was vol licht.'],
    // …and `vol` standing entirely alone, which token matching would still
    // have hit if the term had merely been lengthened instead of dropped.
    ['fr', 'Notre vol avait du retard, mais la chambre nous attendait.'],
  ])('%s: %s → nothing', (lang, text) => {
    expect(matchesFor(text, lang)).toEqual([]);
  });

  it.each([
    // Each of these is an ordinary sentence in one language and a fraud word
    // in another. The term list refuses the bare form for exactly this reason.
    ['de: betrug is also the past tense of betragen', 'de', 'Die Rechnung betrug 200 Euro, wie angekündigt.'],
    ['es: golpe is a stroke of luck, not a scam', 'es', 'Fue un golpe de suerte encontrar este sitio.'],
    ['it: timo is thyme', 'it', 'Nel giardino crescono timo e rosmarino.'],
    ['pt: estafa is exhaustion', 'pt', 'Foi uma estafa subir a ladeira com as malas.'],
    ['es: burla is mockery', 'es', 'El precio del minibar es una burla.'],
  ])('%s', (_name, lang, text) => {
    expect(matchesFor(text, lang)).toEqual([]);
  });

  it('never matches inside a longer word — the whole substring failure', () => {
    // `scam` inside scampi, `fraud` inside a made-up compound, `frode` inside
    // an Italian word that merely starts the same way.
    expect(matchesFor('The scampi were excellent and the staff kind.')).toEqual([]);
    expect(matchesFor('Il frodello non esisteva in camera, ma va bene.')).toHaveLength(1);
    expect(matchesFor('Il frodello era ottimo.')).toEqual([]);
  });

  it('refuses a field that still contains markup instead of quoting the platform', () => {
    // The measured false positive: Booking's own furniture, scanned as text.
    const scan = scanReviews(
      setOf(review({ negative: '<p>Report it so our Fraud team can investigate.</p>' })),
      NOW,
    );
    expect(scan.flagged).toEqual([]);
    expect(scan.counts.markupFields).toBe(1);
    expect(scan.counts.troubleMatched).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// the review this module exists for
// ---------------------------------------------------------------------------

describe('a genuine hijack complaint', () => {
  const scan = scanReviews(
    setOf(
      review({
        id: 'r-1',
        rawScore: { value: 1, max: 10 },
        score: 1,
        reviewedAt: daysAgo(40),
        lang: 'en',
        negative: 'This was a scam. The address did not exist and nobody answered the phone.',
      }),
    ),
    NOW,
  );
  const flagged = scan.flagged[0];

  it('surfaces the review', () => {
    expect(scan.flagged).toHaveLength(1);
    expect(flagged.id).toBe('r-1');
    expect(flagged.lowScore).toBe(true);
    expect(flagged.matchesFound).toBe(2);
  });

  it('finds both claims and names them by category', () => {
    expect(flagged.matches.map((m) => m.category)).toEqual(['fraud', 'nonexistent']);
    expect(flagged.matches.map((m) => m.term)).toEqual(['scam', 'did not exist']);
    expect(flagged.matches.map((m) => m.field)).toEqual(['negative', 'negative']);
  });

  it('carries the guest\'s own sentence, verbatim, with every match', () => {
    expect(flagged.matches[0].quote).toBe('This was a scam.');
    expect(flagged.matches[1].quote).toBe(
      'The address did not exist and nobody answered the phone.',
    );
    expect(flagged.matches.every((m) => m.truncated === false)).toBe(true);
  });

  it('frames a match as a pointer, not a finding', () => {
    // The category sentence in the catalog must keep saying "read the quote".
    expect(reviewsMessages[flagged.matches[0].categoryMsg.key]).toMatch(/read the quote/i);
    expect(reviewsMessages[flagged.matches[1].categoryMsg.key]).toMatch(/read the quote/i);
  });
});

describe('trouble terms across the corpus languages', () => {
  it.each([
    ['en', 'Total scam, do not book.', 'fraud'],
    ['fr', "Nous avons été victimes d'une arnaque.", 'fraud'],
    ['fr', "L'adresse n'existe pas, personne sur place.", 'nonexistent'],
    ['es', 'Esto es una estafa, el piso no existe.', 'fraud'],
    ['pt', 'Foi uma burla, o endereço não existe.', 'fraud'],
    ['it', 'Una truffa: il palazzo non esiste.', 'fraud'],
    ['de', 'Wir wurden betrogen, die Adresse existiert nicht.', 'fraud'],
    ['nl', 'Pure oplichting, het adres bestaat niet.', 'fraud'],
    ['el', 'Η διεύθυνση δεν υπάρχει.', 'nonexistent'],
    ['en', 'The flat was not as described.', 'misrepresented'],
    ['de', 'Die Wohnung war nicht wie beschrieben.', 'misrepresented'],
  ])('%s: %s', (lang, text, category) => {
    const matches = matchesFor(text, lang);
    expect(matches.length).toBeGreaterThan(0);
    expect(matches.map((m) => m.category)).toContain(category);
  });

  it('reads a term regardless of the language the platform tagged the review with', () => {
    // The tag is the platform's guess (`lib/reviews.ts`: "not always right"),
    // so the whole list applies to every review — which is only safe because
    // no term is an innocent word in another language we scan.
    expect(matchesFor('Une arnaque totale.', 'de')).toHaveLength(1);
    expect(matchesFor('Une arnaque totale.')).toHaveLength(1);
  });

  it('separates two words that differ only by their article', () => {
    // pt "uma burla" is fraud; es "una burla" is mockery. Likewise es "una
    // estafa" is fraud while pt "uma estafa" is exhaustion.
    expect(matchesFor('Foi uma burla.').map((m) => m.term)).toEqual(['uma burla']);
    expect(matchesFor('Es una burla.')).toEqual([]);
    expect(matchesFor('Es una estafa.').map((m) => m.term)).toEqual(['una estafa']);
    expect(matchesFor('Foi uma estafa.')).toEqual([]);
  });

  it('folds case and diacritics without folding them into the quote', () => {
    const matches = matchesFor('Reine ABZOCKE, wir wurden von Betrügern abgezockt.');
    expect(matches.length).toBeGreaterThan(0);
    expect(matches[0].quote).toContain('ABZOCKE');
    expect(matches.some((m) => m.quote.includes('Betrügern'))).toBe(true);
  });

  it('reports which half of the review a match came from', () => {
    const scan = scanReviews(
      setOf(review({ title: 'A scam', positive: 'Nothing at all', negative: 'not as described' })),
      NOW,
    );
    const fields = scan.flagged[0].matches.map((m) => m.field);
    expect(fields).toContain('title');
    expect(fields).toContain('negative');
    expect(scan.flagged[0].matches.map((m) => m.fieldMsg.key)).toContain('reviews.field.title');
  });

  it('shows at most three matches but never hides how many there were', () => {
    const scan = scanReviews(
      setOf(
        review({
          negative: 'A scam. A fraud. The scammer lied. Fraudulent throughout. Not as described.',
        }),
      ),
      NOW,
    );
    expect(scan.flagged[0].matches).toHaveLength(3);
    expect(scan.flagged[0].matchesFound).toBe(5);
  });

  it('windows an over-long sentence and marks the cut', () => {
    const filler = 'the bedding was clean and the shower was hot and the staff were polite ';
    const scan = scanReviews(
      setOf(review({ negative: `${filler.repeat(4)}but honestly it was a scam ${filler.repeat(4)}` })),
      NOW,
    );
    const match = scan.flagged[0].matches[0];
    expect(match.truncated).toBe(true);
    expect(match.quote).toContain('scam');
    expect(match.quote.startsWith('…')).toBe(true);
    expect(match.quote.endsWith('…')).toBe(true);
    expect(match.quote.length).toBeLessThan(250);
  });
});

// ---------------------------------------------------------------------------
// term-list hygiene
// ---------------------------------------------------------------------------

describe('the term list itself', () => {
  it('is authored in the folded form the scanner compares against', () => {
    for (const { term } of TROUBLE_TERMS) {
      expect(normalizeForCompare(term), `"${term}" is not in folded form`).toBe(term);
    }
  });

  it('has no single-word term shorter than four characters', () => {
    // Below four characters accidental agreement stops being evidence — the
    // floor `lib/text.ts` uses, and the reason `vol` could never have shipped.
    for (const { term } of TROUBLE_TERMS) {
      if (term.includes(' ')) continue;
      expect(Array.from(term).length, `"${term}" is too short to mean anything`).toBeGreaterThanOrEqual(4);
    }
  });

  it('lists every term once and attributes each to at least one language', () => {
    const terms = TROUBLE_TERMS.map((entry) => entry.term);
    expect(new Set(terms).size).toBe(terms.length);
    for (const entry of TROUBLE_TERMS) expect(entry.langs.length).toBeGreaterThan(0);
  });

  it('does not claim to scan a language it ships no terms for', () => {
    // Japanese has no word boundaries and Turkish welds its suffixes on; both
    // are counted as uncovered rather than scanned by substring.
    expect(SCANNED_LANGUAGES.has('ja')).toBe(false);
    expect(SCANNED_LANGUAGES.has('tr')).toBe(false);
    expect(SCANNED_LANGUAGES.has('en')).toBe(true);
    expect(SCANNED_LANGUAGES.has('el')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// low scores, on the platform's own scale
// ---------------------------------------------------------------------------

describe('what counts as low', () => {
  const lowness = (item: Partial<ReviewItem>): boolean =>
    scanReviews(setOf(review(item)), NOW).counts.lowScore === 1;

  it.each([
    ['1 out of 5', { rawScore: { value: 1, max: 5 }, score: 2 }, true],
    ['2.5 out of 5, exactly half', { rawScore: { value: 2.5, max: 5 }, score: 5 }, true],
    ['3 out of 5', { rawScore: { value: 3, max: 5 }, score: 6 }, false],
    ['5 out of 10, exactly half', { rawScore: { value: 5, max: 10 }, score: 5 }, true],
    ['6 out of 10', { rawScore: { value: 6, max: 10 }, score: 6 }, false],
    ['no score at all', {}, false],
  ] as const)('%s → %s', (_name, item, expected) => {
    expect(lowness(item)).toBe(expected);
  });

  it('keeps the platform\'s own numbers for display: 1/5 is not 2/10', () => {
    const scan = scanReviews(setOf(review({ rawScore: { value: 1, max: 5 }, score: 2 })), NOW);
    expect(scan.flagged[0].rawScore).toEqual({ value: 1, max: 5 });
    expect(scan.flagged[0].scoreMsg?.params).toMatchObject({ score: '1', scoreValue: 1, max: 5 });
    // The normalised value is kept too, but for ordering rather than display.
    expect(scan.flagged[0].score).toBe(2);
  });

  it('trusts the published pair over somebody\'s arithmetic on it', () => {
    // An adapter that forgets to normalise a 5-point scale hands us score 4.5.
    // Read as 0–10 that is a low score; read from the pair it is 9/10.
    const scan = scanReviews(setOf(review({ rawScore: { value: 4.5, max: 5 }, score: 4.5 })), NOW);
    expect(scan.counts.lowScore).toBe(0);
    expect(scan.flagged).toEqual([]);
  });

  it('falls back to the normalised score, stated out of 10, when no pair was served', () => {
    const scan = scanReviews(setOf(review({ score: 3 })), NOW);
    expect(scan.flagged[0].scoreMsg?.params).toMatchObject({ score: '3', max: 10 });
    expect(scan.flagged[0].rawScore).toBeUndefined();
  });

  it('ignores a nonsense pair rather than repairing it', () => {
    for (const rawScore of [{ value: 9, max: 0 }, { value: 12, max: 10 }, { value: -1, max: 10 }]) {
      const scan = scanReviews(setOf(review({ rawScore, score: 9 })), NOW);
      expect(scan.counts.lowScore).toBe(0);
      expect(scan.counts.withScore).toBe(1); // fell back to `score`
    }
  });

  it('never quotes a nonsense pair back at the reader', () => {
    // "-1 out of 10" is not something a guest can have chosen, so a pair we
    // refused to compute with is also a pair we refuse to print.
    const scan = scanReviews(setOf(review({ rawScore: { value: -1, max: 10 }, score: 3 })), NOW);
    expect(scan.flagged[0].lowScore).toBe(true);
    expect(scan.flagged[0].rawScore).toBeUndefined();
    expect(scan.flagged[0].scoreMsg?.params).toMatchObject({ score: '3', max: 10 });
  });

  it('draws the line at half the scale, and says so in one place', () => {
    expect(LOW_SCORE_MAX).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// ages: facts, not weights
// ---------------------------------------------------------------------------

describe('ages across month and year boundaries', () => {
  it.each([
    [0, 'reviews.age.dayZero', undefined],
    [1, 'reviews.age.dayOne', 1],
    [2, 'reviews.age.dayMany', 2],
    [59, 'reviews.age.dayMany', 59], // the corpus median
    [60, 'reviews.age.monthMany', 2],
    [232, 'reviews.age.monthMany', 8], // the corpus p90
    [364, 'reviews.age.monthMany', 12],
    [365, 'reviews.age.yearOne', 1],
    [400, 'reviews.age.yearMany', 1.1],
    [913, 'reviews.age.yearMany', 2.5], // the oldest thing the corpus contains
  ] as const)('%s days → %s', (days, key, count) => {
    const message = ageText(days);
    expect(message.key).toBe(key);
    if (count !== undefined) expect(message.params?.countValue).toBe(count);
  });

  it('reports each surfaced review\'s age as a fact', () => {
    const scan = scanReviews(
      setOf(review({ score: 2, reviewedAt: daysAgo(232) })),
      NOW,
    );
    expect(scan.flagged[0].ageDays).toBe(232);
    expect(scan.flagged[0].ageMsg.key).toBe('reviews.age.monthMany');
  });

  it('says "date not given" rather than guessing one', () => {
    const scan = scanReviews(setOf(review({ score: 2 })), NOW);
    expect(scan.flagged[0].ageDays).toBeUndefined();
    expect(scan.flagged[0].ageMsg.key).toBe('reviews.age.unknown');
    expect(scan.counts.withDate).toBe(0);
  });

  it('treats a future date as no date at all', () => {
    const scan = scanReviews(setOf(review({ score: 2, reviewedAt: NOW + 5 * DAY })), NOW);
    expect(scan.counts.withDate).toBe(0);
    expect(scan.flagged[0].ageDays).toBeUndefined();
    expect(scan.window).toBeUndefined();
  });

  it('reports the window the page allowed us to see', () => {
    const scan = scanReviews(
      setOf(
        review({ score: 9, reviewedAt: daysAgo(10) }),
        review({ score: 9, reviewedAt: daysAgo(59) }),
        review({ score: 9, reviewedAt: daysAgo(232) }),
      ),
      NOW,
    );
    expect(scan.window?.oldestAgeDays).toBe(232);
    expect(scan.window?.newestAgeDays).toBe(10);
    expect(scan.window?.medianAgeDays).toBe(59);
    expect(scan.window?.oldestAgeMsg.key).toBe('reviews.age.monthMany');
    expect(scan.notes.map((n) => n.id)).toContain('window');
  });

  it('never invents a window from undated reviews', () => {
    const scan = scanReviews(setOf(review({ score: 9 }), review({ score: 8 })), NOW);
    expect(scan.window).toBeUndefined();
    expect(scan.notes.map((n) => n.id)).toContain('noDates');
  });
});

// ---------------------------------------------------------------------------
// the sample, and what it is honest about
// ---------------------------------------------------------------------------

describe('sample honesty', () => {
  it('says how few of the claimed reviews it read', () => {
    const scan = scanReviews(
      {
        items: [review({ score: 9 }), review({ score: 10 })],
        summary: { score: 8.4, total: 3526 },
      },
      NOW,
    );
    expect(scan.sample.shown).toBe(2);
    expect(scan.sample.claimedTotal).toBe(3526);
    const sample = scan.notes.find((n) => n.id === 'sample');
    expect(sample?.textMsg.key).toBe('reviews.sample.ofTotal');
    expect(sample?.textMsg.params).toMatchObject({ shown: 2, total: '3,526', totalValue: 3526 });
  });

  it('admits when the page does not say how many reviews exist', () => {
    const scan = scanReviews({ items: [review({ score: 9 })], summary: { score: 8.4 } }, NOW);
    expect(scan.sample.claimedTotal).toBeUndefined();
    expect(scan.notes.find((n) => n.id === 'sample')?.textMsg.key).toBe(
      'reviews.sample.totalUnknown',
    );
  });

  it('measures the curation instead of asserting it', () => {
    const scan = scanReviews(
      { items: [review({ score: 9 }), review({ score: 9.2 })], summary: { score: 8.4 } },
      NOW,
    );
    expect(scan.sample.featuredMean).toBe(9.1);
    expect(scan.sample.featuredAboveAggregate).toBe(true);
    const curation = scan.notes.find((n) => n.id === 'curation');
    expect(curation?.textMsg.params).toMatchObject({ featured: '9.1', overall: '8.4' });
  });

  it('stays quiet about curation on the page where it does not hold', () => {
    // It held on 9 of 12 corpus fixtures, not 12 of 12 — so it is measured.
    const scan = scanReviews(
      { items: [review({ score: 7 }), review({ score: 7 })], summary: { score: 8.4 } },
      NOW,
    );
    expect(scan.sample.featuredAboveAggregate).toBe(false);
    expect(scan.notes.map((n) => n.id)).not.toContain('curation');
  });

  it('counts the reviews written in a language it cannot scan', () => {
    const scan = scanReviews(
      setOf(
        review({ score: 9, lang: 'ja', negative: 'とても良かったです' }),
        review({ score: 9, lang: 'tr', negative: 'Her şey harikaydı' }),
        review({ score: 9, lang: 'en-GB', negative: 'Lovely stay' }),
        review({ score: 9, negative: 'No language tag at all' }),
      ),
      NOW,
    );
    expect(scan.counts.uncoveredLanguage).toBe(2);
    expect(scan.counts.undeclaredLanguage).toBe(1);
    const note = scan.notes.find((n) => n.id === 'language');
    expect(note?.textMsg.key).toBe('reviews.language.uncoveredMany');
    expect(note?.textMsg.params).toMatchObject({ count: 2 });
  });

  it('uses the singular sentence for a single uncovered review', () => {
    const scan = scanReviews(setOf(review({ score: 9, lang: 'ja' })), NOW);
    expect(scan.notes.find((n) => n.id === 'language')?.textMsg.key).toBe(
      'reviews.language.uncoveredOne',
    );
  });
});

// ---------------------------------------------------------------------------
// the two quiet cases, neither of which is a pass
// ---------------------------------------------------------------------------

describe('nothing to report is not the same as nothing wrong', () => {
  it('a page that served no reviews reports no record, not a clean one', () => {
    const scan = scanReviews({ items: [] }, NOW);
    expect(scan.flagged).toEqual([]);
    expect(scan.counts.seen).toBe(0);
    expect(scan.window).toBeUndefined();
    expect(scan.sample.shown).toBe(0);
    expect(scan.notes.map((n) => n.textMsg.key)).toEqual([
      'reviews.sample.none',
      'reviews.limits.advisory',
    ]);
    expect(reviewsMessages['reviews.sample.none']).toMatch(/not a clean record/i);
  });

  it('an all-recent, all-good set flags nothing and says why that proves little', () => {
    const scan = scanReviews(
      {
        items: [
          review({ score: 9.6, rawScore: { value: 9.6, max: 10 }, reviewedAt: daysAgo(5), lang: 'en', positive: 'Spotless, warm welcome.' }),
          review({ score: 10, rawScore: { value: 10, max: 10 }, reviewedAt: daysAgo(20), lang: 'de', positive: 'Alles perfekt.' }),
          review({ score: 8.8, rawScore: { value: 8.8, max: 10 }, reviewedAt: daysAgo(59), lang: 'fr', positive: 'Très bon séjour.' }),
        ],
        summary: { score: 8.9, total: 412 },
      },
      NOW,
    );
    expect(scan.flagged).toEqual([]);
    expect(scan.counts.lowScore).toBe(0);
    expect(scan.counts.troubleMatched).toBe(0);
    expect(scan.counts.withText).toBe(3);
    expect(scan.notes.map((n) => n.id)).toContain('nothingFlagged');
    expect(reviewsMessages['reviews.none.flagged']).toMatch(/not a clean bill of health/i);
  });

  it('states the standing limit on every reading', () => {
    const scan = scanReviews(setOf(review({ score: 9 })), NOW);
    expect(scan.notes.at(-1)?.id).toBe('limits');
    expect(reviewsMessages['reviews.limits.advisory']).toMatch(/never move the verdict/i);
  });
});

// ---------------------------------------------------------------------------
// ordering and message plumbing
// ---------------------------------------------------------------------------

describe('the surfaced list', () => {
  it('puts a quoted match above a bare low score, worst score first', () => {
    const scan = scanReviews(
      setOf(
        review({ score: 4, reviewedAt: daysAgo(2) }), // low only
        review({ score: 2, reviewedAt: daysAgo(90) }), // low only, worse
        review({ score: 9, negative: 'Not as described at all.' }), // matched
      ),
      NOW,
    );
    expect(scan.flagged.map((f) => f.index)).toEqual([2, 1, 0]);
    expect(scan.counts.flagged).toBe(3);
  });

  it('is stable for two reviews that are alike in every ranked respect', () => {
    const twin = { score: 3, reviewedAt: daysAgo(10) };
    const scan = scanReviews(setOf(review(twin), review(twin)), NOW);
    expect(scan.flagged.map((f) => f.index)).toEqual([0, 1]);
  });
});

describe('every sentence is a catalog key with its facts filled', () => {
  const collect = (scan: ReviewScan): ReviewsText[] => [
    ...scan.notes.map((note) => note.textMsg),
    ...scan.flagged.flatMap((flag) => [
      flag.ageMsg,
      ...(flag.scoreMsg === undefined ? [] : [flag.scoreMsg]),
      ...flag.matches.flatMap((match) => [match.categoryMsg, match.fieldMsg]),
    ]),
    ...(scan.window === undefined ? [] : [scan.window.oldestAgeMsg, scan.window.newestAgeMsg]),
  ];

  const everything = [
    scanReviews({ items: [] }, NOW),
    scanReviews(
      {
        items: [
          review({ score: 1, rawScore: { value: 1, max: 5 }, reviewedAt: daysAgo(913), lang: 'ja', title: 'A scam', negative: 'The address did not exist.' }),
          review({ score: 9.6, rawScore: { value: 9.6, max: 10 }, reviewedAt: daysAgo(1), lang: 'en', positive: 'Lovely.' }),
          review({ score: 4, reviewedAt: daysAgo(70), lang: 'tr' }),
        ],
        summary: { score: 8.4, total: 3526 },
      },
      NOW,
    ),
  ].flatMap(collect);

  it('emits no key the catalog lacks', () => {
    for (const message of everything) {
      expect(reviewsMessages[message.key], `missing catalog key ${message.key}`).toBeDefined();
    }
  });

  it('leaves no placeholder unfilled', () => {
    for (const message of everything) {
      const template: string = reviewsMessages[message.key];
      for (const slot of template.match(/\{(\w+)\}/g) ?? []) {
        const name = slot.slice(1, -1);
        expect(message.params?.[name], `${message.key} has no fact for ${slot}`).toBeDefined();
      }
    }
  });

  it('returns keys rather than rendered English', () => {
    // The panel renders. A string of English here could not be re-rendered
    // when the reader switches language, and the worker has no business
    // knowing which language that is.
    const scan = scanReviews(setOf(review({ score: 2, negative: 'A scam.' })), NOW);
    const serialised = JSON.stringify(scan.notes);
    expect(serialised).toContain('reviews.sample');
    expect(serialised).not.toMatch(/shop window/i);
  });
});
