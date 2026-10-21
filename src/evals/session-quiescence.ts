import {
  SESSION_ABORT_TIMEOUT_MS,
  sessionAbortFailure,
  withTimeout,
} from '../utils/session';
import type { EvalSessionClient } from './eval-client';

/** Cleanup must fail closed: keep user work stashed if a writer may remain. */
export class EvalQuiescenceError extends Error {
  constructor(
    readonly sessionIDs: string[],
    reason: string,
  ) {
    super(
      `Cannot establish eval session quiescence (${sessionIDs.join(', ')}): ${reason}`,
    );
    this.name = 'EvalQuiescenceError';
  }
}

const quiescenceDependencies = {
  now: Date.now,
  sleep: (ms: number): Promise<unknown> => Bun.sleep(ms),
  withTimeout,
};

/**
 * Stop only the created eval root and descendants proven by parentID.
 * Abort acknowledgements are awaited, then the complete subtree must remain
 * idle across two scans. Re-scan after cancellation to catch late children.
 * Missing entries in v1's sparse status map mean idle, not missing sessions.
 */
export async function stopEvalSessionTree(
  client: EvalSessionClient,
  rootID: string,
  directory: string,
  deps = quiescenceDependencies,
): Promise<void> {
  const deadline = deps.now() + 10_000;
  const owned = new Set([rootID]);
  let previousIdleTree: string | undefined;

  const request = <T>(operation: Promise<T>) => {
    const remaining = deadline - deps.now();
    return deps.withTimeout(
      operation,
      Math.max(1, Math.min(SESSION_ABORT_TIMEOUT_MS, remaining)),
      'Eval session shutdown request timed out',
    );
  };

  try {
    while (deps.now() < deadline) {
      // Freeze the root first, before discovering and stopping children.
      // Re-aborting known nodes also handles a retry/wake observed as busy.
      for (const id of owned) {
        if (deps.now() >= deadline)
          throw new Error('Shutdown deadline exceeded');
        const result = await request(
          client.session.abort({
            path: { id },
            query: { directory },
          }),
        );
        const failure = sessionAbortFailure(result);
        if (failure || result.data !== true) {
          throw new Error(failure ?? `Abort was not acknowledged for ${id}`);
        }
      }

      const beforeScan = owned.size;
      const queue = [...owned];
      const scanned = new Set<string>();
      while (queue.length > 0) {
        if (deps.now() >= deadline)
          throw new Error('Shutdown deadline exceeded');
        const id = queue.shift() as string;
        if (scanned.has(id)) continue;
        scanned.add(id);
        const result = await request(
          client.session.children({
            path: { id },
            query: { directory },
          }),
        );
        if (result.error != null || !Array.isArray(result.data)) {
          throw new Error(`Cannot enumerate children of ${id}`);
        }
        for (const child of result.data) {
          if (
            !child ||
            typeof child.id !== 'string' ||
            child.parentID !== id ||
            child.id === rootID
          ) {
            throw new Error(`Unverified child returned for ${id}`);
          }
          if (!owned.has(child.id)) {
            owned.add(child.id);
            queue.push(child.id);
          }
        }
      }

      const status = await request(
        client.session.status({ query: { directory } }),
      );
      if (
        status.error != null ||
        !status.data ||
        typeof status.data !== 'object' ||
        Array.isArray(status.data)
      ) {
        throw new Error('Cannot read eval session status');
      }
      const idle = [...owned].every((id) => {
        const state = status.data?.[id];
        return state === undefined || state.type === 'idle';
      });
      const tree = [...owned].sort().join('\n');
      if (owned.size === beforeScan && idle) {
        if (previousIdleTree === tree) return;
        previousIdleTree = tree;
      } else {
        previousIdleTree = undefined;
      }
      await deps.sleep(100);
    }
    throw new Error(
      'Session subtree did not stop before the shutdown deadline',
    );
  } catch (error) {
    throw new EvalQuiescenceError(
      [...owned],
      error instanceof Error ? error.message : String(error),
    );
  }
}
