import { describe, expect, it, vi } from 'vitest';
import { createPresenceClient, createPresenceRegistry, type PresencePort } from './presence';

/**
 * A port double with a `close()` the test drives, standing in for the browser
 * tearing a port down when its document goes.
 */
function fakePort(): PresencePort & { close(): void; listeners: number } {
  const listeners: Array<() => void> = [];
  return {
    onDisconnect: { addListener: (listener: () => void) => listeners.push(listener) },
    close: () => {
      for (const listener of listeners) listener();
    },
    get listeners() {
      return listeners.length;
    },
  };
}

describe('presence client (the page side)', () => {
  it('connects once, however often it is asked', () => {
    const connect = vi.fn(() => fakePort());
    const client = createPresenceClient(connect);

    client.ensure();
    client.ensure();
    client.ensure();

    expect(connect).toHaveBeenCalledTimes(1);
  });

  it('reconnects after the worker is retired and takes the port with it', () => {
    // The invariant the whole mechanism rests on: state for a tab implies a
    // live port from the page that produced it. Chrome retires an MV3 worker
    // on its own schedule, so the page must be able to announce itself again
    // alongside the next report.
    const ports = [fakePort(), fakePort()];
    const connect = vi.fn(() => ports.shift() as PresencePort);
    const client = createPresenceClient(connect);

    client.ensure();
    (connect.mock.results[0]!.value as ReturnType<typeof fakePort>).close();
    client.ensure();

    expect(connect).toHaveBeenCalledTimes(2);
  });

  it('a late disconnect from the OLD port does not discard the live one', () => {
    const first = fakePort();
    const second = fakePort();
    const connect = vi.fn(() => (connect.mock.calls.length === 1 ? first : second));
    const client = createPresenceClient(connect);

    client.ensure();
    first.close();
    client.ensure(); // now holding `second`
    first.close(); // a duplicate teardown for a port already replaced
    client.ensure();

    expect(connect).toHaveBeenCalledTimes(2);
  });

  it('survives a connect that throws, and retries next time', () => {
    // A worker torn down mid-call rejects the connect. Presence is a guard;
    // failing to arm it must never cost the report it rides along with.
    let fail = true;
    const connect = vi.fn(() => {
      if (fail) throw new Error('Extension context invalidated');
      return fakePort();
    });
    const client = createPresenceClient(connect);

    expect(() => client.ensure()).not.toThrow();
    fail = false;
    client.ensure();

    expect(connect).toHaveBeenCalledTimes(2);
  });
});

describe('presence registry (the worker side)', () => {
  it('reports which page is connected from a tab, and nothing for a tab with none', () => {
    const registry = createPresenceRegistry();

    const token = registry.arrived(7);

    expect(registry.token(7)).toBe(token);
    expect(registry.token(8)).toBeUndefined();
  });

  it('gives every page its own token, so a reload is a different page', () => {
    // Same tab, same URL, new document. This is the case the URL comparison
    // this module replaced could not see at all.
    const registry = createPresenceRegistry();

    const before = registry.arrived(7);
    const after = registry.arrived(7);

    expect(after).not.toBe(before);
    expect(registry.token(7)).toBe(after);
  });

  it('forgets a tab when its own page disconnects', () => {
    const registry = createPresenceRegistry();
    const token = registry.arrived(7);

    expect(registry.left(7, token)).toBe(true);
    expect(registry.token(7)).toBeUndefined();
  });

  it('ignores a disconnect once a newer page owns the tab', () => {
    // What a full-page navigation looks like when the new document's connect
    // beats the old document's disconnect: the state that exists now belongs
    // to the page that is there, and must not be dropped by its predecessor.
    const registry = createPresenceRegistry();
    const oldPage = registry.arrived(7);
    const newPage = registry.arrived(7);

    expect(registry.left(7, oldPage)).toBe(false);
    expect(registry.token(7)).toBe(newPage);
  });

  it('ignores a disconnect for a tab it knows nothing about', () => {
    const registry = createPresenceRegistry();
    expect(registry.left(7, 1)).toBe(false);
  });

  it('keeps tabs independent', () => {
    const registry = createPresenceRegistry();
    const seven = registry.arrived(7);
    const eight = registry.arrived(8);

    registry.left(7, seven);

    expect(registry.token(7)).toBeUndefined();
    expect(registry.token(8)).toBe(eight);
  });
});
