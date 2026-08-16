import { coveredByBuiltIn, originPatternFor, parseGrantHost } from '../../lib/sitegrants';
import { DEFAULT_SETTINGS } from '../../background/settings';
import type { Settings, SettingsStore } from '../../background/settings';

/**
 * Options page logic: site grants and settings, with every browser call
 * injected so the whole flow is unit-testable (the `render.ts`/`controller.ts`
 * recipe from the side panel).
 *
 * Site grants are the P0-2 fix: the generic schema.org adapter is unreachable
 * unless the content script runs on the site, and the manifest deliberately
 * requests no all-URLs access. The user names a site here; the browser asks
 * for that one origin; the content script is registered for it. The browser's
 * own permission + registration state is the single source of truth — nothing
 * about granted sites is stored separately, so the list can never disagree
 * with what the extension can actually do.
 */

const GRANT_ID_PREFIX = 'user-site:';

export interface RegisteredScript {
  id: string;
  matches?: string[];
}

export interface OptionsDeps {
  /** `permissions.request` — must run in a user gesture. */
  requestPermission(pattern: string): Promise<boolean>;
  removePermission(pattern: string): Promise<boolean>;
  registerContentScript(id: string, matches: string[]): Promise<void>;
  unregisterContentScript(id: string): Promise<void>;
  registeredContentScripts(): Promise<RegisteredScript[]>;
  settings: SettingsStore;
}

export type AddSiteResult =
  | { kind: 'added'; host: string }
  | { kind: 'invalid' }
  | { kind: 'covered'; host: string }
  | { kind: 'exists'; host: string }
  | { kind: 'denied'; host: string }
  | { kind: 'failed'; host: string };

export interface SaveSettingsResult {
  saved: Settings;
  /**
   * False when a custom Ollama endpoint was saved but the browser permission
   * for its origin was declined — the setting is stored, but the worker's
   * fetches to it will fail until the permission is granted.
   */
  endpointGranted: boolean;
}

export interface OptionsController {
  /** Hosts the user has granted, alphabetical. */
  grantedSites(): Promise<string[]>;
  addSite(input: string): Promise<AddSiteResult>;
  removeSite(host: string): Promise<void>;
  loadSettings(): Promise<Settings>;
  saveSettings(patch: Partial<Settings>): Promise<SaveSettingsResult>;
}

export function createOptionsController(deps: OptionsDeps): OptionsController {
  async function grantedSites(): Promise<string[]> {
    const registered = await deps.registeredContentScripts();
    return registered
      .filter((script) => script.id.startsWith(GRANT_ID_PREFIX))
      .map((script) => script.id.slice(GRANT_ID_PREFIX.length))
      .sort();
  }

  return {
    grantedSites,

    async addSite(input: string): Promise<AddSiteResult> {
      const host = parseGrantHost(input);
      if (host === null) return { kind: 'invalid' };
      if (coveredByBuiltIn(host)) return { kind: 'covered', host };
      if ((await grantedSites()).includes(host)) return { kind: 'exists', host };

      const pattern = originPatternFor(host);
      const granted = await deps.requestPermission(pattern).catch(() => false);
      if (!granted) return { kind: 'denied', host };

      try {
        await deps.registerContentScript(GRANT_ID_PREFIX + host, [pattern]);
      } catch {
        // Registration failed after the permission was granted; hand the
        // permission back rather than leaving an orphaned grant behind.
        await deps.removePermission(pattern).catch(() => {});
        return { kind: 'failed', host };
      }
      return { kind: 'added', host };
    },

    async removeSite(host: string): Promise<void> {
      // Unregister first: an origin without a script is inert, a script
      // without an origin is a registration Chrome would reject on restart.
      await deps.unregisterContentScript(GRANT_ID_PREFIX + host).catch(() => {});
      await deps.removePermission(originPatternFor(host)).catch(() => {});
    },

    loadSettings: () => deps.settings.load(),

    async saveSettings(patch: Partial<Settings>): Promise<SaveSettingsResult> {
      const saved = await deps.settings.save(patch);
      // The worker fetches the Ollama endpoint. localhost is a manifest host
      // permission already; any other origin needs its own grant, and this
      // save click is the user gesture that can request it.
      if (saved.ollamaEndpoint === DEFAULT_SETTINGS.ollamaEndpoint) {
        return { saved, endpointGranted: true };
      }
      const origin = `${new URL(saved.ollamaEndpoint).origin}/*`;
      const endpointGranted = await deps.requestPermission(origin).catch(() => false);
      return { saved, endpointGranted };
    },
  };
}
