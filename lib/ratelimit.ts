/**
 * Serialized minimum-interval rate limiter.
 *
 * Nominatim's usage policy allows "an absolute maximum of 1 request per
 * second", and it is enforced per source IP by an operator with no appeals
 * process. A burst does not degrade our results, it removes geocoding from the
 * extension for every user behind that IP — so the interval is a correctness
 * constraint, not a politeness knob. This module therefore serializes strictly
 * (one task in flight, FIFO) instead of the usual token-bucket, which would
 * happily let N callers fire at once as long as the average holds.
 *
 * Spacing is measured start-to-start, matching how the policy is written and
 * how the far side sees us: a task that itself takes 3 s already satisfies a
 * 1 s interval, so the queue never adds delay it does not owe.
 *
 * Every failure mode resolves toward waiting longer or rejecting the task,
 * never toward an unspaced request. A limiter that silently degrades into a
 * pass-through is indistinguishable from having no limiter at all, and the
 * first symptom is a blocked IP.
 *
 * Pure module: `now`/`sleep` are injected, so the service worker gets real
 * timers and tests get a fake clock and run instantly. `Date.now()` is the
 * default because it is available everywhere an MV3 worker runs; it is wall
 * clock and may step backwards (NTP correction, a user setting the clock), so
 * no single wait is allowed to exceed one interval. A caller that wants a
 * monotonic clock can inject `performance.now`.
 */

export interface RateLimiterOptions {
  /** Minimum delay between the START of one task and the START of the next. */
  minIntervalMs: number;
  /** Clock in milliseconds. Defaults to `Date.now`. */
  now?: () => number;
  /** Resolves after at least `ms`. Defaults to a `setTimeout` sleep. */
  sleep?: (ms: number) => Promise<void>;
}

export interface RateLimiter {
  /**
   * Queue `task` and resolve with its result. Rejection of the returned promise
   * is the task's own failure and affects no other caller.
   *
   * The queue is strictly serial, so a task that never settles blocks every
   * task behind it. Timeouts belong to the caller: the limiter cannot abandon a
   * request it has already sent without losing track of when it was sent.
   */
  run<T>(task: () => Promise<T>): Promise<T>;
}

/**
 * One queued submission. `start` owns the caller's promise and never rejects —
 * a rejecting pump would abandon the rest of the queue.
 */
interface QueuedTask {
  start: () => Promise<void>;
  /** Settle the caller with a failure without ever invoking the task. */
  abort: (reason: unknown) => void;
}

/**
 * `setTimeout` truncates its delay to a signed 32-bit integer, so a request
 * above ~24.8 days wraps and fires immediately — "wait a month" silently
 * becomes "wait not at all". Long waits are therefore taken one timer at a
 * time; the re-check loop re-arms until the deadline is genuinely reached.
 */
const MAX_TIMER_DELAY_MS = 2_147_483_647;

const defaultNow = (): number => Date.now();

const defaultSleep = (ms: number): Promise<void> =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

