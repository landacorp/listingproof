import type { AnalysisState } from '../../lib/messages';
import type { TermsAdvisory } from '../../lib/terms';
import type {
  FlaggedReview,
  ReviewNote,
  ReviewNoteId,
  ReviewScan,
  ReviewsText,
} from '../../lib/reviewscan';
import type {
  CheckCoverage,
  CheckStatus,
  LocalizedText,
  ScoreResult,
  Signal,
  Verdict,
} from '../../lib/signals';
import { activeLanguageTag, selectPlural, t } from '../../lib/i18n';
import type { MessageKey } from '../../lib/i18n';
import { en } from '../../lib/i18n/en';

/**
 * Panel rendering, kept free of messaging so it can be unit-tested and
 * previewed against any AnalysisState.
 *
 * This module computes nothing about the listing. Every verdict, signal and
 * number is produced by the service worker's scorer, so what the user reads is
 * exactly what the engines decided — there is no second, divergent opinion
 * rendered here.
 *
 * Its job is to make a claim checkable rather than to be believed: each
 * evidence row names the rule that fired, shows the values it compared, and
 * links whatever external source backs it (a geocode result, a map).
 */

// Catalog keys, resolved through t() at render time — never at module load,
// which runs before main.ts has activated the stored language.
const VERDICT_KEYS: Record<Verdict, { label: MessageKey; sub: MessageKey }> = {
  RED: { label: 'panel.verdict.red.label', sub: 'panel.verdict.red.sub' },
  YELLOW: { label: 'panel.verdict.yellow.label', sub: 'panel.verdict.yellow.sub' },
  GREEN: { label: 'panel.verdict.green.label', sub: 'panel.verdict.green.sub' },
  GRAY: { label: 'panel.verdict.gray.label', sub: 'panel.verdict.gray.sub' },
};

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  children: Array<Node | string> = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
  // append() of a string inserts a text node and never parses markup, so
  // attacker-authored listing text (names, addresses, review snippets) cannot
  // become DOM in the panel.
  for (const child of children) node.append(child);
  return node;
}

type Params = Record<string, string | number>;

/** The plural variants an engine may author, in `selectPlural`'s own order. */
const PLURAL_SUFFIXES = ['One', 'Few', 'Many'] as const;

/**
 * Re-pick a plural variant for the reader's language.
 *
 * `selectPlural` resolves against the ACTIVE language and the service worker
 * has none, so an engine can only author the form English needs. It carries
 * `count` on every variant — including `One`, where nothing interpolates it —
 * precisely so the choice can be made again here, where the language is
 * known: Russian bends at 2-4, and "3" rendered from the `many` key is the
 * right sentence with the wrong ending.
 *
 * Deliberately general over the suffix trio rather than taught about Engine L,
 * because the scorer wants the same treatment. It invents nothing: a key whose
 * re-picked variant the catalog does not carry keeps the one the engine chose,
 * so a half-populated trio degrades to the engine's answer instead of naming a
 * string that does not exist.
 */
function pluralKey(key: string, params: Params | undefined): MessageKey {
  // `count` is what the sentence interpolates and is usually the number too.
  // When an engine had to pre-format it (an age of "1.5" years, a grouped
  // total), the raw twin is what a plural rule can be asked about — the same
  // pairing `localizeParams` reads, used here for the choice rather than for
  // the printing.
  const count = typeof params?.count === 'number' ? params.count : params?.countValue;
  const suffix = PLURAL_SUFFIXES.find((candidate) => key.endsWith(candidate));
  if (typeof count !== 'number' || suffix === undefined) return key as MessageKey;
  const base = key.slice(0, key.length - suffix.length);
  const picked = selectPlural(count, {
    one: `${base}One` as MessageKey,
    few: `${base}Few` as MessageKey,
    many: `${base}Many` as MessageKey,
  });
  return en[picked] === undefined ? (key as MessageKey) : picked;
}

/**
 * Regroup every figure that travels with a raw twin.
 *
 * Engines group amounts English-style at authoring time, because `english()`
 * has to produce a finished sentence and the worker has no language to group
 * for. When the raw figure rides along as `amountValue`, the panel formats it
 * properly — 15,000 becomes 15 000 for a Russian reader — and passes the
 * result back in as `amount`. The slot stays `{amount}` in every catalog on
 * purpose: `lib/i18n.test.ts` holds each locale's placeholder set to
 * English's, so a translation that reached for `{amountValue}` would fail as
 * placeholder drift. The raw param is the panel's input, never a locale's.
 *
 * The rule is the convention, not one param name: `<slot>Value` regroups
 * `<slot>`. `lib/reviewscan.ts` authors several of these pairs (a review total
 * of 3,526, a score, an age), and teaching this function each name in turn
 * would mean every new sentence silently printing English grouping until
 * someone noticed.
 */
