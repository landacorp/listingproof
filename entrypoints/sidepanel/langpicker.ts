import { SUPPORTED_LANGUAGES } from '../../lib/i18n';

/**
 * The panel's language picker.
 *
 * Its own module, with both browser-facing steps injected, for the reason
 * `./controller.ts` gives: `main.ts` is the only file allowed to know about
 * `chrome.*`, and everything else in the panel should be testable in jsdom
 * without it.
 *
 * `apply` is deliberately a dependency rather than something this module does.
 * The panel already has ONE way to change language — a generation-counted
 * queue in `main.ts` that re-requests the tab's state so the verdict is redrawn
 * through the new catalog — and a picker that re-translated the page itself
 * would be a second, subtly different mechanism sitting beside it.
 */
export interface LanguagePickerDeps {
  /** Persist the choice; answers the code that was actually stored. */
  save(language: string): Promise<string>;
  /** Apply a language to the panel: `main.ts`'s single application path. */
  apply(language: string): Promise<void>;
}

/**
 * Fill the picker and wire it to `deps`.
 *
 * Option labels are the languages' own names and are never translated: someone
 * looking for their language reads it in their language, not in the one the
 * panel happens to be showing. That is also why `applyTranslations` leaves
 * these alone — only the control's accessible name carries a `data-i18n` key.
 */
export function mountLanguagePicker(select: HTMLSelectElement, deps: LanguagePickerDeps): void {
  const doc = select.ownerDocument;
  for (const { code, name } of SUPPORTED_LANGUAGES) {
    const option = doc.createElement('option');
    option.value = code;
    option.textContent = name;
    select.append(option);
  }

  select.addEventListener('change', () => {
    const chosen = select.value;
    void deps
      .save(chosen)
      // A storage failure must not leave the user staring at a control that
      // did nothing: apply what they picked, and let the next session fall
      // back to whatever is actually stored.
      .catch(() => chosen)
      .then((saved) => deps.apply(saved));
  });
}
