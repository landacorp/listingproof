/**
 * Booking.com terms extraction: parking, payment method, cancellation.
 *
 * Parking comes from the page's embedded Apollo cache, which is the one
 * locale-invariant source: `chargeMode: FREE|PAID|CHARGES_MAY_APPLY` and
 * `ParkingAttributes.type: PRIVATE|PUBLIC` are enums, identical whether the
 * page is served in Greek or Japanese. (Verified across the 13-fixture corpus:
 * the Spanish capture yields `PUBLIC`/`CHARGES_MAY_APPLY` exactly like an
 * English one would.)
 *
 * Payment has no structured carrier: the "bank transfer required" sentence
 * lives in the property's fine print, which Booking serves in the page's
 * language. Detection is a per-language dictionary over the fine-print block —
 * honest about its limits: a locale outside the dictionary yields "could not
 * check", never a silent pass. The real hijack fixture carries the sentence
 * verbatim: "Payment before arrival via bank transfer is required."
 *
 * Cancellation policies are per-rate and only load once dates are chosen, so a
 * dateless page — which is what a first visit often is — yields unknown. When
 * the rate table is present its Apollo nodes are used.
 */
import { collapse } from '../../pagecontext';
import type { ListingTerms, ParkingTerms, PaymentTerms } from '../../terms';

/** Bound on how much script text the slicers below will walk. */
const MAX_SCRIPT_SCAN = 4_000_000;
const QUOTE_MAX = 220;

// ---------------------------------------------------------------------------
// parking — Apollo cache enums
// ---------------------------------------------------------------------------

interface ApolloParking {
  isOffsite?: boolean;
  chargeMode?: string;
  type?: string;
}

/**
 * The Apollo cache is embedded as JSON-stringified JSON, so quotes appear as
 * `\"` (and sometimes deeper). Stripping backslashes from a bounded slice is
 * cruder than parsing and far more robust than guessing the escape depth.
 */
function apolloParkingNodes(scripts: string[]): ApolloParking[] {
  const nodes: ApolloParking[] = [];
  for (const text of scripts) {
    if (nodes.length >= 8) break;
    const scan = text.length > MAX_SCRIPT_SCAN ? text.slice(0, MAX_SCRIPT_SCAN) : text;
    const clean = scan.includes('Parking') ? scan.replace(/\\+"/g, '"') : '';
    if (!clean) continue;
    const re =
      /"title":"([^"]*)","attributes":\{[^{]*?"isOffsite":(true|false),[\s\S]{0,200}?"chargeMode":"([A-Z_]+)"\}(?:,"extendedAttributes":\{"__typename":"ParkingAttributes","type":"([A-Z_]+)"\})?/g;
    let match: RegExpExecArray | null;
    while ((match = re.exec(clean)) && nodes.length < 8) {
      if (!/parking/i.test(match[1])) continue;
      nodes.push({
        isOffsite: match[2] === 'true',
        chargeMode: match[3],
        ...(match[4] === undefined ? {} : { type: match[4] }),
      });
    }
  }
  return nodes;
}

function parkingTerms(doc: Document, scripts: string[]): ParkingTerms | undefined {
  const nodes = apolloParkingNodes(scripts);
  if (nodes.length === 0) return undefined;

  // A property can list several parking facilities (garage + street). The one
  // the "free parking" chip refers to is the free one, so judge the best free
  // option; with no free option the chip cannot have said "free".
  const free = nodes.filter((n) => n.chargeMode === 'FREE');
  if (free.length === 0) return { advertisedFree: false };

  // Only when EVERY free option is public is the advertised free parking
  // something the property cannot promise — one free private space anywhere
  // on-site makes the advisory unfair.
  const allPublic = free.every((n) => n.type === 'PUBLIC');
  const anyTyped = free.some((n) => n.type !== undefined);

  const quoteEl = doc.querySelector('.ph-item-copy-parking');
  const quote = quoteEl?.textContent ? collapse(quoteEl.textContent, QUOTE_MAX) : undefined;

  return {
    advertisedFree: true,
    ...(anyTyped ? { kind: allPublic ? ('public' as const) : ('private' as const) } : {}),
    ...(quote === undefined ? {} : { quote }),
  };
}

// ---------------------------------------------------------------------------
// payment — fine-print dictionary, per language
// ---------------------------------------------------------------------------

/**
 * Booking serves the fine print in the page's language. These cover the ten
 * corpus locales plus the biggest others; a language with no entry means the
 * check honestly reports "could not check" rather than quietly passing.
 */
