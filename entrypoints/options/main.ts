import { browser } from 'wxt/browser';
import { createOptionsController } from './controller';
import { createSettingsStore } from '../../background/settings';
import { SUPPORTED_LANGUAGES, activateLanguage, applyTranslations, t } from '../../lib/i18n';
import type { AddSiteResult, RegisteredScript } from './controller';

/**
 * Options page wiring. All decisions live in `./controller.ts`; this file
 * connects them to the browser APIs and the DOM. DOM is built with
 * textContent/append only — user input must never become markup.
 */

/**
 * The registered script must load the same file the manifest's own content
 * script does, so read it from the manifest instead of hardcoding the build
 * output name — the two cannot drift apart.
 */
function contentScriptJs(): string[] {
  const manifest = browser.runtime.getManifest() as {
    content_scripts?: Array<{ js?: string[] }>;
  };
  return manifest.content_scripts?.[0]?.js ?? [];
}

const scripting = (
  browser as unknown as {
    scripting: {
      registerContentScripts(
        scripts: Array<{
          id: string;
          matches: string[];
          js: string[];
          runAt: string;
          persistAcrossSessions: boolean;
        }>,
      ): Promise<void>;
      unregisterContentScripts(filter: { ids: string[] }): Promise<void>;
      getRegisteredContentScripts(): Promise<RegisteredScript[]>;
    };
  }
).scripting;

const permissions = (
  browser as unknown as {
    permissions: {
      request(p: { origins: string[] }): Promise<boolean>;
      remove(p: { origins: string[] }): Promise<boolean>;
    };
  }
).permissions;

const controller = createOptionsController({
  requestPermission: (pattern) => permissions.request({ origins: [pattern] }),
  removePermission: (pattern) => permissions.remove({ origins: [pattern] }),
  registerContentScript: (id, matches) =>
    scripting.registerContentScripts([
      { id, matches, js: contentScriptJs(), runAt: 'document_idle', persistAcrossSessions: true },
    ]),
  unregisterContentScript: (id) => scripting.unregisterContentScripts({ ids: [id] }),
  registeredContentScripts: () => scripting.getRegisteredContentScripts(),
  settings: createSettingsStore(),
});

function byId<T extends HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}

const sitesList = byId<HTMLUListElement>('sites-list');
const siteStatus = byId<HTMLParagraphElement>('site-status');

function setStatus(element: HTMLParagraphElement, text: string, ok: boolean): void {
  element.textContent = text;
  element.className = `status ${ok ? 'ok' : 'err'}`;
}

// Looked up at event time, so a language switch reaches later messages too.
const ADD_MESSAGES: Record<Exclude<AddSiteResult['kind'], 'added'>, (host: string) => string> = {
  invalid: () => t('options.sites.addInvalid'),
  covered: (host) => t('options.sites.addCovered', { host }),
  exists: (host) => t('options.sites.addExists', { host }),
  denied: (host) => t('options.sites.addDenied', { host }),
  failed: (host) => t('options.sites.addFailed', { host }),
};

async function renderSites(): Promise<void> {
  sitesList.replaceChildren();

  const builtin = document.createElement('li');
  const builtinLabel = document.createElement('span');
  builtinLabel.className = 'builtin';
  builtinLabel.textContent = t('options.sites.builtinRow');
  builtin.append(builtinLabel);
  sitesList.append(builtin);

  for (const host of await controller.grantedSites()) {
    const item = document.createElement('li');
    const name = document.createElement('span');
    name.textContent = host;
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.textContent = t('options.sites.removeButton');
    remove.addEventListener('click', () => {
      void controller.removeSite(host).then(() => {
        setStatus(siteStatus, t('options.sites.removed', { host }), true);
        return renderSites();
      });
    });
    item.append(name, remove);
    sitesList.append(item);
  }
}

byId<HTMLFormElement>('site-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const input = byId<HTMLInputElement>('site-input');
  void controller.addSite(input.value).then((result) => {
    if (result.kind === 'added') {
      input.value = '';
      setStatus(siteStatus, t('options.sites.added', { host: result.host }), true);
      return renderSites();
    }
    setStatus(siteStatus, ADD_MESSAGES[result.kind](result.kind === 'invalid' ? '' : result.host), false);
    return undefined;
  });
});

const endpointInput = byId<HTMLInputElement>('ollama-endpoint');
const modelInput = byId<HTMLInputElement>('ollama-model');
const languageSelect = byId<HTMLSelectElement>('language');
const settingsStatus = byId<HTMLParagraphElement>('settings-status');

for (const { code, name } of SUPPORTED_LANGUAGES) {
  const option = document.createElement('option');
  option.value = code;
  option.textContent = name;
  languageSelect.append(option);
}

/** The catalog currently applied to the page, to detect a switch on save. */
let activeLanguageCode = '';

function speakLanguage(code: string): void {
  activeLanguageCode = code;
  activateLanguage(code);
  applyTranslations(document);
  document.title = t('options.title');
}

byId<HTMLButtonElement>('settings-save').addEventListener('click', () => {
  void controller
    .saveSettings({
      ollamaEndpoint: endpointInput.value,
      ollamaModel: modelInput.value,
      language: languageSelect.value,
    })
    .then(({ saved, endpointGranted }) => {
      // Reflect what was actually stored — sanitisation may have corrected it.
      endpointInput.value = saved.ollamaEndpoint;
      modelInput.value = saved.ollamaModel;
      languageSelect.value = saved.language;
      if (saved.language !== activeLanguageCode) {
        // Save is the explicit apply step: retranslate statics and re-render
        // dynamic rows so the page speaks the new language without a reload.
        speakLanguage(saved.language);
        void renderSites();
      }
      if (endpointGranted) {
        setStatus(settingsStatus, t('options.settings.saved'), true);
      } else {
        setStatus(
          settingsStatus,
          t('options.settings.savedNoAccess', { endpoint: saved.ollamaEndpoint }),
          false,
        );
      }
    })
    .catch(() => setStatus(settingsStatus, t('options.settings.saveFailed'), false));
});

void controller.loadSettings().then((settings) => {
  // Language first: the first render of dynamic rows must already speak it.
  speakLanguage(settings.language);
  endpointInput.value = settings.ollamaEndpoint;
  modelInput.value = settings.ollamaModel;
  languageSelect.value = settings.language;
  return renderSites();
});
