import { describe, expect, it } from 'vitest';
import { canonicalizeListingUrl } from './canonicalize';

const ALPINE_SLUG = 'l-39-horizon-des-alpes-le-petit-bornand-les-glieres';
const ALPINE_CANONICAL = `https://www.booking.com/hotel/fr/${ALPINE_SLUG}.html`;
const ALPINE_PREFIX = `booking.com/hotel/fr/${ALPINE_SLUG}`;

describe('canonicalizeListingUrl', () => {
  it.each([
    // [name, input, expected]
    [
      'real-world URL with locale, affiliate params, session id and fragment',
      `https://www.booking.com/hotel/fr/${ALPINE_SLUG}.en-gb.html?aid=1610684&label=elat-abc%3Apl%3Ata&sid=a99ecdd1&checkin=2026-11-27&checkout=2026-12-10&group_adults=2&group_children=3#tab-main`,
      { canonicalUrl: ALPINE_CANONICAL, cdxPrefix: ALPINE_PREFIX, countryCode: 'fr', slug: ALPINE_SLUG, locale: 'en-gb' },
    ],
    [
      'bare canonical form without locale',
      `https://www.booking.com/hotel/fr/${ALPINE_SLUG}.html`,
      { canonicalUrl: ALPINE_CANONICAL, cdxPrefix: ALPINE_PREFIX, countryCode: 'fr', slug: ALPINE_SLUG, locale: null },
    ],
    [
      'two-letter locale',
      'https://www.booking.com/hotel/it/grand-hotel-rimini.de.html',
      {
        canonicalUrl: 'https://www.booking.com/hotel/it/grand-hotel-rimini.html',
        cdxPrefix: 'booking.com/hotel/it/grand-hotel-rimini',
        countryCode: 'it',
        slug: 'grand-hotel-rimini',
        locale: 'de',
      },
    ],
    [
      'region locale zh-cn',
      'https://www.booking.com/hotel/jp/tokyo-inn.zh-cn.html',
      {
        canonicalUrl: 'https://www.booking.com/hotel/jp/tokyo-inn.html',
        cdxPrefix: 'booking.com/hotel/jp/tokyo-inn',
        countryCode: 'jp',
        slug: 'tokyo-inn',
        locale: 'zh-cn',
      },
    ],
    [
      'mobile host, http scheme',
      `http://m.booking.com/hotel/fr/${ALPINE_SLUG}.html`,
      { canonicalUrl: ALPINE_CANONICAL, cdxPrefix: ALPINE_PREFIX, countryCode: 'fr', slug: ALPINE_SLUG, locale: null },
    ],
    [
      'secure host with uppercase letters in URL',
      `https://Secure.Booking.com/hotel/FR/${ALPINE_SLUG.toUpperCase()}.EN-GB.html`,
      { canonicalUrl: ALPINE_CANONICAL, cdxPrefix: ALPINE_PREFIX, countryCode: 'fr', slug: ALPINE_SLUG, locale: 'en-gb' },
    ],
  ])('%s', (_name, input, expected) => {
    expect(canonicalizeListingUrl(input)).toEqual(expected);
  });

  it.each([
    ['search results page', 'https://www.booking.com/searchresults.en-gb.html?ss=Paris'],
    ['hotel index without slug', 'https://www.booking.com/hotel/fr/.html'],
    ['non-booking host', 'https://www.bookingg.com/hotel/fr/some-hotel.html'],
    ['lookalike host suffix', 'https://booking.com.evil.example/hotel/fr/some-hotel.html'],
    ['non-http scheme', 'ftp://www.booking.com/hotel/fr/some-hotel.html'],
    ['not a URL at all', 'obviously not a url'],
    ['country segment too long', 'https://www.booking.com/hotel/fra/some-hotel.html'],
    ['missing .html suffix', 'https://www.booking.com/hotel/fr/some-hotel'],
  ])('rejects %s', (_name, input) => {
    expect(canonicalizeListingUrl(input)).toBeNull();
  });

  it('keeps an unknown dot-suffix as part of the slug (permissive rule)', () => {
    const out = canonicalizeListingUrl('https://www.booking.com/hotel/fr/hotel-st.michel.html');
    expect(out).not.toBeNull();
    expect(out!.slug).toBe('hotel-st.michel');
    expect(out!.locale).toBeNull();
  });

  it('does not confuse a slug ending in a locale-shaped word with a locale plus keeps real one', () => {
    // "spa" is 3 letters -> not locale-shaped; "de" would be. This documents the known
    // ambiguity: a slug genuinely ending in ".de" cannot be distinguished from a locale.
    const out = canonicalizeListingUrl('https://www.booking.com/hotel/es/costa-del-spa.html');
    expect(out!.slug).toBe('costa-del-spa');
  });
});
