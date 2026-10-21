import {
  type ChildProcess,
  type SpawnOptions,
  spawn,
} from 'node:child_process';

const DEFAULT_URL = 'http://127.0.0.1:4096';
export interface EvalServerDependencies {
  spawn: (
    command: string,
    args: string[],
    options: SpawnOptions,
  ) => ChildProcess;
  fetch: (url: string, options: RequestInit) => Promise<Response>;
  sleep: (ms: number) => Promise<unknown>;
}

const serverDependencies: EvalServerDependencies = {
  spawn,
  fetch,
  sleep: (ms: number) => Bun.sleep(ms),
};

export interface EvalServer {
  url: string;
  proc: ChildProcess | null;
}

/** Explicit URLs are connect-only. Never terminate an existing listener. */
export async function startEvalServer(
  targetUrl: string | undefined,
  deps = serverDependencies,
): Promise<EvalServer> {
  const url = (targetUrl ?? DEFAULT_URL).replace(/\/$/, '');
  const healthy = async () => {
    try {
      const res = await deps.fetch(`${url}/session`, {
        signal: AbortSignal.timeout(2_000),
      });
      const body: unknown = await res.json();
      return res.ok && Array.isArray(body);
    } catch {
      return false;
    }
  };
  if (await healthy()) return { url, proc: null };
  if (targetUrl !== undefined) {
    throw new Error(`OpenCode server unavailable at ${url}`);
  }

  const proc = deps.spawn(
    'opencode',
    ['serve', '--hostname', '127.0.0.1', '--port', '4096'],
    { cwd: process.cwd(), stdio: 'ignore' },
  );
  let spawnError: Error | undefined;
  const onError = (error: Error) => {
    spawnError = error;
  };
  proc.on('error', onError);
  try {
    for (let i = 0; i < 40; i++) {
      await deps.sleep(250);
      if (spawnError) throw spawnError;
      if (proc.exitCode !== null || proc.signalCode !== null) break;
      if (await healthy()) return { url, proc };
    }
    throw new Error(`opencode serve did not become healthy at ${url}`);
  } catch (error) {
    await stopEvalServer(proc, deps);
    throw error;
  } finally {
    proc.off('error', onError);
  }
}

/** Stop only the child this invocation owns, escalating after a grace period. */
export async function stopEvalServer(
  proc: ChildProcess | null,
  deps = serverDependencies,
): Promise<void> {
  if (!proc || proc.exitCode !== null || proc.signalCode !== null) return;
  proc.kill('SIGTERM');
  for (let i = 0; i < 10; i++) {
    if (proc.exitCode !== null || proc.signalCode !== null) return;
    await deps.sleep(50);
  }
  proc.kill('SIGKILL');
}
