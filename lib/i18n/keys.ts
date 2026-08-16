/**
 * The set of message keys the English catalog defines — the compiler's copy of
 * it, so a typo is a build error rather than a raw `enginea.a1.titel` shown to
 * a user in fourteen languages.
 *
 * Its own module, and not a line in `lib/i18n.ts`, for one reason: this type is
 * needed by `lib/signals.ts` and by every engine, and `lib/signals.ts` is
 * imported by pure logic and by the service worker alike. A TYPE-ONLY import of
 * this file costs exactly nothing at runtime — `import type` is erased — whereas
 * importing `lib/i18n.ts` would drag `./locales` and all fourteen translated
 * JSON catalogs into every one of those bundles to obtain a type that vanishes
 * at compile time. `lib/i18n.ts` re-exports `MessageKey` from here, so there is
 * still exactly one definition and existing importers are unaffected.
 */

import type { en } from './en';

export type MessageKey = keyof typeof en;
