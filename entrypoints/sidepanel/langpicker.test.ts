// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mountLanguagePicker } from './langpicker';
import { render } from './render';
import { activateLanguage, applyTranslations, SUPPORTED_LANGUAGES } from '../../lib/i18n';
import type { AnalysisState } from '../../lib/messages';

/**
 * The panel's language picker, and the titlebar it sits in.
 *
 * The markup comes from the real `index.html` rather than a hand-written stub:
 * the point of most of these assertions is that the three things in the
 * titlebar exist and are wired, and a stub would only prove the stub.
 */
const TITLEBAR = readFileSync(join(__dirname, 'index.html'), 'utf8');

function mountPanel(): void {
  document.body.innerHTML = TITLEBAR.replace(/^[\s\S]*<body>/, '').replace(/<\/body>[\s\S]*$/, '');
}

function picker(): HTMLSelectElement {
  return document.getElementById('language') as HTMLSelectElement;
}

afterEach(() => {
  activateLanguage('');
});

const DONE: AnalysisState = {
  phase: 'done',
  result: { verdict: 'GREEN', signals: [], reasons: [], llmCapped: false },
};

describe('the titlebar', () => {
  it('carries the wordmark, the picker and the version, in that order', () => {
    mountPanel();
    const titlebar = document.querySelector('.titlebar');
    const children = [...(titlebar?.children ?? [])].map((node) => node.tagName.toLowerCase());
    expect(children).toEqual(['h1', 'select', 'button']);
    expect(titlebar?.querySelector('h1')?.textContent).toBe('ListingProof');
    // The version keeps its five-press way into the map search, and keeps
    // giving no hint of being pressable — main.ts owns that behaviour.
    expect(titlebar?.querySelector('button')?.id).toBe('version');
  });

  it('gives the picker an accessible name from the catalog', () => {
    mountPanel();
    expect(picker().getAttribute('aria-label')).toBe('Language');
    activateLanguage('ru');
    applyTranslations(document);
    expect(picker().getAttribute('aria-label')).toBe('Язык');
  });
});

describe('mountLanguagePicker', () => {
  const deps = () => ({
    save: vi.fn(async (language: string) => language),
    apply: vi.fn(async () => {}),
  });

  it('offers every language this build carries, under its own name', () => {
    mountPanel();
    mountLanguagePicker(picker(), deps());
    const options = [...picker().options].map((option) => [option.value, option.textContent]);
    expect(options).toEqual(SUPPORTED_LANGUAGES.map(({ code, name }) => [code, name]));
    // A language's own name is never translated: someone hunting for their
    // language reads it in theirs, not in whatever the panel is showing.
    activateLanguage('ru');
    applyTranslations(document);
    expect(picker().options[0]?.textContent).toBe('English');
  });

  it('persists a change and applies what was actually stored', async () => {
    mountPanel();
    const injected = deps();
    mountLanguagePicker(picker(), injected);

    picker().value = 'ru';
    picker().dispatchEvent(new Event('change'));
    await vi.waitFor(() => expect(injected.apply).toHaveBeenCalledWith('ru'));
    expect(injected.save).toHaveBeenCalledWith('ru');
  });

  it('applies the sanitised code, not the one that was clicked', async () => {
    mountPanel();
    // The settings store degrades an unsupported code to English; the panel
    // must speak what was stored, or the next session would disagree with it.
    const injected = { save: vi.fn(async () => ''), apply: vi.fn(async () => {}) };
    mountLanguagePicker(picker(), injected);

    picker().value = 'ru';
    picker().dispatchEvent(new Event('change'));
    await vi.waitFor(() => expect(injected.apply).toHaveBeenCalledWith(''));
  });

  it('still applies the choice when storage refuses the write', async () => {
    mountPanel();
    const injected = {
      save: vi.fn(async () => {
        throw new Error('quota exceeded');
      }),
      apply: vi.fn(async () => {}),
    };
    mountLanguagePicker(picker(), injected);

    picker().value = 'de';
    picker().dispatchEvent(new Event('change'));
    // A failed write must not leave the user staring at a control that did
    // nothing; only the persistence is lost.
    await vi.waitFor(() => expect(injected.apply).toHaveBeenCalledWith('de'));
  });

  it('re-renders the panel through the new catalog', async () => {
    mountPanel();
    // `apply` stands in for main.ts's one application path: activate, re-run
    // the static translations, re-render the state the panel is showing.
    mountLanguagePicker(picker(), {
      save: async (language) => language,
      apply: async (language) => {
        activateLanguage(language);
        applyTranslations(document);
        render(DONE);
      },
    });

    picker().value = 'ru';
    picker().dispatchEvent(new Event('change'));
    await vi.waitFor(() =>
      expect(document.querySelector('.verdict-label')?.textContent).toBe(
        'Противоречий не обнаружено',
      ),
    );
  });
});
