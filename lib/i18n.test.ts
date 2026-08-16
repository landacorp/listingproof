// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  activateLanguage,
  applyTranslations,
  isSupportedLanguage,
  SUPPORTED_LANGUAGES,
  t,
} from './i18n';
import { en } from './i18n/en';
import { locales } from './i18n/locales';

afterEach(() => activateLanguage(''));

describe('t', () => {
  it('answers English by default and fills params', () => {
    expect(t('search.status.resultsMany', { count: 25 })).toBe('25 places found.');
  });

  it('leaves an unfilled param visible instead of vanishing it', () => {
    expect(t('search.status.resultsMany')).toBe('{count} places found.');
  });

  it('falls back to English for a key a locale lacks', () => {
    activateLanguage('de');
    // Whatever de.json holds, a key it lacks must answer the English text.
    const missing = (Object.keys(en) as Array<keyof typeof en>).find(
      (key) => locales.de[key] === undefined,
    );
    if (missing !== undefined) expect(t(missing)).toBe(en[missing]);
  });

  it('treats an unknown language as English rather than throwing', () => {
    activateLanguage('xx');
    expect(t('panel.section.why')).toBe('Why');
  });
});

describe('supported languages', () => {
  it('lists English first as the empty code', () => {
    expect(SUPPORTED_LANGUAGES[0]).toEqual({ code: '', name: 'English' });
  });

  it('accepts every listed code and refuses others', () => {
    for (const { code } of SUPPORTED_LANGUAGES) expect(isSupportedLanguage(code)).toBe(true);
    expect(isSupportedLanguage('xx')).toBe(false);
    expect(isSupportedLanguage('en')).toBe(false); // English is '', not 'en'
  });

  it('has a committed catalog for every non-English language', () => {
    for (const { code } of SUPPORTED_LANGUAGES) {
      if (code !== '') expect(locales[code]).toBeDefined();
    }
  });
});

describe('applyTranslations', () => {
  it('fills element text and attribute pairs, and skips unknown keys', () => {
    document.body.innerHTML =
      '<p data-i18n="panel.section.why">inline</p>' +
      '<input data-i18n-attr="aria-label:common.language;placeholder:panel.noResult" />' +
      '<span data-i18n="not.a.key">untouched</span>';
    applyTranslations(document);
    expect(document.querySelector('p')?.textContent).toBe('Why');
    const input = document.querySelector('input');
    expect(input?.getAttribute('aria-label')).toBe('Language');
    expect(input?.getAttribute('placeholder')).toBe('No result.');
    expect(document.querySelector('span')?.textContent).toBe('untouched');
  });
});

describe('catalog integrity (fails CI on a bad regeneration)', () => {
  const placeholders = (text: string): string => (text.match(/\{\w+\}/g) ?? []).sort().join('|');

  it('every locale key exists in English, is non-empty, and keeps its placeholders', () => {
    for (const [code, catalog] of Object.entries(locales)) {
      for (const [key, translated] of Object.entries(catalog) as Array<[keyof typeof en, string]>) {
        expect(en[key], `${code}:${key} not in en catalog`).toBeDefined();
        expect(translated.trim(), `${code}:${key} is empty`).not.toBe('');
        expect(placeholders(translated), `${code}:${key} placeholder drift`).toBe(
          placeholders(en[key]),
        );
      }
    }
  });

  it('every data-i18n key in the page markup exists in the catalog', () => {
    // data-i18n references are the one key class the compiler cannot check
    // (t() calls are typed; dataset strings are not) — pin them here.
    const pages = ['entrypoints/search/index.html', 'entrypoints/options/index.html', 'entrypoints/sidepanel/index.html'];
    for (const page of pages) {
      const html = readFileSync(join(__dirname, '..', page), 'utf8');
      for (const match of html.matchAll(/data-i18n="([^"]+)"/g)) {
        expect(en[match[1] as keyof typeof en], `${page}: ${match[1]}`).toBeDefined();
      }
      for (const match of html.matchAll(/data-i18n-attr="([^"]+)"/g)) {
        for (const pair of match[1].split(';')) {
          const key = pair.split(':')[1];
          expect(en[key as keyof typeof en], `${page}: ${key}`).toBeDefined();
        }
      }
    }
  });
});
