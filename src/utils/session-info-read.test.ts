import { describe, expect, mock, test } from 'bun:test';
import type { PluginInput } from '@opencode-ai/plugin';
import { readHostSessionInfo } from './session-info-read';

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

  test('refuses a different identity while open, then frees on settle', async () => {
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
    await expect(
      readHostSessionInfo(input, { taskID: 'ses_a', identity: 'new' }),
    ).rejects.toThrow('still in flight');
    resolveFirst({ data: { first: true } });
    await first;
    // The slot frees only when the underlying read settles.
    await Promise.resolve();
    expect(
      await readHostSessionInfo(input, {
        taskID: 'ses_a',
        identity: 'new',
      }),
    ).toEqual({ data: { second: true } });
    expect(get).toHaveBeenCalledTimes(2);
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
