/**
 * Fixture scrubber.
 *
 * Captured pages are third-party HTML, and third-party HTML carries other
 * people's credentials: analytics ids, anti-forgery tokens, and the client-side
 * API keys every mapping and captcha widget needs. None of it is ours to
 * republish, and a public repository containing a recognisable Google or Mapbox
 * key trips GitHub secret scanning — which alerts on every commit in history,
 * not just the checked-out one.
 *
 * This ran as ad-hoc greps twice and missed something both times: the first pass
 * looked for session tokens and not key formats, the second caught Google keys
 * and not Mapbox. Hence a committed, tested rule set — the list below is the
 * project's definition of "safe to publish", and `npm run scrub` is what any
 * new capture goes through before it is committed.
 *
 * Run:  npx vite-node scripts/scrub-fixtures.ts [--check]
 *       --check exits non-zero instead of writing, for CI.
 */
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const FIXTURE_DIRS = [
  'fixtures/live',
  'fixtures/live-airbnb',
  'fixtures/live-generic',
  'fixtures/live-search',
];

interface Rule {
  name: string;
  pattern: RegExp;
  replacement: string;
  /** Why this is here, so nobody deletes a rule they do not recognise. */
  note: string;
}

/**
 * Ordered, and every replacement keeps the token's *shape* — same prefix, same
 * length class — so the surrounding markup still parses and the extractor sees
 * a realistic page rather than a hole.
 *
 * Key patterns are anchored with a negative lookbehind so they cannot match
 * INSIDE a longer base64 run. Without it, `6L` followed by 38 base64 characters
 * matches happily in the middle of an npm integrity hash or a data URI — and
 * captured pages are full of both. That is not theoretical: an unanchored
 * version of these rules, applied across a history rewrite, silently corrupted
 * three `package-lock.json` integrity hashes and broke `npm ci` on every CI
 * runner. A scrubber that damages the data it is protecting is worse than none.
 *
 * Every replacement must ALSO fail its own pattern, or the scrubber is not
 * idempotent and `--check` reports its own placeholders forever — a guard that
 * cries wolf on a clean corpus gets ignored, then deleted. Two ways to get this
 * wrong, both of which happened here: replacing a 32-hex id with 32 zeros
 * leaves 32 valid hex characters; and a fixed-length placeholder shorter than
 * the token it replaced can be completed back into a match by the characters
 * left behind. Hence the dots — `.` is outside every token charset above, so no
 * placeholder can be re-consumed. `scripts/scrub-fixtures.test.ts` asserts it.
 */
export const SCRUB_RULES: Rule[] = [
  {
    name: 'google-api-key',
    pattern: /(?<![0-9A-Za-z_/+-])AIza[0-9A-Za-z_-]{35}/g,
    replacement: 'AIza.REDACTED.GOOGLE.API.KEY.REMOVED',
    note: "Google Maps/Firebase browser keys. Public by design, but GitHub's push protection and secret scanning both flag them.",
  },
  {
    name: 'recaptcha-site-key',
    pattern: /(?<![0-9A-Za-z_/+-])6L[0-9A-Za-z_-]{38}/g,
    replacement: '6L.REDACTED.RECAPTCHA.SITE.KEY.REMOVED',
    note: 'reCAPTCHA site keys embedded by the captured site.',
  },
  {
    name: 'mapbox-token',
    pattern: /pk\.eyJ[0-9A-Za-z_-]{20,}\.[0-9A-Za-z_-]{10,}/g,
    replacement: 'pk.eyJREDACTED.REDACTED',
    note: "Mapbox access tokens. `pk.` is Mapbox's PUBLIC prefix, but GitHub reports it as a secret and it belongs to the captured site, not to us.",
  },
  {
    name: 'airbnb-session-token',
    pattern: /("SessionIdToken",")[0-9a-f-]{16,}/g,
    replacement: '$1redacted-session-token-not-a-real-id',
    note: 'Anonymous session id minted by our own fetch.',
  },
  {
    name: 'booking-session-id',
    pattern: /(b_sid['":\s=]{1,6}['"]?)[a-f0-9]{32}/g,
    replacement: '$1redactedsessionidredactedsession',
    note: 'Booking session identifier tied to the capture.',
  },
  {
    name: 'csrf-meta-tag',
    pattern:
      /(<meta[^>]{0,120}?name=["'](?:csrf|authenticity)[_-]?token["'][^>]{0,120}?content=["'])[A-Za-z0-9_+/=-]{16,}/gi,
    note: 'The meta-tag shape, where the value lives in a sibling attribute rather than next to the key — missed by the inline rule below, and the commonest form in server-rendered pages.',
    replacement: '$1REDACTED',
  },
  {
    name: 'csrf-token-value',
    pattern: /((?:csrf|authenticity)[_-]?token['":\s=]{1,6}['"])[A-Za-z0-9_+/=-]{16,}/gi,
    replacement: '$1REDACTED',
    note: 'Anti-forgery tokens. Useless to an attacker without the session, but not ours to publish.',
  },
];

export interface ScrubResult {
  file: string;
  counts: Record<string, number>;
  total: number;
}

export function scrubText(html: string): { text: string; counts: Record<string, number> } {
  const counts: Record<string, number> = {};
  let text = html;
  for (const rule of SCRUB_RULES) {
    // Count on the current text so an earlier rule cannot inflate a later count.
    const found = text.match(rule.pattern);
    if (found && found.length > 0) counts[rule.name] = found.length;
    text = text.replace(rule.pattern, rule.replacement);
  }
  return { text, counts };
}

function main(): void {
  const checkOnly = process.argv.includes('--check');
  const results: ScrubResult[] = [];

  for (const dir of FIXTURE_DIRS) {
    const full = join(ROOT, dir);
    if (!existsSync(full)) continue;
    for (const file of readdirSync(full).filter((f) => f.endsWith('.html'))) {
      const path = join(full, file);
      const original = readFileSync(path, 'utf8');
      const { text, counts } = scrubText(original);
      const total = Object.values(counts).reduce((a, b) => a + b, 0);
      if (total === 0) continue;
      results.push({ file: join(dir, file), counts, total });
      if (!checkOnly) writeFileSync(path, text);
    }
  }

  if (results.length === 0) {
    console.log('fixtures clean — no credentials found');
    return;
  }

  for (const r of results) {
    console.log(`${r.file}: ${r.total} (${Object.entries(r.counts).map(([k, v]) => `${k}=${v}`).join(', ')})`);
  }
  const total = results.reduce((a, r) => a + r.total, 0);

  if (checkOnly) {
    console.error(
      `\n${total} credential(s) found in ${results.length} fixture(s). ` +
        'Run `npm run scrub` before committing.',
    );
    process.exit(1);
  }
  console.log(`\nscrubbed ${total} credential(s) from ${results.length} fixture(s)`);
}

main();
