import { type CrossSpawnResult, crossSpawn } from '../../utils/compat';

type RewriteProcess = Pick<CrossSpawnResult, 'exited' | 'stderr' | 'kill'>;
// Host overloads can return object handles or numeric IDs; the harness uses IDs.
type TimerHandle = ReturnType<typeof setTimeout> | number;

interface RewriteDependencies {
  spawn?: (...args: Parameters<typeof crossSpawn>) => RewriteProcess;
  setTimeout?: (callback: () => void, delay: number) => TimerHandle;
  clearTimeout?: (timer: TimerHandle) => void;
}

export async function applyRewrites(
  cliPath: string,
  args: string[],
  timeout: number,
  dependencies: RewriteDependencies = {},
): Promise<string | undefined> {
  const spawn = dependencies.spawn ?? crossSpawn;
  const setTimer = dependencies.setTimeout ?? setTimeout;
  const clearTimer = dependencies.clearTimeout ?? clearTimeout;
  let timer: TimerHandle | undefined;

  try {
    const proc = spawn([cliPath, 'run', '--update-all', ...args], {
      // The JSON pass already captured the report. Do not collect it twice.
      stdout: 'ignore',
      stderr: 'pipe',
    });
    const timedOut = new Promise<'timeout'>((resolve) => {
      timer = setTimer(() => {
        proc.kill();
        resolve('timeout');
      }, timeout);
    });
    const exitCode = await Promise.race([proc.exited, timedOut]);
    if (exitCode === 'timeout') {
      return `Rewrite timeout after ${timeout}ms`;
    }
    if (exitCode !== 0) {
      const stderr = (await proc.stderr()).trim();
      return stderr || `ast-grep exited with code ${exitCode}`;
    }
    return undefined;
  } catch (error) {
    return `Failed to apply rewrite: ${(error as Error).message}`;
  } finally {
    if (timer !== undefined) clearTimer(timer);
  }
}
