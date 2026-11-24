/** A fake clock: sleep advances time instantly, so tests never wait. `set` jumps forward (never back). */
export function makeClock(start = 1_700_000_000_000): {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  sleeps: number[];
  set: (t: number) => void;
} {
  let t = start;
  const sleeps: number[] = [];
  return {
    now: () => t,
    sleep: (ms: number) => {
      sleeps.push(ms);
      t += ms;
      return Promise.resolve();
    },
    sleeps,
    set: (to: number) => {
      t = Math.max(t, to);
    },
  };
}

/** Lets every pending promise chain settle (fake REST never touches real timers, so one macrotask turn is enough). */
export const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/**
 * Fake timers on a fake clock. `setTimer` queues; `advance(ms)` moves the clock forward, firing due timers in time order
 * and settling promises after each one. No real waiting.
 */
export function makeTimers(clock: ReturnType<typeof makeClock>): {
  setTimer: typeof setTimeout;
  advance: (ms: number) => Promise<void>;
  pending: () => number;
} {
  let seq = 0;
  const queue: { at: number; seq: number; fn: () => void }[] = [];
  const setTimer = ((fn: () => void, ms?: number) => {
    queue.push({ at: clock.now() + (ms ?? 0), seq: seq++, fn });
    return { ref: () => undefined, unref: () => undefined } as unknown as NodeJS.Timeout;
  }) as unknown as typeof setTimeout;
  const advance = async (ms: number): Promise<void> => {
    const end = clock.now() + ms;
    await flush();
    for (;;) {
      queue.sort((a, b) => a.at - b.at || a.seq - b.seq);
      const next = queue[0];
      if (!next || next.at > end) break;
      queue.shift();
      clock.set(next.at);
      next.fn();
      await flush();
    }
    clock.set(end);
    await flush();
  };
  return { setTimer, advance, pending: () => queue.length };
}
