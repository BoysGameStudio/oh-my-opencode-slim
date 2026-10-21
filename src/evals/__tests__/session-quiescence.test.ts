import { expect, mock, test } from 'bun:test';
import { createTimerHarness, tick } from '../../utils/test-timers';
import type { EvalSessionClient } from '../eval-client';
import {
  EvalQuiescenceError,
  stopEvalSessionTree,
} from '../session-quiescence';

function fixture() {
  const timers = createTimerHarness();
  const session = {
    abort: mock<EvalSessionClient['session']['abort']>(async () => ({
      data: true,
    })),
    children: mock<EvalSessionClient['session']['children']>(async () => ({
      data: [],
    })),
    status: mock<EvalSessionClient['session']['status']>(async () => ({
      data: {},
    })),
  };
  const client = { session } as unknown as EvalSessionClient;
  const deps = {
    now: timers.now,
    sleep: timers.advance,
    withTimeout: async <T>(promise: Promise<T>) => promise,
  };
  return { session, client, deps };
}

test('does not report idle before the server acknowledges abort', async () => {
  const { session, client, deps } = fixture();
  const acknowledged = Promise.withResolvers<{ data: boolean }>();
  session.abort.mockReturnValueOnce(acknowledged.promise);
  let settled = false;
  const stopped = stopEvalSessionTree(
    client,
    'eval-root',
    '/checkout',
    deps,
  ).finally(() => {
    settled = true;
  });
  await tick();
  expect(settled).toBe(false);
  expect(session.status).not.toHaveBeenCalled();
  acknowledged.resolve({ data: true });
  await stopped;
  expect(settled).toBe(true);
});

test('only the owned root is aborted; unrelated busy sessions do not gate cleanup', async () => {
  const { session, client, deps } = fixture();
  session.status.mockResolvedValue({ data: { production: { type: 'busy' } } });
  await stopEvalSessionTree(client, 'eval-root', '/checkout', deps);
  expect(session.abort.mock.calls.map(([args]) => args.path.id)).toEqual([
    'eval-root',
    'eval-root',
  ]);
  for (const [args] of session.abort.mock.calls)
    expect(args.query.directory).toBe('/checkout');
  expect(session.status).toHaveBeenCalledTimes(2);
});

test('discovers and aborts late descendants before two stable idle scans', async () => {
  const { session, client, deps } = fixture();
  let childScans = 0;
  session.children.mockImplementation(async ({ path }) => {
    if (path.id === 'eval-root')
      return { data: [{ id: 'child', parentID: 'eval-root' }] };
    if (path.id === 'child' && ++childScans >= 2)
      return { data: [{ id: 'late-grandchild', parentID: 'child' }] };
    return { data: [] };
  });
  await stopEvalSessionTree(client, 'eval-root', '/checkout', deps);
  const aborted = session.abort.mock.calls.map(([args]) => args.path.id);
  expect(aborted[0]).toBe('eval-root');
  expect(aborted).toContain('child');
  expect(aborted.filter((id) => id === 'late-grandchild')).toHaveLength(2);
  expect(session.status.mock.calls.length).toBeGreaterThanOrEqual(4);
});

test('waits for a busy child to stop rather than trusting abort acceptance alone', async () => {
  const { session, client, deps } = fixture();
  session.children.mockImplementation(async ({ path }) => ({
    data:
      path.id === 'eval-root' ? [{ id: 'child', parentID: 'eval-root' }] : [],
  }));
  session.status.mockResolvedValueOnce({ data: { child: { type: 'busy' } } });
  await stopEvalSessionTree(client, 'eval-root', '/checkout', deps);
  expect(session.status).toHaveBeenCalledTimes(3);
  expect(
    session.abort.mock.calls.some(([args]) => args.path.id === 'child'),
  ).toBe(true);
});

test('rejected or false abort responses fail closed', async () => {
  for (const response of [
    { data: false },
    { error: 'abort unavailable' },
    {},
  ]) {
    const { session, client, deps } = fixture();
    session.abort.mockResolvedValue(response);
    await expect(
      stopEvalSessionTree(client, 'eval-root', '/checkout', deps),
    ).rejects.toBeInstanceOf(EvalQuiescenceError);
  }
});

test('an incomplete child listing or status response cannot establish quiescence', async () => {
  for (const stage of ['children', 'status'] as const) {
    const { session, client, deps } = fixture();
    session[stage].mockResolvedValue({ error: 'disconnected' });
    await expect(
      stopEvalSessionTree(client, 'eval-root', '/checkout', deps),
    ).rejects.toBeInstanceOf(EvalQuiescenceError);
  }
});

test('a mis-scoped children response never causes an unrelated abort', async () => {
  const { session, client, deps } = fixture();
  session.children.mockResolvedValue({
    data: [{ id: 'production', parentID: 'unrelated-parent' }],
  });
  await expect(
    stopEvalSessionTree(client, 'eval-root', '/checkout', deps),
  ).rejects.toThrow('Unverified child');
  expect(session.abort.mock.calls.map(([args]) => args.path.id)).toEqual([
    'eval-root',
  ]);
});

test('persistent busy state reaches a deterministic shutdown deadline', async () => {
  const { session, client, deps } = fixture();
  session.status.mockResolvedValue({ data: { 'eval-root': { type: 'busy' } } });
  await expect(
    stopEvalSessionTree(client, 'eval-root', '/checkout', deps),
  ).rejects.toThrow('shutdown deadline');
  expect(deps.now()).toBe(10_000);
});

test('request timeouts are fail-closed, not inferred idle', async () => {
  const { client, deps } = fixture();
  deps.withTimeout = async () => {
    throw new Error('request timed out');
  };
  await expect(
    stopEvalSessionTree(client, 'eval-root', '/checkout', deps),
  ).rejects.toThrow('request timed out');
});
