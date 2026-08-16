// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { analyzeFirstPass } from './pipeline';
import { extractLiveIdentity } from '../lib/sites/booking/extract';
import { extractPageContext } from '../lib/sites/booking/pagecontext';
import type { Geocoder, GeocodeResult } from '../lib/geocoder';
import type { ListingDetectedMessage } from '../lib/messages';
import type { Verdict } from '../lib/signals';

/**
 * False-positive corpus (M7) and Engine A acceptance (M4), run against the 13
 * REAL Booking pages rather than generated ones.
 *
 * PLAN.md sets the budget at under 2% RED on the normal corpus. With 11 normal
 * listings that rounds to zero: a single false RED fails this suite. That is
 * the intended strictness — a fraud warning shown on a legitimate business is
 * the failure that gets the extension uninstalled, and the one that does real
 * harm to a real hotel.
 *
 * The two known hijacks are held to the opposite standard: each must reach RED
 * on the live page alone, which is the M4 acceptance criterion. Both were found
 * by the extension while browsing normally, not constructed.
 */

const LIVE_DIR = join(process.cwd(), 'fixtures/live');

const liveManifest = JSON.parse(readFileSync(join(LIVE_DIR, 'manifest.json'), 'utf8')) as {
  fixtures: Record<string, string>;
};

/**
 * The fixtures that are genuine in-the-wild hijacks, both found by the
 * extension in normal use rather than constructed.
 *
 *  - paris-eiffel:   slug `l-39-horizon-des-alpes-le-petit-bornand-les-glieres`
 *                    (an Alpine chalet) now serving "Paris Eiffel Residence".
 *  - gite-chassagne: slug `gitenchassagne` (a gite in rural Chassagne) now
 *                    serving "Le Grand Paris Apartments".
 *
 * Both score exactly 0.000 slug/name overlap, which is why the corpus still
 * cannot pin A1's threshold from below — see the boundary test at the end.
 */
const HIJACK_FILES = [
  'fr-hijack-paris-eiffel.en-gb.html',
  'fr-hijack-gite-chassagne.en-gb.html',
] as const;

/** The original hijack, used where a single worked example is clearer. */
const HIJACK_FILE = HIJACK_FILES[0];

/**
 * A geocoder that resolves every landmark to the listing's own coordinates.
 *
 * This is deliberately the most FORGIVING geography possible: A2 and A3 can
 * never fire. What remains under test is A1 — slug versus displayed name —
 * which is the rule with the least margin and the most false-positive risk, run
 * against twelve real properties in ten locales. Any RED here is A1's fault and
 * nobody else's.
 */
function agreeableGeocoder(at: { lat: number; lng: number }): Geocoder {
  return {
    async geocode(query: string): Promise<GeocodeResult | null> {
      return { ...at, displayName: query };
    },
  };
}

function analyze(file: string): Promise<{ verdict: Verdict; ids: string[] }> {
  const html = readFileSync(join(LIVE_DIR, file), 'utf8');
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const identity = extractLiveIdentity(doc);
  if (!identity) throw new Error(`no identity extracted from ${file}`);

  const message: ListingDetectedMessage = {
    type: 'LISTING_DETECTED',
    vector: identity,
    url: liveManifest.fixtures[file],
    context: extractPageContext(doc),
  };

  return analyzeFirstPass(message, {
    geocoder: agreeableGeocoder({ lat: identity.lat ?? 0, lng: identity.lng ?? 0 }),
  }).then(({ result }) => ({
    verdict: result.verdict,
    ids: result.signals.filter((s) => s.severity !== 'GRAY').map((s) => s.id),
  }));
}

const normalFiles = Object.keys(liveManifest.fixtures).filter(
  (f) => !HIJACK_FILES.includes(f as (typeof HIJACK_FILES)[number]),
);

describe('false-positive corpus: real listings must not be accused', () => {
  it.each(normalFiles)('%s is not flagged', async (file) => {
    const { verdict, ids } = await analyze(file);
    expect(verdict, `${file} fired ${ids.join(', ') || 'nothing'}`).not.toBe('RED');
    expect(ids, `${file} should fire no A1 slug/name mismatch`).not.toContain('A1');
  }, 30_000);

  it('the whole normal corpus stays within the RED budget', async () => {
    const verdicts = await Promise.all(normalFiles.map((f) => analyze(f)));
    const reds = verdicts.filter((v) => v.verdict === 'RED');
    // Budget is <2% of the corpus; with 11 listings that means zero.
    expect(reds).toHaveLength(0);
  }, 60_000);
});

describe('M4 acceptance: real hijacks are caught on the live page alone', () => {
  it.each(HIJACK_FILES)('%s reaches RED on intra-page evidence alone', async (file) => {
    const { verdict, ids } = await analyze(file);
    expect(verdict).toBe('RED');
    // The slug still names the property the listing used to be, while the page
    // claims somewhere else entirely.
    expect(ids).toContain('A1');
  }, 30_000);

  /**
   * Where A1 stops working, pinned so nobody mistakes it for total coverage.
   *
   * BOTH real hijacks score exactly 0.000 overlap, so they are caught by any
   * threshold above zero — which means the corpus still cannot pin A1 from
   * below, and a second sample did not change that.
   * (Verified by mutation: dropping the threshold to 0.001 leaves every test in
   * this file green, while raising it to 0.9 fails three.) A hijacker who keeps
   * one distinctive word from the victim's slug therefore buys silence from A1
   * specifically, and the product has to catch them somewhere else.
   */
  it('does not fire A1 when the hijacker keeps a distinctive slug token', async () => {
    const html = readFileSync(join(LIVE_DIR, HIJACK_FILE), 'utf8');
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const identity = { ...extractLiveIdentity(doc)!, name: 'Horizon Paris Eiffel Residence' };

    const { result } = await analyzeFirstPass(
      {
        type: 'LISTING_DETECTED',
        vector: identity,
        // Slug still names the Alpine property; the new name borrows "Horizon".
        url: liveManifest.fixtures[HIJACK_FILE],
        context: extractPageContext(doc),
      },
      { geocoder: agreeableGeocoder({ lat: identity.lat!, lng: identity.lng! }) },
    );

    // A1 goes quiet — this is the documented cost of a recall-oriented overlap.
    expect(result.signals.filter((s) => s.severity !== 'GRAY').map((s) => s.id)).not.toContain('A1');
    // Which is survivable only because it is not the sole check: A2's geography
    // sees this listing without consulting the slug at all. That margin is
    // thinner than it was — the archive diff used to be the second independent
    // reader of the same listing and is gone — so if A2 also has no landmarks
    // to work with, this hijacker escapes.
  }, 30_000);

  it('explains itself with the actual slug and name it compared', async () => {
    const html = readFileSync(join(LIVE_DIR, HIJACK_FILE), 'utf8');
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const identity = extractLiveIdentity(doc)!;
    const { result } = await analyzeFirstPass(
      {
        type: 'LISTING_DETECTED',
        vector: identity,
        url: liveManifest.fixtures[HIJACK_FILE],
        context: extractPageContext(doc),
      },
      { geocoder: agreeableGeocoder({ lat: identity.lat!, lng: identity.lng! }) },
    );

    const a1 = result.signals.find((s) => s.id === 'A1');
    expect(a1?.severity).toBe('RED');
    const rendered = JSON.stringify(a1?.values);
    expect(rendered).toMatch(/horizon|alpes|bornand/i);
    expect(rendered).toMatch(/Paris Eiffel Residence/i);
  }, 30_000);
});
