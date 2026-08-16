/**
 * Engine L — optional local-LLM semantic checks.
 *
 * The model proposes; `lib/score.ts` disposes. Three properties keep an
 * untrusted, page-influenced model from being able to lie the user into or out
 * of a verdict:
 *
 *   1. Influence cap. L signals alone never reach RED (enforced in the scorer,
 *      not here). A model that has been fully talked over can, at worst, ask
 *      for a second look.
 *   2. Downstream verification. L1's job is only to *find candidate landmark
 *      names*; the geocoder then measures them. A hallucinated landmark either
 *      fails to geocode or lands where the real ones do — either way it cannot
 *      manufacture a contradiction.
 *   3. Quote grounding. Every L2/L3 finding must carry a quote that actually
 *      occurs in the page text. Findings whose evidence cannot be located are
 *      discarded here, before scoring. This is what stops a confident,
 *      fluent, entirely invented contradiction from reaching the user.
 *   4. No key authority. Signals are authored as message keys plus facts (see
 *      `lib/msg.ts`) so the panel can show them in the user's language — and
 *      every model-derived string travels as a `{param}` or a quoted value,
 *      never as a key. Only the frame around it is ours to look up. A page
 *      that could choose our catalog keys could choose our sentences.
 *
 * If Ollama is not reachable, every function here returns nothing and the
 * deterministic verdict stands unchanged. Engine L is never load-bearing.
 */
import { english, msg } from './msg';
import type { IdentityVector } from './identity';
import type { PageContext, PoiMention } from './pagecontext';
import type { Signal } from './signals';
import type { OllamaClient } from '../background/llm/ollama';

/** Caps on what we accept back from the model. */
export const MAX_L1_POIS = 12;
export const MAX_L2_CONTRADICTIONS = 6;
export const MAX_L3_FLAGS = 6;
const MAX_FIELD_CHARS = 300;
/** Minimum quote length that counts as evidence — "the" grounds nothing. */
export const MIN_EVIDENCE_QUOTE_CHARS = 12;

export interface EngineLModels {
  /** Fast NER-class model for L1. */
  extractor: string;
  /** Stronger instruct model shared by L2 and L3. */
  judge: string;
}

export const DEFAULT_MODELS: EngineLModels = {
  extractor: 'llama3.1:8b',
  judge: 'mistral-nemo:12b',
};

export interface EngineLInput {
  identity: IdentityVector;
  context: PageContext;
  client: OllamaClient;
  models?: EngineLModels;
}

/**
 * Why Engine L did or did not contribute. The extension is fully functional in
 * every one of these states — this exists so the panel can *offer* the optional
 * upgrade rather than silently omitting a feature the user paid nothing for and
 * never heard of.
 */
export type EngineLStatus =
  /** Ollama answered and a model produced output. */
  | 'ran'
  /** Nothing listening on localhost:11434 — Ollama not installed or not started. */
  | 'unreachable'
  /** Ollama is running but has no model pulled, or none we can use. */
  | 'no-model'
  /** Reachable with a model, but the request failed or returned nothing usable. */
  | 'failed';

export interface EngineLOutput {
  signals: Signal[];
  /** Extra landmark candidates for Engine A2 to verify geographically. */
  extraPois: PoiMention[];
  /** True only for 'ran'. Kept for callers that only care whether it counted. */
  ran: boolean;
  status: EngineLStatus;
  /** The model actually used, when one was. */
  modelUsed?: string;
}

// --- schemas handed to Ollama's `format` ------------------------------------

const L1_SCHEMA = {
  type: 'object',
  properties: {
    poi: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          statedDistanceKm: { type: ['number', 'null'] },
        },
        required: ['name'],
      },
    },
  },
  required: ['poi'],
} as const;

const L2_SCHEMA = {
  type: 'object',
  properties: {
    contradictions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          claim: { type: 'string' },
          evidenceQuote: { type: 'string' },
          field: { type: 'string' },
        },
        required: ['claim', 'evidenceQuote', 'field'],
      },
    },
  },
  required: ['contradictions'],
} as const;

const L3_SCHEMA = {
  type: 'object',
  properties: {
    flags: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          amenity: { type: 'string' },
          reason: { type: 'string' },
          evidenceQuote: { type: 'string' },
        },
        required: ['amenity', 'reason', 'evidenceQuote'],
      },
    },
  },
  required: ['flags'],
} as const;

// --- helpers ---------------------------------------------------------------

function asText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, MAX_FIELD_CHARS) : undefined;
}

