/// <reference types="bun-types" />

import { describe, expect, mock, spyOn, test } from 'bun:test';
import type { SpawnSyncReturns } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  fetchLatestVersion,
  getOpenCodeVersion,
  isOpenCodeInstalled,
  isTmuxInstalled,
  resolveOpenCodePath,
} from './system';

describe('system', () => {
  test('resolves opencode in ~/.opencode/bin', () => {
    const dir = mkdtempSync(join(tmpdir(), 'opencode-system-test-'));

    try {
      const opencodePath = join(dir, '.opencode', 'bin', 'opencode');
      mkdirSync(join(dir, '.opencode', 'bin'), { recursive: true });
      writeFileSync(opencodePath, 'placeholder');

      expect(
        resolveOpenCodePath({
          ...process.env,
          HOME: dir,
          PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
        }),
      ).toBe(opencodePath);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('isOpenCodeInstalled returns boolean', async () => {
    // We don't necessarily want to depend on the host system
    // but for a basic test we can just check it returns a boolean
    const result = await isOpenCodeInstalled();
    expect(typeof result).toBe('boolean');
  });

  test('isTmuxInstalled returns boolean', async () => {
    const result = await isTmuxInstalled();
    expect(typeof result).toBe('boolean');
  });

  test('fetchLatestVersion returns version string or null', async () => {
    // Mock global fetch
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(async () => {
      return {
        ok: true,
        json: async () => ({ version: '1.2.3' }),
      };
    }) as any;

    try {
      const version = await fetchLatestVersion('any-package');
      expect(version).toBe('1.2.3');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('fetchLatestVersion returns null on error', async () => {
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = mock(async () => {
        return {
          ok: false,
        };
      }) as any;

      const version = await fetchLatestVersion('any-package');
      expect(version).toBeNull();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('getOpenCodeVersion parses stdout on success', async () => {
    const childProcess = await import('node:child_process');
    const fakeResult = (stdout: string): SpawnSyncReturns<string> => ({
      status: 0,
      stdout,
      stderr: '',
      pid: 1234,
      output: [],
      signal: null,
    });
    const spawnSpy = spyOn(childProcess, 'spawnSync').mockImplementation(
      (cmd: string, args?: readonly string[]) => {
        // Hermetic: intercept the PATH resolver too, so the test does not
        // depend on opencode being installed on the host.
        if (cmd === 'which' || cmd === 'where') {
          return fakeResult('/usr/local/bin/opencode\n');
        }
        if (args?.includes('--version')) {
          return fakeResult('1.2.3\n');
        }
        return undefined;
      },
    );

    try {
      const version = await getOpenCodeVersion();
      expect(version).toBe('1.2.3');
    } finally {
      spawnSpy.mockRestore();
    }
  });

  test('getOpenCodeVersion returns null on failure', async () => {
    const childProcess = await import('node:child_process');
    const spawnSpy = spyOn(childProcess, 'spawnSync').mockReturnValue({
      status: 1,
      stdout: '',
      stderr: 'command not found',
      pid: 1234,
      output: [],
      signal: null,
    } as any);

    try {
      const version = await getOpenCodeVersion();
      expect(version).toBeNull();
    } finally {
      spawnSpy.mockRestore();
    }
  });
});
