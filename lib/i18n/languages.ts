/**
 * The language offering, separated from the catalogs so the service worker
 * (which validates the stored setting but never renders text) can import
 * this list without pulling every translation into its bundle.
 *
 * Codes are our storage values and the translate script's targets; names are
 * written in their own language because a reader hunting for theirs may not
 * read English. '' is English — the source language, not a translation.
 */
export const SUPPORTED_LANGUAGES: ReadonlyArray<{ code: string; name: string }> = [
  { code: '', name: 'English' },
  { code: 'de', name: 'Deutsch' },
  { code: 'el', name: 'Ελληνικά' },
  { code: 'es', name: 'Español' },
  { code: 'fr', name: 'Français' },
  { code: 'it', name: 'Italiano' },
  { code: 'ja', name: '日本語' },
  { code: 'ko', name: '한국어' },
  { code: 'nl', name: 'Nederlands' },
  { code: 'pl', name: 'Polski' },
  { code: 'pt', name: 'Português' },
  { code: 'ru', name: 'Русский' },
  { code: 'tr', name: 'Türkçe' },
  { code: 'uk', name: 'Українська' },
  { code: 'zh', name: '中文' },
];

export function isSupportedLanguage(code: string): boolean {
  return SUPPORTED_LANGUAGES.some((language) => language.code === code);
}
