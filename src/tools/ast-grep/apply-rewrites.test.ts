import { describe, expect, mock, test } from 'bun:test';
import { createTimerHarness } from '../../utils/test-timers';
import { applyRewrites } from './apply-rewrites';

const ARGS = ['-p', 'old($A)', '--lang', 'javascript', '-r', 'next($A)', '.'];

describe('applyRewrites', () => {
  test('runs a non-JSON update pass and clears its timer after success', async () => {
    const timers = createTimerHarness();
    const kill = mock(() => true);
    const spawn = mock(() => ({
      exited: Promise.resolve(0),
      stderr: async () => '',
      kill,
    }));

    expect(await applyRewrites('/sg', ARGS, 100, { spawn, ...timers })).toBe(
      undefined,
    );
    expect(spawn).toHaveBeenCalledWith(
      ['/sg', 'run', '--update-all', ...ARGS],
      { stdout: 'ignore', stderr: 'pipe' },
    );
    expect(timers.pending()).toBe(0);
    await timers.advance(100);
    expect(kill).not.toHaveBeenCalled();
  });

  test('returns stderr on a failed write and clears its timer', async () => {
    const timers = createTimerHarness();
    const spawn = () => ({
      exited: Promise.resolve(2),
      stderr: async () => '  Permission denied\n',
      kill: () => true,
    });

    expect(await applyRewrites('/sg', ARGS, 100, { spawn, ...timers })).toBe(
      'Permission denied',
    );
    expect(timers.pending()).toBe(0);
  });

  test('reports the exit code when a failed write has no stderr', async () => {
    const timers = createTimerHarness();
    const spawn = () => ({
      exited: Promise.resolve(3),
      stderr: async () => '',
      kill: () => true,
    });

    expect(await applyRewrites('/sg', ARGS, 100, { spawn, ...timers })).toBe(
      'ast-grep exited with code 3',
    );
    expect(timers.pending()).toBe(0);
  });

  test('surfaces synchronous spawn failures without leaving a timer', async () => {
    const timers = createTimerHarness();
    const spawn = () => {
      throw new Error('spawn failed');
    };

    expect(await applyRewrites('/sg', ARGS, 100, { spawn, ...timers })).toBe(
      'Failed to apply rewrite: spawn failed',
    );
    expect(timers.pending()).toBe(0);
  });

  test('surfaces asynchronous spawn failures and clears its timer', async () => {
    const timers = createTimerHarness();
    const spawn = () => ({
      exited: Promise.reject(new Error('ENOENT')),
      stderr: async () => '',
      kill: () => true,
    });

    expect(await applyRewrites('/sg', ARGS, 100, { spawn, ...timers })).toBe(
      'Failed to apply rewrite: ENOENT',
    );
    expect(timers.pending()).toBe(0);
  });

  test('kills a hung rewrite at its deterministic deadline and clears its timer', async () => {
    const timers = createTimerHarness();
    const kill = mock(() => true);
    const spawn = () => ({
      exited: new Promise<number>(() => {}),
      stderr: async () => '',
      kill,
    });
    const result = applyRewrites('/sg', ARGS, 100, { spawn, ...timers });

    await timers.advance(99);
    expect(kill).not.toHaveBeenCalled();
    expect(timers.pending()).toBe(1);
    await timers.advance(1);
    expect(await result).toBe('Rewrite timeout after 100ms');
    expect(kill).toHaveBeenCalledTimes(1);
    expect(timers.pending()).toBe(0);
  });
});
