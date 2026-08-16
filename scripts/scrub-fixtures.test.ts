import { describe, expect, it } from 'vitest';
import { SCRUB_RULES, scrubText } from './scrub-fixtures';

/**
 * The scrubber is what stands between a captured page and a public repository,
 * so its failure mode is publishing someone else's credentials. It has already
 * failed twice by omission (a pass that looked for session tokens and not key
 * formats, then one that caught Google keys and not Mapbox) and once by
 * non-idempotence. These tests pin all three lessons.
 */

/**
 * Sample credentials are ASSEMBLED, never written as literals.
 *
 * A literal API-key-shaped string in this file would trip the same secret
 * scanners the scrubber exists to satisfy — and would itself be rewritten by
 * any history scrub, which is exactly how these tests broke once. Concatenation
 * keeps the shapes valid while leaving nothing key-shaped on disk.
 */
const fake = {
  google: 'AI' + 'za' + 'Sy' + 'B'.repeat(33),
  recaptcha: '6' + 'L' + 'e'.repeat(38),
  mapboxPayload: 'eyJ' + '1IjoibWFwYm94LWV4YW1wbGUifQ',
  mapboxSig: 'c'.repeat(12),
  uuid: '4a0d7cd2-3866-4b00-91cf-2b1d5e4a9f77',
  hex32: 'a9' + '9ecdd1f2b34c56d78e90ab12cd34e'.slice(0, 29) + 'f',
  csrf: 'Ab3xY9zQ1mN7pR4tW2vK8sL6dF0gH5jC',
};

const SAMPLES: Array<{ rule: string; text: string; leaks: string }> = [
  {
    rule: 'google-api-key',
    text: `<script>var k="${fake.google}";</script>`,
    leaks: fake.google,
  },
  {
    rule: 'recaptcha-site-key',
    text: `<div data-sitekey="${fake.recaptcha}"></div>`,
    leaks: fake.recaptcha,
  },
  {
    rule: 'mapbox-token',
    text: `mapboxAccessToken: 'pk.${fake.mapboxPayload}.${fake.mapboxSig}'`,
    leaks: `pk.${fake.mapboxPayload}`,
  },
  {
    rule: 'airbnb-session-token',
    text: `["SessionIdToken","${fake.uuid}"]`,
    leaks: fake.uuid,
  },
  {
    rule: 'booking-session-id',
    text: `b_sid: '${fake.hex32}',`,
    leaks: fake.hex32,
  },
  {
    // The meta-tag shape: value in a sibling attribute, not next to the key.
    // The inline rule cannot see this one, which is why both exist.
    rule: 'csrf-meta-tag',
    text: `<meta name="csrf-token" content="${fake.csrf}">`,
    leaks: fake.csrf,
  },
  {
    rule: 'csrf-token-value',
    text: `var cfg = { csrf_token: "${fake.csrf}" };`,
    leaks: fake.csrf,
  },
];

describe('every rule actually removes what it claims to', () => {
  it.each(SAMPLES.map((s) => [s.rule, s] as const))('%s', (rule, sample) => {
    const { text, counts } = scrubText(sample.text);
    expect(counts[rule], `${rule} did not fire`).toBeGreaterThan(0);
    expect(text, 'the credential survived').not.toContain(sample.leaks);
  });
});

describe('scrubbing is idempotent', () => {
  /**
   * A guard that reports its own placeholders is a guard people learn to
   * ignore. Two real ways to break this: a replacement that still satisfies its
   * own pattern (32 zeros are still 32 hex characters), and a replacement
   * shorter than the token it replaced, which trailing characters can complete
   * back into a match.
   */
  it.each(SAMPLES.map((s) => [s.rule, s] as const))(
    '%s finds nothing on a second pass',
    (rule, sample) => {
      const once = scrubText(sample.text);
      const twice = scrubText(once.text);
      expect(twice.counts[rule], `${rule} matched its own placeholder`).toBeUndefined();
      expect(twice.text).toBe(once.text);
    },
  );

  it('is idempotent over all rules at once, including trailing remainders', () => {
    // A token LONGER than its pattern leaves characters behind; if the
    // placeholder is shorter, those can complete a fresh match.
    const text = SAMPLES.map((s) => s.text).join('\n') + '\nAIza.REDACTED.GOOGLE.API.KEY.REMOVEDUEXTRA';
    const once = scrubText(text);
    const twice = scrubText(once.text);
    expect(twice.text).toBe(once.text);
    expect(Object.keys(twice.counts)).toEqual([]);
  });

  it('no replacement satisfies any rule pattern', () => {
    // The structural property behind idempotency, asserted directly rather than
    // inferred from the samples above.
    for (const rule of SCRUB_RULES) {
      for (const other of SCRUB_RULES) {
        const literal = rule.replacement.replace(/\$1/g, '');
        expect(
          new RegExp(other.pattern.source).test(literal),
          `${rule.name}'s replacement matches ${other.name}`,
        ).toBe(false);
      }
    }
  });
});

describe('scrubbing never damages data that merely looks like a key', () => {
  /**
   * The expensive lesson. An unanchored `6L[0-9A-Za-z_-]{38}` matches inside any
   * long base64 run — and captured pages, lockfiles and data URIs are full of
   * them. Applied across a history rewrite, it corrupted three npm integrity
   * hashes and broke `npm ci` on every CI runner at once.
   */
  it('leaves npm integrity hashes intact', () => {
    const hash =
      'sha512-27HBghJxjiZtIk3Ycvn/4kbJk/1uZuJFfuPEns6L51rBGdAQT20J3YSOqxC53Lo3bjWRtr2BKcfYoAf352WYpsZSTURrA0tqhfgudPA==';
    expect(scrubText(`"integrity": "${hash}"`).text).toContain(hash);
  });

  it('leaves base64 data URIs intact', () => {
    const uri = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg6LAAAAEAAAABAIAAAA' + 'f8/9hAAAAGXRFWHRTb2Z0d2F';
    expect(scrubText(`<img src="${uri}">`).text).toContain(uri);
  });

  it('still catches a real key at a value boundary', () => {
    // The anchor must not cost detection: a key after a quote, space, or `=`
    // is exactly how these appear in markup.
    for (const prefix of ['"', "'", ' ', '=', '(']) {
      const key = `6L${'e'.repeat(38)}`;
      expect(scrubText(`${prefix}${key}`).text, `after ${JSON.stringify(prefix)}`).not.toContain(key);
    }
  });
});

describe('scrubbing preserves the page', () => {
  it('leaves ordinary markup untouched', () => {
    const html = '<h1>Grand Hotel Rimini</h1><script>var b_hotel_id=84430;</script>';
    expect(scrubText(html).text).toBe(html);
  });

  it('does not eat identity data that looks tokenish', () => {
    // Booking photo asset ids and listing ids are long digit strings; losing
    // them would silently gut the extractor.
    const html = 'https://cf.bstatic.com/xdata/images/hotel/max500/887746162.jpg  ufi: \'-1746443\'';
    expect(scrubText(html).text).toBe(html);
  });
});