function localizeParams(params: Params | undefined): Params | undefined {
  if (params === undefined) return params;
  let localized: Params | undefined;
  for (const [name, value] of Object.entries(params)) {
    if (!name.endsWith('Value') || typeof value !== 'number') continue;
    const slot = name.slice(0, -'Value'.length);
    if (slot === '') continue;
    localized ??= { ...params };
    localized[slot] = new Intl.NumberFormat(activeLanguageTag()).format(value);
  }
  return localized ?? params;
}

/**
 * An engine-authored sentence in the reader's language, falling back to the
 * English the engines shipped beside it.
 *
 * The fallback carries weight rather than guarding against nothing. A service
 * worker evicted mid-analysis republishes the state it had, which may predate
 * the engines learning to author messages at all — and the engines learn it
 * one commit at a time, so half a verdict can arrive keyless for a while. A
 * key this build's catalog no longer carries is the same situation: the
 * English already travelling in the state is the answer, never a blank row.
 */
function text(message: LocalizedText | undefined, fallback: string): string {
  if (message === undefined) return fallback;
  const key = pluralKey(message.key, message.params);
  return en[key] === undefined ? fallback : t(key, localizeParams(message.params));
}

const CHECK_STATUS_KEYS: Record<Exclude<CheckStatus, 'checked'>, MessageKey> = {
  'not-applicable': 'panel.coverage.status.notApplicable',
  'no-data': 'panel.coverage.status.noData',
};

function renderCoverageRow(check: CheckCoverage): HTMLElement {
  const row = el('section', { class: 'row s-GRAY' });
  // Each catalog string carries its own casing (en's 'ran' is deliberately
  // lowercase); code-side lowercasing would mangle cased languages.
  const status =
    check.status === 'checked' ? t('panel.coverage.status.ran') : t(CHECK_STATUS_KEYS[check.status]);
  const detail = text(check.detailMsg, check.detail ?? '');
  row.append(
    el('div', { class: 'row-head' }, [
      el('span', { class: 'rule-id' }, [check.id]),
      el('span', { class: 'row-title' }, [`${text(check.labelMsg, check.label)} — ${status}`]),
    ]),
  );
  if (detail) row.append(el('p', { class: 'row-detail' }, [detail]));
  return row;
}

/**
 * One verdict reason, in the reader's language.
 *
 * A reason that cites a rule quotes that rule's own one-line statement in a
 * `{title}` slot and names it in `{id}`. The scorer fills `{title}` with the
 * English so its own rendering is a whole sentence; here the cited signal is
 * looked up in the same result and its title refilled in the reader's
 * language, so a translated reason does not trail off into English. A reason
 * citing a signal this result does not carry keeps the scorer's own words.
 */
function reasonText(result: ScoreResult, index: number): string {
  const fallback = result.reasons[index] ?? '';
  const message = result.reasonMsgs?.[index];
  if (message === undefined) return fallback;
  const params = message.params;
  if (params === undefined || params.title === undefined || params.id === undefined) {
    return text(message, fallback);
  }
  const cited = result.signals.find((signal) => signal.id === String(params.id));
  if (cited === undefined) return text(message, fallback);
  return text(
    { key: message.key, params: { ...params, title: text(cited.titleMsg, cited.title) } },
    fallback,
  );
}

