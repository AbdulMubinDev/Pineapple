/** A fake clock: sleep advances time instantly, so tests never wait. */
export function makeClock(start = 1_700_000_000_000): { now: () => number; sleep: (ms: number) => Promise<void>; sleeps: number[] } {
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
  };
}
