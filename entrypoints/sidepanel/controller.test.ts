import { describe, expect, it, vi } from 'vitest';
import { createPanelController } from './controller';
import type { PanelControllerDeps } from './controller';
import type { AnalysisState, RequestStateResponse, StateMessage } from '../../lib/messages';

const RED: AnalysisState = {
  phase: 'done',
  canonicalUrl: 'https://www.booking.com/hotel/fr/hijacked.html',
  result: { verdict: 'RED', signals: [], reasons: ['RED from B.geo'], llmCapped: false },
};

const GREEN: AnalysisState = {
  phase: 'done',
  canonicalUrl: 'https://www.booking.com/hotel/fr/honest.html',
  result: { verdict: 'GREEN', signals: [], reasons: [], llmCapped: false },
};

const IDLE: AnalysisState = { phase: 'idle' };

function stateMessage(tabId: number, state: AnalysisState): StateMessage {
  return { type: 'STATE', tabId, state };
}

function stateResponse(tabId: number | undefined, state: AnalysisState): RequestStateResponse {
  return { tabId, state };
}

interface Deferred {
  resolve(value: unknown): void;
  reject(reason?: unknown): void;
}

/**
 * Test double for the controller's deps. `requestState` hands back a deferred
 * per call so tests control exactly when (and in what order) responses land.
 */
function makeDeps() {
  const requests: Array<{ tabId: number | undefined; deferred: Deferred }> = [];
  const rendered: AnalysisState[] = [];
  const deps: PanelControllerDeps = {
    requestState: vi.fn((tabId: number | undefined) => {
      return new Promise((resolve, reject) => {
        requests.push({ tabId, deferred: { resolve, reject } });
      });
    }),
    queryActive: vi.fn(() => Promise.resolve({ tabId: 1, windowId: 10 })),
    requestRereport: vi.fn(),
    render: vi.fn((state: AnalysisState) => {
      rendered.push(state);
    }),
  };
  return { deps, requests, rendered };
}

/** Let queued promise callbacks run. */
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

async function startedController(overrides: Partial<PanelControllerDeps> = {}) {
  const { deps, requests, rendered } = makeDeps();
  Object.assign(deps, overrides);
  const controller = createPanelController(deps);
  await controller.start();
  return { controller, deps, requests, rendered };
}

describe('broadcast filtering', () => {
  it("drops a background tab's verdict instead of replacing the active tab's", async () => {
    const { controller, requests, rendered } = await startedController();
    requests[0]!.deferred.resolve(stateResponse(1, RED));
    await settle();
    expect(rendered).toEqual([RED]);

    // Tab 2 finishes its analysis in the background: its GREEN must not paint
    // over the RED the user is looking at on tab 1.
    controller.onMessage(stateMessage(2, GREEN));
    expect(rendered).toEqual([RED]);
  });

  it("renders the active tab's own broadcasts", async () => {
    const { controller, rendered } = await startedController();
    controller.onMessage(stateMessage(1, RED));
    expect(rendered).toEqual([RED]);
  });

  it('renders nothing while the active tab is still unknown', async () => {
    const { deps } = makeDeps();
    const controller = createPanelController(deps);
    // start() not called yet — a broadcast this early has no tab to match.
    controller.onMessage(stateMessage(1, GREEN));
    expect(deps.render).not.toHaveBeenCalled();
  });

  it('ignores non-STATE messages', async () => {
    const { controller, deps } = await startedController();
    controller.onMessage({ type: 'REQUEST_STATE' });
    expect(deps.render).not.toHaveBeenCalled();
  });
});

