import { describe, expect, mock, test } from 'bun:test';
import type { PluginInput } from '@opencode-ai/plugin';
import { pendingForeignRead, readHostSessionInfo } from './session-info-read';

function inputWith(client: unknown): PluginInput {
  return { client, directory: '/proj' } as PluginInput;
}

describe('readHostSessionInfo', () => {
  test('shares one in-flight read per client and task', async () => {
    let resolveRead: (value: unknown) => void = () => {};
    const get = mock(
      () =>
        new Promise((resolve) => {
          resolveRead = resolve;
        }),
    );
    const input = inputWith({ session: { get } });
    const first = readHostSessionInfo(input, {
      taskID: 'ses_a',
      identity: 'same',
    });
    const second = readHostSessionInfo(input, {
      taskID: 'ses_a',
      identity: 'same',
    });
    await Promise.resolve();
    expect(get).toHaveBeenCalledTimes(1);
    resolveRead({ data: { ok: true } });
    expect(await first).toEqual({ data: { ok: true } });
    expect(await second).toEqual({ data: { ok: true } });
  });

  test('isolates clients that reuse the same task id', async () => {
    const a = mock(async () => ({ data: { from: 'a' } }));
    const b = mock(async () => ({ data: { from: 'b' } }));
    const first = readHostSessionInfo(inputWith({ session: { get: a } }), {
      taskID: 'ses_a',
      identity: 'same',
    });
    const second = readHostSessionInfo(inputWith({ session: { get: b } }), {
      taskID: 'ses_a',
      identity: 'same',
    });
    expect(await first).toEqual({ data: { from: 'a' } });
    expect(await second).toEqual({ data: { from: 'b' } });
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });

  test('a foreign waiter re-issues a fresh read after the occupant settles', async () => {
    let resolveFirst: (value: unknown) => void = () => {};
    const firstRead = new Promise((resolve) => {
      resolveFirst = resolve;
    });
    let calls = 0;
    const get = mock(() => {
      calls += 1;
      return calls === 1
        ? firstRead
        : Promise.resolve({ data: { second: true } });
    });
    const input = inputWith({ session: { get } });
    const first = readHostSessionInfo(input, {
      taskID: 'ses_a',
      identity: 'old',
    });
    await Promise.resolve();
    const chained = readHostSessionInfo(input, {
      taskID: 'ses_a',
      identity: 'new',
    });
    resolveFirst({ data: { first: true } });
    expect(await first).toEqual({ data: { first: true } });
    // The waiter receives only its own fresh read, never the occupant's
    // evidence, and the underlying reads stay serialized.
    expect(await chained).toEqual({ data: { second: true } });
    expect(get).toHaveBeenCalledTimes(2);
  });

  test('a foreign waiter re-issues fresh even when the occupant rejects', async () => {
    let rejectFirst: (error: Error) => void = () => {};
    const firstRead = new Promise((_resolve, reject) => {
      rejectFirst = reject;
    });
    let calls = 0;
    const get = mock(() => {
      calls += 1;
      return calls === 1
        ? firstRead
        : Promise.resolve({ data: { fresh: true } });
    });
    const input = inputWith({ session: { get } });
    const first = readHostSessionInfo(input, {
      taskID: 'ses_a',
      identity: 'old',
    });
    await Promise.resolve();
    const chained = readHostSessionInfo(input, {
      taskID: 'ses_a',
      identity: 'new',
    });
    rejectFirst(new Error('read failed'));
    await expect(first).rejects.toThrow('read failed');
    expect(await chained).toEqual({ data: { fresh: true } });
    expect(get).toHaveBeenCalledTimes(2);
  });

  test('two same-identity waiters share one fresh read behind a foreign occupant', async () => {
    let resolveFirst: (value: unknown) => void = () => {};
    const firstRead = new Promise((resolve) => {
      resolveFirst = resolve;
    });
    let calls = 0;
    const get = mock(() => {
      calls += 1;
      return calls === 1
        ? firstRead
        : Promise.resolve({ data: { fresh: true } });
    });
    const input = inputWith({ session: { get } });
    const occupant = readHostSessionInfo(input, {
      taskID: 'ses_a',
      identity: 'old',
    });
    await Promise.resolve();
    const waiterA = readHostSessionInfo(input, {
      taskID: 'ses_a',
      identity: 'new',
    });
    const waiterB = readHostSessionInfo(input, {
      taskID: 'ses_a',
      identity: 'new',
    });
    resolveFirst({ data: { first: true } });
    await occupant;
    expect(await waiterA).toEqual({ data: { fresh: true } });
    expect(await waiterB).toEqual({ data: { fresh: true } });
    // One fresh read coalesces both waiters.
    expect(get).toHaveBeenCalledTimes(2);
  });

  test('pendingForeignRead exposes only a foreign settle signal', async () => {
    let resolveRead: (value: unknown) => void = () => {};
    const get = mock(
      () =>
        new Promise((resolve) => {
          resolveRead = resolve;
        }),
    );
    const input = inputWith({ session: { get } });
    expect(
      pendingForeignRead(input, { taskID: 'ses_a', identity: 'x' }),
    ).toBeUndefined();
    void readHostSessionInfo(input, { taskID: 'ses_a', identity: 'x' });
    await Promise.resolve();
    // The registry coalesces the same identity; no foreign signal.
    expect(
      pendingForeignRead(input, { taskID: 'ses_a', identity: 'x' }),
    ).toBeUndefined();
    const wait = pendingForeignRead(input, { taskID: 'ses_a', identity: 'y' });
    expect(wait).toBeDefined();
    resolveRead({ data: {} });
    await wait;
    // Inside the continuation the slot is already free.
    expect(
      pendingForeignRead(input, { taskID: 'ses_a', identity: 'y' }),
    ).toBeUndefined();
  });

  test('resolves undefined when the host cannot read sessions', async () => {
    expect(
      await readHostSessionInfo(inputWith({ session: {} }), {
        taskID: 'ses_a',
        identity: 'same',
      }),
    ).toBeUndefined();
  });
});
