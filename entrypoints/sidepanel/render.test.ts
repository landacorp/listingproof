// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { render } from './render';
import { activateLanguage, type MessageKey } from '../../lib/i18n';
import { scanReviews, type FlaggedReview, type ReviewScan } from '../../lib/reviewscan';
import type { AnalysisState } from '../../lib/messages';
import type { PageReviews } from '../../lib/pagecontext';
import type { ReviewItem } from '../../lib/reviews';
import type { TermsAdvisory } from '../../lib/terms';
import type { Signal } from '../../lib/signals';

function mount(): HTMLElement {
  document.body.innerHTML = '<div id="app"></div>';
  return document.getElementById('app')!;
}

const IDENTITY = {
  name: 'Paris Eiffel Residence',
  address: '12 Rue Desaix, 75015 Paris, France',
  city: 'Paris',
  photoUrls: [],
  capturedAt: '2026-08-11T12:00:00.000Z',
  source: { kind: 'live' as const },
};

const LANDMARK_SIGNAL: Signal = {
  id: 'A2',
  engine: 'A',
  severity: 'RED',
  title: 'The landmarks this page calls nearby are 437 km away',
  detail: 'The page places itself beside the Eiffel Tower; its coordinates are in the Alps.',
  values: [
    { label: 'page says', value: '46.0289, 6.4122' },
    { label: 'geocoder says', value: '48.8540, 2.2942' },
  ],
  links: [
    { label: 'Geocode result', href: 'https://www.openstreetmap.org/?mlat=48.8540&mlon=2.2942' },
  ],
};

function doneState(overrides: Partial<AnalysisState> = {}): AnalysisState {
  return {
    phase: 'done',
    canonicalUrl: 'https://www.booking.com/hotel/fr/x.html',
    identity: IDENTITY,
    result: {
      verdict: 'RED',
      signals: [LANDMARK_SIGNAL],
      reasons: ['RED from deterministic rule A2: the landmarks this page calls nearby are 437 km away'],
      llmCapped: false,
    },
    ...overrides,
  };
}

beforeEach(() => {
  mount();
});

// The active language is module state shared by every test in this file, so a
// case that switches it puts it back rather than colouring the next one.
afterEach(() => {
  activateLanguage('');
});

describe('verdict rendering', () => {
  it.each([
    ['RED', 'Signs of tampering'],
    ['YELLOW', 'Worth a closer look'],
    ['GREEN', 'No contradictions found'],
    ['GRAY', 'Not enough to judge'],
  ] as const)('%s shows its own words, not just a colour', (verdict, label) => {
    render(doneState({ result: { verdict, signals: [], reasons: [], llmCapped: false } }));
    const banner = document.querySelector(`.verdict.v-${verdict}`);
    expect(banner).not.toBeNull();
    // Colour must never be the only carrier of the verdict.
    expect(banner?.textContent).toContain(label);
  });

  it('never promises that GREEN means genuine', () => {
    render(doneState({ result: { verdict: 'GREEN', signals: [], reasons: [], llmCapped: false } }));
    expect(document.body.textContent).toMatch(/not a guarantee/i);
  });
});

describe('evidence rows show their work', () => {
  it('names the rule, the values compared and the source link', () => {
    render(doneState());
    const row = document.querySelector('.row');
    expect(row?.querySelector('.rule-id')?.textContent).toBe('A2');
    expect(row?.textContent).toContain('437 km');
    const values = [...document.querySelectorAll('dl.values dd')].map((d) => d.textContent);
    expect(values).toEqual(['46.0289, 6.4122', '48.8540, 2.2942']);
    const link = row?.querySelector('a');
    expect(link?.getAttribute('href')).toBe(
      'https://www.openstreetmap.org/?mlat=48.8540&mlon=2.2942',
    );
    expect(link?.getAttribute('rel')).toBe('noopener noreferrer');
  });

  it('says so plainly when nothing fired', () => {
    render(doneState({ result: { verdict: 'GREEN', signals: [], reasons: [], llmCapped: false } }));
    expect(document.body.textContent).toMatch(/No rule fired/i);
  });

  // The panel offers no action of its own: it is a view over the verdict.
  // (The version button in the static header is not rendered here — it is
  // page chrome, and the way into the map search page.)
  it('offers no buttons — nothing here asks the user to do anything', () => {
    render(doneState());
    expect(document.querySelector('button')).toBeNull();
  });
});

