import { describe, expect, it, vi } from 'vitest';
import { createOptionsController } from './controller';
import type { OptionsDeps, RegisteredScript } from './controller';
import { DEFAULT_SETTINGS } from '../../background/settings';
import type { Settings } from '../../background/settings';

/**
 * Fake deps that mirror the browser's real invariant: the registration list
 * is the single source of truth the controller derives everything from.
 */
function makeDeps(overrides: Partial<OptionsDeps> = {}) {
  const registered: RegisteredScript[] = [];
  const permissions = new Set<string>();
  let stored: Settings = { ...DEFAULT_SETTINGS };
  const deps: OptionsDeps = {
    requestPermission: vi.fn(async (pattern: string) => {
      permissions.add(pattern);
      return true;
    }),
    removePermission: vi.fn(async (pattern: string) => permissions.delete(pattern)),
    registerContentScript: vi.fn(async (id: string, matches: string[]) => {
      registered.push({ id, matches });
    }),
    unregisterContentScript: vi.fn(async (id: string) => {
      const index = registered.findIndex((s) => s.id === id);
      if (index >= 0) registered.splice(index, 1);
    }),
    registeredContentScripts: vi.fn(async () => [...registered]),
    settings: {
      load: async () => stored,
      save: async (patch) => {
        stored = { ...stored, ...patch };
        return stored;
      },
    },
    ...overrides,
  };
  return { deps, registered, permissions };
}

describe('addSite', () => {
  it('grants the origin and registers the content script for it', async () => {
    const { deps, registered, permissions } = makeDeps();
    const controller = createOptionsController(deps);

    const result = await controller.addSite('https://www.premierinn.com/gb/en/hotels/x.html');

    expect(result).toEqual({ kind: 'added', host: 'premierinn.com' });
    expect(permissions.has('*://*.premierinn.com/*')).toBe(true);
    expect(registered).toEqual([
      { id: 'user-site:premierinn.com', matches: ['*://*.premierinn.com/*'] },
    ]);
    expect(await controller.grantedSites()).toEqual(['premierinn.com']);
  });

  it('rejects input that names no host', async () => {
    const { deps } = makeDeps();
    expect(await createOptionsController(deps).addSite('not a domain')).toEqual({
      kind: 'invalid',
    });
    expect(deps.requestPermission).not.toHaveBeenCalled();
  });

  it('refuses a site the manifest already covers — double injection', async () => {
    const { deps } = makeDeps();
    expect(await createOptionsController(deps).addSite('secure.booking.com')).toEqual({
      kind: 'covered',
      host: 'secure.booking.com',
    });
    expect(deps.requestPermission).not.toHaveBeenCalled();
  });

  it('refuses a duplicate grant', async () => {
    const { deps } = makeDeps();
    const controller = createOptionsController(deps);
    await controller.addSite('agoda.com');
    expect(await controller.addSite('www.agoda.com')).toEqual({
      kind: 'exists',
      host: 'agoda.com',
    });
    expect(deps.registerContentScript).toHaveBeenCalledTimes(1);
  });

  it('reports a permission the user declined, and registers nothing', async () => {
    const { deps, registered } = makeDeps({
      requestPermission: vi.fn(async () => false),
    });
    expect(await createOptionsController(deps).addSite('agoda.com')).toEqual({
      kind: 'denied',
      host: 'agoda.com',
    });
    expect(registered).toEqual([]);
  });

  it('a rejecting permission prompt reads as declined, not as a crash', async () => {
    const { deps } = makeDeps({
      requestPermission: vi.fn(async () => {
        throw new Error('no user gesture');
      }),
    });
    expect(await createOptionsController(deps).addSite('agoda.com')).toEqual({
      kind: 'denied',
      host: 'agoda.com',
    });
  });

  it('hands the permission back when registration fails', async () => {
    const { deps, permissions } = makeDeps({
      registerContentScript: vi.fn(async () => {
        throw new Error('invalid pattern');
      }),
    });
    expect(await createOptionsController(deps).addSite('agoda.com')).toEqual({
      kind: 'failed',
      host: 'agoda.com',
    });
    expect(permissions.size).toBe(0);
  });
});

describe('removeSite', () => {
  it('unregisters the script and hands back the origin', async () => {
    const { deps, registered, permissions } = makeDeps();
    const controller = createOptionsController(deps);
    await controller.addSite('agoda.com');

    await controller.removeSite('agoda.com');

    expect(registered).toEqual([]);
    expect(permissions.size).toBe(0);
    expect(await controller.grantedSites()).toEqual([]);
  });
});

describe('grantedSites', () => {
  it('lists only this feature\'s registrations, alphabetically', async () => {
    const { deps, registered } = makeDeps();
    registered.push(
      { id: 'user-site:premierinn.com' },
      { id: 'some-other-feature' },
      { id: 'user-site:agoda.com' },
    );
    expect(await createOptionsController(deps).grantedSites()).toEqual([
      'agoda.com',
      'premierinn.com',
    ]);
  });
});

describe('settings', () => {
  it('loads and saves through the injected store', async () => {
    const { deps } = makeDeps();
    const controller = createOptionsController(deps);
    await controller.saveSettings({ ollamaModel: 'llama3.1:8b' });
    expect(await controller.loadSettings()).toEqual({
      ...DEFAULT_SETTINGS,
      ollamaModel: 'llama3.1:8b',
    });
  });

  it('saving the default endpoint asks for no extra permission', async () => {
    const { deps } = makeDeps();
    const result = await createOptionsController(deps).saveSettings({ ollamaModel: 'llama3.1:8b' });
    expect(result.endpointGranted).toBe(true);
    expect(deps.requestPermission).not.toHaveBeenCalled();
  });

  it("requests a custom endpoint's origin so the worker may fetch it", async () => {
    const { deps, permissions } = makeDeps();
    const result = await createOptionsController(deps).saveSettings({
      ollamaEndpoint: 'http://192.168.1.5:11434',
    });
    expect(result.endpointGranted).toBe(true);
    expect(permissions.has('http://192.168.1.5:11434/*')).toBe(true);
  });

  it('reports a declined endpoint grant while still keeping the setting', async () => {
    const { deps } = makeDeps({ requestPermission: vi.fn(async () => false) });
    const controller = createOptionsController(deps);
    const result = await controller.saveSettings({ ollamaEndpoint: 'https://ollama.lan' });
    expect(result.endpointGranted).toBe(false);
    expect((await controller.loadSettings()).ollamaEndpoint).toBe('https://ollama.lan');
  });
});
