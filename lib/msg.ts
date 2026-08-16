/**
 * Rendering for engine-authored `LocalizedText`.
 *
 * The engines run in the service worker, which has no business knowing which
 * language a panel is showing — and their English output is what the test
 * suite and every non-panel consumer read. So they author a key plus facts,
 * and `english()` renders the English immediately: `signal.title` is always
 * the English sentence, derived from the catalog rather than duplicated
 * beside it, so prose and catalog cannot drift apart.
 *
 * The panel renders the same `LocalizedText` through `lib/i18n`'s `t()` in
 * the user's language. That is the whole trick: one authored sentence, two
 * renderings, no second copy of the words.
 */

import { en } from './i18n/en';
import type { MessageKey } from './i18n/keys';
import type { LocalizedText } from './signals';

/** Fill `{param}` slots. Unknown params stay visible — a bug you can see. */
function fill(template: string, params?: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (match: string, name: string) =>
    params !== undefined && params[name] !== undefined ? String(params[name]) : match,
  );
}

/**
 * The English rendering of a message. A key absent from the catalog answers
 * the key itself: visible, greppable, and never a blank sentence in the
 * evidence table.
 *
 * The compiler now rules that out for messages authored *here* — `msg` only
 * accepts a `MessageKey`. The fallback stays because not every `LocalizedText`
 * is authored here: signals cross a `runtime.sendMessage` boundary, and a
 * worker or a cached verdict from an older build can hand this function a key
 * that a later catalog renamed or dropped. That is the case the guard exists
 * for, and at that boundary the compiler's word is worth nothing.
 */
export function english(message: LocalizedText): string {
  const template = (en as Record<string, string>)[message.key];
  return template === undefined ? message.key : fill(template, message.params);
}

/**
 * Convenience for engine sites: author once, get the English back.
 *
 * `MessageKey`, not `string`, so a typo is a compile error at the authoring
 * site rather than a raw key in the reader's evidence table.
 */
export function msg(key: MessageKey, params?: Record<string, string | number>): LocalizedText {
  return params === undefined ? { key } : { key, params };
}
