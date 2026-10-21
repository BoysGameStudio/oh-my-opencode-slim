import { expect, mock, test } from 'bun:test';
import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import {
  type EvalServerDependencies,
  startEvalServer,
  stopEvalServer,
} from './eval-server';

function dependencies(responses: boolean[]) {
  const proc = Object.assign(new EventEmitter(), {
    exitCode: null as number | null,
    signalCode: null as string | null,
    kill: mock((_signal: string) => {
      proc.exitCode = 0;
      return true;
    }),
  });
  const deps = {
    spawn: mock<EvalServerDependencies['spawn']>(
      () => proc as unknown as ChildProcess,
    ),
    fetch: mock<EvalServerDependencies['fetch']>(
      async () => new Response(JSON.stringify(responses.shift() ? [] : {})),
    ),
    sleep: mock(async (_ms: number) => {}),
  };
  return { proc, deps };
}

test('explicit OPENCODE_URL is the only probed target and is never managed', async () => {
  const { proc, deps } = dependencies([true]);
  const server = await startEvalServer('http://remote.test:8765/', deps);
  expect(server).toEqual({ url: 'http://remote.test:8765', proc: null });
  expect(deps.fetch.mock.calls[0][0]).toBe('http://remote.test:8765/session');
  await stopEvalServer(server.proc, deps);
  expect(deps.spawn).not.toHaveBeenCalled();
  expect(proc.kill).not.toHaveBeenCalled();
});

test('unavailable explicit URL fails without spawning or killing local services', async () => {
  const { proc, deps } = dependencies([false]);
  await expect(
    startEvalServer('http://remote.test:8765', deps),
  ).rejects.toThrow('unavailable');
  expect(deps.spawn).not.toHaveBeenCalled();
  expect(proc.kill).not.toHaveBeenCalled();
});

test('healthy default server is reused without ownership', async () => {
  const { deps } = dependencies([true]);
  const server = await startEvalServer(undefined, deps);
  expect(server.proc).toBeNull();
  expect(deps.spawn).not.toHaveBeenCalled();
});

test('spawned server uses the same target as the client and is stopped', async () => {
  const { proc, deps } = dependencies([false, true]);
  const server = await startEvalServer(undefined, deps);
  expect(server.proc).toBe(proc as unknown as ChildProcess);
  expect(deps.spawn.mock.calls[0][1]).toEqual([
    'serve',
    '--hostname',
    '127.0.0.1',
    '--port',
    '4096',
  ]);
  expect(
    deps.fetch.mock.calls.every(([url]) => url === `${server.url}/session`),
  ).toBe(true);
  await stopEvalServer(server.proc, deps);
  expect(proc.kill).toHaveBeenCalledWith('SIGTERM');
});

test('startup timeout cleans up only the spawned child', async () => {
  const { proc, deps } = dependencies([false]);
  await expect(startEvalServer(undefined, deps)).rejects.toThrow(
    'did not become healthy',
  );
  expect(proc.kill).toHaveBeenCalledTimes(1);
});

test('spawn errors and early exits fail promptly with no polling delay', async () => {
  for (const error of [true, false]) {
    const { proc, deps } = dependencies([false]);
    deps.sleep.mockImplementation(async () => {
      if (error) proc.emit('error', new Error('missing opencode'));
      else proc.exitCode = 1;
    });
    await expect(startEvalServer(undefined, deps)).rejects.toThrow();
    expect(deps.sleep).toHaveBeenCalledTimes(1);
    expect(proc.listenerCount('error')).toBe(0);
  }
});
