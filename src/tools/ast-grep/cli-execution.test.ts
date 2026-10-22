import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { join } from 'node:path';
import { createTimerHarness, tick } from '../../utils/test-timers';
import { getAstGrepPath, runSg } from './cli';
import { DEFAULT_TIMEOUT_MS, getSgCliPath, setSgCliPath } from './constants';

const OPTIONS = { pattern: 'foo($A)', lang: 'javascript' } as const;
const MISSING_PATH = join(import.meta.dir, 'missing-ast-grep');
const failedSpawn = () =>
  Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' });

function setup() {
  setSgCliPath(MISSING_PATH);
  const timers = createTimerHarness();
  const kill = mock(() => true);
  const ensureBinary = mock(async () => null);
  const findBinary = mock((): string | null => null);
  return { ...timers, kill, ensureBinary, findBinary };
}

describe('runSg execution lifecycle', () => {
  let originalPath: string;
  beforeEach(() => {
    originalPath = getSgCliPath();
  });
  afterEach(() => {
    setSgCliPath(originalPath);
  });

  test('clears the deadline on success without acquiring another binary', async () => {
    const deps = setup();
    const spawn = mock(() => ({
      stdout: async () => '[]',
      stderr: async () => '',
      exited: Promise.resolve(0),
      kill: deps.kill,
    }));
    const result = await runSg(OPTIONS, { ...deps, spawn });
    expect(result.error).toBeUndefined();
    expect(result.matches).toEqual([]);
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(deps.ensureBinary).not.toHaveBeenCalled();
    expect(deps.pending()).toBe(0);
    await deps.advance(DEFAULT_TIMEOUT_MS);
    expect(deps.kill).not.toHaveBeenCalled();
  });

  test('observes a rejected exit while stdout never settles and clears the timer', async () => {
    const deps = setup();
    const spawn = () => ({
      stdout: () => new Promise<string>(() => {}),
      stderr: async () => '',
      exited: Promise.reject(failedSpawn()),
      kill: deps.kill,
    });
    const result = await runSg(OPTIONS, { ...deps, spawn });
    expect(result.error).toContain('binary not found');
    expect(deps.ensureBinary).toHaveBeenCalledTimes(1);
    expect(deps.ensureBinary).toHaveBeenCalledWith(MISSING_PATH);
    expect(deps.pending()).toBe(0);
    await tick(); // Rejected exit must not produce an unhandled rejection.
  });

  test('clears each failed attempt before acquiring and retrying once', async () => {
    const deps = setup();
    const spawn = mock(() => ({
      stdout: async () => '',
      stderr: async () => '',
      exited: Promise.reject(failedSpawn()),
      kill: deps.kill,
    }));
    const ensureBinary = mock(async () => {
      expect(deps.pending()).toBe(0);
      return join(import.meta.dir, 'downloaded-sg');
    });
    const result = await runSg(OPTIONS, { ...deps, spawn, ensureBinary });
    expect(result.error).toContain('binary not found');
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(ensureBinary).toHaveBeenCalledTimes(1);
    expect(deps.pending()).toBe(0);
  });

  test('recovers from a synchronous spawn failure', async () => {
    const deps = setup();
    const spawn = mock(() => {
      throw failedSpawn();
    });
    const result = await runSg(OPTIONS, { ...deps, spawn });
    expect(result.error).toContain('binary not found');
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(deps.ensureBinary).toHaveBeenCalledTimes(1);
    expect(deps.pending()).toBe(0);
  });

  test('does not recover again if a rediscovered binary also cannot execute', async () => {
    const deps = setup();
    const replacement = join(import.meta.dir, 'cli.ts');
    const findBinary = mock(() => replacement);
    const spawn = mock(() => {
      throw failedSpawn();
    });
    const result = await runSg(OPTIONS, { ...deps, spawn, findBinary });
    expect(result.error).toContain('exists but cannot execute');
    expect(getSgCliPath()).toBe(replacement);
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(findBinary).toHaveBeenCalledTimes(1);
    expect(deps.ensureBinary).not.toHaveBeenCalled();
    expect(deps.pending()).toBe(0);
  });

  test.each(['missing', 'unexecutable'])(
    'shares recovery across concurrent searches when the binary is %s',
    async (state) => {
      const deps = setup();
      if (state === 'unexecutable') {
        setSgCliPath(join(import.meta.dir, 'cli.ts'));
      }
      const failedPath = getSgCliPath();
      const replacement = join(import.meta.dir, 'downloaded-sg');
      const acquisition = Promise.withResolvers<string | null>();
      const ensureBinary = mock(() => acquisition.promise);
      const spawn = mock(([path]: string[]) => {
        if (path === failedPath) throw failedSpawn();
        return {
          stdout: async () => '[]',
          stderr: async () => '',
          exited: Promise.resolve(0),
          kill: deps.kill,
        };
      });
      const searches = Promise.all([
        runSg(OPTIONS, { ...deps, spawn, ensureBinary }),
        runSg(OPTIONS, { ...deps, spawn, ensureBinary }),
      ]);
      try {
        await tick();
        expect(ensureBinary).toHaveBeenCalledTimes(1);
        expect(ensureBinary).toHaveBeenCalledWith(failedPath);
        expect(spawn).toHaveBeenCalledTimes(2);
        // Availability checks must join recovery, not start another download.
        const initialization = getAstGrepPath();
        acquisition.resolve(replacement);
        expect(await initialization).toBe(replacement);
      } finally {
        acquisition.resolve(replacement);
        await searches;
      }
      for (const result of await searches) {
        expect(result.error).toBeUndefined();
        expect(result.matches).toEqual([]);
      }
      expect(spawn).toHaveBeenCalledTimes(4);
      expect(getSgCliPath()).toBe(replacement);
      expect(deps.pending()).toBe(0);
    },
  );

  test.each(['empty', 'rejected'])(
    'releases shared recovery after acquisition is %s',
    async (failure) => {
      const deps = setup();
      const replacement = join(import.meta.dir, 'downloaded-sg');
      let acquisitions = 0;
      const ensureBinary = mock(async () => {
        if (++acquisitions === 1) {
          if (failure === 'rejected') throw new Error('download unavailable');
          return null;
        }
        return replacement;
      });
      const spawn = mock(([path]: string[]) => {
        if (path === MISSING_PATH) throw failedSpawn();
        return {
          stdout: async () => '[]',
          stderr: async () => '',
          exited: Promise.resolve(0),
          kill: deps.kill,
        };
      });
      const dependencies = { ...deps, spawn, ensureBinary };
      const results = await Promise.all([
        runSg(OPTIONS, dependencies),
        runSg(OPTIONS, dependencies),
      ]);
      for (const result of results) {
        expect(result.error).toContain('Automatic recovery failed');
      }
      expect(ensureBinary).toHaveBeenCalledTimes(1);
      expect((await runSg(OPTIONS, dependencies)).error).toBeUndefined();
      expect(ensureBinary).toHaveBeenCalledTimes(2);
      expect(spawn).toHaveBeenCalledTimes(4);
      expect(deps.pending()).toBe(0);
    },
  );

  test.each(['stdout', 'stderr'] as const)(
    'kills the child before clearing the deadline when %s rejects and exit is pending',
    async (stream) => {
      const deps = setup();
      const kill = mock(() => {
        expect(deps.pending()).toBe(1);
        return true;
      });
      const spawn = () => ({
        stdout: async () => {
          if (stream === 'stdout') throw new Error('stream failure');
          return '[]';
        },
        stderr: async () => {
          if (stream === 'stderr') throw new Error('stream failure');
          return '';
        },
        exited: new Promise<number>(() => {}),
        kill,
      });
      const result = await runSg(OPTIONS, { ...deps, spawn });
      expect(result.error).toBe('Failed to spawn ast-grep: stream failure');
      expect(kill).toHaveBeenCalledTimes(1);
      expect(deps.ensureBinary).not.toHaveBeenCalled();
      expect(deps.pending()).toBe(0);
      await deps.advance(DEFAULT_TIMEOUT_MS);
      expect(kill).toHaveBeenCalledTimes(1);
    },
  );

  test('returns acquisition failures as tool errors rather than throwing', async () => {
    const deps = setup();
    const spawn = () => {
      throw failedSpawn();
    };
    const ensureBinary = async () => {
      throw new Error('cache is read-only');
    };
    const result = await runSg(OPTIONS, { ...deps, spawn, ensureBinary });
    expect(result.error).toContain('cache is read-only');
    expect(deps.pending()).toBe(0);
  });

  test('does not retry unrelated execution errors', async () => {
    const deps = setup();
    const spawn = () => {
      throw new Error('unexpected failure');
    };
    const result = await runSg(OPTIONS, { ...deps, spawn });
    expect(result.error).toBe('Failed to spawn ast-grep: unexpected failure');
    expect(deps.ensureBinary).not.toHaveBeenCalled();
    expect(deps.pending()).toBe(0);
  });

  test.each(['stdout', 'stderr', 'exited'] as const)(
    'enforces the deadline even when only %s is pending',
    async (pending) => {
      const deps = setup();
      const spawn = () => ({
        stdout: () =>
          pending === 'stdout'
            ? new Promise<string>(() => {})
            : Promise.resolve('[]'),
        stderr: () =>
          pending === 'stderr'
            ? new Promise<string>(() => {})
            : Promise.resolve(''),
        exited:
          pending === 'exited'
            ? new Promise<number>(() => {})
            : Promise.resolve(0),
        kill: deps.kill,
      });
      const result = runSg(OPTIONS, { ...deps, spawn });
      await deps.advance(DEFAULT_TIMEOUT_MS - 1);
      expect(deps.pending()).toBe(1);
      expect(deps.kill).not.toHaveBeenCalled();
      await deps.advance(1);
      expect((await result).truncatedReason).toBe('timeout');
      expect(deps.kill).toHaveBeenCalledTimes(1);
      expect(deps.ensureBinary).not.toHaveBeenCalled();
      expect(deps.pending()).toBe(0);
    },
  );
});
