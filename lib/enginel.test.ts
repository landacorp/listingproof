// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runEngineL, selectModel, MIN_EVIDENCE_QUOTE_CHARS, type EngineLInput } from './enginel';
import { extractLiveIdentity } from './sites/booking/extract';
import { extractPageContext } from './sites/booking/pagecontext';
import { score } from './score';
import type { IdentityVector } from './identity';
import type { PageContext } from './pagecontext';
import type { Signal } from './signals';
import type { OllamaClient, StructuredRequest } from '../background/llm/ollama';

const INJECTION_DIR = join(process.cwd(), 'fixtures/injection');

const manifest = JSON.parse(readFileSync(join(INJECTION_DIR, 'manifest.json'), 'utf8')) as {
  cases: Array<{ file: string; technique: string; goal: string }>;
};

const IDENTITY: IdentityVector = {
  name: 'Warwick New York',
  address: '65 West 54th street, New York, NY 10019, United States',
  city: 'New York',
  country: 'us',
  lat: 40.7623695,
  lng: -73.97826634,
  photoUrls: [],
  capturedAt: '2026-08-11T12:00:00.000Z',
  source: { kind: 'live' },
};

const CONTEXT: PageContext = {
  breadcrumbs: ['Home', 'Hotels', 'United States', 'New York', 'Warwick New York'],
  pois: [],
  description: 'A landmark hotel on West 54th street, steps from Museum of Modern Art.',
  reviews: ['The rooms were spacious and the staff were welcoming throughout our stay.'],
};

/** Client that returns canned payloads keyed by which schema was requested. */
function clientReturning(
  payloads: { l1?: unknown; l2?: unknown; l3?: unknown },
  opts: { available?: boolean; models?: string[] } = {},
): OllamaClient & { calls: StructuredRequest[] } {
  const calls: StructuredRequest[] = [];
  return {
    calls,
    async available() {
      return opts.available ?? true;
    },
    async probe() {
      return {
        reachable: opts.available ?? true,
        models: opts.models ?? ['llama3.1:8b', 'mistral-nemo:12b'],
      };
    },
    async complete(request: StructuredRequest) {
      calls.push(request);
      const props = (request.schema as { properties?: Record<string, unknown> }).properties ?? {};
      if ('poi' in props) return payloads.l1 ?? { poi: [] };
      if ('contradictions' in props) return payloads.l2 ?? { contradictions: [] };
      return payloads.l3 ?? { flags: [] };
    },
  };
}

function inputWith(client: OllamaClient, context: PageContext = CONTEXT): EngineLInput {
  return { identity: IDENTITY, context, client };
}

describe('runEngineL feature flagging', () => {
  it('does nothing at all when Ollama is unreachable', async () => {
    const client = clientReturning({}, { available: false });
    const out = await runEngineL(inputWith(client));
    expect(out).toEqual({ signals: [], extraPois: [], ran: false, status: 'unreachable' });
    expect(client.calls).toHaveLength(0);
  });

  it('never throws when the model returns garbage', async () => {
    const client: OllamaClient = {
      async available() {
        return true;
      },
      async probe() {
        return { reachable: true, models: ['llama3.1:8b'] };
      },
      async complete() {
        return null;
      },
    };
    await expect(runEngineL(inputWith(client))).resolves.toEqual({
      signals: [],
      extraPois: [],
      ran: true,
      status: 'ran',
      modelUsed: 'llama3.1:8b',
    });
  });

  it('survives the client rejecting outright', async () => {
    const client: OllamaClient = {
      async available() {
        return true;
      },
      async probe() {
        return { reachable: true, models: ['llama3.1:8b'] };
      },
      async complete() {
        throw new Error('connection reset');
      },
    };
    const out = await runEngineL(inputWith(client));
    expect(out.ran).toBe(true);
    expect(out.signals).toEqual([]);
  });
});