export function createRateLimiter(options: RateLimiterOptions): RateLimiter {
  const { minIntervalMs } = options;
  // Fail loudly on a nonsense interval. `Math.max(0, NaN)` is NaN and every
  // comparison against it is false, so a typo'd config would silently turn the
  // limiter into a pass-through — the exact failure mode that gets us banned.
  if (!Number.isFinite(minIntervalMs) || minIntervalMs < 0) {
    throw new RangeError(
      `createRateLimiter: minIntervalMs must be a finite number >= 0, got ${String(minIntervalMs)}`,
    );
  }

  // Read once: a limiter must not be retunable through the object its caller
  // still holds, and nothing here writes back into it.
  const now = options.now ?? defaultNow;
  const sleep = options.sleep ?? defaultSleep;

  const queue: QueuedTask[] = [];
  let pumping = false;
  /** Clock reading at the last task start; null until the first task runs. */
  let lastStartedAt: number | null = null;

  /**
   * Read the clock, refusing a reading that arithmetic cannot use.
   *
   * NaN is the dangerous one and it is dangerous in the same way a NaN interval
   * is: it makes `remaining > 0` false forever, so the limiter keeps accepting
   * work and stops spacing it — no error, no symptom, just an unthrottled
   * client. Infinity is the same class (`Infinity - Infinity` is NaN). The
   * throw is caught by the pump and charged to the task that was about to run,
   * so a broken clock costs lookups rather than the IP.
   */
  function readClock(): number {
    const reading = now();
    if (!Number.isFinite(reading)) {
      throw new RangeError(
        `rate limiter: clock returned a non-finite reading (${String(reading)})`,
      );
    }
    return reading;
  }

  /**
   * Block until the next start is permitted, then return the clock reading that
   * start is charged to. Throws only if the clock or the sleep is unusable.
   */
  async function acquireSlot(): Promise<number> {
    if (lastStartedAt === null) return readClock();

    const enteredAt = readClock();
    // Cap the wait at one interval. `lastStartedAt` came from an earlier
    // reading of the same wall clock, and a backwards step (NTP correction,
    // user sets the clock back an hour) makes the debt look an hour long — the
    // queue would park until the clock caught up with its own past. One
    // interval is the most that can ever be owed, and when the cap binds we
    // still overpay in real time, never underpay: the clock only reads early
    // because it moved backwards after the last start.
    const deadline = Math.min(lastStartedAt + minIntervalMs, enteredAt + minIntervalMs);

    let remaining = deadline - enteredAt;
    while (remaining > 0) {
      const before = readClock();
      await sleep(Math.min(remaining, MAX_TIMER_DELAY_MS));

      // Re-check the clock instead of trusting the sleep: host timers are
      // permitted to fire a fraction early, and waking early is precisely the
      // violation we are here to prevent.
      //
      // The loop is bounded by progress, not by an iteration count: if the
      // clock did not move across a sleep the injected timing pair cannot
      // advance time at all (frozen clock, stubbed sleep), and spinning would
      // hang the queue forever. Degrading to "no spacing" is the lesser failure
      // — it is visible in tests, a hung service worker is not.
      const after = readClock();
      if (after <= before) return after;
      remaining = deadline - after;
    }

    return readClock();
  }

  async function pump(): Promise<void> {
    try {
      // Yield once so `run()` has returned before any task body executes,
      // whatever the interval. Without this a zero-interval limiter would
      // invoke the first task synchronously inside `run()` and callers would
      // see two different execution models depending on configuration.
      await Promise.resolve();

      for (;;) {
        const entry = queue.shift();
        // No `await` between this check and the `finally` below, so a task
        // enqueued by another task can never race the pump into shutting down.
        if (entry === undefined) return;

        try {
          // Assigned only on success: a failed acquisition must not move the
          // baseline, or the next task would be spaced against a start that
          // never happened.
          lastStartedAt = await acquireSlot();
        } catch (error) {
          // Fail closed: if the delay could not be taken, or the clock cannot
          // say when this request goes out, we do not know how long it has been
          // since the last one and firing anyway risks the ban. A failed lookup
          // is recoverable, a blocked IP is not.
          //
          // Aborting here rather than letting the error escape also keeps the
          // pump alive: an error out of `pump()` would settle nobody, leaving
          // every queued caller waiting on a promise that can never resolve.
          entry.abort(error);
          continue;
        }

        await entry.start();
      }
    } finally {
      pumping = false;
    }
  }

  return {
    run<T>(task: () => Promise<T>): Promise<T> {
      return new Promise<T>((resolve, reject) => {
        queue.push({
          start: async () => {
            try {
              // `await` inside the try also converts a task that throws
              // synchronously into this caller's rejection.
              resolve(await task());
            } catch (error) {
              reject(error);
            }
          },
          abort: reject,
        });

        // Iterative pump, one activation at a time: `run` never recurses into
        // execution, so queue depth costs heap, never stack.
        if (!pumping) {
          pumping = true;
          void pump();
        }
      });
    },
  };
}
