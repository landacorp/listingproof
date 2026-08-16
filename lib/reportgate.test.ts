import { describe, expect, it } from 'vitest';
import { createReportGate, reportFingerprint } from './reportgate';
import type { IdentityVector } from './identity';
import type { PageContext } from './pagecontext';

const URL = 'https://www.booking.com/hotel/fr/x.html';

function identity(overrides: Partial<IdentityVector> = {}): IdentityVector {
  return {
    name: 'Paris Eiffel Residence',
    address: '12 Rue Desaix, 75015 Paris, France',
    city: 'Paris',
    photoUrls: [],
    capturedAt: '2026-08-13T10:00:00.000Z',
    source: { kind: 'live' },
    ...overrides,
  };
}

function context(overrides: Partial<PageContext> = {}): PageContext {
  return { breadcrumbs: ['France', 'Paris'], pois: [], reviews: [], ...overrides };
}

const print = (i: IdentityVector, c: PageContext = context()) => reportFingerprint(i, c, undefined);

describe('reportFingerprint', () => {
  it('is stable across extractions that differ only by timestamp', () => {
    expect(print(identity({ capturedAt: 'A' }))).toBe(print(identity({ capturedAt: 'B' })));
  });

  it('changes when the address arrives on a page that was still hydrating', () => {
    // The deadline-extraction case: name present, address not yet. The
    // follow-up read with the address must be treated as news.
    expect(print(identity({ address: '' }))).not.toBe(print(identity()));
  });

  it('changes when coordinates, photos, landmarks or terms arrive', () => {
    const base = print(identity());
    expect(print(identity({ lat: 48.85, lng: 2.29 }))).not.toBe(base);
    expect(print(identity({ photoUrls: ['https://cf.bstatic.com/x.jpg'] }))).not.toBe(base);
    expect(print(identity(), context({ pois: [{ name: 'Eiffel Tower' }] }))).not.toBe(base);
    expect(
      reportFingerprint(identity(), context(), {
        parking: { advertisedFree: true, kind: 'public' },
      }),
    ).not.toBe(base);
  });

  it('ignores rotating review snippets — a carousel must not re-run the analysis', () => {
    expect(print(identity(), context({ reviews: ['lovely'] }))).toBe(
      print(identity(), context({ reviews: ['awful', 'other'] })),
    );
  });
});

describe('createReportGate', () => {
  it('sends a first extraction and suppresses an identical repeat', () => {
    const gate = createReportGate();
    expect(gate.shouldSend(URL, 'fp1')).toBe(true);
    expect(gate.shouldSend(URL, 'fp1')).toBe(false);
  });

  it('sends again when the page or its content changes', () => {
    const gate = createReportGate();
    gate.shouldSend(URL, 'fp1');
    expect(gate.shouldSend(URL, 'fp2')).toBe(true); // hydration caught up
    expect(gate.shouldSend('https://other.example/x', 'fp2')).toBe(true); // SPA moved on
  });

  it('reset makes the next identical extraction send — the REREPORT contract', () => {
    const gate = createReportGate();
    gate.shouldSend(URL, 'fp1');
    gate.reset();
    // Same page, same content: after a worker eviction this exact re-send is
    // what rebuilds the lost state, and the dedup must not eat it.
    expect(gate.shouldSend(URL, 'fp1')).toBe(true);
  });
});