describe('attacker-authored text cannot become markup', () => {
  it('renders a scripted property name as text', () => {
    render(
      doneState({
        identity: { ...IDENTITY, name: '<img src=x onerror="globalThis.pwned=1">Hotel' },
      }),
    );
    expect(document.querySelector('img')).toBeNull();
    expect(document.querySelector('.property-name')?.textContent).toContain('<img src=x');
    expect((globalThis as Record<string, unknown>).pwned).toBeUndefined();
  });

  it('renders scripted signal content as text', () => {
    const hostile: Signal = {
      ...LANDMARK_SIGNAL,
      title: '<script>globalThis.pwned=1</script>',
      values: [{ label: '<b>label</b>', value: '<iframe src="evil"></iframe>' }],
    };
    render(doneState({ result: { verdict: 'RED', signals: [hostile], reasons: [], llmCapped: false } }));
    expect(document.querySelector('script')).toBeNull();
    expect(document.querySelector('iframe')).toBeNull();
    expect(document.querySelector('dl.values b')).toBeNull();
  });

  it.each([
    ['javascript:alert(1)'],
    ['data:text/html,<script>alert(1)</script>'],
    ['vbscript:msgbox'],
    ['  javascript:alert(1)'],
  ])('refuses to render a %s link', (href) => {
    const hostile: Signal = { ...LANDMARK_SIGNAL, links: [{ label: 'proof', href }] };
    render(doneState({ result: { verdict: 'RED', signals: [hostile], reasons: [], llmCapped: false } }));
    for (const a of document.querySelectorAll('a')) {
      expect(a.getAttribute('href')).toMatch(/^https?:\/\//);
    }
  });
});

describe('progressive and empty states', () => {
  it('invites the user to open a listing when idle', () => {
    render({ phase: 'idle' });
    expect(document.body.textContent).toMatch(/Open an accommodation listing/i);
  });

  it('surfaces an error instead of a verdict', () => {
    render({ phase: 'error', error: 'Geocoder unreachable' });
    expect(document.body.textContent).toContain('Geocoder unreachable');
    expect(document.querySelector('.verdict.v-RED')).toBeNull();
  });

  it('says the language-model pass is still running', () => {
    render(doneState({ llmPending: true }));
    expect(document.body.textContent).toMatch(/still running/i);
  });

  it('explains an uncounted language-model flag without implying it counted', () => {
    render(
      doneState({
        result: { verdict: 'GREEN', signals: [], reasons: [], llmCapped: true },
      }),
    );
    const text = document.body.textContent ?? '';
    expect(text).toMatch(/not counted towards the verdict/i);
    expect(text).toMatch(/never to decide/i);
  });
});

describe('the optional local model is offered, never demanded', () => {
  it('offers setup when Ollama is not responding, without calling it an error', () => {
    render(doneState({ llmStatus: 'unreachable' }));
    const text = document.body.textContent ?? '';
    expect(text).toMatch(/optional extra check/i);
    // Must not imply the check above it is incomplete or broken.
    expect(text).toMatch(/everything above was checked without it/i);
    expect(text).not.toMatch(/error|failed|warning/i);
    // The three indistinguishable causes are all named, so nobody reinstalls a
    // working Ollama when the real problem is the allowed-origins setting.
    expect(text).toMatch(/not be installed/i);
    expect(text).toMatch(/not running/i);
    expect(text).toMatch(/allowed to accept requests from extensions/i);
    expect(document.querySelector('a[href^="https://ollama.com"]')).not.toBeNull();
  });

  it('asks for a model when Ollama is up but empty', () => {
    render(doneState({ llmStatus: 'no-model' }));
    const text = document.body.textContent ?? '';
    expect(text).toMatch(/no usable model/i);
    expect(text).toMatch(/everything above was checked without it/i);
  });

  it('says nothing at all when the model ran', () => {
    render(doneState({ llmStatus: 'ran' }));
    expect(document.body.textContent).not.toMatch(/ollama/i);
  });

  it('says nothing while the pass is still in flight', () => {
    render(doneState({ llmStatus: 'unreachable', llmPending: true }));
    expect(document.body.textContent).not.toMatch(/optional extra check/i);
  });

  it('still renders the full verdict and evidence when the model is absent', () => {
    // The whole point: no Ollama must cost the user nothing but the extra check.
    render(doneState({ llmStatus: 'unreachable' }));
    expect(document.querySelector('.verdict.v-RED')).not.toBeNull();
    expect(document.querySelector('.row .rule-id')?.textContent).toBe('A2');
  });
});

describe('the "Before you book" advisories', () => {
  it('renders warn and notice advisories with the page quoted', () => {
    render(
      doneState({
        termsReport: {
          advisories: [
            {
              id: 'T.payment',
              severity: 'warn',
              title: 'Full prepayment by bank transfer requested',
              detail: 'A bank transfer is irreversible.',
              quote: 'Payment before arrival via bank transfer is required.',
            },
            {
              id: 'T.parking',
              severity: 'notice',
              title: 'The "free parking" is public parking',
              detail: 'It may not be available on arrival.',
            },
          ],
          unchecked: ['cancellation'],
        },
      }),
    );
    const text = document.body.textContent ?? '';
    expect(text).toMatch(/Before you book/i);
    expect(document.querySelector('.term.t-warn')?.textContent).toMatch(/bank transfer/i);
    expect(document.querySelector('.term.t-notice')?.textContent).toMatch(/public parking/i);
    expect(text).toContain('The page says: “Payment before arrival via bank transfer is required.”');
    expect(text).toMatch(/Could not check: cancellation policy/i);
  });

  it('advisories never restyle themselves as the verdict', () => {
    render(
      doneState({
        result: { verdict: 'GREEN', signals: [], reasons: [], llmCapped: false },
        termsReport: {
          advisories: [
            { id: 'T.payment', severity: 'warn', title: 'Bank transfer requested', detail: 'x' },
          ],
          unchecked: [],
        },
      }),
    );
    // A GREEN verdict banner and a payment warning must coexist: the advisory
    // section uses .term styling, never the verdict classes.
    expect(document.querySelector('.verdict.v-GREEN')).not.toBeNull();
    expect(document.querySelector('.term .verdict')).toBeNull();
  });

  it('says nothing at all when nothing was flagged and nothing was checkable', () => {
    render(doneState({ termsReport: { advisories: [], unchecked: ['parking', 'cancellation', 'payment'] } }));
    expect(document.body.textContent).not.toMatch(/Before you book/i);
  });

  it('quotes render as text even when hostile', () => {
    render(
      doneState({
        termsReport: {
          advisories: [
            {
              id: 'T.parking',
              severity: 'notice',
              title: 'x',
              detail: 'y',
              quote: '<img src=x onerror="globalThis.pwned=1">',
            },
          ],
          unchecked: [],
        },
      }),
    );
    expect(document.querySelector('.term img')).toBeNull();
    expect((globalThis as Record<string, unknown>).pwned).toBeUndefined();
  });
});

describe('engine prose speaks the reader’s language', () => {
  // Real catalog keys with real Russian translations — a made-up key would
  // prove only that the fallback works. Values, hrefs and quotes are page
  // data and must survive untouched.
  const TRANSLATED: Signal = {
    ...LANDMARK_SIGNAL,
    titleMsg: { key: 'panel.section.why' }, // ru: Почему
    detailMsg: { key: 'panel.terms.label.payment' }, // ru: способ оплаты
    values: [
      { label: 'page says', value: '46.0289, 6.4122', labelMsg: { key: 'panel.terms.label.parking' } },
    ],
    links: [
      {
        label: 'Geocode result',
        href: 'https://www.openstreetmap.org/?mlat=48.8540&mlon=2.2942',
        labelMsg: { key: 'panel.terms.label.cancellation' },
      },
    ],
  };

  function renderSignals(signals: Signal[], reasons: string[] = []): void {
    render(doneState({ result: { verdict: 'RED', signals, reasons, llmCapped: false } }));
  }

  it('renders a signal’s message, not its English, when another language is active', () => {
    activateLanguage('ru');
    renderSignals([TRANSLATED]);
    expect(document.querySelector('.row-title')?.textContent).toBe('Почему');
    expect(document.querySelector('.row-detail')?.textContent).toBe('способ оплаты');
    expect(document.querySelector('dl.values dt')?.textContent).toBe('стоянка');
    expect(document.querySelector('.links a')?.textContent).toBe('политика отмены');
  });

  it('leaves the values and links themselves as the page reported them', () => {
    activateLanguage('ru');
    renderSignals([TRANSLATED]);
    expect(document.querySelector('dl.values dd')?.textContent).toBe('46.0289, 6.4122');
    expect(document.querySelector('.links a')?.getAttribute('href')).toBe(
      'https://www.openstreetmap.org/?mlat=48.8540&mlon=2.2942',
    );
  });

  it('translates a value that is our own prose rather than the page’s data', () => {
    activateLanguage('ru');
    renderSignals([
      {
        ...LANDMARK_SIGNAL,
        values: [
          // Engine prose standing in for a value: "no distance stated".
          { label: 'page says', value: 'no distance stated', valueMsg: { key: 'panel.section.why' } },
          // The page's own coordinate, keyless and untouched.
          { label: 'geocoder says', value: '48.8540, 2.2942' },
        ],
      },
    ]);
    const values = [...document.querySelectorAll('dl.values dd')].map((d) => d.textContent);
    expect(values).toEqual(['Почему', '48.8540, 2.2942']);
  });

  it('keeps a prose value in English when its message has not landed yet', () => {
    activateLanguage('ru');
    renderSignals([
      { ...LANDMARK_SIGNAL, values: [{ label: 'page says', value: 'no distance stated' }] },
    ]);
    expect(document.querySelector('dl.values dd')?.textContent).toBe('no distance stated');
  });

  it('keeps the English prose for a signal that carries no message', () => {
    activateLanguage('ru');
    renderSignals([LANDMARK_SIGNAL]);
    expect(document.querySelector('.row-title')?.textContent).toBe(
      'The landmarks this page calls nearby are 437 km away',
    );
    expect(document.querySelector('.row-detail')?.textContent).toContain('Alps');
    expect(document.querySelector('dl.values dt')?.textContent).toBe('page says');
    expect(document.querySelector('.links a')?.textContent).toBe('Geocode result');
  });

  it('keeps the English prose when the message names a key this build dropped', () => {
    activateLanguage('ru');
    // The one key in the suite that must NOT typecheck as a `MessageKey`: the
    // whole scenario is a signal authored by an older build, arriving over
    // `runtime.sendMessage` with a key the current catalog no longer has. The
    // cast is the message boundary, written out.
    const dropped = { key: 'enginea.a1.renamedLastRelease' as MessageKey };
    renderSignals([{ ...LANDMARK_SIGNAL, titleMsg: dropped }]);
    expect(document.querySelector('.row-title')?.textContent).toBe(
      'The landmarks this page calls nearby are 437 km away',
    );
  });

  it('translates a coverage row’s label and reason, and falls back per row', () => {
    activateLanguage('ru');
    render(
      doneState({
        result: {
          verdict: 'GREEN',
          signals: [],
          reasons: [],
          llmCapped: false,
          coverage: [
            {
              id: 'A3',
              label: 'Breadcrumb trail vs the map',
              status: 'no-data',
              detail: 'the page had no breadcrumb trail to read',
              labelMsg: { key: 'panel.section.why' },
              detailMsg: { key: 'panel.terms.label.parking' },
            },
            {
              id: 'A1',
              label: 'Web address vs displayed name',
              status: 'not-applicable',
              detail: "this platform's listing addresses carry no property name to compare",
            },
          ],
        },
      }),
    );
    const rows = [...document.querySelectorAll('.row')];
    // Label from the catalog, status word from the panel's own chrome.
    expect(rows[0]?.querySelector('.row-title')?.textContent).toBe(
      'Почему — На этой странице нет данных',
    );
    expect(rows[0]?.querySelector('.row-detail')?.textContent).toBe('стоянка');
    // The second row carries no messages at all — an engine that has not been
    // taught to author keys yet must still render, in its own English.
    expect(rows[1]?.querySelector('.row-title')?.textContent).toBe(
      'Web address vs displayed name — Не применимо на этой платформе',
    );
    expect(rows[1]?.querySelector('.row-detail')?.textContent).toBe(
      "this platform's listing addresses carry no property name to compare",
    );
  });

  it('translates the verdict reasons, index by index', () => {
    activateLanguage('ru');
    render(
      doneState({
        result: {
          verdict: 'RED',
          signals: [],
          reasons: ['first reason in English', 'second reason in English'],
          reasonMsgs: [{ key: 'panel.section.why' }],
          llmCapped: false,
        },
      }),
    );
    const reasons = [...document.querySelectorAll('ul.reasons li')].map((li) => li.textContent);
    // The second reason has no message yet — the engines land one commit at a
    // time, and half a verdict must not render as half a list.
    expect(reasons).toEqual(['Почему', 'second reason in English']);
  });

  it('keeps every reason in English when the state predates messages entirely', () => {
    activateLanguage('ru');
    render(doneState());
    expect(document.querySelector('ul.reasons li')?.textContent).toBe(
      'RED from deterministic rule A2: the landmarks this page calls nearby are 437 km away',
    );
  });

  it('fills a reason’s quoted rule title from that rule’s own message', () => {
    activateLanguage('ru');
    render(
      doneState({
        result: {
          verdict: 'RED',
          signals: [TRANSLATED],
          reasons: ['RED from deterministic rule A2: The landmarks this page calls nearby are 437 km away'],
          reasonMsgs: [
            {
              key: 'score.reason.deterministicRed',
              params: { id: 'A2', title: 'The landmarks this page calls nearby are 437 km away' },
            },
          ],
          llmCapped: false,
        },
      }),
    );
    // Both halves speak Russian: the frame from the reason's own key, and the
    // quoted title refilled from the cited signal's message rather than from
    // the English the scorer passed. That pairing is the point of the refill —
    // a translated sentence quoting an English claim would be worse than
    // either language alone.
    expect(document.querySelector('ul.reasons li')?.textContent).toBe(
      'RED из детерминированного правила A2: Почему',
    );
  });

  it('keeps the scorer’s own title when the cited rule is not in this result', () => {
    activateLanguage('ru');
    render(
      doneState({
        result: {
          verdict: 'RED',
          signals: [],
          reasons: ['RED from deterministic rule A2: The landmarks this page calls nearby are 437 km away'],
          reasonMsgs: [
            {
              key: 'score.reason.deterministicRed',
              params: { id: 'A2', title: 'The landmarks this page calls nearby are 437 km away' },
            },
          ],
          llmCapped: false,
        },
      }),
    );
    // The frame translates, but the title stays exactly as the scorer wrote
    // it: the cited rule is absent from this result, so there is no message to
    // refill from and inventing one would misattribute the claim.
    expect(document.querySelector('ul.reasons li')?.textContent).toBe(
      'RED из детерминированного правила A2: The landmarks this page calls nearby are 437 km away',
    );
  });

  it('translates a booking advisory while leaving its quote as the page wrote it', () => {
    activateLanguage('ru');
    render(
      doneState({
        termsReport: {
          advisories: [
            {
              id: 'T.payment',
              severity: 'warn',
              title: 'Full prepayment by bank transfer requested',
              detail: 'A bank transfer is irreversible.',
              titleMsg: { key: 'panel.section.why' },
              detailMsg: { key: 'panel.terms.label.payment' },
              quote: 'Payment before arrival via bank transfer is required.',
            },
            {
              id: 'T.parking',
              severity: 'notice',
              title: 'The "free parking" is public parking',
              detail: 'It may not be available on arrival.',
            },
          ],
          unchecked: [],
        },
      }),
    );
    expect(document.querySelector('.term-title')?.textContent).toBe('Почему');
    expect(document.querySelector('.term-detail')?.textContent).toBe('способ оплаты');
    expect(document.querySelector('.term-quote')?.textContent).toContain(
      'Payment before arrival via bank transfer is required.',
    );
    expect(document.querySelector('.term.t-notice .term-title')?.textContent).toBe(
      'The "free parking" is public parking',
    );
  });

  // The engines author the variant English needs and carry `count` on all of
  // them; the panel is the only place that knows the reader's language, so it
  // picks again. `search.dates.nights*` is a real trio whose three Russian
  // forms differ, which is what makes the choice observable at all — the
  // engines' own trios are identical in English and not yet translated.
  function renderCount(key: MessageKey, count: number): string {
    render(
      doneState({
        result: {
          verdict: 'RED',
          signals: [{ ...LANDMARK_SIGNAL, detailMsg: { key, params: { count } } }],
          reasons: [],
          llmCapped: false,
        },
      }),
    );
    return document.querySelector('.row-detail')?.textContent ?? '';
  }

  it('re-picks the Slavic “few” form for 3, where English has only “many”', () => {
    activateLanguage('ru');
    expect(renderCount('search.dates.nightsMany', 3)).toBe('3 ночи');
    // 5 is a different category in Russian and the same one in English.
    expect(renderCount('search.dates.nightsMany', 5)).toBe('5 ночей');
    activateLanguage('');
    expect(renderCount('search.dates.nightsMany', 3)).toBe('3 nights');
  });

  it('picks the “one” form from a “many” key in both languages', () => {
    activateLanguage('ru');
    expect(renderCount('search.dates.nightsMany', 1)).toBe('1 ночь');
    activateLanguage('');
    expect(renderCount('search.dates.nightsMany', 1)).toBe('1 night');
  });

  it('keeps the engine’s own key when the catalog carries no such variant', () => {
    // 'search.status.results' has One and Many but no Few: a Russian 3 must
    // still render the engine's sentence, never a key that does not exist.
    activateLanguage('ru');
    expect(renderCount('search.status.resultsMany', 3)).toBe('Найдено мест: 3.');
  });

  it('leaves a message alone when it has no plural suffix or no numeric count', () => {
    activateLanguage('ru');
    // No suffix to strip: re-selection must not touch an ordinary key.
    expect(renderCount('panel.section.why', 3)).toBe('Почему');
    // A count that is not a number cannot drive a plural rule, so the key the
    // engine chose stands — Russian renders its `many` form, not its `few`.
    render(
      doneState({
        result: {
          verdict: 'RED',
          signals: [
            {
              ...LANDMARK_SIGNAL,
              detailMsg: { key: 'search.dates.nightsMany', params: { count: '3' } },
            },
          ],
          reasons: [],
          llmCapped: false,
        },
      }),
    );
    expect(document.querySelector('.row-detail')?.textContent).toBe('3 ночей');
  });

  it('groups a cancellation fee the way the reader’s language groups it', () => {
    const advisory: TermsAdvisory = {
      id: 'T.cancellation' as const,
      severity: 'warn' as const,
      title: 'Cancelling this booking costs real money from the start',
      detail: 'The stated cancellation cost is 20,000 JPY.',
      detailMsg: {
        key: 'terms.cancellation.detailWithFee',
        // `amount` is the engine's English grouping, `amountValue` the figure.
        params: { amount: '20,000', amountValue: 20000, currency: 'JPY' },
      },
    };
    activateLanguage('ru');
    render(doneState({ termsReport: { advisories: [advisory], unchecked: [] } }));
    const russian = document.querySelector('.term-detail')?.textContent ?? '';
    expect(russian).toContain(`${new Intl.NumberFormat('ru').format(20000)} JPY`);
    expect(russian).not.toContain('20,000');

    activateLanguage('');
    render(doneState({ termsReport: { advisories: [advisory], unchecked: [] } }));
    expect(document.querySelector('.term-detail')?.textContent).toContain('20,000 JPY');
  });

  it('renders English again once the language is switched back', () => {
    activateLanguage('ru');
    renderSignals([TRANSLATED]);
    activateLanguage('');
    renderSignals([TRANSLATED]);
    expect(document.querySelector('.row-title')?.textContent).toBe('Why');
  });
});

describe('“What guests wrote”', () => {
  const NOW = Date.parse('2026-08-16T12:00:00.000Z');
  const DAY = 86_400_000;

  /** Surfaced by a word match, and NOT by its score: 8/10 is a happy guest. */
  const ACCUSING: ReviewItem = {
    id: 'r1',
    rawScore: { value: 8, max: 10 },
    reviewedAt: NOW - 45 * DAY,
    lang: 'en',
    negative: 'Honestly a scam. Nobody was ever at the door.',
  };
  /** Surfaced by its score, on the platform's own five-point scale. */
  const LOW: ReviewItem = {
    id: 'r2',
    rawScore: { value: 1, max: 5 },
    reviewedAt: NOW - 400 * DAY,
    lang: 'en',
    positive: 'The street was quiet.',
  };
  const HAPPY: ReviewItem = {
    id: 'r3',
    rawScore: { value: 10, max: 10 },
    reviewedAt: NOW - 10 * DAY,
    lang: 'en',
    positive: 'Spotless and central.',
  };

  function reviewState(set: PageReviews, over: Partial<AnalysisState> = {}): AnalysisState {
    return doneState({
      reviewReport: {
        availability: set.availability,
        ...(set.availability === 'not-in-page' ? {} : { scan: scanReviews(set, NOW) }),
      },
      ...over,
    });
  }

  const TROUBLING: PageReviews = {
    availability: 'in-page',
    items: [ACCUSING, LOW, HAPPY],
    summary: { score: 5, total: 3526 },
  };

  it('shows each surfaced review in the platform’s own scale, with its age and its quote', () => {
    render(reviewState(TROUBLING));
    expect(document.body.textContent).toContain('What guests wrote');

    const reviews = [...document.querySelectorAll('.review')];
    expect(reviews).toHaveLength(2);

    // Word match first (a pointer at a sentence beats a bare number).
    expect(reviews[0]?.querySelector('.review-score')?.textContent).toBe('8/10');
    expect(reviews[0]?.querySelector('.review-age')?.textContent).toBe('45 days ago');
    expect(reviews[0]?.textContent).toMatch(/word for a scam or a fraud/i);
    expect(reviews[0]?.textContent).toContain('"disliked" part of the review');
    // The guest's own sentence, verbatim and cut at the sentence boundary.
    expect(reviews[0]?.querySelector('blockquote.review-quote')?.textContent).toBe(
      'Honestly a scam.',
    );

    // 1 out of 5 is not 2 out of 10, and the panel never converts one into the
    // other: the scale printed is the one the guest was offered.
    expect(reviews[1]?.querySelector('.review-score')?.textContent).toBe('1/5');
    expect(reviews[1]?.textContent).toContain('Scored 1 out of 5');
    expect(reviews[1]?.querySelector('.review-age')?.textContent).toBe('1.1 years ago');
    // A low score with nothing troubling in the text carries no quote to show.
    expect(reviews[1]?.querySelector('blockquote')).toBeNull();
  });

  it('says how small and how curated the sample is, above the quotes', () => {
    render(reviewState(TROUBLING));
    const section = document.querySelector('.reviews');
    const notes = [...(section?.children ?? [])];
    // The framing has to be read BEFORE the alarming sentences, not after: the
    // first thing in the section is "these are 3 of 3,526, chosen by the page".
    expect(notes[0]?.className).toBe('review-note');
    expect(notes[0]?.textContent).toContain('Read 3 of the 3,526 reviews this page claims');
    expect(notes[0]?.textContent).toMatch(/shop window, not a sample/i);
    expect(notes[1]?.textContent).toMatch(/showing you its better reviews/i);
    expect(notes.findIndex((node) => node.className === 'review')).toBeGreaterThan(1);
  });

  it('states the window the page allows, and that none of this moves the verdict', () => {
    render(reviewState(TROUBLING));
    const tail = document.querySelector('.review-notes')?.textContent ?? '';
    // The note says "That is as far back as this page lets anyone see" — the
    // age it points at is printed immediately before it, or the sentence is
    // about nothing.
    expect(tail).toContain('1.1 years ago. That is as far back as this page lets anyone see.');
    expect(tail).toMatch(/never move the verdict/i);
    expect(tail).toMatch(/here to be read, not scored/i);
  });

  it('counts the reviews it could not word-check', () => {
    render(
      reviewState({
        availability: 'in-page',
        items: [{ ...ACCUSING, lang: 'ja' }, { ...HAPPY, lang: 'tr' }],
        summary: { total: 40 },
      }),
    );
    expect(document.body.textContent).toMatch(
      /2 of these reviews are written in a language this word check does not cover/i,
    );
  });

  it('never restyles a review as a verdict, whatever it says', () => {
    render(
      reviewState(TROUBLING, {
        result: { verdict: 'GREEN', signals: [], reasons: [], llmCapped: false },
      }),
    );
    // A GREEN verdict and a review shouting "scam" coexist by design: reviews
    // are other people's words, chosen by the platform, and cannot move it.
    expect(document.querySelector('.verdict.v-GREEN')).not.toBeNull();
    expect(document.querySelector('.review .verdict')).toBeNull();
    expect(document.querySelector('.review.v-RED, .review.s-RED')).toBeNull();
  });

  describe('the three silences read differently', () => {
    it('a platform that embeds no reviews in the page says nothing at all', () => {
      // Airbnb. There is no honest sentence here — "no reviews" would be a
      // claim about a property that may have hundreds — so the section is absent.
      render(reviewState({ availability: 'not-in-page', items: [], summary: { score: 4.9 } }));
      expect(document.body.textContent).not.toContain('What guests wrote');
      expect(document.querySelector('.reviews')).toBeNull();
    });

    it('a page that served none says that is no record, rather than a clean one', () => {
      render(reviewState({ availability: 'in-page', items: [] }));
      const text = document.body.textContent ?? '';
      expect(text).toContain('What guests wrote');
      expect(text).toMatch(/served no guest reviews/i);
      expect(text).toMatch(/not a clean record; it is no record/i);
      expect(document.querySelector('.review')).toBeNull();
      // Nothing was read, so there is nothing to say about a window or a sample.
      expect(text).not.toMatch(/as far back as this page lets anyone see/i);
    });

    it('a page whose reviews were unremarkable refuses to call that a clean bill of health', () => {
      render(
        reviewState({
          availability: 'in-page',
          items: [HAPPY],
          summary: { score: 9.2, total: 120 },
        }),
      );
      const text = document.body.textContent ?? '';
      expect(text).toMatch(/Nothing stood out in the reviews the page served/i);
      expect(text).toMatch(/this is not a clean bill of health — it is the absence of one/i);
      // It still says how little it read, which is the whole point of saying it.
      expect(text).toContain('Read 1 of the 120 reviews this page claims');
      expect(document.querySelector('.review')).toBeNull();
    });
  });

  it('renders a hostile review body as text, never as markup', () => {
    // The scanner refuses a field that still contains markup (an extractor
    // regression, not a guest), so this state cannot come from `scanReviews` —
    // it is the message boundary written out. The panel must not depend on the
    // sender having been careful.
    const hostile: FlaggedReview = {
      index: 0,
      lowScore: false,
      ageMsg: { key: 'reviews.age.dayOne', params: { count: 1, countValue: 1 } },
      langScanned: true,
      matchesFound: 1,
      matches: [
        {
          category: 'fraud',
          term: 'scam',
          termLangs: ['en'],
          field: 'negative',
          quote: '<img src=x onerror="globalThis.pwned=1">a scam',
          truncated: false,
          categoryMsg: { key: 'reviews.match.fraud' },
          fieldMsg: { key: 'reviews.field.negative' },
        },
      ],
    };
    const scan: ReviewScan = {
      flagged: [hostile],
      counts: {
        seen: 1, withText: 1, withScore: 0, withDate: 1, lowScore: 0, troubleMatched: 1,
        flagged: 1, uncoveredLanguage: 0, undeclaredLanguage: 0, markupFields: 0,
      },
      sample: { shown: 1 },
      notes: [{ id: 'limits', textMsg: { key: 'reviews.limits.advisory' } }],
    };

    render(doneState({ reviewReport: { availability: 'in-page', scan } }));
    expect(document.querySelector('.review img')).toBeNull();
    expect((globalThis as Record<string, unknown>).pwned).toBeUndefined();
    expect(document.querySelector('blockquote.review-quote')?.textContent).toContain('<img src=x');
    // No score published usably: no number is invented in its place.
    expect(document.querySelector('.review-score')).toBeNull();
  });

  it('renders the section in another language, with the numbers grouped that way', () => {
    // The section travels as keys and FACTS, never as rendered prose: our
    // sentences arrive in the reader's language, the review total is regrouped
    // for them from its raw twin, and the guest's own words are untouched by
    // any of it — a translated panel must never restate what a guest wrote.
    activateLanguage('ru');
    render(reviewState(TROUBLING));

    const section = document.querySelector('.reviews');
    // The heading is a sibling of the section, so look for it on the page.
    expect(document.body.textContent).toContain('Что написали гости');
    expect(document.body.textContent).not.toContain('What guests wrote');
    expect(section?.textContent).toContain(new Intl.NumberFormat('ru').format(3526));
    expect(section?.textContent).not.toContain('3,526');
    expect(document.querySelector('blockquote.review-quote')?.textContent).toBe(
      'Honestly a scam.',
    );
  });

  it('shows nothing when the analysis predates the reviews reading entirely', () => {
    render(doneState());
    expect(document.querySelector('.reviews')).toBeNull();
    expect(document.body.textContent).not.toContain('What guests wrote');
  });
});

describe('coverage — what was not checked (P0-3)', () => {
  const COVERAGE = [
    { id: 'A1', label: 'Web address vs displayed name', status: 'not-applicable' as const,
      detail: "this platform's listing addresses carry no property name to compare" },
    { id: 'A2', label: 'Nearby landmarks vs the map', status: 'checked' as const },
    { id: 'A3', label: 'Breadcrumb trail vs the map', status: 'no-data' as const,
      detail: 'the page had no breadcrumb trail to read' },
  ];

  it("GREEN's subtitle counts the checks that actually ran", () => {
    render(
      doneState({
        result: { verdict: 'GREEN', signals: [], reasons: [], llmCapped: false, coverage: COVERAGE },
      }),
    );
    const banner = document.querySelector('.verdict.v-GREEN');
    expect(banner?.textContent).toContain('1 of 3 checks ran');
    expect(banner?.textContent).toMatch(/not a guarantee/i);
  });

  it('renders each skipped check with the reason it could not run', () => {
    render(
      doneState({
        result: { verdict: 'GREEN', signals: [], reasons: [], llmCapped: false, coverage: COVERAGE },
      }),
    );
    const text = document.body.textContent ?? '';
    expect(text).toContain('Not checked');
    // Catalog strings carry their own casing; the row no longer lowercases.
    expect(text).toContain('Not applicable on this platform');
    expect(text).toContain('no property name to compare');
    expect(text).toContain('No data on this page');
    expect(text).toContain('no breadcrumb trail to read');
    // The check that ran is not listed among the skipped ones.
    expect(text).not.toContain('Nearby landmarks vs the map — ran');
  });

  it('renders no coverage section when everything ran', () => {
    render(
      doneState({
        result: {
          verdict: 'GREEN',
          signals: [],
          reasons: [],
          llmCapped: false,
          coverage: COVERAGE.map((check) => ({ ...check, status: 'checked' as const })),
        },
      }),
    );
    expect(document.body.textContent).not.toContain('Not checked');
  });

  it('keeps the static GREEN subtitle for a result without a coverage report', () => {
    render(doneState({ result: { verdict: 'GREEN', signals: [], reasons: [], llmCapped: false } }));
    const banner = document.querySelector('.verdict.v-GREEN');
    expect(banner?.textContent).toContain('The checks that could run all passed');
  });
});