/** Loose comparison so quoting differences (spacing, case, curly quotes) still ground. */
function normalizeForQuote(text: string): string {
  return text
    .toLowerCase()
    .replace(/[‘’“”]/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * A finding is kept only if its quote genuinely occurs in the page text. The
 * model is reading attacker-authored prose and is perfectly capable of
 * producing a fluent contradiction that was never written; requiring locatable
 * evidence turns that from a user-visible claim into a discarded one.
 */
function isGrounded(quote: string, haystack: string): boolean {
  if (quote.length < MIN_EVIDENCE_QUOTE_CHARS) return false;
  return normalizeForQuote(haystack).includes(normalizeForQuote(quote));
}

function sourceText(context: PageContext): string {
  return [context.description ?? '', ...context.reviews].join('\n\n');
}

function buildPrompt(context: PageContext, identity: IdentityVector): string {
  const claimed = [
    `name: ${identity.name}`,
    identity.propertyType ? `type: ${identity.propertyType}` : '',
    identity.city ? `city: ${identity.city}` : '',
    identity.address ? `address: ${identity.address}` : '',
  ]
    .filter(Boolean)
    .join('\n');
  return `CLAIMED IDENTITY (from structured page metadata):\n${claimed}\n\nPAGE TEXT:\n${sourceText(context)}`;
}

// --- the three checks ------------------------------------------------------

async function runL1(input: EngineLInput, models: EngineLModels): Promise<PoiMention[]> {
  const result = await input.client.complete({
    model: models.extractor,
    task:
      'List every named place, landmark, station, airport or neighbourhood the data mentions ' +
      'as being near the property, with the distance the text states for it if any (in km, ' +
      'converting units as needed; null when no distance is given). Copy names exactly as ' +
      'written. Do not add places that are not mentioned. Return JSON only.',
    untrustedData: sourceText(input.context),
    schema: L1_SCHEMA,
  });

  const poi = (result as { poi?: unknown[] } | null)?.poi;
  if (!Array.isArray(poi)) return [];

  const out: PoiMention[] = [];
  for (const raw of poi.slice(0, MAX_L1_POIS)) {
    if (typeof raw !== 'object' || raw === null) continue;
    const name = asText((raw as { name?: unknown }).name);
    if (!name) continue;
    const distance = (raw as { statedDistanceKm?: unknown }).statedDistanceKm;
    out.push(
      typeof distance === 'number' && Number.isFinite(distance) && distance >= 0
        ? { name, statedDistanceKm: distance }
        : { name },
    );
  }
  return out;
}

async function runL2(input: EngineLInput, models: EngineLModels): Promise<Signal | undefined> {
  const result = await input.client.complete({
    model: models.judge,
    task:
      'Compare the claimed identity against what guests actually describe. Report only ' +
      'contradictions that the text itself evidences — for example reviews describing a ' +
      'different city, a different kind of property, or a different building than the ' +
      'claimed identity states. For each contradiction give the claimed value, the field, ' +
      'and a short quote copied verbatim from the data that shows it. Report nothing if ' +
      'the text is consistent. Return JSON only.',
    untrustedData: buildPrompt(input.context, input.identity),
    schema: L2_SCHEMA,
  });

  const items = (result as { contradictions?: unknown[] } | null)?.contradictions;
  if (!Array.isArray(items) || items.length === 0) return undefined;

  const haystack = sourceText(input.context);
  const grounded: Array<{ claim: string; field: string; quote: string }> = [];
  for (const raw of items.slice(0, MAX_L2_CONTRADICTIONS)) {
    if (typeof raw !== 'object' || raw === null) continue;
    const claim = asText((raw as { claim?: unknown }).claim);
    const field = asText((raw as { field?: unknown }).field);
    const quote = asText((raw as { evidenceQuote?: unknown }).evidenceQuote);
    if (!claim || !field || !quote) continue;
    if (!isGrounded(quote, haystack)) continue;
    grounded.push({ claim, field, quote });
  }
  if (grounded.length === 0) return undefined;

  const titleMsg = msg('enginel.l2.title');
  // `selectPlural` reads the ACTIVE panel language, and a service worker has
  // none — so the engine picks by the rule English needs (one vs many) and
  // cannot choose the Slavic `few`. It carries `count` on every variant
  // regardless, including the `one` form that has no slot for it, so the panel
  // can re-select `enginel.l2.detailFew` for 2-4 when it renders. Emitting the
  // English-correct key rather than always `many` also means a panel that
  // never re-selects is wrong only for 2-4, not for 1.
  const count = grounded.length;
  const detailMsg = msg(count === 1 ? 'enginel.l2.detailOne' : 'enginel.l2.detailMany', { count });

  return {
    id: 'L2',
    engine: 'L',
    // Proposed severity only. The scorer caps this to YELLOW unless a
    // deterministic rule independently fired.
    severity: 'RED',
    title: english(titleMsg),
    detail: english(detailMsg),
    titleMsg,
    detailMsg,
    // `field`, `claim` and `quote` are all model output. They fill slots in a
    // frame we wrote; none of them is looked up, so none of them can name a
    // sentence.
    values: grounded.map((g) => {
      const labelMsg = msg('enginel.l2.evidenceLabel', { field: g.field, claim: g.claim });
      return { label: english(labelMsg), value: `“${g.quote}”`, labelMsg };
    }),
  };
}

async function runL3(input: EngineLInput, models: EngineLModels): Promise<Signal | undefined> {
  const result = await input.client.complete({
    model: models.judge,
    task:
      'Identify amenities the data advertises that are implausible together for this kind ' +
      'of property in this location — for example free private parking, a free airport ' +
      'shuttle and a full spa at a small central-city bed and breakfast. Give the amenity, ' +
      'a one-sentence reason, and a verbatim quote from the data mentioning it. Report ' +
      'nothing if the offering is ordinary. Return JSON only.',
    untrustedData: buildPrompt(input.context, input.identity),
    schema: L3_SCHEMA,
  });

  const items = (result as { flags?: unknown[] } | null)?.flags;
  if (!Array.isArray(items) || items.length === 0) return undefined;

  const haystack = sourceText(input.context);
  const grounded: Array<{ amenity: string; reason: string }> = [];
  for (const raw of items.slice(0, MAX_L3_FLAGS)) {
    if (typeof raw !== 'object' || raw === null) continue;
    const amenity = asText((raw as { amenity?: unknown }).amenity);
    const reason = asText((raw as { reason?: unknown }).reason);
    const quote = asText((raw as { evidenceQuote?: unknown }).evidenceQuote);
    if (!amenity || !reason || !quote) continue;
    if (!isGrounded(quote, haystack)) continue;
    grounded.push({ amenity, reason });
  }
  if (grounded.length === 0) return undefined;

  const titleMsg = msg('enginel.l3.title');
  const detailMsg = msg('enginel.l3.detail');

  return {
    id: 'L3',
    engine: 'L',
    severity: 'YELLOW',
    title: english(titleMsg),
    detail: english(detailMsg),
    titleMsg,
    detailMsg,
    // Both halves are the model's own words with no frame around them, so
    // there is nothing here we authored and nothing to key.
    values: grounded.map((g) => ({ label: g.amenity, value: g.reason })),
  };
}

/**
 * Pick a usable model from what is actually installed.
 *
 * Hardcoding a model name means Engine L silently does nothing on every machine
 * that pulled a different one — which, given the user chooses what to pull, is
 * most of them. Preference order: the configured model if present (exactly or
 * as a tag prefix, so `llama3.1:8b` matches a configured `llama3.1`), then any
 * installed model, so a working Ollama is never wasted. Embedding-only models
 * cannot chat and are excluded.
 */
const NON_CHAT_MODEL = /embed|bge-|e5-|nomic-embed|all-minilm/i;

export function selectModel(preferred: string, installed: readonly string[]): string | undefined {
  const usable = installed.filter((m) => !NON_CHAT_MODEL.test(m));
  if (usable.length === 0) return undefined;

  const base = preferred.split(':')[0].toLowerCase();
  return (
    usable.find((m) => m.toLowerCase() === preferred.toLowerCase()) ??
    usable.find((m) => m.split(':')[0].toLowerCase() === base) ??
    usable[0]
  );
}

export async function runEngineL(input: EngineLInput): Promise<EngineLOutput> {
  const configured = input.models ?? DEFAULT_MODELS;
  const none = { signals: [] as Signal[], extraPois: [] as PoiMention[], ran: false };

  // Feature flag by reachability. No Ollama means no Engine L, no error, and a
  // verdict that is exactly as good as it was before — the deterministic
  // engines never depended on it.
  const probe = await input.client.probe().catch(() => ({ reachable: false, models: [] }));
  if (!probe.reachable) return { ...none, status: 'unreachable' };

  const extractor = selectModel(configured.extractor, probe.models);
  const judge = selectModel(configured.judge, probe.models);
  if (!extractor || !judge) return { ...none, status: 'no-model' };

  const models: EngineLModels = { extractor, judge };
  const [extraPois, l2, l3] = await Promise.all([
    runL1(input, models).catch(() => [] as PoiMention[]),
    runL2(input, models).catch(() => undefined),
    runL3(input, models).catch(() => undefined),
  ]);

  const signals: Signal[] = [];
  if (l2) signals.push(l2);
  if (l3) signals.push(l3);
  return { signals, extraPois, ran: true, status: 'ran', modelUsed: judge };
}