export function renderSignal(signal: Signal): HTMLElement {
  const row = el('section', { class: `row s-${signal.severity}` });

  row.append(
    el('div', { class: 'row-head' }, [
      el(
        'span',
        { class: 'rule-id', title: t('panel.signal.ruleTooltip', { id: signal.id, engine: signal.engine }) },
        [signal.id],
      ),
      el('span', { class: 'row-title' }, [text(signal.titleMsg, signal.title)]),
    ]),
    el('p', { class: 'row-detail' }, [text(signal.detailMsg, signal.detail)]),
  );

  if (signal.values?.length) {
    const dl = el('dl', { class: 'values' });
    // Labels are always ours. A value usually is not: a coordinate, a name or
    // a page quote is evidence and renders exactly as it arrived. Only the
    // values the engines wrote themselves ("no distance stated") carry a
    // message, so the absent one is the common case, not the failure case.
    for (const { label, labelMsg, value, valueMsg } of signal.values) {
      dl.append(el('dt', {}, [text(labelMsg, label)]), el('dd', {}, [text(valueMsg, value)]));
    }
    row.append(dl);
  }

  if (signal.links?.length) {
    const links = el('div', { class: 'links' });
    for (const { label, labelMsg, href } of signal.links) {
      // Only http(s) links are ever rendered: a javascript: or data: URL
      // reaching here from page-derived content would be an XSS vector.
      if (!/^https?:\/\//i.test(href)) continue;
      links.append(
        el('a', { href, target: '_blank', rel: 'noopener noreferrer' }, [text(labelMsg, label)]),
      );
    }
    if (links.childNodes.length > 0) row.append(links);
  }

  return row;
}

export function render(state: AnalysisState): void {
  const app = document.getElementById('app');
  if (!app) return;
  app.replaceChildren();

  if (state.phase === 'idle') {
    app.append(el('p', { class: 'empty' }, [t('panel.idle')]));
    return;
  }

  if (state.phase === 'error') {
    app.append(
      el('div', { class: 'verdict v-GRAY' }, [
        el('p', { class: 'verdict-label' }, [t('panel.error.label')]),
        // state.error is engine/worker prose and stays verbatim.
        el('p', { class: 'verdict-sub' }, [state.error ?? t('panel.error.fallback')]),
      ]),
    );
    return;
  }

  if (state.identity) {
    // Address · city are page data joined by punctuation; no catalog key
    // exists for this composition (reported), so it stays in code.
    const meta = [state.identity.address, state.identity.city].filter(Boolean).join(' · ');
    app.append(
      el('div', { class: 'property' }, [
        el('div', { class: 'property-name' }, [state.identity.name]),
        el('div', { class: 'property-meta' }, [meta]),
      ]),
    );
  }

  if (state.phase === 'extracting' || state.phase === 'checking') {
    app.append(
      el('p', { class: 'empty' }, [
        el('span', { class: 'spinner', role: 'presentation' }),
        ' ',
        state.phase === 'extracting' ? t('panel.phase.extracting') : t('panel.phase.checking'),
      ]),
    );
    return;
  }

  const result = state.result;
  if (!result) {
    app.append(el('p', { class: 'empty' }, [t('panel.noResult')]));
    return;
  }

  const copy = VERDICT_KEYS[result.verdict];
  // A GREEN from two checks and a GREEN from five are different claims; when
  // the coverage report travelled with the result, the banner says which.
  const sub =
    result.verdict === 'GREEN' && result.coverage?.length
      ? t('panel.verdict.green.subWithCoverage', {
          ran: result.coverage.filter((check) => check.status === 'checked').length,
          total: result.coverage.length,
        })
      : t(copy.sub);
  app.append(
    el('div', { class: `verdict v-${result.verdict}` }, [
      el('p', { class: 'verdict-label' }, [t(copy.label)]),
      el('p', { class: 'verdict-sub' }, [sub]),
    ]),
  );

  if (result.reasons.length > 0) {
    const list = el('ul', { class: 'reasons' });
    for (let i = 0; i < result.reasons.length; i += 1) {
      list.append(el('li', {}, [reasonText(result, i)]));
    }
    app.append(el('h2', {}, [t('panel.section.why')]), list);
  }

  app.append(el('h2', {}, [t('panel.section.evidence')]));
  if (result.signals.length === 0) {
    app.append(el('p', { class: 'empty' }, [t('panel.evidence.noneFired')]));
  } else {
    const evidence = el('div', { class: 'evidence' });
    for (const signal of result.signals) evidence.append(renderSignal(signal));
    app.append(evidence);
  }

  // Checks that never ran, and why — "not checked" is a different answer from
  // "checked and clean", and a silent skip would read as the latter.
  const skipped = (result.coverage ?? []).filter((check) => check.status !== 'checked');
  if (skipped.length > 0) {
    app.append(el('h2', {}, [t('panel.section.notChecked')]));
    const rows = el('div', { class: 'evidence' });
    for (const check of skipped) rows.append(renderCoverageRow(check));
    app.append(rows);
  }

  // Advisories, in the order they bear on "is this listing what it claims to
  // be?": what other guests wrote about this property first, then what the
  // booking itself would cost you. Both sit below the verdict and its evidence
  // — neither may be read as part of the answer.
  renderReviewsSection(app, state);
  renderTermsSection(app, state);

  // The optional local-model pass. Everything above this point was produced
  // without it, so this is an offer, not a warning — no alarm colour, no error
  // wording, and nothing the user has to act on to keep using the extension.
  if (!state.llmPending && (state.llmStatus === 'unreachable' || state.llmStatus === 'no-model')) {
    const note = el('p', { class: 'llm-note' });
    // "Unreachable" covers three cases the browser cannot tell apart: not
    // installed, not running, and running but refusing this extension's
    // origin. The wording has to fit all three, because guessing wrong
    // sends the user to fix something that is not broken.
    note.append(
      state.llmStatus === 'unreachable' ? t('panel.llm.unreachable') : t('panel.llm.noModel'),
      ' ',
    );
    note.append(
      el(
        'a',
        {
          href:
            state.llmStatus === 'unreachable'
              ? 'https://ollama.com/download'
              : 'https://ollama.com/library',
          target: '_blank',
          rel: 'noopener noreferrer',
        },
        [state.llmStatus === 'unreachable' ? t('panel.llm.setupLink') : t('panel.llm.browseModelsLink')],
      ),
    );
    app.append(note);
  }

  if (state.llmPending) {
    app.append(
      el('p', { class: 'llm-note' }, [
        el('span', { class: 'spinner', role: 'presentation' }),
        ' ',
        t('panel.llm.pending'),
      ]),
    );
  }
  if (result.llmCapped) {
    app.append(el('p', { class: 'llm-note' }, [t('panel.llm.capped')]));
  }
}

/**
 * A sentence `lib/reviewscan.ts` authored, in the reader's language.
 *
 * No English fallback rides along with these — unlike a signal, they were
 * authored as keys from the first commit, so a key this catalog does not carry
 * is a dropped key and not an older build's prose. It renders as nothing, and
 * the caller drops the line rather than printing an empty paragraph.
 */
function reviewText(message: ReviewsText): string {
  return text(message, '');
}

/** A number as the reader's language writes it. 8.5 → "8,5" in ru. */
function reviewNumber(value: number): string {
  return new Intl.NumberFormat(activeLanguageTag()).format(value);
}

/**
 * Notes that FRAME the findings rather than qualify them, and therefore lead
 * the section instead of following it.
 *
 * The order matters more than it looks. "These are 10 of 3,526 reviews, the
 * ones the page chose to show" has to be read before the quotes, not after: a
 * reader who meets three alarming sentences first has already drawn the
 * conclusion by the time the sample size arrives. Everything else — the window,
 * the languages we could not scan, the standing reminder that none of this
 * moves the verdict — qualifies what was just read and sits under it.
 */
const LEAD_NOTE_IDS: ReadonlySet<ReviewNoteId> = new Set<ReviewNoteId>(['sample', 'curation']);

/**
 * "What guests wrote" — the reviews the page served, what stood out in them,
 * and how small a slice of the truth they are.
 *
 * Advisory, like the terms below it, and hedged harder: reviews are written by
 * other people and selected by the platform (`lib/reviews.ts`), so nothing here
 * reaches the scorer and nothing here is styled as a verdict. The section is a
 * pointer at text worth reading, printed beside the honesty notes that say how
 * little of it there is.
 *
 * Three silences are deliberately different, and this function only draws the
 * ones it can say something true about: a platform that embeds no reviews at
 * all carries no scan and gets NO section (there is no honest sentence for
 * "Airbnb hydrates its reviews after load", and inventing one in code would be
 * both untranslatable and a claim about the property); a page that served none
 * where the platform does serve them gets the section, saying exactly that;
 * and a page whose reviews were all unremarkable gets the section with
 * "nothing stood out … this is not a clean bill of health".
 */
function renderReviewsSection(app: HTMLElement, state: AnalysisState): void {
  const scan = state.reviewReport?.scan;
  if (scan === undefined) return;

  const lead = scan.notes.filter((note) => LEAD_NOTE_IDS.has(note.id));
  const tail = scan.notes.filter((note) => !LEAD_NOTE_IDS.has(note.id));

  const section = el('div', { class: 'reviews' });
  for (const note of lead) appendNote(section, note, scan);
  for (const review of scan.flagged) section.append(renderFlaggedReview(review));
  if (tail.length > 0) {
    const notes = el('div', { class: 'review-notes' });
    for (const note of tail) appendNote(notes, note, scan);
    if (notes.childNodes.length > 0) section.append(notes);
  }
  if (section.childNodes.length === 0) return;

  app.append(el('h2', {}, [t('reviews.section.title')]), section);
}

/**
 * One honesty note.
 *
 * The window note reads "That is as far back as this page lets anyone see" —
 * "that" being the age of the oldest review the page served, which travels as a
 * fact beside the sentence rather than inside it (an age is printed in several
 * places and only its unit word needs translating). The two are joined here,
 * where the only thing authored is the full stop between them.
 */
function appendNote(parent: HTMLElement, note: ReviewNote, scan: ReviewScan): void {
  const sentence = reviewText(note.textMsg);
  if (sentence === '') return;
  const oldest = scan.window === undefined ? '' : reviewText(scan.window.oldestAgeMsg);
  const body = note.id === 'window' && oldest !== '' ? `${oldest}. ${sentence}` : sentence;
  parent.append(el('p', { class: 'review-note' }, [body]));
}

/**
 * One review the scan surfaced: what the guest scored it, how long ago, and the
 * sentence that made it worth showing.
 *
 * The score is printed as the PLATFORM's own pair and never converted — 1 out
 * of 5 and 2 out of 10 are different claims, and the guest chose one of them.
 * A review whose score the page did not publish usably simply shows no number
 * rather than a manufactured one.
 */
function renderFlaggedReview(review: FlaggedReview): HTMLElement {
  const item = el('section', { class: 'review' });
  const head = el('div', { class: 'review-head' });
  if (review.rawScore !== undefined) {
    head.append(
      el('span', { class: 'review-score' }, [
        `${reviewNumber(review.rawScore.value)}/${reviewNumber(review.rawScore.max)}`,
      ]),
    );
  }
  head.append(el('span', { class: 'review-age' }, [reviewText(review.ageMsg)]));
  item.append(head);

  if (review.scoreMsg) {
    item.append(el('p', { class: 'review-reason' }, [reviewText(review.scoreMsg)]));
  }

  for (const match of review.matches) {
    item.append(
      el('p', { class: 'review-reason' }, [reviewText(match.categoryMsg)]),
      el('p', { class: 'review-field' }, [reviewText(match.fieldMsg)]),
      // The guest's own sentence, verbatim: never keyed, never reworded, and
      // never innerHTML — append() of a string is a text node, so the most
      // attacker-adjacent text in the panel cannot become DOM. The blockquote
      // is what keeps it visibly theirs rather than ours.
      el('blockquote', { class: 'review-quote' }, [match.quote]),
    );
  }

  return item;
}

/**
 * "Before you book" — consumer advisories about the listing's own stated
 * terms. Deliberately separate from the verdict, visually and verbally: an
 * expensive cancellation policy is not fraud, and folding it into the verdict
 * would spend the credibility the RED banner depends on. Advisory text is
 * built from our own rule copy; only the QUOTE is page text, and it renders
 * through append() as an inert text node like everything else.
 */
function renderTermsSection(app: HTMLElement, state: AnalysisState): void {
  const report = state.termsReport;
  if (!report) return;
  if (report.advisories.length === 0 && report.unchecked.length === 3) return;

  app.append(el('h2', {}, [t('panel.section.beforeYouBook')]));

  if (report.advisories.length > 0) {
    const list = el('div', { class: 'terms' });
    for (const advisory of report.advisories) list.append(renderAdvisory(advisory));
    app.append(list);
  } else {
    app.append(el('p', { class: 'empty' }, [t('panel.terms.nothingFlagged')]));
  }

  if (report.unchecked.length > 0) {
    const labelKeys: Record<string, MessageKey> = {
      parking: 'panel.terms.label.parking',
      cancellation: 'panel.terms.label.cancellation',
      payment: 'panel.terms.label.payment',
    };
    // The ', ' joiner stays in code; the catalog string only carries {list}.
    const list = report.unchecked
      .map((u) => {
        const key = labelKeys[u];
        return key !== undefined ? t(key) : u;
      })
      .join(', ');
    app.append(el('p', { class: 'empty' }, [t('panel.terms.couldNotCheck', { list })]));
  }
}

function renderAdvisory(advisory: TermsAdvisory): HTMLElement {
  const item = el('section', { class: `term t-${advisory.severity}` });
  item.append(
    el('div', { class: 'term-title' }, [text(advisory.titleMsg, advisory.title)]),
    el('p', { class: 'term-detail' }, [text(advisory.detailMsg, advisory.detail)]),
  );
  if (advisory.quote) {
    // The quote itself is page text and stays verbatim inside the {quote} slot.
    item.append(el('p', { class: 'term-quote' }, [t('panel.terms.pageSays', { quote: advisory.quote })]));
  }
  return item;
}
