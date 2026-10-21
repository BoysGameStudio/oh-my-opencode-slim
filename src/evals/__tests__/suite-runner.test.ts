import { describe, expect, mock, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { collectSuite } from '../../cli/auto-collect';
import type { EvalSessionClient } from '../eval-client';
import { type EvalSuiteResult, EvalSuiteSchema } from '../schema';
import { runSuite } from '../suite-runner';

function dependencies() {
  const suite = EvalSuiteSchema.parse({
    name: 'test-suite',
    description: 'test',
    evals: [
      {
        id: 'test-1',
        prompt: 'Say hello',
        smoke: true,
        assertions: [
          { type: 'contains', value: 'hello', description: 'hello' },
        ],
      },
      {
        id: 'full-only',
        prompt: 'Say hello again',
        assertions: [
          { type: 'contains', value: 'hello', description: 'hello' },
        ],
      },
    ],
  });
  const result: EvalSuiteResult = {
    suiteName: suite.name,
    totalEvals: 1,
    passed: 1,
    failed: 0,
    skipped: 0,
    passAtK: 1,
    passK: 1,
    results: [],
    durationMs: 0,
    timestamp: '2026-10-21T00:00:00Z',
  };
  return {
    collectSuite: mock<typeof collectSuite>(async () => ({
      outputs: { 'test-1': ['hello'] },
      transcripts: {},
      errors: [],
    })),
    stashChanges: mock(
      (_message?: string, _cwd?: string): string | null => 'stash-id',
    ),
    restoreAfterEvals: mock((_stash: string | null, _cwd?: string) => {}),
    loadEvalSuite: mock((name: string) => (name === suite.name ? suite : null)),
    executeSuite: mock(async (..._args: unknown[]) => result),
    saveResults: mock(() => '/tmp/opencode/test-suite-result.json'),
    formatResult: mock(() => 'formatted result'),
  };
}

const options = {
  suiteName: 'test-suite',
  client: {} as EvalSessionClient,
  smoke: true,
};

describe('suite-runner', () => {
  test('invalid suite never stashes or cleans the working tree', async () => {
    const deps = dependencies();
    expect(await runSuite({ ...options, suiteName: 'not-found' }, deps)).toBe(
      1,
    );
    expect(deps.stashChanges).not.toHaveBeenCalled();
    expect(deps.restoreAfterEvals).not.toHaveBeenCalled();
  });

  test('restores once after scoring and excludes non-smoke cases', async () => {
    const deps = dependencies();
    expect(await runSuite(options, deps)).toBe(0);
    expect(deps.restoreAfterEvals).toHaveBeenCalledTimes(1);
    expect(deps.restoreAfterEvals).toHaveBeenCalledWith(
      'stash-id',
      process.cwd(),
    );
    expect(deps.collectSuite.mock.calls[0][0].suite.evals).toHaveLength(1);
    expect(deps.executeSuite.mock.calls[0][3]).toEqual(new Set(['full-only']));
  });

  test('cleans eval edits even when the initial tree was clean', async () => {
    const deps = dependencies();
    deps.stashChanges.mockReturnValue(null);
    await runSuite(options, deps);
    expect(deps.restoreAfterEvals).toHaveBeenCalledWith(null, process.cwd());
  });

  test('restores on collection failure', async () => {
    const deps = dependencies();
    deps.collectSuite.mockRejectedValue(new Error('collection failed'));
    await expect(runSuite(options, deps)).rejects.toThrow('collection failed');
    expect(deps.restoreAfterEvals).toHaveBeenCalledTimes(1);
  });

  test('restores on scoring or result-write failure', async () => {
    for (const stage of ['score', 'save']) {
      const deps = dependencies();
      if (stage === 'score') {
        deps.executeSuite.mockRejectedValue(new Error('scoring failed'));
      } else {
        deps.saveResults.mockImplementation(() => {
          throw new Error('save failed');
        });
      }
      await expect(runSuite(options, deps)).rejects.toThrow();
      expect(deps.restoreAfterEvals).toHaveBeenCalledTimes(1);
    }
  });

  test('a failed stash never triggers destructive cleanup', async () => {
    const deps = dependencies();
    deps.stashChanges.mockImplementation(() => {
      throw new Error('stash failed');
    });
    await expect(runSuite(options, deps)).rejects.toThrow('stash failed');
    expect(deps.restoreAfterEvals).not.toHaveBeenCalled();
  });

  test('missing outputs fail rather than reporting a successful suite', async () => {
    const deps = dependencies();
    const result = await deps.executeSuite();
    result.skipped = 1;
    result.passed = 0;
    expect(await runSuite(options, deps)).toBe(1);
  });

  test('flaky trials retain exit code 2', async () => {
    const deps = dependencies();
    const result = await deps.executeSuite();
    result.failed = 1;
    result.results = [
      {
        evalId: 'test-1',
        prompt: 'Say hello',
        passed: false,
        runs: 3,
        passRate: 1 / 3,
        passAtK: 1,
        passKk: 0,
        assertions: [],
      },
    ];
    expect(await runSuite(options, deps)).toBe(2);
  });

  test('saved outputs are loaded and scored without git mutations or a client', async () => {
    const dir = mkdtempSync('/tmp/opencode/eval-offline-');
    try {
      const path = join(dir, 'outputs.json');
      writeFileSync(path, JSON.stringify({ 'test-1': 'hello from file' }));
      const deps = dependencies();
      expect(
        await runSuite(
          { ...options, client: undefined, outputsFile: path },
          deps,
        ),
      ).toBe(0);
      expect(deps.executeSuite.mock.calls[0][1]).toEqual({
        'test-1': 'hello from file',
      });
      expect(deps.stashChanges).not.toHaveBeenCalled();
      expect(deps.restoreAfterEvals).not.toHaveBeenCalled();
      expect(deps.collectSuite).not.toHaveBeenCalled();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
