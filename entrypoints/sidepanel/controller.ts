import type { AnalysisState, ExtensionMessage } from '../../lib/messages';

/**
 * Tab correlation for the side panel.
 *
 * The panel is per-window and must only ever show the verdict of the tab the
 * user is looking at. Three rules enforce that:
 *
 *   - every STATE broadcast is stamped with the tab it describes, and the
 *     panel drops broadcasts about any other tab — without this, a background
 *     tab finishing its analysis could replace the active tab's RED with its
 *     own GREEN;
 *   - switching tabs re-requests state for the newly active tab, so the panel
 *     never keeps rendering the previous tab's verdict;
 *   - a state response that arrives after a further tab switch is dropped
 *     rather than rendered late.
 *
 * Browser APIs arrive as injected deps (the same reason `render.ts` is kept
 * free of messaging), so every rule above is unit-testable.
 */

export interface TabActivation {
  tabId: number;
  windowId: number;
}

export interface PanelControllerDeps {
  /** Ask the worker for the state of one tab. */
  requestState(tabId: number | undefined): Promise<unknown>;
  /** The panel's own window and that window's active tab. */
  queryActive(): Promise<{ tabId?: number; windowId?: number }>;
  /**
   * Ask the tab's content script to report its listing again. Sent when the
   * worker answers "idle" for a real tab: MV3 eviction wipes the worker's
   * state, and without this nudge an analysed listing dead-ends at the idle
   * copy. On a non-listing tab the ping lands on no listener and is a no-op.
   */
  requestRereport(tabId: number): void;
  render(state: AnalysisState): void;
}

export interface PanelController {
  start(): Promise<void>;
  onMessage(message: ExtensionMessage): void;
  onTabActivated(info: TabActivation): void;
}

function asState(value: unknown): AnalysisState {
  return value !== null && typeof value === 'object' && 'phase' in value
    ? (value as AnalysisState)
    : { phase: 'idle' };
}

function asResponse(response: unknown): { tabId?: number; state: AnalysisState } {
  if (response !== null && typeof response === 'object' && 'state' in response) {
    const envelope = response as { tabId?: unknown; state: unknown };
    return {
      tabId: typeof envelope.tabId === 'number' ? envelope.tabId : undefined,
      state: asState(envelope.state),
    };
  }
  return { state: { phase: 'idle' } };
}

export function createPanelController(deps: PanelControllerDeps): PanelController {
  let started = false;
  let windowId: number | undefined;
  let activeTabId: number | undefined;
  /** The latest activation that fired while `start()` was still resolving. */
  let pendingActivation: TabActivation | undefined;

  function refresh(): void {
    const requested = activeTabId;
    void deps
      .requestState(requested)
      .then((response) => {
        if (activeTabId !== requested) return; // superseded by a later tab switch
        const answer = asResponse(response);
        // A panel that could not resolve its own active tab adopts the tab
        // the worker answered for — otherwise this render would be the last:
        // every later broadcast would fail the tab filter and a spinner
        // could mask the finished verdict.
        if (activeTabId === undefined) activeTabId = answer.tabId;
        deps.render(answer.state);
        // "Idle" for a real tab may just mean a restarted worker that lost
        // its state. The re-report is self-limiting: once the fresh analysis
        // publishes, this tab stops answering idle.
        if (answer.state.phase === 'idle' && activeTabId !== undefined) {
          deps.requestRereport(activeTabId);
        }
      })
      .catch(() => {
        if (activeTabId !== requested) return;
        deps.render({ phase: 'idle' });
      });
  }

  return {
    async start() {
      const active = await deps
        .queryActive()
        .catch((): { tabId?: number; windowId?: number } => ({}));
      windowId = active.windowId;
      activeTabId = active.tabId;
      started = true;
      // An activation that raced the query is newer than the query's answer;
      // adopt it if it belongs to this window (or the window is unknown).
      const pending = pendingActivation;
      pendingActivation = undefined;
      if (pending !== undefined && (windowId === undefined || pending.windowId === windowId)) {
        activeTabId = pending.tabId;
      }
      refresh();
    },
    onMessage(message) {
      if (message.type !== 'STATE') return;
      if (activeTabId === undefined || message.tabId !== activeTabId) return;
      deps.render(message.state);
    },
    onTabActivated(info) {
      if (!started) {
        pendingActivation = info;
        return;
      }
      // Activations fire for every window; the panel follows only its own.
      // An unknown windowId (the startup query failed) degrades to following
      // all windows rather than freezing on a stale verdict.
      if (windowId !== undefined && info.windowId !== windowId) return;
      activeTabId = info.tabId;
      refresh();
    },
  };
}