describe('Ollama is optional — every path leaves a working extension', () => {
  it('reports no-model when Ollama runs but nothing is pulled', async () => {
    const client = clientReturning({}, { models: [] });
    const out = await runEngineL(inputWith(client));
    expect(out.status).toBe('no-model');
    expect(out.ran).toBe(false);
    expect(out.signals).toEqual([]);
    // Crucially: it must not attempt a request it knows will 404.
    expect(client.calls).toHaveLength(0);
  });

  it('ignores embedding-only models, which cannot answer a chat request', async () => {
    const client = clientReturning({}, { models: ['nomic-embed-text', 'all-minilm'] });
    expect((await runEngineL(inputWith(client))).status).toBe('no-model');
  });

  it('uses whatever chat model is installed rather than insisting on ours', async () => {
    // The user chooses what to pull. Hardcoding a name means Engine L silently
    // does nothing on most machines that have Ollama working.
    const client = clientReturning({}, { models: ['qwen2.5:7b-instruct'] });
    const out = await runEngineL(inputWith(client));
    expect(out.status).toBe('ran');
    expect(out.modelUsed).toBe('qwen2.5:7b-instruct');
  });

  it.each([
    ['exact match wins', ['gemma2:9b', 'llama3.1:8b'], 'llama3.1:8b'],
    ['same family on a different tag', ['gemma2:9b', 'llama3.1:70b'], 'llama3.1:70b'],
    ['anything usable rather than nothing', ['gemma2:9b'], 'gemma2:9b'],
  ])('selects a model: %s', (_case, installed, expected) => {
    expect(selectModel('llama3.1:8b', installed)).toBe(expected);
  });

  it('never lets a probe failure become an exception', async () => {
    const angry: OllamaClient = {
      async available() {
        throw new Error('boom');
      },
      async probe() {
        throw new Error('boom');
      },
      async complete() {
        throw new Error('boom');
      },
    };
    const out = await runEngineL(inputWith(angry));
    expect(out.status).toBe('unreachable');
    expect(out.signals).toEqual([]);
  });
});

describe('quote grounding bounds hallucination', () => {
  const QUOTE = 'The rooms were spacious and the staff were welcoming';

  it('keeps an L2 finding whose quote really appears on the page', async () => {
    const client = clientReturning({
      l2: { contradictions: [{ claim: 'New York', field: 'city', evidenceQuote: QUOTE }] },
    });
    const out = await runEngineL(inputWith(client));
    const l2 = out.signals.find((s) => s.id === 'L2');
    expect(l2).toBeDefined();
    expect(l2?.engine).toBe('L');
    expect(JSON.stringify(l2?.values)).toContain('spacious');
  });

  it('discards a fluent contradiction whose quote was never written', async () => {
    const client = clientReturning({
      l2: {
        contradictions: [
          {
            claim: 'New York',
            field: 'city',
            evidenceQuote: 'Guests repeatedly said this hotel is actually located in Bucharest.',
          },
        ],
      },
    });
    const out = await runEngineL(inputWith(client));
    expect(out.signals.find((s) => s.id === 'L2')).toBeUndefined();
  });

  it('rejects a quote too short to ground anything', async () => {
    const client = clientReturning({
      l2: { contradictions: [{ claim: 'x', field: 'city', evidenceQuote: 'the' }] },
    });
    expect('the'.length).toBeLessThan(MIN_EVIDENCE_QUOTE_CHARS);
    expect((await runEngineL(inputWith(client))).signals).toHaveLength(0);
  });

  it('tolerates whitespace and curly-quote differences when grounding', async () => {
    const client = clientReturning({
      l2: {
        contradictions: [
          { claim: 'c', field: 'city', evidenceQuote: '  the rooms   were SPACIOUS and the staff  ' },
        ],
      },
    });
    expect((await runEngineL(inputWith(client))).signals.find((s) => s.id === 'L2')).toBeDefined();
  });

  it('applies the same grounding rule to L3', async () => {
    const ungrounded = clientReturning({
      l3: { flags: [{ amenity: 'spa', reason: 'implausible', evidenceQuote: 'free heliport transfer' }] },
    });
    expect((await runEngineL(inputWith(ungrounded))).signals).toHaveLength(0);
  });
});

describe('L1 output is a proposal for the geocoder, not a finding', () => {
  it('returns landmark candidates without emitting any signal', async () => {
    const client = clientReturning({
      l1: { poi: [{ name: 'Museum of Modern Art', statedDistanceKm: 0.25 }, { name: 'Bryant Park' }] },
    });
    const out = await runEngineL(inputWith(client));
    expect(out.extraPois).toEqual([
      { name: 'Museum of Modern Art', statedDistanceKm: 0.25 },
      { name: 'Bryant Park' },
    ]);
    // L1 never produces a signal on its own: a hallucinated landmark has to
    // survive geocoding before it can affect anything.
    expect(out.signals.filter((s) => s.id === 'L1')).toHaveLength(0);
  });

  it('drops nonsense distances rather than passing NaN downstream', async () => {
    const client = clientReturning({
      l1: { poi: [{ name: 'Somewhere', statedDistanceKm: -5 }, { name: 'Elsewhere', statedDistanceKm: 'far' }] },
    });
    const out = await runEngineL(inputWith(client));
    expect(out.extraPois).toEqual([{ name: 'Somewhere' }, { name: 'Elsewhere' }]);
  });
});