describe('tab switching', () => {
  it('re-requests state for the newly active tab and renders the answer', async () => {
    const { controller, deps, requests, rendered } = await startedController();
    requests[0]!.deferred.resolve(stateResponse(1, IDLE));
    await settle();

    controller.onTabActivated({ tabId: 2, windowId: 10 });
    expect(deps.requestState).toHaveBeenLastCalledWith(2);
    requests[1]!.deferred.resolve(stateResponse(2, RED));
    await settle();
    expect(rendered.at(-1)).toEqual(RED);
  });

  it('follows the switch immediately for broadcast filtering', async () => {
    const { controller, rendered } = await startedController();
    controller.onTabActivated({ tabId: 2, windowId: 10 });
    controller.onMessage(stateMessage(1, GREEN)); // old tab — now stale
    controller.onMessage(stateMessage(2, RED)); // new tab
    expect(rendered).toEqual([RED]);
  });

  it('ignores activations in other windows', async () => {
    const { controller, deps, rendered } = await startedController();
    controller.onTabActivated({ tabId: 9, windowId: 99 });
    expect(deps.requestState).toHaveBeenCalledTimes(1); // only the startup request
    controller.onMessage(stateMessage(9, GREEN));
    expect(rendered).toEqual([]);
    controller.onMessage(stateMessage(1, RED)); // still following tab 1
    expect(rendered).toEqual([RED]);
  });

  it('follows activations in any window when the panel window is unknown', async () => {
    const { controller, deps } = await startedController({
      queryActive: () => Promise.resolve({}),
    });
    controller.onTabActivated({ tabId: 3, windowId: 42 });
    expect(deps.requestState).toHaveBeenLastCalledWith(3);
  });

  it('drops a state response that a later tab switch has superseded', async () => {
    const { controller, requests, rendered } = await startedController();
    requests[0]!.deferred.resolve(stateResponse(1, IDLE));
    await settle();

    controller.onTabActivated({ tabId: 2, windowId: 10 });
    controller.onTabActivated({ tabId: 3, windowId: 10 });
    // Tab 2's answer arrives after the user already moved to tab 3.
    requests[1]!.deferred.resolve(stateResponse(2, GREEN));
    requests[2]!.deferred.resolve(stateResponse(3, RED));
    await settle();
    expect(rendered).toEqual([IDLE, RED]);
  });

  it('drops a rejection that a later tab switch has superseded', async () => {
    const { controller, requests, rendered } = await startedController();
    requests[0]!.deferred.resolve(stateResponse(1, IDLE));
    await settle();

    controller.onTabActivated({ tabId: 2, windowId: 10 });
    controller.onTabActivated({ tabId: 3, windowId: 10 });
    // Tab 2's request fails late (worker evicted, port closed): its idle
    // fallback must not blank the verdict tab 3 is about to show.
    requests[1]!.deferred.reject(new Error('port closed'));
    requests[2]!.deferred.resolve(stateResponse(3, RED));
    await settle();
    expect(rendered).toEqual([IDLE, RED]);
  });
});

