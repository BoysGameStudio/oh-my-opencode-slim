import type { PluginInput } from '@opencode-ai/plugin';
import { getClient } from './opencode-client';

/** Platform timer handle; fake harnesses may return bare numeric ids. */
type TimerHandle = Timer;

interface TimerFns {
  setTimeout(callback: () => void, delay: number): unknown;
  clearTimeout(timer: unknown): void;
}

/** Wait for a host read with a deadline: the deadline only releases the
 *  WAITER (to undefined), never the underlying read. */
export function raceEvidenceDeadline<T>(
  promise: Promise<T>,
  timeoutMs: number,
  timers?: TimerFns,
): Promise<T | undefined> {
  const settled = promise.catch(() => undefined);
  if (timeoutMs <= 0) return settled;
  const setTimer =
    timers?.setTimeout ?? ((callback, delay) => setTimeout(callback, delay));
  const clearTimer =
    timers?.clearTimeout ??
    ((timer: unknown) => clearTimeout(timer as ReturnType<typeof setTimeout>));
  const deadline = Promise.withResolvers<undefined>();
  const timer = setTimer(() => deadline.resolve(undefined), timeoutMs);
  (timer as { unref?: () => void }).unref?.();
  return Promise.race([settled, deadline.promise]).finally(() =>
    clearTimer(timer),
  );
}

/** In-flight raw session-info reads, scoped to the client session domain,
 *  then task ID: a timed-out or failed waiter never releases the slot, so
 *  concurrent consumers share the one underlying host read. */
const sessionInfoReads = new WeakMap<
  object,
  Map<string, { identity: string; promise: Promise<unknown> }>
>();

/** Share the raw, still-open host `session.get` across consumers of one
 *  task. A consumer deadline must not release this slot or authorize a new
 *  read; the entry clears only when the underlying read settles. A caller
 *  holding a different identity (e.g. a newer generation) is refused rather
 *  than handed the older read. Hosts without `session.get` resolve
 *  undefined (capability absence, not evidence). */
export function readHostSessionInfo(
  input: PluginInput,
  key: { taskID: string; identity: string },
): Promise<unknown> {
  const client = getClient(input);
  const session = client?.session;
  if (typeof session?.get !== 'function') return Promise.resolve(undefined);
  let reads = sessionInfoReads.get(session);
  if (!reads) {
    reads = new Map();
    sessionInfoReads.set(session, reads);
  }
  const existing = reads.get(key.taskID);
  if (existing)
    return existing.identity === key.identity
      ? existing.promise
      : Promise.reject(
          new Error('An earlier session-info observation is still in flight.'),
        );
  const promise = Promise.resolve().then(() =>
    session.get({
      path: { id: key.taskID },
      query: { directory: input.directory },
    }),
  );
  reads.set(key.taskID, { identity: key.identity, promise });
  const release = () => {
    if (reads.get(key.taskID)?.promise === promise) reads.delete(key.taskID);
  };
  void promise.then(release, release);
  return promise;
}