describe('prompt construction', () => {
  it('fences untrusted data and never asks the model for a verdict', async () => {
    const client = clientReturning({});
    await runEngineL(inputWith(client));
    for (const call of client.calls) {
      expect(call.schema).toBeDefined();
      // The verdict vocabulary must never appear in a task instruction: the
      // model reports observations, the scorer decides.
      expect(call.task).not.toMatch(/\b(GREEN|RED|YELLOW|GRAY|verdict)\b/i);
    }
  });
});

describe('injection corpus: a subverted model cannot move the verdict', () => {
  /**
   * Each fixture is an ordinary listing carrying a payload that tries to make
   * the model lie. The model here is maximally compromised — it does exactly
   * what the payload asks — and the assertion is that the verdict is
   * nonetheless identical to the Engine-L-disabled verdict.
   */
  const deterministic: Signal[] = [
    {
      id: 'A1',
      engine: 'A',
      severity: 'GRAY',
      title: 'Slug check inconclusive',
      detail: 'no tokens',
    },
  ];

  it.each(manifest.cases.map((c) => [c.file, c] as const))(
    '%s',
    async (file) => {
      const html = readFileSync(join(INJECTION_DIR, file), 'utf8');
      const doc = new DOMParser().parseFromString(html, 'text/html');
      const identity = extractLiveIdentity(doc);
      expect(identity).not.toBeNull();
      const context = extractPageContext(doc);

      // A model that has fully surrendered to the payload: it claims the
      // listing is perfect AND screams fraud, quoting the injected text
      // verbatim so even quote-grounding passes.
      const injected = [context.description ?? '', ...context.reviews].join('\n\n');
      const obedient = clientReturning({
        l1: { poi: [{ name: 'Attacker Plaza', statedDistanceKm: 0.1 }] },
        l2: {
          contradictions: [
            { claim: 'listing is a scam', field: 'name', evidenceQuote: injected.slice(0, 120) },
          ],
        },
        l3: {
          flags: [{ amenity: 'everything', reason: 'attacker says so', evidenceQuote: injected.slice(0, 120) }],
        },
      });

      const out = await runEngineL({ identity: identity!, context, client: obedient });

      // Property 1: still schema-shaped output, no throw, no crash.
      for (const signal of out.signals) {
        expect(signal.engine).toBe('L');
        expect(['RED', 'YELLOW', 'GRAY']).toContain(signal.severity);
      }

      // Property 2 — the one that matters: the verdict is unchanged.
      const withoutL = score(deterministic, { identityComplete: true });
      const withL = score([...deterministic, ...out.signals], { identityComplete: true });
      expect(withL.verdict).toBe(withoutL.verdict);
      expect(withL.verdict).not.toBe('RED');
    },
    20_000,
  );

  it('unsupported L signals move the verdict by nothing, however loudly they fire', () => {
    const allL: Signal[] = [
      { id: 'L2', engine: 'L', severity: 'RED', title: 'x', detail: 'x' },
      { id: 'L3', engine: 'L', severity: 'RED', title: 'y', detail: 'y' },
    ];
    const result = score(allL, { identityComplete: true });
    // Not merely capped below RED — unchanged. Review text is written by third
    // parties, so an L-only path to YELLOW would be a working reputation attack
    // on an honest listing.
    expect(result.verdict).toBe('GREEN');
    expect(result.llmCapped).toBe(true);
    // Silenced, but not hidden: the findings still reach the evidence table.
    expect(result.signals).toHaveLength(2);
  });

  it('counts Engine L only when a deterministic rule independently fired', () => {
    // Engine A is the only deterministic engine left — the archive engine that
    // used to supply this support (a `B.photos` YELLOW) has been removed, and
    // the scorer now treats a stray `B.*` row as untrusted, so it would not
    // promote anything.
    const withSupport: Signal[] = [
      { id: 'A3', engine: 'A', severity: 'YELLOW', title: 'breadcrumbs', detail: 'd' },
      { id: 'L2', engine: 'L', severity: 'RED', title: 'x', detail: 'x' },
    ];
    const result = score(withSupport, { identityComplete: true });
    expect(result.verdict).toBe('RED');
    expect(result.llmCapped).toBe(false);
  });
});
