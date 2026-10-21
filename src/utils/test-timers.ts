/**
 * Deterministic timer harness for tests: tests never bind to real time.
 *
 * Scheduling components accept injected `setTimeout`/`clearTimeout` seams
 * (see `BackgroundJobSupervisor`, `createBackgroundJobTerminalGate`); this
 * module supplies them a manual clock. Observation-time seams (`now`) stay
 * separate from scheduling when event timestamps are the subject — wire
 * both from one harness only when a test wants them to track together.
 *
 * Awaiting a promise that only settles on a timer (e.g. a deadline race):
 * start the promise, `tick()` so it arms its timer, `advance()` to fire it,
 * then await the promise.
 */
export function createTimerHarness() {
  let now = 0;
  let nextID = 0;
  const timers = new Map<number, { at: number; callback: () => void }>();

  const advanceTo = async (target: number) => {
    now = target;
    while (true) {
      const due = [...timers.entries()]
        .filter(([, timer]) => timer.at <= now)
        .sort(([, a], [, b]) => a.at - b.at)[0];
      if (!due) break;
      timers.delete(due[0]);
      due[1].callback();
      await tick();
    }
  };
  return {
    now: () => now,
    setTimeout: (callback: () => void, delay: number) => {
      const id = ++nextID;
      timers.set(id, { at: now + delay, callback });
      return id;
    },
    clearTimeout: (id: number) => {
      timers.delete(id);
    },
    advanceTo,
    advance: (ms: number) => advanceTo(now + ms),
    tick,
    pending: () => timers.size,
  };
}

/**
 * Yield one event-loop turn and drain microtasks without firing any timer.
 * The macrotask hop lets async work outside the harness (e.g. I/O, shim
 * internals) interleave; zero duration — no time is guessed or bound.
 */
export async function tick(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
  for (let i = 0; i < 50; i++) await Promise.resolve();
}
