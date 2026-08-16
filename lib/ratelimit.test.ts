import { describe, expect, it } from 'vitest';
import { createRateLimiter, type RateLimiterOptions } from './ratelimit';

/** `setTimeout`'s ceiling: a longer delay wraps and fires immediately. */
const MAX_TIMER_DELAY_MS = 2_147_483_647;

/**
 * Deterministic stand-in for wall clock + timers. `sleep` advances the clock by
 * exactly the requested amount and resolves on the next microtask, so a suite
 * that models hours of Nominatim traffic finishes in milliseconds and never
 * flakes on timer jitter.
 */
interface FakeClock {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  /**
   * Simulate time passing outside the limiter (a slow task, an idle caller).
   * Negative amounts are legal and model a backwards wall-clock step.
   */
  advance: (ms: number) => void;
  /** Every duration handed to `sleep`, in order. */
  sleeps: number[];
}

function createFakeClock(): FakeClock {
  let current = 0;
  const sleeps: number[] = [];
  return {
    now: () => current,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      current += ms;
    },
    advance: (ms: number) => {
      current += ms;
    },
    sleeps,
  };
}

describe('createRateLimiter', () => {
  describe('start-to-start spacing', () => {
    it.each([
      // [name, minIntervalMs, how long each task occupies the clock, expected starts]
      ['the Nominatim 1 req/s interval with instant tasks', 1000, 0, [0, 1000, 2000, 3000, 4000]],
      ['a zero interval runs tasks back to back', 0, 0, [0, 0, 0, 0, 0]],
      ['tasks faster than the interval are padded', 1000, 400, [0, 1000, 2000, 3000, 4000]],
      ['tasks exactly as long as the interval are not padded', 1000, 1000, [0, 1000, 2000, 3000, 4000]],
      // Spacing is start-to-start, so a slow task has already paid the debt.
      ['tasks slower than the interval never wait', 1000, 2500, [0, 2500, 5000, 7500, 10000]],
    ])('%s', async (_name, minIntervalMs, taskCostMs, expected) => {
      const clock = createFakeClock();
      const limiter = createRateLimiter({ minIntervalMs, now: clock.now, sleep: clock.sleep });
      const starts: number[] = [];

      await Promise.all(
        Array.from({ length: expected.length }, () =>
          limiter.run(async () => {
            starts.push(clock.now());
            clock.advance(taskCostMs);
          }),
        ),
      );

      expect(starts).toEqual(expected);
    });

    it.each([
      // Sequential callers (await, then submit again) are the common case for a
      // geocoder loop; the interval must still hold across an empty queue.
      ['a caller that submits again immediately', 0, 1000],
      ['a caller that idles less than the interval', 400, 1000],
      ['a caller that idles exactly the interval', 1000, 1000],
      ['a caller that idles past the interval', 2500, 2500],
    ])('%s waits only for the remainder', async (_name, idleMs, expectedSecondStart) => {
      const clock = createFakeClock();
      const limiter = createRateLimiter({ minIntervalMs: 1000, now: clock.now, sleep: clock.sleep });
      const starts: number[] = [];
      const record = () =>
        limiter.run(async () => {
          starts.push(clock.now());
        });

      await record();
      clock.advance(idleMs);
      await record();

      expect(starts).toEqual([0, expectedSecondStart]);
    });

    it('never sleeps at all when minIntervalMs is 0', async () => {
      const clock = createFakeClock();
      const limiter = createRateLimiter({ minIntervalMs: 0, now: clock.now, sleep: clock.sleep });

      await Promise.all(Array.from({ length: 4 }, () => limiter.run(async () => undefined)));

      expect(clock.sleeps).toEqual([]);
      expect(clock.now()).toBe(0);
    });

    it.each([
      ['a zero interval', 0],
      ['the policy interval', 1000],
    ])(
      'does not start the next task until the current one settles, at %s',
      async (_name, minIntervalMs) => {
        const clock = createFakeClock();
        const limiter = createRateLimiter({ minIntervalMs, now: clock.now, sleep: clock.sleep });
        const started: string[] = [];
        let releaseFirst: () => void = () => undefined;
        const firstMayFinish = new Promise<void>((resolve) => {
          releaseFirst = resolve;
        });

        const first = limiter.run(async () => {
          started.push('a');
          await firstMayFinish;
        });
        const second = limiter.run(async () => {
          started.push('b');
        });

        // Move the clock well past the interval so that spacing is no longer
        // what holds 'b' back — only "one request in flight" is. An in-flight
        // request still counts against the far side even after the interval.
        clock.advance(minIntervalMs * 5 + 1);
        for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();
        expect(started).toEqual(['a']);

        releaseFirst();
        await Promise.all([first, second]);

        expect(started).toEqual(['a', 'b']);
      },
    );

    it('never overlaps task bodies when minIntervalMs is 0', async () => {
      const clock = createFakeClock();
      const limiter = createRateLimiter({ minIntervalMs: 0, now: clock.now, sleep: clock.sleep });
      const events: string[] = [];
      let inFlight = 0;

      await Promise.all(
        ['a', 'b', 'c'].map((label) =>
          limiter.run(async () => {
            inFlight += 1;
            expect(inFlight).toBe(1);
            events.push(`enter:${label}`);
            await Promise.resolve();
            events.push(`exit:${label}`);
            inFlight -= 1;
          }),
        ),
      );

      expect(events).toEqual([
        'enter:a',
        'exit:a',
        'enter:b',
        'exit:b',
        'enter:c',
        'exit:c',
      ]);
    });
  });

  describe('ordering', () => {
    it('runs a burst submitted in one tick in FIFO order', async () => {
      const clock = createFakeClock();
      const limiter = createRateLimiter({ minIntervalMs: 1000, now: clock.now, sleep: clock.sleep });
      const order: number[] = [];

      const results = await Promise.all(
        [0, 1, 2, 3, 4].map((i) =>
          limiter.run(async () => {
            order.push(i);
            return i;
          }),
        ),
      );

      expect(order).toEqual([0, 1, 2, 3, 4]);
      expect(results).toEqual([0, 1, 2, 3, 4]);
    });

    it('appends tasks submitted while the queue is already draining', async () => {
      const clock = createFakeClock();
      const limiter = createRateLimiter({ minIntervalMs: 1000, now: clock.now, sleep: clock.sleep });
      const order: string[] = [];
      const record = (label: string) =>
        limiter.run(async () => {
          order.push(label);
        });

      const pending = [record('a'), record('b')];
      // Let the pump start and take 'a' before the next submissions arrive.
      await Promise.resolve();
      pending.push(record('c'), record('d'));

      await Promise.all(pending);

      expect(order).toEqual(['a', 'b', 'c', 'd']);
    });

    it('queues a task submitted from inside a running task behind the existing queue', async () => {
      const clock = createFakeClock();
      const limiter = createRateLimiter({ minIntervalMs: 1000, now: clock.now, sleep: clock.sleep });
      const order: string[] = [];
      const starts: number[] = [];
      const nested: Array<Promise<void>> = [];
      const record = (label: string) =>
        limiter.run(async () => {
          order.push(label);
          starts.push(clock.now());
        });

      const outer = [
        limiter.run(async () => {
          order.push('a');
          starts.push(clock.now());
          nested.push(record('a-followup'));
        }),
        record('b'),
      ];

      await Promise.all(outer);
      await Promise.all(nested);

      expect(order).toEqual(['a', 'b', 'a-followup']);
      expect(starts).toEqual([0, 1000, 2000]);
    });
  });

  describe('failure isolation', () => {
    it('rejects only the failing caller, keeps draining, and keeps spacing', async () => {
      const clock = createFakeClock();
      const limiter = createRateLimiter({ minIntervalMs: 1000, now: clock.now, sleep: clock.sleep });
      const boom = new Error('nominatim 429');
      const starts: number[] = [];

      const settled = await Promise.allSettled([
        limiter.run(async () => {
          starts.push(clock.now());
          return 'a';
        }),
        limiter.run(async () => {
          starts.push(clock.now());
          throw boom;
        }),
        limiter.run(async () => {
          starts.push(clock.now());
          return 'c';
        }),
      ]);

      expect(settled.map((outcome) => outcome.status)).toEqual([
        'fulfilled',
        'rejected',
        'fulfilled',
      ]);
      const failure = settled[1];
      // Reason identity matters: callers retry on some errors and not others.
      if (failure.status === 'rejected') expect(failure.reason).toBe(boom);
      expect(starts).toEqual([0, 1000, 2000]);
    });

    it('treats a task that throws synchronously as that task’s own failure', async () => {
      const clock = createFakeClock();
      const limiter = createRateLimiter({ minIntervalMs: 1000, now: clock.now, sleep: clock.sleep });
      const boom = new Error('bad request shape');
      const throwsBeforeReturningAPromise = (): Promise<string> => {
        throw boom;
      };

      await expect(limiter.run(throwsBeforeReturningAPromise)).rejects.toBe(boom);
      await expect(limiter.run(async () => 'still alive')).resolves.toBe('still alive');
    });

    it('does not surface one task’s rejection to any other caller', async () => {
      const clock = createFakeClock();
      const limiter = createRateLimiter({ minIntervalMs: 1000, now: clock.now, sleep: clock.sleep });

      const failing = limiter.run(async () => {
        throw new Error('boom');
      });
      const survivor = limiter.run(async () => 'ok');

      await expect(failing).rejects.toThrow('boom');
      await expect(survivor).resolves.toBe('ok');
    });
  });

  describe('result passthrough', () => {
    const values: Array<[string, unknown]> = [
      ['a string', 'nominatim-hit'],
      ['zero', 0],
      ['null', null],
      ['undefined', undefined],
      ['an object, by reference', { lat: 48.8584, lng: 2.2945 }],
    ];

    it.each(values)('resolves with the task value: %s', async (_name, value) => {
      const clock = createFakeClock();
      const limiter = createRateLimiter({ minIntervalMs: 1000, now: clock.now, sleep: clock.sleep });

      await expect(limiter.run(async () => value)).resolves.toBe(value);
    });

    it('preserves the task result type', async () => {
      const clock = createFakeClock();
      const limiter = createRateLimiter({ minIntervalMs: 1000, now: clock.now, sleep: clock.sleep });

      // The annotations are the assertion here: `tsc --noEmit` fails if `run`
      // widens or loses the task's result type.
      const coords: { lat: number; lng: number } = await limiter.run(async () => ({
        lat: 48.8584,
        lng: 2.2945,
      }));
      const label: string = await limiter.run(async () => 'Tour Eiffel');

      expect(coords.lat).toBeCloseTo(48.8584);
      expect(label).toBe('Tour Eiffel');
    });
  });

  describe('queue depth', () => {
    it('drains 5000 queued tasks in order without overflowing the stack', async () => {
      const clock = createFakeClock();
      const limiter = createRateLimiter({ minIntervalMs: 1000, now: clock.now, sleep: clock.sleep });
      const count = 5000;
      const order: number[] = [];

      const results = await Promise.all(
        Array.from({ length: count }, (_unused, i) =>
          limiter.run(async () => {
            order.push(i);
            return i;
          }),
        ),
      );

      expect(order).toHaveLength(count);
      expect(order.every((value, index) => value === index)).toBe(true);
      expect(results[count - 1]).toBe(count - 1);
      // Every start after the first paid the full interval.
      expect(clock.now()).toBe((count - 1) * 1000);
    });
  });

  describe('submission is side-effect free', () => {
    it('does not start a task before run() returns, even at a zero interval', () => {
      const clock = createFakeClock();
      const limiter = createRateLimiter({ minIntervalMs: 0, now: clock.now, sleep: clock.sleep });
      let started = false;

      const pending = limiter.run(async () => {
        started = true;
      });

      expect(started).toBe(false);
      return pending;
    });
  });

  describe('hostile timing injections', () => {
    it('gives up on spacing rather than spinning when sleep cannot advance the clock', async () => {
      let sleepCalls = 0;
      const limiter = createRateLimiter({
        minIntervalMs: 1000,
        now: () => 0,
        sleep: async () => {
          sleepCalls += 1;
        },
      });
      const order: string[] = [];

      await Promise.all(
        ['a', 'b', 'c'].map((label) =>
          limiter.run(async () => {
            order.push(label);
          }),
        ),
      );

      expect(order).toEqual(['a', 'b', 'c']);
      // One attempt per slot, then the limiter accepts it cannot wait — a hung
      // service worker would be a worse failure than an unspaced request.
      expect(sleepCalls).toBe(2);
    });

    it('fails the task whose wait failed and keeps the queue alive', async () => {
      const clock = createFakeClock();
      const timerGone = new Error('timer unavailable');
      let failNextSleep = true;
      const limiter = createRateLimiter({
        minIntervalMs: 1000,
        now: clock.now,
        sleep: async (ms: number) => {
          if (failNextSleep) {
            failNextSleep = false;
            throw timerGone;
          }
          await clock.sleep(ms);
        },
      });
      const starts: number[] = [];
      const record = (value: string) =>
        limiter.run(async () => {
          starts.push(clock.now());
          return value;
        });

      const settled = await Promise.allSettled([record('a'), record('b'), record('c')]);

      expect(settled.map((outcome) => outcome.status)).toEqual([
        'fulfilled',
        'rejected',
        'fulfilled',
      ]);
      const failure = settled[1];
      if (failure.status === 'rejected') expect(failure.reason).toBe(timerGone);
      // 'b' never ran: failing closed is deliberate, an unspaced request is the
      // thing we are protecting against.
      expect(starts).toEqual([0, 1000]);
    });

    it.each([
      ['NaN', Number.NaN],
      ['Infinity', Number.POSITIVE_INFINITY],
    ])('refuses to run anything on a clock reading %s', async (_name, reading) => {
      // A non-finite reading poisons the arithmetic: `remaining > 0` is false
      // forever, so a limiter that accepted it would keep taking work and stop
      // spacing it — an unthrottled client with no error to notice. Same
      // failure the constructor rejects `minIntervalMs: NaN` for, except the
      // clock is read on every task rather than once.
      const limiter = createRateLimiter({
        minIntervalMs: 1000,
        now: () => reading,
        sleep: async () => undefined,
      });
      let bodiesRun = 0;
      const record = () =>
        limiter.run(async () => {
          bodiesRun += 1;
        });

      const settled = await Promise.allSettled([record(), record(), record()]);

      expect(settled.map((outcome) => outcome.status)).toEqual([
        'rejected',
        'rejected',
        'rejected',
      ]);
      settled.forEach((outcome) => {
        if (outcome.status === 'rejected') expect(outcome.reason).toBeInstanceOf(RangeError);
      });
      expect(bodiesRun).toBe(0);
    });

    it('aborts the task whose clock read threw and keeps the queue alive', async () => {
      const clock = createFakeClock();
      const clockGone = new Error('clock unavailable');
      // Armed before the first task, whose slot needs no wait — so the throw
      // lands on the read that timestamps the start, not on one inside the
      // wait. Letting that one escape would kill the pump with the queue still
      // full: 'b' would never be dequeued and neither promise would ever
      // settle, hanging this test rather than failing it.
      let armed = true;
      const limiter = createRateLimiter({
        minIntervalMs: 1000,
        now: () => {
          if (armed) {
            armed = false;
            throw clockGone;
          }
          return clock.now();
        },
        sleep: clock.sleep,
      });
      const starts: number[] = [];
      const record = (value: string) =>
        limiter.run(async () => {
          starts.push(clock.now());
          return value;
        });

      const settled = await Promise.allSettled([record('a'), record('b')]);

      expect(settled.map((outcome) => outcome.status)).toEqual(['rejected', 'fulfilled']);
      const failure = settled[0];
      if (failure.status === 'rejected') expect(failure.reason).toBe(clockGone);
      // 'b' is still the first request ever sent, so it owes no wait: the
      // failed start must not have moved the baseline.
      expect(starts).toEqual([0]);
      expect(clock.sleeps).toEqual([]);
    });

    it('caps the wait at one interval when the wall clock steps backwards', async () => {
      const clock = createFakeClock();
      const limiter = createRateLimiter({ minIntervalMs: 1000, now: clock.now, sleep: clock.sleep });
      const starts: number[] = [];
      const record = () =>
        limiter.run(async () => {
          starts.push(clock.now());
        });

      await record();
      // NTP correction, or the user setting the system clock back. Date.now()
      // is wall clock and the limiter's default, so this is not exotic.
      clock.advance(-3_600_000);
      await record();

      // One interval is the most that can ever be owed. Believing the raw
      // subtraction would park every geocode for the full hour while the clock
      // caught up with its own past.
      expect(clock.sleeps).toEqual([1000]);
      expect(starts).toEqual([0, -3_599_000]);
    });

    it('never asks a timer for a delay it would silently drop', async () => {
      const clock = createFakeClock();
      const minIntervalMs = MAX_TIMER_DELAY_MS * 2 + 500;
      const limiter = createRateLimiter({ minIntervalMs, now: clock.now, sleep: clock.sleep });
      const starts: number[] = [];
      const record = () =>
        limiter.run(async () => {
          starts.push(clock.now());
        });

      await Promise.all([record(), record()]);

      // A single setTimeout for the whole span would wrap to a 32-bit int and
      // fire at once, so the long interval would enforce nothing at all.
      expect(clock.sleeps.every((ms) => ms <= MAX_TIMER_DELAY_MS)).toBe(true);
      expect(clock.sleeps.reduce((total, ms) => total + ms, 0)).toBe(minIntervalMs);
      expect(starts).toEqual([0, minIntervalMs]);
    });
  });

  describe('configuration', () => {
    it.each([
      ['a negative', -1],
      ['NaN', Number.NaN],
      ['an infinite', Number.POSITIVE_INFINITY],
    ])('throws on %s interval instead of silently disabling spacing', (_name, minIntervalMs) => {
      expect(() => createRateLimiter({ minIntervalMs })).toThrow(RangeError);
    });

    it('reads its configuration once, at construction', async () => {
      const clock = createFakeClock();
      const options: RateLimiterOptions = {
        minIntervalMs: 1000,
        now: clock.now,
        sleep: clock.sleep,
      };
      const limiter = createRateLimiter(options);
      // Callers reuse an options object to build several clients. Retuning a
      // live limiter through a reference it handed over would bypass the
      // constructor's validation entirely — the one place spacing is checked.
      options.minIntervalMs = 0;
      const starts: number[] = [];
      const record = () =>
        limiter.run(async () => {
          starts.push(clock.now());
        });

      await Promise.all([record(), record()]);

      expect(starts).toEqual([0, 1000]);
    });

    it('does not write to the options object it was given', async () => {
      const clock = createFakeClock();
      // Frozen in a module (always strict mode), so any write throws.
      const options = Object.freeze<RateLimiterOptions>({
        minIntervalMs: 1000,
        now: clock.now,
        sleep: clock.sleep,
      });

      const limiter = createRateLimiter(options);

      await expect(limiter.run(async () => 'ok')).resolves.toBe('ok');
    });

    it('uses real timers when now and sleep are not injected', async () => {
      const limiter = createRateLimiter({ minIntervalMs: 20 });
      const order: string[] = [];
      const startedAt = Date.now();

      await Promise.all(
        ['a', 'b', 'c'].map((label) =>
          limiter.run(async () => {
            order.push(label);
          }),
        ),
      );

      expect(order).toEqual(['a', 'b', 'c']);
      // Two gaps of 20 ms, and the bound is exact rather than slack: the
      // limiter re-checks Date.now() after every sleep, so an early-firing
      // timer cannot shorten a gap. `startedAt` is read before the first task
      // and Date.now() truncates downwards, both of which can only inflate the
      // measured span. Tolerating 38 here would pass an implementation that
      // trusts the timer — the one thing this module refuses to do.
      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(40);
    });
  });
});
