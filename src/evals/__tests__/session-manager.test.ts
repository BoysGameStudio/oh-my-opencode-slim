import { expect, mock, test } from 'bun:test';
import { tick } from '../../utils/test-timers';
import type { EvalSessionClient } from '../eval-client';
import type { pollSession } from '../polling-session';
import { runWithSession } from '../session-manager';
import { EvalQuiescenceError } from '../session-quiescence';

function fixture() {
  const promptAsync = mock<EvalSessionClient['session']['promptAsync']>(
    async () => ({}),
  );
  const client = {
    session: {
      create: mock(async () => ({ data: { id: 'eval-root' } })),
      promptAsync,
      messages: mock(async () => ({ data: [] })),
    },
  } as unknown as EvalSessionClient;
  const deps = {
    withTimeout: async <T>(
      promise: Promise<T>,
      _ms: number,
      _message: string,
    ) => promise,
    pollSession: mock<typeof pollSession>(async () => ({
      success: true,
      response: 'done',
      transcript: undefined,
      durationSecs: 0,
    })),
    stopEvalSessionTree: mock(
      async (
        _client: EvalSessionClient,
        _sid: string,
        _directory: string,
      ) => {},
    ),
  };
  const run = () =>
    runWithSession(
      client,
      'orchestrator',
      'prompt',
      'test',
      1,
      '/checkout',
      100,
      undefined,
      deps,
    );
  return { client, deps, run, promptAsync };
}

test('success is not published until the owned subtree has stopped', async () => {
  const { client, deps, run } = fixture();
  const stopped = Promise.withResolvers<void>();
  deps.stopEvalSessionTree.mockReturnValue(stopped.promise);
  let settled = false;
  const result = run().finally(() => {
    settled = true;
  });
  await tick();
  expect(settled).toBe(false);
  expect(deps.stopEvalSessionTree).toHaveBeenCalledWith(
    client,
    'eval-root',
    '/checkout',
  );
  stopped.resolve();
  expect((await result).success).toBe(true);
});

test('stall, timeout, and polling exceptions all stop the owned subtree', async () => {
  for (const reason of ['stalled', 'timed out', 'poll threw']) {
    const { deps, run } = fixture();
    if (reason === 'poll threw')
      deps.pollSession.mockRejectedValue(new Error(reason));
    else
      deps.pollSession.mockResolvedValue({
        success: false,
        response: '',
        transcript: undefined,
        error: reason,
        durationSecs: 0,
      });
    expect((await run()).success).toBe(false);
    expect(deps.stopEvalSessionTree).toHaveBeenCalledTimes(1);
  }
});

test('shutdown failure is fatal instead of an ordinary failed trial eligible for cleanup', async () => {
  const { deps, run } = fixture();
  deps.stopEvalSessionTree.mockRejectedValue(
    new EvalQuiescenceError(['eval-root'], 'still busy'),
  );
  await expect(run()).rejects.toBeInstanceOf(EvalQuiescenceError);
});

test('a timed-out pending prompt submission cannot be declared safe after abort', async () => {
  const { promptAsync, deps, run } = fixture();
  const dispatch = Promise.withResolvers<unknown>();
  promptAsync.mockReturnValue(dispatch.promise);
  deps.withTimeout = async <T>(
    promise: Promise<T>,
    _ms: number,
    message: string,
  ) => {
    if (message === 'Session prompt timed out')
      throw new Error('dispatch timed out');
    return promise;
  };
  await expect(run()).rejects.toThrow('Prompt submission was still pending');
  expect(deps.stopEvalSessionTree).toHaveBeenCalledTimes(1);
  dispatch.resolve({});
});

test('a prompt settling during shutdown does not bypass the fail-closed fence', async () => {
  const { promptAsync, deps, run } = fixture();
  const dispatch = Promise.withResolvers<unknown>();
  promptAsync.mockReturnValue(dispatch.promise);
  deps.withTimeout = async <T>(
    promise: Promise<T>,
    _ms: number,
    message: string,
  ) => {
    if (message === 'Session prompt timed out')
      throw new Error('dispatch timed out');
    return promise;
  };
  deps.stopEvalSessionTree.mockImplementation(async () => {
    dispatch.resolve({});
    await tick();
  });
  await expect(run()).rejects.toThrow('Prompt submission was still pending');
});

test('SDK prompt errors still stop the created session', async () => {
  const { promptAsync, deps, run } = fixture();
  promptAsync.mockResolvedValue({ error: 'rejected' });
  expect((await run()).success).toBe(false);
  expect(deps.stopEvalSessionTree).toHaveBeenCalledTimes(1);
});
