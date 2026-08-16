import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, createSettingsStore } from './settings';
import type { StorageArea } from '../lib/cache';

function fakeStorage(seed: Record<string, unknown> = {}) {
  const data = new Map<string, unknown>(Object.entries(seed));
  let failGet = false;
  const storage: StorageArea = {
    async get(key) {
      if (failGet) throw new Error('storage broken');
      return data.has(key) ? { [key]: data.get(key) } : {};
    },
    async set(items) {
      for (const [key, value] of Object.entries(items)) data.set(key, value);
    },
    async remove(key) {
      data.delete(key);
    },
  };
  return { storage, data, breakGet: () => (failGet = true) };
}

describe('load', () => {
  it('answers defaults on an empty store', async () => {
    const { storage } = fakeStorage();
    expect(await createSettingsStore(storage).load()).toEqual(DEFAULT_SETTINGS);
  });

  it('answers defaults when storage itself fails — settings must never block analysis', async () => {
    const { storage, breakGet } = fakeStorage();
    breakGet();
    expect(await createSettingsStore(storage).load()).toEqual(DEFAULT_SETTINGS);
  });

  it('fills missing and wrongly-typed fields from defaults', async () => {
    const { storage } = fakeStorage({
      settings: { ollamaModel: 42, language: 7, unknownField: true },
    });
    expect(await createSettingsStore(storage).load()).toEqual(DEFAULT_SETTINGS);
  });

  it('drops a setting an older build stored and this one no longer has', async () => {
    // `photoHashing` configured the archive photo comparison, removed with the
    // rest of the archive check. Sanitising rebuilds the object field by field,
    // so a retired key is neither returned nor written back on the next save.
    const { storage, data } = fakeStorage({ settings: { photoHashing: false, language: 'uk' } });
    const store = createSettingsStore(storage);
    expect(await store.load()).toEqual({ ...DEFAULT_SETTINGS, language: 'uk' });
    await store.save({ ollamaModel: 'llama3.1:8b' });
    expect(data.get('settings')).not.toHaveProperty('photoHashing');
  });

  it.each([
    ['javascript:alert(1)'],
    ['file:///etc/passwd'],
    ['not a url'],
    [''],
  ])('refuses %s as an endpoint and keeps the default', async (endpoint) => {
    const { storage } = fakeStorage({ settings: { ollamaEndpoint: endpoint } });
    const loaded = await createSettingsStore(storage).load();
    expect(loaded.ollamaEndpoint).toBe(DEFAULT_SETTINGS.ollamaEndpoint);
  });

  it('keeps a valid custom endpoint, without its trailing slash', async () => {
    const { storage } = fakeStorage({ settings: { ollamaEndpoint: 'http://192.168.1.5:11434/' } });
    const loaded = await createSettingsStore(storage).load();
    expect(loaded.ollamaEndpoint).toBe('http://192.168.1.5:11434');
  });
});

describe('save', () => {
  it('merges a patch over the stored settings and persists the result', async () => {
    const { storage, data } = fakeStorage();
    const store = createSettingsStore(storage);
    await store.save({ language: 'uk' });
    const saved = await store.save({ ollamaModel: ' llama3.1:8b ' });

    expect(saved).toEqual({
      ...DEFAULT_SETTINGS,
      language: 'uk',
      ollamaModel: 'llama3.1:8b',
    });
    expect(data.get('settings')).toEqual(saved);
    expect(await store.load()).toEqual(saved);
  });

  it('sanitises what it writes, not just what it reads', async () => {
    const { storage, data } = fakeStorage();
    await createSettingsStore(storage).save({ ollamaEndpoint: 'javascript:alert(1)' });
    expect((data.get('settings') as { ollamaEndpoint: string }).ollamaEndpoint).toBe(
      DEFAULT_SETTINGS.ollamaEndpoint,
    );
  });

  it('keeps a supported language and degrades an unknown one to English', async () => {
    const { storage } = fakeStorage();
    const store = createSettingsStore(storage);
    expect((await store.save({ language: 'uk' })).language).toBe('uk');
    expect((await store.save({ language: 'klingon' })).language).toBe('');
  });

  it('keeps sane search defaults and drops stale or foreign values', async () => {
    const { storage } = fakeStorage();
    const store = createSettingsStore(storage);
    const saved = await store.save({
      search: {
        checkin: '2001-01-01', // long past — must not resurrect
        checkout: '2001-01-03',
        stayCleared: false,
        adults: 4,
        rooms: 2,
        children: 99, // out of bounds → default
        categories: ['hotel', 'castle'], // unknown filtered, known kept
        sort: 'by-vibes', // unknown → default
      },
    });
    expect(saved.search.checkin).toBeUndefined();
    expect(saved.search.checkout).toBeUndefined();
    expect(saved.search).toMatchObject({
      adults: 4,
      rooms: 2,
      children: 0,
      categories: ['hotel'],
      sort: 'price-asc',
    });
  });

  it('remembers a deliberately undated stay, and forgets it when dates return', async () => {
    const { storage } = fakeStorage();
    const store = createSettingsStore(storage);
    // Default: no dates stored, but nothing was cleared either — the page's
    // own default stay stands in.
    expect((await store.load()).search.stayCleared).toBe(false);

    const cleared = await store.save({ search: { ...DEFAULT_SETTINGS.search, stayCleared: true } });
    expect(cleared.search.stayCleared).toBe(true);
    expect((await store.load()).search.stayCleared).toBe(true);

    // A stay that survives sanitising outranks the flag: they cannot both hold.
    const nextYear = new Date().getFullYear() + 1;
    const dated = await store.save({
      search: {
        ...DEFAULT_SETTINGS.search,
        stayCleared: true,
        checkin: `${nextYear}-09-13`,
        checkout: `${nextYear}-09-15`,
      },
    });
    expect(dated.search).toMatchObject({
      stayCleared: false,
      checkin: `${nextYear}-09-13`,
      checkout: `${nextYear}-09-15`,
    });
  });

  it('degrades a non-boolean stayCleared to false rather than to a truthy string', async () => {
    const { storage } = fakeStorage({ settings: { search: { stayCleared: 'yes' } } });
    expect((await createSettingsStore(storage).load()).search.stayCleared).toBe(false);
  });
});
