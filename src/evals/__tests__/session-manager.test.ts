import { expect, mock, test } from 'bun:test';
import { tick } from '../../utils/test-timers';
import type { EvalSessionClient } from '../eval-client';
import type { pollSession } from '../polling-session';
import { runWithSession } from '../session-manager';
import { EvalQuiescenceError } from '../session-quiescence';

type PromptResponse = Awaited<
  ReturnType<EvalSessionClient['session']['promptAsync']>
>;

function fixture() {
  const promptAsync = mock<EvalSessionClient['session']['promptAsync']>(
    async () => ({ response: new Response(null, { status: 204 }) }),
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
  const run = (prompt = 'prompt', agent = 'orchestrator') =>
    runWithSession(
      client,
      agent,
      prompt,
      'test',
      1,
      '/checkout',
      100,
      undefined,
      deps,
    );
  return { client, deps, run, promptAsync };
}

test('dispatch explicitly preserves the selected agent and mention parts', async () => {
  const cases: Array<{
    prompt: string;
    agent: string;
    expected: Parameters<
      EvalSessionClient['session']['promptAsync']
    >[0]['body'];
  }> = [
    {
      prompt: 'prompt',
      agent: 'orchestrator',
      expected: {
        parts: [{ type: 'text', text: 'prompt' }],
        agent: 'orchestrator',
      },
    },
    {
      prompt: '@FiXeR implement',
      agent: 'orchestrator',
      expected: {
        parts: [
          { type: 'agent', name: 'fixer' },
          { type: 'text', text: 'implement' },
        ],
        agent: 'fixer',
      },
    },
    {
      prompt: '@oracle',
      agent: 'orchestrator',
      expected: { parts: [{ type: 'agent', name: 'oracle' }], agent: 'oracle' },
    },
    {
      prompt: '@not-installed do work',
      agent: 'explorer',
      expected: {
        parts: [{ type: 'text', text: '@not-installed do work' }],
        agent: 'explorer',
      },
    },
  ];
  for (const entry of cases) {
    const { run, promptAsync } = fixture();
    await run(entry.prompt, entry.agent);
    expect(promptAsync.mock.calls[0][0].body).toEqual(entry.expected);
  }
});

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
  const dispatch = Promise.withResolvers<PromptResponse>();
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
  await expect(run()).rejects.toThrow('not positively acknowledged');
  expect(deps.stopEvalSessionTree).toHaveBeenCalledTimes(1);
  dispatch.resolve({});
});

test('a prompt settling during shutdown does not bypass the fail-closed fence', async () => {
  const { promptAsync, deps, run } = fixture();
  const dispatch = Promise.withResolvers<PromptResponse>();
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
    dispatch.resolve({ response: new Response(null, { status: 204 }) });
    await tick();
  });
  await expect(run()).rejects.toThrow('not positively acknowledged');
});

test('SDK prompt errors still stop the created session', async () => {
  const { promptAsync, deps, run } = fixture();
  promptAsync.mockResolvedValue({ error: 'rejected' });
  await expect(run()).rejects.toBeInstanceOf(EvalQuiescenceError);
  expect(deps.stopEvalSessionTree).toHaveBeenCalledTimes(1);
});

test('transport rejection remains unsafe when the host admits the prompt after idle scans', async () => {
  const { promptAsync, deps, run } = fixture();
  const admit = Promise.withResolvers<void>();
  let hostAdmitted = false;
  const admitted = admit.promise.then(() => {
    hostAdmitted = true;
  });
  promptAsync.mockRejectedValue(
    new Error('connection reset after request write'),
  );
  // The shutdown barrier succeeds before the server's delayed admission.
  deps.stopEvalSessionTree.mockResolvedValue();
  await expect(run()).rejects.toThrow('late admission remains possible');
  expect(deps.stopEvalSessionTree).toHaveBeenCalledTimes(1);
  expect(deps.pollSession).not.toHaveBeenCalled();
  expect(hostAdmitted).toBe(false);
  admit.resolve();
  await admitted;
  expect(hostAdmitted).toBe(true);
});

test('a fulfilled SDK promise without a positive HTTP acknowledgement remains unsafe', async () => {
  const { promptAsync, run } = fixture();
  promptAsync.mockResolvedValue({});
  await expect(run()).rejects.toBeInstanceOf(EvalQuiescenceError);
});
