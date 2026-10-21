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
    fetch: mock<EvalServerDependencies['fetch']>(async (url) => {
      if (url.endsWith('/global/health')) {
        if (!responses.shift()) throw new Error('connection refused');
        return Response.json({ healthy: true, version: '1.18.32' });
      }
      return Response.json([]);
    }),
    sleep: mock(async (_ms: number) => {}),
    version: mock<EvalServerDependencies['version']>(() => '1.18.32'),
  };
  return { proc, deps };
}

test('explicit OPENCODE_URL is the only probed target and is never managed', async () => {
  const { proc, deps } = dependencies([true]);
  const server = await startEvalServer(
    { url: 'http://remote.test:8765/' },
    deps,
  );
  expect(server).toEqual({ url: 'http://remote.test:8765', proc: null });
  expect(deps.fetch.mock.calls[0][0]).toBe(
    'http://remote.test:8765/global/health',
  );
  await stopEvalServer(server.proc, deps);
  expect(deps.spawn).not.toHaveBeenCalled();
  expect(proc.kill).not.toHaveBeenCalled();
  expect(deps.version).not.toHaveBeenCalled();
});

test('unavailable explicit URL fails without spawning or killing local services', async () => {
  const { proc, deps } = dependencies([false]);
  await expect(
    startEvalServer({ url: 'http://remote.test:8765' }, deps),
  ).rejects.toThrow('unavailable');
  expect(deps.spawn).not.toHaveBeenCalled();
  expect(proc.kill).not.toHaveBeenCalled();
});

test('healthy v1 server is reused when an explicit v1 executable selects the local endpoint', async () => {
  const { deps } = dependencies([true]);
  const server = await startEvalServer(
    { executable: '/tools/opencode-v1' },
    deps,
  );
  expect(server.proc).toBeNull();
  expect(deps.spawn).not.toHaveBeenCalled();
  expect(deps.version).toHaveBeenCalledWith('/tools/opencode-v1');
});

test('spawned server uses the same target as the client and is stopped', async () => {
  const { proc, deps } = dependencies([false, true]);
  const server = await startEvalServer(
    { executable: '/tools/opencode-v1' },
    deps,
  );
  expect(server.proc).toBe(proc as unknown as ChildProcess);
  expect(deps.spawn.mock.calls[0][0]).toBe('/tools/opencode-v1');
  expect(deps.spawn.mock.calls[0][1]).toEqual([
    'serve',
    '--hostname',
    '127.0.0.1',
    '--port',
    '4096',
  ]);
  expect(
    deps.fetch.mock.calls.every(([url]) => url.startsWith(`${server.url}/`)),
  ).toBe(true);
  await stopEvalServer(server.proc, deps);
  expect(proc.kill).toHaveBeenCalledWith('SIGTERM');
});

test('startup timeout cleans up only the spawned child', async () => {
  const { proc, deps } = dependencies([false]);
  await expect(
    startEvalServer({ executable: '/tools/opencode-v1' }, deps),
  ).rejects.toThrow('did not become healthy');
  expect(proc.kill).toHaveBeenCalledTimes(1);
});

test('spawn errors and early exits fail promptly with no polling delay', async () => {
  for (const error of [true, false]) {
    const { proc, deps } = dependencies([false]);
    deps.sleep.mockImplementation(async () => {
      if (error) proc.emit('error', new Error('missing opencode'));
      else proc.exitCode = 1;
    });
    await expect(
      startEvalServer({ executable: '/tools/opencode-v1' }, deps),
    ).rejects.toThrow();
    expect(deps.sleep).toHaveBeenCalledTimes(1);
    expect(proc.listenerCount('error')).toBe(0);
  }
});

test('live runs without an explicit v1 endpoint or executable fail before any service access', async () => {
  const { proc, deps } = dependencies([]);
  await expect(startEvalServer({}, deps)).rejects.toThrow(
    'OPENCODE_V1_EXECUTABLE',
  );
  expect(deps.version).not.toHaveBeenCalled();
  expect(deps.fetch).not.toHaveBeenCalled();
  expect(deps.spawn).not.toHaveBeenCalled();
  expect(proc.kill).not.toHaveBeenCalled();
});

test('an installed v2 executable is rejected before probing or spawning', async () => {
  const { proc, deps } = dependencies([]);
  deps.version.mockReturnValue('2.0.28');
  await expect(
    startEvalServer({ executable: '/tools/opencode' }, deps),
  ).rejects.toThrow('reported 2.0.28');
  expect(deps.fetch).not.toHaveBeenCalled();
  expect(deps.spawn).not.toHaveBeenCalled();
  expect(proc.kill).not.toHaveBeenCalled();
});

test('an unavailable explicit executable fails without touching a service', async () => {
  const { deps } = dependencies([]);
  deps.version.mockImplementation(() => {
    throw new Error('ENOENT');
  });
  await expect(
    startEvalServer({ executable: '/missing/opencode-v1' }, deps),
  ).rejects.toThrow('Cannot determine');
  expect(deps.fetch).not.toHaveBeenCalled();
  expect(deps.spawn).not.toHaveBeenCalled();
});

test('a v2 endpoint is rejected before any v1 session route or local executable is used', async () => {
  const { proc, deps } = dependencies([]);
  deps.fetch.mockResolvedValue(
    Response.json({ healthy: true, version: '2.0.28' }),
  );
  await expect(
    startEvalServer(
      { url: 'http://remote.test:8765', executable: '/unused' },
      deps,
    ),
  ).rejects.toThrow('reported version 2.0.28');
  expect(deps.fetch).toHaveBeenCalledTimes(1);
  expect(deps.version).not.toHaveBeenCalled();
  expect(deps.spawn).not.toHaveBeenCalled();
  expect(proc.kill).not.toHaveBeenCalled();
});

test('unverifiable health or incompatible v1 session responses fail closed', async () => {
  for (const validHealth of [false, true]) {
    const { deps } = dependencies([]);
    deps.fetch.mockImplementation(async (url) => {
      if (validHealth && url.endsWith('/global/health'))
        return Response.json({ healthy: true, version: '1.18.32' });
      return Response.json({});
    });
    await expect(
      startEvalServer({ url: 'http://remote.test:8765' }, deps),
    ).rejects.toThrow();
    expect(deps.spawn).not.toHaveBeenCalled();
  }
});
