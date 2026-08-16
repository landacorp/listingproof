/**
 * Build-time machine translation of the UI catalog: `npx vite-node
 * scripts/translate-catalog.ts` (optionally `-- de fr` for specific
 * languages).
 *
 * Reads `lib/i18n/en.ts`, translates every string through Google Translate's
 * free endpoint, and writes `lib/i18n/locales/<code>.json`. This runs on a
 * DEVELOPER machine at build time and sends only our own UI strings — the
 * shipped extension never contacts a translation service, which is what
 * keeps the "nothing you view leaves your machine" promise true.
 *
 * Honesty mechanics:
 * - `{param}` placeholders must survive translation verbatim. A translation
 *   that drops or mangles one is retried once with sentinel protection and
 *   otherwise DISCARDED — the runtime then falls back to English for that
 *   key, which is honest; a broken placeholder in fourteen languages is not.
 * - Each locale JSON carries a `__meta.sourceHash` per key (hash of the
 *   English text). Re-runs skip up-to-date keys, so drift re-translates
 *   exactly what changed and nothing else.
 * - The endpoint is unofficial (client=gtx). Fine for a dev-machine script;
 *   it must never move into the extension.
 */

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { en } from '../lib/i18n/en';
import { SUPPORTED_LANGUAGES } from '../lib/i18n/languages';

const ROOT = join(__dirname, '..');
const LOCALES_DIR = join(ROOT, 'lib/i18n/locales');
/** Storage code → endpoint code, where they differ. */
const ENDPOINT_CODES: Record<string, string> = { zh: 'zh-CN' };
const REQUEST_GAP_MS = 120;

const hash = (text: string): string =>
  createHash('sha256').update(text).digest('hex').slice(0, 12);

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const placeholders = (text: string): string[] => (text.match(/\{\w+\}/g) ?? []).sort();

async function translateOnce(text: string, lang: string): Promise<string> {
  const url =
    'https://translate.googleapis.com/translate_a/single?client=gtx&sl=en' +
    `&tl=${ENDPOINT_CODES[lang] ?? lang}&dt=t&q=${encodeURIComponent(text)}`;
  const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const data = (await response.json()) as unknown;
  // Response shape: [[["translated","source",...], ...sentence segments], ...]
  if (!Array.isArray(data) || !Array.isArray(data[0])) throw new Error('unexpected shape');
  return (data[0] as unknown[][])
    .map((segment) => (typeof segment?.[0] === 'string' ? segment[0] : ''))
    .join('');
}

/** Translate preserving {param} tokens; null = unusable, caller falls back. */
async function translate(text: string, lang: string): Promise<string | null> {
  const wanted = placeholders(text);
  const direct = await translateOnce(text, lang);
  // An odd response shape can join to an empty string, which placeholder
  // comparison alone would accept for placeholder-free keys — a blank UI
  // string in one language. Empty is always unusable.
  if (direct.trim() === '') return null;
  if (placeholders(direct).join('|') === wanted.join('|')) return direct;

  // Retry wrapping each placeholder in a sentinel the engine leaves alone,
  // then unwrap. ⟦0⟧-style markers survive translation far more reliably.
  const names = wanted.map((token) => token.slice(1, -1));
  const wrapped = names.reduce(
    (acc, name, i) => acc.split(`{${name}}`).join(`⟦${i}⟧`),
    text,
  );
  const retried = await translateOnce(wrapped, lang);
  const unwrapped = names.reduce(
    (acc, name, i) => acc.split(`⟦${i}⟧`).join(`{${name}}`),
    retried,
  );
  if (unwrapped.trim() === '') return null;
  return placeholders(unwrapped).join('|') === wanted.join('|') ? unwrapped : null;
}

async function run(): Promise<void> {
  const requested = process.argv.slice(2).filter((arg) => arg !== '--');
  const targets = SUPPORTED_LANGUAGES.map((l) => l.code).filter(
    (code) => code !== '' && (requested.length === 0 || requested.includes(code)),
  );
  const entries = Object.entries(en) as Array<[string, string]>;
  let translated = 0;
  let skipped = 0;
  const fallbacks: string[] = [];

  for (const lang of targets) {
    const file = join(LOCALES_DIR, `${lang}.json`);
    const existing = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    const meta = (existing.__meta as { sourceHash?: Record<string, string> } | undefined) ?? {};
    const sourceHash: Record<string, string> = { ...(meta.sourceHash ?? {}) };
    const next: Record<string, string> = {};

    for (const [key, text] of entries) {
      const current = existing[key];
      if (typeof current === 'string' && sourceHash[key] === hash(text)) {
        next[key] = current;
        skipped += 1;
        continue;
      }
      await sleep(REQUEST_GAP_MS);
      try {
        const result = await translate(text, lang);
        if (result === null) {
          fallbacks.push(`${lang}:${key} (placeholder mangled — falls back to English)`);
          delete sourceHash[key];
          continue;
        }
        next[key] = result;
        sourceHash[key] = hash(text);
        translated += 1;
      } catch (error) {
        fallbacks.push(`${lang}:${key} (${String(error)} — falls back to English)`);
        delete sourceHash[key];
      }
    }

    const sorted = Object.fromEntries(Object.entries(next).sort(([a], [b]) => a.localeCompare(b)));
    writeFileSync(file, `${JSON.stringify({ ...sorted, __meta: { sourceHash } }, null, 2)}\n`);
    console.log(`${lang}: ${Object.keys(sorted).length}/${entries.length} keys`);
  }

  console.log(`\ntranslated ${translated}, unchanged ${skipped}`);
  if (fallbacks.length > 0) {
    console.log(`English fallbacks (${fallbacks.length}):`);
    for (const line of fallbacks) console.log(`  - ${line}`);
  }
}

void run();
