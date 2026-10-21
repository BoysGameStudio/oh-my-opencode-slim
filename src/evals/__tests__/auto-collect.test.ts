import { expect, mock, test } from 'bun:test';
import { collectSuite } from '../../cli/auto-collect';
import type { cleanEvalArtifacts } from '../../cli/git-lifecycle';
import { tick } from '../../utils/test-timers';
import type { EvalSessionClient } from '../eval-client';
import type { RunCaseResult } from '../run-case';
import { EvalSuiteSchema } from '../schema';
import { runWithSession } from '../session-manager';
import { EvalQuiescenceError } from '../session-quiescence';

test('worker failure drains all other workers before propagating and never cleans between passes', async () => {
  const first = Promise.withResolvers<RunCaseResult>();
  const second = Promise.withResolvers<RunCaseResult>();
  const deps = {
    runWithSession,
    cleanEvalArtifacts: mock<typeof cleanEvalArtifacts>(() => {}),
    runCase: mock(async () => first.promise)
      .mockImplementationOnce(async () => first.promise)
      .mockImplementationOnce(async () => second.promise),
  };
  const suite = EvalSuiteSchema.parse({
    name: 'test',
    description: 'test',
    evals: ['one', 'two', 'never-start'].map((id) => ({ id, prompt: id })),
  });
  let settled = false;
  const collected = collectSuite(
    {
      suite,
      client: {} as EvalSessionClient,
      runs: 2,
      concurrency: 2,
      directory: '/checkout',
      outPath: '/unused.json',
      timeoutMs: 100,
    },
    deps,
  )
    .then(
      () => null,
      (error: unknown) => error,
    )
    .finally(() => {
      settled = true;
    });
  await tick();
  first.reject(new Error('first worker failed'));
  await tick();
  expect(settled).toBe(false);
  expect(deps.cleanEvalArtifacts).not.toHaveBeenCalled();
  second.reject(
    new EvalQuiescenceError(['eval-root'], 'second worker still busy'),
  );
  expect(await collected).toBeInstanceOf(EvalQuiescenceError);
  expect(deps.runCase).toHaveBeenCalledTimes(2);
  expect(deps.cleanEvalArtifacts).not.toHaveBeenCalled();
});
