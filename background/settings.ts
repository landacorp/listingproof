import { extensionStorage } from './storage';
import type { StorageArea } from '../lib/cache';
import { isSupportedLanguage } from '../lib/i18n/languages';
import { SEARCH_CATEGORIES } from '../lib/areasearch';

/**
 * User settings, stored under one `chrome.storage.local` key.
 *
 * Read fresh by the worker on every run (a settings change must not require a
 * worker restart) and written only by the options page. Values are sanitised
 * on every read AND write, so a corrupt or hand-edited store degrades to the
 * defaults rather than to undefined behaviour — the same reason `lib/cache.ts`
 * treats malformed entries as misses.
 *
 * Nothing here is a record of what the user viewed; it is configuration only.
 */

export interface Settings {
  /** Ollama HTTP endpoint. The default matches a stock local install. */
  ollamaEndpoint: string;
  /**
   * Preferred model for both Engine L roles (extractor and judge).
   * Empty string = automatic: Engine L probes what is installed and picks.
   */
  ollamaModel: string;
  /**
   * UI-chrome language, a code from `lib/i18n/languages.ts`. '' = English.
   * Chosen once on any page's picker, remembered here for every session.
   */
  language: string;
  /**
   * The map-search page's last-used filters — preferences, not history: no
   * coordinates and no drawn area are ever stored (the privacy policy's
   * "no record of what you viewed" covers where you searched too).
   */
  search: SearchDefaults;
}

export interface SearchDefaults {
  /** Dropped on read once in the past — stale stays must not resurrect. */
  checkin?: string;
  checkout?: string;
  /**
   * The user deliberately searches without dates. Absent dates alone cannot
   * say that: they also mean "never chose any" and "the pair went stale", both
   * of which should fall back to the page's default stay. This flag separates
   * a chosen emptiness from an unknown one, so "Search without dates" survives
   * to the next session.
   */
  stayCleared: boolean;
  adults: number;
  rooms: number;
  children: number;
  categories: string[];
  sort: string;
}

export const DEFAULT_SEARCH: SearchDefaults = {
  stayCleared: false,
  adults: 2,
  rooms: 1,
  children: 0,
  categories: [],
  sort: 'price-asc',
};

export const DEFAULT_SETTINGS: Settings = {
  ollamaEndpoint: 'http://localhost:11434',
  ollamaModel: '',
  language: '',
  search: DEFAULT_SEARCH,
};

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const SORT_MODES = ['price-asc', 'price-desc', 'rating-desc', 'platform'];

function sanitizeSearch(raw: unknown): SearchDefaults {
  const record = raw !== null && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const count = (value: unknown, min: number, max: number, fallback: number): number =>
    typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max
      ? value
      : fallback;
  const result: SearchDefaults = {
    stayCleared:
      typeof record.stayCleared === 'boolean' ? record.stayCleared : DEFAULT_SEARCH.stayCleared,
    adults: count(record.adults, 1, 30, DEFAULT_SEARCH.adults),
    rooms: count(record.rooms, 1, 30, DEFAULT_SEARCH.rooms),
    children: count(record.children, 0, 10, DEFAULT_SEARCH.children),
    categories: Array.isArray(record.categories)
      ? record.categories.filter(
          (value): value is string =>
            typeof value === 'string' && (SEARCH_CATEGORIES as readonly string[]).includes(value),
        )
      : [],
    sort:
      typeof record.sort === 'string' && SORT_MODES.includes(record.sort)
        ? record.sort
        : DEFAULT_SEARCH.sort,
  };
  // A stored stay whose check-in has passed is stale, not a preference.
  const today = new Date();
  const todayIso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  if (
    typeof record.checkin === 'string' &&
    typeof record.checkout === 'string' &&
    ISO_DATE.test(record.checkin) &&
    ISO_DATE.test(record.checkout) &&
    record.checkin < record.checkout &&
    record.checkin >= todayIso
  ) {
    result.checkin = record.checkin;
    result.checkout = record.checkout;
    // A kept stay and "deliberately undated" cannot both be true; the stay wins.
    result.stayCleared = false;
  }
  return result;
}

const KEY = 'settings';

export interface SettingsStore {
  load(): Promise<Settings>;
  /** Merge a partial update over what is stored; returns the result. */
  save(patch: Partial<Settings>): Promise<Settings>;
}

function sanitizeEndpoint(value: unknown): string {
  if (typeof value !== 'string') return DEFAULT_SETTINGS.ollamaEndpoint;
  const trimmed = value.trim().replace(/\/+$/, '');
  if (trimmed === '') return DEFAULT_SETTINGS.ollamaEndpoint;
  try {
    const url = new URL(trimmed);
    // The worker fetches `${endpoint}/api/…`; only http(s) may ever be stored.
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return DEFAULT_SETTINGS.ollamaEndpoint;
    }
  } catch {
    return DEFAULT_SETTINGS.ollamaEndpoint;
  }
  return trimmed;
}

function sanitize(raw: unknown): Settings {
  const record = raw !== null && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  return {
    ollamaEndpoint: sanitizeEndpoint(record.ollamaEndpoint),
    ollamaModel:
      typeof record.ollamaModel === 'string'
        ? record.ollamaModel.trim()
        : DEFAULT_SETTINGS.ollamaModel,
    // Unknown codes (an older build's store, hand edits) degrade to English
    // rather than to a blank UI.
    language:
      typeof record.language === 'string' && isSupportedLanguage(record.language)
        ? record.language
        : DEFAULT_SETTINGS.language,
    search: sanitizeSearch(record.search),
  };
}

export function createSettingsStore(storage: StorageArea = extensionStorage): SettingsStore {
  async function load(): Promise<Settings> {
    try {
      return sanitize((await storage.get(KEY))[KEY]);
    } catch {
      // Storage failure must degrade to defaults, never block analysis.
      return { ...DEFAULT_SETTINGS };
    }
  }

  return {
    load,
    async save(patch: Partial<Settings>): Promise<Settings> {
      const next = sanitize({ ...(await load()), ...patch });
      await storage.set({ [KEY]: next });
      return next;
    },
  };
}