const BANK_TRANSFER_TERMS: readonly RegExp[] = [
  /bank\s?transfer|bank\s?wire|wire\s?transfer/i, // en
  /bank[üu]berweisung|überweisung/i, // de
  /virement(?:\s+bancaire)?/i, // fr
  /transferencia(?:\s+bancaria)?/i, // es
  /bonifico(?:\s+bancario)?/i, // it
  /transfer[êe]ncia(?:\s+banc[áa]ria)?/i, // pt
  /(?:bank)?overschrijving/i, // nl
  /τραπεζικ\S*\s+έμβασμα|έμβασμα/i, // el
  /銀行振込|銀行送金/, // ja
  /банковск\S*\s+перевод/i, // ru
  /przelew(?:\s+bankowy)?/i, // pl
];

const BEFORE_ARRIVAL_TERMS: readonly RegExp[] = [
  /before\s+arrival|prior\s+to\s+arrival|in\s+advance|payment\s+before/i, // en
  /vor\s+(?:der\s+)?anreise|vorauszahlung|im\s+voraus/i, // de
  /avant\s+(?:l['']|votre\s+)?arriv[ée]e|pr[ée]paiement|[àa]\s+l['']avance/i, // fr
  /antes\s+de\s+la\s+llegada|por\s+adelantado|pago\s+anticipado/i, // es
  /prima\s+dell['']arrivo|in\s+anticipo|pagamento\s+anticipato/i, // it
  /antes\s+da\s+chegada|antecipad/i, // pt
  /v[óo][óo]?r\s+aankomst|vooruitbetaling/i, // nl
  /πριν\s+από\s+την\s+άφιξη|προκαταβολ/i, // el
  /事前|到着前|前払い/, // ja
  /до\s+(?:прибытия|заезда)|предоплат/i, // ru
  /przed\s+przyjazdem|przedpłat/i, // pl
];

/** True when the page's language is one the dictionaries can actually read. */
function dictionaryCoversLanguage(lang: string): boolean {
  const covered = ['en', 'de', 'fr', 'es', 'it', 'pt', 'nl', 'el', 'ja', 'ru', 'pl'];
  return covered.includes(lang.slice(0, 2).toLowerCase());
}

/**
 * Fine-print paragraphs. The section carries no dedicated testid, so the <p>
 * elements of the generic content sections are scanned — bounded, text-only,
 * and the sentence is quoted so the panel shows the page's own words.
 */
function finePrintTexts(doc: Document): string[] {
  const texts: string[] = [];
  const sections = doc.querySelectorAll('[data-testid="property-section--content"] p');
  for (const p of Array.from(sections).slice(0, 80)) {
    const text = collapse(p.textContent ?? '', 500);
    if (text.length > 20) texts.push(text);
  }
  return texts;
}

function paymentTerms(doc: Document): PaymentTerms | undefined {
  const lang = doc.documentElement.getAttribute('lang') ?? '';
  if (!dictionaryCoversLanguage(lang)) return undefined;

  const texts = finePrintTexts(doc);
  if (texts.length === 0) return undefined;

  for (const text of texts) {
    if (BANK_TRANSFER_TERMS.some((re) => re.test(text))) {
      const before = BEFORE_ARRIVAL_TERMS.some((re) => re.test(text));
      return {
        bankTransferRequested: true,
        ...(before ? { fullPrepaymentRequired: true } : {}),
        quote: collapse(text, QUOTE_MAX),
      };
    }
  }
  // The fine print was present, readable, and does not request a transfer.
  return { bankTransferRequested: false };
}

// ---------------------------------------------------------------------------
// cancellation — rate table, present only once dates are chosen
// ---------------------------------------------------------------------------

function cancellationTerms(scripts: string[]): ListingTerms['cancellation'] {
  // Per-rate policies load with the availability table. Their Apollo nodes
  // carry `"freeCancellation":true/false` per block when dates are selected;
  // a dateless capture has none, and unknown must stay unknown.
  let sawTrue = false;
  let sawAny = false;
  for (const text of scripts) {
    const scan = text.length > MAX_SCRIPT_SCAN ? text.slice(0, MAX_SCRIPT_SCAN) : text;
    if (!scan.includes('freeCancellation')) continue;
    const clean = scan.replace(/\\+"/g, '"');
    for (const match of clean.matchAll(/"freeCancellation":(true|false)/g)) {
      sawAny = true;
      if (match[1] === 'true') sawTrue = true;
    }
  }
  if (!sawAny) return undefined;
  return sawTrue ? { freeOptionAvailable: true } : { freeOptionAvailable: false, allNonRefundable: true };
}

// ---------------------------------------------------------------------------

export function extractBookingTerms(doc: Document): ListingTerms {
  const scripts = Array.from(doc.querySelectorAll('script:not([type="application/ld+json"])'))
    .map((s) => s.textContent ?? '')
    .filter((t) => t.length > 0);

  const parking = parkingTerms(doc, scripts);
  const payment = paymentTerms(doc);
  const cancellation = cancellationTerms(scripts);

  return {
    ...(parking === undefined ? {} : { parking }),
    ...(payment === undefined ? {} : { payment }),
    ...(cancellation === undefined ? {} : { cancellation }),
  };
}
