/**
 * Debounce with a deadline: coalesce a burst of events into one run, but never
 * let a burst that refuses to end postpone the run forever.
 *
 * The content script re-reads the page `settleMs` after the DOM goes quiet —
 * listing pages mutate constantly (price polling, lazy images, carousels), and
 * extraction walks a megabyte of markup, so running per mutation would burn
 * the user's main thread. A plain debounce, though, hands a hostile page a
 * verdict-suppression lever: keep mutating at sub-`settleMs` intervals and
 * extraction is postponed indefinitely. `maxWaitMs` closes that — the run
 * fires that long after a burst starts no matter what the page does.
 */

export interface SettleSchedulerOptions {
  /** Quiet period after the last bump before running. */
  settleMs: number;
  /** Hard deadline after the first bump of a burst; the run fires regardless. */
  maxWaitMs: number;
  run(): void;
}

export interface SettleScheduler {
  /** Signal an event (a DOM mutation). Starts a burst if none is open. */
  bump(): void;
}

export function createSettleScheduler(options: SettleSchedulerOptions): SettleScheduler {
  let settleTimer: ReturnType<typeof setTimeout> | undefined;
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;

  function fire(): void {
    if (settleTimer !== undefined) clearTimeout(settleTimer);
    if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
    settleTimer = undefined;
    deadlineTimer = undefined; // the burst is spent; the next bump opens a new one
    options.run();
  }

  return {
    bump(): void {
      if (settleTimer !== undefined) clearTimeout(settleTimer);
      settleTimer = setTimeout(fire, options.settleMs);
      // Armed once per burst and never pushed back — this is the guarantee.
      deadlineTimer ??= setTimeout(fire, options.maxWaitMs);
    },
  };
}