describe('startup', () => {
  it("requests the active tab's state and renders it", async () => {
    const { deps, requests, rendered } = await startedController();
    expect(deps.requestState).toHaveBeenCalledWith(1);
    requests[0]!.deferred.resolve(stateResponse(1, RED));
    await settle();
    expect(rendered).toEqual([RED]);
  });

  it('renders idle on a malformed response', async () => {
    const { requests, rendered } = await startedController();
    requests[0]!.deferred.resolve('nonsense');
    await settle();
    expect(rendered).toEqual([IDLE]);
  });

  it('renders idle when the state request rejects', async () => {
    const { requests, rendered } = await startedController();
    requests[0]!.deferred.reject(new Error('no worker'));
    await settle();
    expect(rendered).toEqual([IDLE]);
  });

  it('still starts when the active-tab query fails', async () => {
    const { deps } = await startedController({
      queryActive: () => Promise.reject(new Error('no tabs api')),
    });
    // The worker resolves the active tab itself when the panel could not.
    expect(deps.requestState).toHaveBeenCalledWith(undefined);
  });

  it("adopts the worker's answered tab when its own query failed, so broadcasts still render", async () => {
    const { controller, requests, rendered } = await startedController({
      queryActive: () => Promise.reject(new Error('no tabs api')),
    });
    // The worker answered for tab 4; the panel must follow it from here on —
    // otherwise this render would be the last and a 'checking' spinner could
    // mask the finished verdict forever.
    requests[0]!.deferred.resolve(stateResponse(4, { phase: 'checking' }));
    await settle();
    controller.onMessage(stateMessage(4, RED));
    expect(rendered).toEqual([{ phase: 'checking' }, RED]);
  });

  it('asks an idle tab to re-report, in case a restarted worker lost its state', async () => {
    const { deps, requests } = await startedController();
    requests[0]!.deferred.resolve(stateResponse(1, IDLE));
    await settle();
    expect(deps.requestRereport).toHaveBeenCalledWith(1);
  });

  it('does not ask for a re-report when the worker has real state', async () => {
    const { deps, requests } = await startedController();
    requests[0]!.deferred.resolve(stateResponse(1, RED));
    await settle();
    expect(deps.requestRereport).not.toHaveBeenCalled();
  });

  it('does not ask for a re-report when no tab could be resolved at all', async () => {
    const { deps, requests } = await startedController({
      queryActive: () => Promise.resolve({}),
    });
    requests[0]!.deferred.resolve(stateResponse(undefined, IDLE));
    await settle();
    expect(deps.requestRereport).not.toHaveBeenCalled();
  });

  it("asks the worker's adopted tab to re-report when it answered idle", async () => {
    const { deps, requests } = await startedController({
      queryActive: () => Promise.reject(new Error('no tabs api')),
    });
    // The worker resolved the active tab itself and found no state for it —
    // the panel adopted tab 4 and should nudge it.
    requests[0]!.deferred.resolve(stateResponse(4, IDLE));
    await settle();
    expect(deps.requestRereport).toHaveBeenCalledWith(4);
  });

  it('adopts an activation that raced the startup query', async () => {
    const { deps, requests } = makeDeps();
    let resolveQuery: (value: { tabId?: number; windowId?: number }) => void = () => {};
    deps.queryActive = () =>
      new Promise((resolve) => {
        resolveQuery = resolve;
      });
    const controller = createPanelController(deps);
    const starting = controller.start();

    // The user switches tabs before the query answers; the event is newer.
    controller.onTabActivated({ tabId: 5, windowId: 10 });
    resolveQuery({ tabId: 1, windowId: 10 });
    await starting;
    expect(requests).toHaveLength(1);
    expect(requests[0]!.tabId).toBe(5);
  });

  it('keeps only the latest of several activations that raced the startup query', async () => {
    const { deps, requests } = makeDeps();
    let resolveQuery: (value: { tabId?: number; windowId?: number }) => void = () => {};
    deps.queryActive = () =>
      new Promise((resolve) => {
        resolveQuery = resolve;
      });
    const controller = createPanelController(deps);
    const starting = controller.start();

    controller.onTabActivated({ tabId: 2, windowId: 10 });
    controller.onTabActivated({ tabId: 3, windowId: 10 });
    controller.onTabActivated({ tabId: 4, windowId: 10 });
    resolveQuery({ tabId: 1, windowId: 10 });
    await starting;
    expect(requests).toHaveLength(1);
    expect(requests[0]!.tabId).toBe(4);
  });

  it('adopts a raced activation even when the startup query failed', async () => {
    const { deps, requests } = makeDeps();
    let rejectQuery: (reason?: unknown) => void = () => {};
    deps.queryActive = () =>
      new Promise((_resolve, reject) => {
        rejectQuery = reject;
      });
    const controller = createPanelController(deps);
    const starting = controller.start();

    // No window to filter by — the activation is still the best signal available.
    controller.onTabActivated({ tabId: 5, windowId: 42 });
    rejectQuery(new Error('no tabs api'));
    await starting;
    expect(requests).toHaveLength(1);
    expect(requests[0]!.tabId).toBe(5);
  });

  it('discards a raced activation from another window', async () => {
    const { deps, requests } = makeDeps();
    let resolveQuery: (value: { tabId?: number; windowId?: number }) => void = () => {};
    deps.queryActive = () =>
      new Promise((resolve) => {
        resolveQuery = resolve;
      });
    const controller = createPanelController(deps);
    const starting = controller.start();

    controller.onTabActivated({ tabId: 5, windowId: 99 });
    resolveQuery({ tabId: 1, windowId: 10 });
    await starting;
    expect(requests).toHaveLength(1);
    expect(requests[0]!.tabId).toBe(1);
  });
});
