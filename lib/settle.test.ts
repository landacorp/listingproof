import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSettleScheduler } from './settle';

const SETTLE = 400;
const MAX_WAIT = 2500;

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

function scheduler() {
  const run = vi.fn();
  return { run, bump: createSettleScheduler({ settleMs: SETTLE, maxWaitMs: MAX_WAIT, run }).bump };
}

describe('settling', () => {
  it('runs once the page has been quiet for the settle period', () => {
    const { run, bump } = scheduler();
    bump();
    vi.advanceTimersByTime(SETTLE - 1);
    expect(run).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('coalesces a burst into a single run after the last bump', () => {
    const { run, bump } = scheduler();
    bump();
    vi.advanceTimersByTime(300);
    bump();
    vi.advanceTimersByTime(300);
    bump();
    vi.advanceTimersByTime(SETTLE);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('a later burst runs again', () => {
    const { run, bump } = scheduler();
    bump();
    vi.advanceTimersByTime(SETTLE);
    bump();
    vi.advanceTimersByTime(SETTLE);
    expect(run).toHaveBeenCalledTimes(2);
  });
});

describe('the deadline', () => {
  it('a page that never goes quiet cannot postpone the run forever', () => {
    const { run, bump } = scheduler();
    // Continuous sub-settle mutation — the verdict-suppression attack.
    for (let elapsed = 0; elapsed < MAX_WAIT; elapsed += 100) {
      bump();
      vi.advanceTimersByTime(100);
    }
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('fires exactly at the deadline, measured from the first bump of the burst', () => {
    const { run, bump } = scheduler();
    bump(); // burst opens; deadline armed
    for (let elapsed = 0; elapsed < MAX_WAIT - 100; elapsed += 100) {
      vi.advanceTimersByTime(100);
      bump();
    }
    vi.advanceTimersByTime(99);
    expect(run).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('does not fire a second time from the settle timer the deadline preempted', () => {
    const { run, bump } = scheduler();
    for (let elapsed = 0; elapsed < MAX_WAIT; elapsed += 100) {
      bump();
      vi.advanceTimersByTime(100);
    }
    expect(run).toHaveBeenCalledTimes(1); // the deadline fired
    // The last bump's settle timer would land about now; the deadline's run
    // must have cancelled it, or every deadline fire would soon double-report.
    vi.advanceTimersByTime(SETTLE);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('a new burst after a deadline-fired run gets a fresh deadline', () => {
    const { run, bump } = scheduler();
    for (let elapsed = 0; elapsed <= MAX_WAIT; elapsed += 100) {
      bump();
      vi.advanceTimersByTime(100);
    }
    expect(run).toHaveBeenCalledTimes(1);
    // The page is still churning; the next burst must also hit its deadline.
    for (let elapsed = 0; elapsed <= MAX_WAIT; elapsed += 100) {
      bump();
      vi.advanceTimersByTime(100);
    }
    expect(run).toHaveBeenCalledTimes(2);
  });
});
