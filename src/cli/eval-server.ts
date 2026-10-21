import {
  type ChildProcess,
  execFileSync,
  type SpawnOptions,
  spawn,
} from 'node:child_process';
import { parse } from 'semver';

const DEFAULT_URL = 'http://127.0.0.1:4096';
export interface EvalServerDependencies {
  spawn: (
    command: string,
    args: string[],
    options: SpawnOptions,
  ) => ChildProcess;
  fetch: (url: string, options: RequestInit) => Promise<Response>;
  sleep: (ms: number) => Promise<unknown>;
  version: (executable: string) => string;
}

const serverDependencies: EvalServerDependencies = {
  spawn,
  fetch,
  sleep: (ms: number) => Bun.sleep(ms),
  version: (executable) =>
    execFileSync(executable, ['--version'], {
      encoding: 'utf-8',
      timeout: 2_000,
    }).trim(),
};

export interface EvalServer {
  url: string;
  proc: ChildProcess | null;
}

export interface EvalServerOptions {
  url?: string;
  executable?: string;
}

/** Explicit URLs are connect-only. Never terminate an existing listener. */
export async function startEvalServer(
  options: EvalServerOptions,
  deps = serverDependencies,
): Promise<EvalServer> {
  const { url: targetUrl, executable } = options;
  if (targetUrl === undefined && !executable) {
    throw new Error(
      'Live evals require OPENCODE_URL for a compatible OpenCode 1.x server or OPENCODE_V1_EXECUTABLE for an explicit v1 binary. The default opencode executable may be v2 and is not used.',
    );
  }
  if (targetUrl === undefined && executable) {
    let version: string;
    try {
      version = deps.version(executable);
    } catch (error) {
      throw new Error(
        `Cannot determine OpenCode v1 executable version (${executable}): ${String(error)}`,
      );
    }
    if (parse(version)?.major !== 1) {
      throw new Error(
        `OPENCODE_V1_EXECUTABLE must report OpenCode 1.x; ${executable} reported ${version}`,
      );
    }
  }
  const url = (targetUrl ?? DEFAULT_URL).replace(/\/$/, '');
  const healthy = async () => {
    let res: Response;
    try {
      res = await deps.fetch(`${url}/global/health`, {
        signal: AbortSignal.timeout(2_000),
      });
    } catch {
      return false;
    }
    let health: unknown;
    try {
      health = await res.json();
    } catch {
      throw new Error(
        `Cannot verify OpenCode 1.x compatibility at ${url}: invalid /global/health response`,
      );
    }
    if (
      !res.ok ||
      !health ||
      typeof health !== 'object' ||
      !('version' in health) ||
      typeof health.version !== 'string' ||
      parse(health.version)?.major !== 1
    ) {
      const version =
        health && typeof health === 'object' && 'version' in health
          ? health.version
          : 'unknown';
      throw new Error(
        `Expected compatible OpenCode 1.x at ${url}; reported version ${String(version)}`,
      );
    }
    if (!('healthy' in health) || health.healthy !== true) {
      throw new Error(`OpenCode 1.x server is not healthy at ${url}`);
    }
    const sessions = await deps.fetch(`${url}/session`, {
      signal: AbortSignal.timeout(2_000),
    });
    const body: unknown = await sessions.json();
    if (!sessions.ok || !Array.isArray(body)) {
      throw new Error(
        `Server at ${url} does not expose the compatible v1 /session API`,
      );
    }
    return true;
  };
  if (await healthy()) return { url, proc: null };
  if (targetUrl !== undefined) {
    throw new Error(`OpenCode server unavailable at ${url}`);
  }

  const proc = deps.spawn(
    executable as string,
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
