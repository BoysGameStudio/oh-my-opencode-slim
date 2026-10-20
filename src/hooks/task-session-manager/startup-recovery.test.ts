import { afterEach, describe, expect, mock, test } from 'bun:test';
import {
  BackgroundJobBoard,
  recordBackgroundJobSuppression,
} from '../../utils';
import {
  configureBackgroundJobPersistence,
  loadInitialBackgroundJobPersistence,
  markPersistedBackgroundChildDelivered,
  type PersistedBackgroundChild,
  persistedBackgroundChildren,
  recordPersistedBackgroundChild,
} from '../../utils/background-job-persistence';
import { tick } from '../../utils/test-timers';
import { buildPluginInput } from '../../v2/client-shim';
import { recoverSubagentSessionsAtStartup } from './session-recovery';

const PARENT = 'ses_parent';
const RUNNING = 'ses_running';
const DONE = 'ses_done';
const FOREGROUND = 'ses_foreground';

function launchText(taskID: string): string {
  return (
    `The subagent is working in the background (sessionID: ${taskID}). ` +
    'You will be notified automatically when it finishes.\n' +
    'DO NOT sleep, poll, or wait. Continue with other work.'
  );
}

function completedText(taskID: string): string {
  return `<subagent sessionID="${taskID}" state="completed">\nDone\n</subagent>`;
}

function deliveryMessage(
  taskID: string,
  at: number,
  state: 'completed' | 'error' | 'cancelled' = 'completed',
  metadata = true,
) {
  return {
    info: {
      id: `delivery-${taskID}`,
      role: 'assistant',
      time: { created: at },
    },
    parts: [
      {
        type: 'text',
        text:
          state === 'completed'
            ? completedText(taskID)
            : `<subagent sessionID="${taskID}" state="${state}">\nEnded\n</subagent>`,
        ...(metadata
          ? { metadata: { source: 'subagent', childID: taskID, state } }
          : {}),
      },
    ],
  };
}

function parentTranscript(
  entries: Array<{
    callID: string;
    sessionID: string;
    value: string;
    background?: boolean;
  }>,
): { data: unknown[] } {
  return {
    data: entries.flatMap(({ callID, sessionID, value, background }) => [
      {
        info: {
          id: `assistant-${callID}`,
          role: 'assistant',
          agent: 'orchestrator',
          time: { created: 10 },
        },
        parts: [
          {
            type: 'tool-call',
            toolCallId: callID,
            toolName: 'subagent',
            input: {
              agent: 'explorer',
              description: `delegated ${sessionID}`,
              prompt: 'find it',
              ...(background === true ? { background: true } : {}),
            },
          },
        ],
      },
      {
        info: { id: `tool-${callID}`, role: 'tool', time: { created: 11 } },
        parts: [
          {
            type: 'tool-result',
            toolCallId: callID,
            toolName: 'subagent',
            output: { type: 'text', value },
          },
        ],
      },
    ]),
  };
}

function runningChildTranscript(startedAt = 12): { data: unknown[] } {
  return {
    data: [
      {
        info: { id: 'u', role: 'user', time: { created: startedAt } },
        parts: [{ type: 'text', text: 'go' }],
      },
    ],
  };
}

function completedChildTranscript(text: string): { data: unknown[] } {
  return {
    data: [
      {
        info: { id: 'u', role: 'user', time: { created: 12 } },
        parts: [{ type: 'text', text: 'go' }],
      },
      {
        info: {
          id: 'a',
          role: 'assistant',
          finish: 'stop',
          time: { created: 13, completed: 15 },
        },
        parts: [{ type: 'text', text }],
      },
      {
        info: {
          id: 'idle',
          sourceType: 'idle',
          outcome: 'succeeded',
          time: { created: 14 },
        },
        parts: [],
      },
    ],
  };
}

function client(options: {
  sessions: Array<Record<string, unknown>>;
  parent: unknown;
  children?: Record<string, unknown>;
  childOutcome?: 'succeeded' | 'failed' | 'interrupted';
}) {
  return {
    session: {
      list: mock(async () => ({ data: options.sessions })),
      get: mock(async ({ path }: { path: { id: string } }) => ({
        data:
          path.id === PARENT
            ? { id: PARENT, agent: 'orchestrator' }
            : {
                id: path.id,
                parentID: PARENT,
                agent: 'explorer',
                ...(options.childOutcome
                  ? { outcome: options.childOutcome }
                  : {}),
              },
      })),
      messages: mock(async ({ path }: { path: { id: string } }) =>
        path.id === PARENT
          ? options.parent
          : (options.children?.[path.id] ?? { data: [] }),
      ),
      status: mock(async () => ({ data: {} })),
    },
  };
}

function input(options: Parameters<typeof client>[0]) {
  return {
    client: client(options) as never,
    directory: '/tmp',
    worktree: '/tmp',
  };
}

function memoryStorage(): {
  get(key: string): unknown;
  set(key: string, value: unknown): void;
  remove(key: string): void;
  scan(options: { prefix: string }): {
    entries: Array<{ key: string; value: unknown }>;
  };
} {
  const values = new Map<string, unknown>();
  return {
    get: (key) => values.get(key),
    set: (key, value) => {
      values.set(key, value);
    },
    remove: (key) => {
      values.delete(key);
    },
    scan: ({ prefix }) => ({
      entries: [...values.entries()]
        .filter(([key]) => key.startsWith(prefix))
        .map(([key, value]) => ({ key, value })),
    }),
  };
}

function persistedChild(
  taskID: string,
  overrides: Partial<PersistedBackgroundChild> = {},
): PersistedBackgroundChild {
  return {
    taskID,
    parentSessionID: PARENT,
    agent: 'explorer',
    description: `delegated ${taskID}`,
    launchedAt: 6,
    background: true,
    ...overrides,
  };
}

async function seedPersistence(
  storage: ReturnType<typeof memoryStorage>,
  children: PersistedBackgroundChild[],
): Promise<void> {
  configureBackgroundJobPersistence(storage);
  for (const child of children) {
    recordPersistedBackgroundChild(child);
    if (child.deliveredAt !== undefined) {
      markPersistedBackgroundChildDelivered(child.taskID, child.deliveredAt);
    }
  }
  await tick();
  await tick();
  configureBackgroundJobPersistence(storage);
  await loadInitialBackgroundJobPersistence();
}

afterEach(() => {
  configureBackgroundJobPersistence(undefined);
});

describe('startup subagent recovery', () => {
  test('adopts a running native background child without a parent transform', async () => {
    const board = new BackgroundJobBoard();
    const result = await recoverSubagentSessionsAtStartup({
      input: input({
        sessions: [
          { id: PARENT, agent: 'orchestrator' },
          { id: RUNNING, parentID: PARENT, agent: 'explorer' },
        ],
        parent: parentTranscript([
          {
            callID: 'call-running',
            sessionID: RUNNING,
            value: launchText(RUNNING),
          },
        ]),
        children: { [RUNNING]: runningChildTranscript() },
      }),
      backgroundJobBoard: board,
      hostFlavor: 'v2',
      shouldManageSession: () => false,
    });

    expect(result).toEqual([RUNNING]);
    expect(board.get(RUNNING)).toMatchObject({
      parentSessionID: PARENT,
      agent: 'explorer',
      background: true,
      state: 'running',
      externalOrigin: true,
      recoveredAtStartup: true,
    });
    expect(board.get(RUNNING)?.pluginLaunched).toBeUndefined();
  });

  test('is idempotent across repeated startup scans', async () => {
    const board = new BackgroundJobBoard();
    const options = {
      input: input({
        sessions: [
          { id: PARENT, agent: 'orchestrator' },
          { id: RUNNING, parentID: PARENT, agent: 'explorer' },
        ],
        parent: parentTranscript([
          {
            callID: 'call-running',
            sessionID: RUNNING,
            value: launchText(RUNNING),
          },
        ]),
        children: { [RUNNING]: runningChildTranscript() },
      }),
      backgroundJobBoard: board,
      hostFlavor: 'v2',
      shouldManageSession: () => false,
    };
    await recoverSubagentSessionsAtStartup(options);
    const generation = board.get(RUNNING)?.generation;
    const repeated = await recoverSubagentSessionsAtStartup(options);

    expect(repeated).toEqual([]);
    expect(board.get(RUNNING)?.generation).toBe(generation);
  });

  test('restores a child that completed during downtime and requests one wake', async () => {
    const board = new BackgroundJobBoard();
    const wakes: string[] = [];
    await seedPersistence(memoryStorage(), [persistedChild(DONE)]);
    const result = await recoverSubagentSessionsAtStartup({
      input: input({
        sessions: [
          { id: PARENT, agent: 'orchestrator' },
          {
            id: DONE,
            parentID: PARENT,
            agent: 'explorer',
            outcome: 'succeeded',
          },
        ],
        parent: parentTranscript([
          {
            callID: 'call-done',
            sessionID: DONE,
            value: completedText(DONE),
            background: true,
          },
        ]),
        children: { [DONE]: completedChildTranscript('Done') },
      }),
      backgroundJobBoard: board,
      hostFlavor: 'v2',
      shouldManageSession: () => false,
      onRecoveredTerminal: (parentSessionID, taskID) => {
        wakes.push(`${parentSessionID}:${taskID}`);
        return true;
      },
    });

    expect(result).toEqual([DONE]);
    expect(board.get(DONE)).toMatchObject({
      parentSessionID: PARENT,
      state: 'completed',
      externalOrigin: true,
    });
    expect(wakes).toEqual([`${PARENT}:${DONE}`]);
  });

  test('does not replay a terminal child whose outcome was delivered', async () => {
    const board = new BackgroundJobBoard();
    const wakes: string[] = [];
    await seedPersistence(memoryStorage(), [
      persistedChild(DONE, { deliveredAt: 20 }),
    ]);
    const result = await recoverSubagentSessionsAtStartup({
      input: input({
        sessions: [
          { id: PARENT, agent: 'orchestrator' },
          {
            id: DONE,
            parentID: PARENT,
            agent: 'explorer',
            outcome: 'succeeded',
          },
        ],
        parent: parentTranscript([]),
        children: { [DONE]: completedChildTranscript('Done') },
      }),
      backgroundJobBoard: board,
      hostFlavor: 'v2',
      shouldManageSession: () => false,
      onRecoveredTerminal: (parentSessionID, taskID) => {
        wakes.push(`${parentSessionID}:${taskID}`);
        return true;
      },
    });

    expect(result).toEqual([]);
    expect(board.get(DONE)).toBeUndefined();
    expect(wakes).toEqual([]);
  });

  test('treats a trusted delivery in parent history as already delivered', async () => {
    const storage = memoryStorage();
    const board = new BackgroundJobBoard();
    const wakes: string[] = [];
    await seedPersistence(storage, [persistedChild(DONE)]);
    const parent = parentTranscript([
      {
        callID: 'call-done',
        sessionID: DONE,
        value: launchText(DONE),
      },
    ]);
    parent.data.push(deliveryMessage(DONE, 20));

    const result = await recoverSubagentSessionsAtStartup({
      input: input({
        sessions: [
          { id: PARENT, agent: 'orchestrator' },
          { id: DONE, parentID: PARENT, agent: 'explorer' },
        ],
        parent,
        children: { [DONE]: completedChildTranscript('Done') },
      }),
      backgroundJobBoard: board,
      shouldManageSession: () => true,
      onRecoveredTerminal: (_parent, taskID) => {
        wakes.push(taskID);
        return true;
      },
    });

    expect(result).toEqual([]);
    expect(wakes).toEqual([]);
    expect(board.get(DONE)).toBeUndefined();
    expect(persistedBackgroundChildren().get(DONE)?.deliveredAt).toBe(20);
  });

  test('does not adopt a history-delivered child without persistence', async () => {
    const board = new BackgroundJobBoard();
    const wakes: string[] = [];
    const parent = parentTranscript([
      {
        callID: 'call-done',
        sessionID: DONE,
        value: launchText(DONE),
      },
    ]);
    parent.data.push(deliveryMessage(DONE, 20));

    const result = await recoverSubagentSessionsAtStartup({
      input: input({
        sessions: [
          { id: PARENT, agent: 'orchestrator' },
          { id: DONE, parentID: PARENT, agent: 'explorer' },
        ],
        parent,
        children: { [DONE]: completedChildTranscript('Done') },
      }),
      backgroundJobBoard: board,
      shouldManageSession: () => true,
      onRecoveredTerminal: (_parent, taskID) => {
        wakes.push(taskID);
        return true;
      },
    });

    expect(result).toEqual([]);
    expect(wakes).toEqual([]);
    expect(board.get(DONE)).toBeUndefined();
  });

  test('does not acknowledge a different launch fence', async () => {
    const storage = memoryStorage();
    await seedPersistence(storage, [persistedChild(DONE, { launchedAt: 6 })]);

    expect(markPersistedBackgroundChildDelivered(DONE, 30, 7)).toBe(false);
    expect(persistedBackgroundChildren().get(DONE)?.deliveredAt).toBe(
      undefined,
    );
  });

  test('an old or forged delivery does not suppress the current run', async () => {
    const storage = memoryStorage();
    const board = new BackgroundJobBoard();
    await seedPersistence(storage, [
      persistedChild(RUNNING, { launchedAt: 100 }),
    ]);
    const parent = parentTranscript([
      {
        callID: 'call-running',
        sessionID: RUNNING,
        value: launchText(RUNNING),
      },
    ]);
    parent.data.push(deliveryMessage(RUNNING, 20, 'completed', false));

    const result = await recoverSubagentSessionsAtStartup({
      input: input({
        sessions: [
          { id: PARENT, agent: 'orchestrator' },
          { id: RUNNING, parentID: PARENT, agent: 'explorer' },
        ],
        parent,
        children: { [RUNNING]: runningChildTranscript() },
      }),
      backgroundJobBoard: board,
      shouldManageSession: () => true,
      onRecoveredTerminal: () => true,
    });

    expect(result).toEqual([RUNNING]);
    expect(board.get(RUNNING)?.state).toBe('running');
    expect(persistedBackgroundChildren().get(RUNNING)?.deliveredAt).toBe(
      undefined,
    );
  });

  test('reads host outcome for a listed child that omits it', async () => {
    const storage = memoryStorage();
    const board = new BackgroundJobBoard();
    const wakes: string[] = [];
    await seedPersistence(storage, [persistedChild(DONE)]);
    const parent = parentTranscript([
      {
        callID: 'call-done',
        sessionID: DONE,
        value: launchText(DONE),
        background: true,
      },
    ]);

    const result = await recoverSubagentSessionsAtStartup({
      input: input({
        sessions: [
          { id: PARENT, agent: 'orchestrator' },
          { id: DONE, parentID: PARENT, agent: 'explorer' },
        ],
        parent,
        children: { [DONE]: { data: [] } },
        childOutcome: 'succeeded',
      }),
      backgroundJobBoard: board,
      shouldManageSession: () => true,
      onRecoveredTerminal: (_parent, taskID) => {
        wakes.push(taskID);
        return true;
      },
    });

    expect(result).toEqual([DONE]);
    expect(board.get(DONE)?.state).toBe('completed');
    expect(wakes).toEqual([DONE]);
  });

  test('corrects a running startup row once the child is terminal', async () => {
    const board = new BackgroundJobBoard();
    const wakes: string[] = [];
    const storage = memoryStorage();
    await seedPersistence(storage, [persistedChild(RUNNING)]);
    board.registerLaunch({
      taskID: RUNNING,
      parentSessionID: PARENT,
      agent: 'explorer',
      description: 'delegated',
      background: true,
      adopted: true,
      now: 0,
    });
    const result = await recoverSubagentSessionsAtStartup({
      input: input({
        sessions: [
          { id: PARENT, agent: 'orchestrator' },
          {
            id: RUNNING,
            parentID: PARENT,
            agent: 'explorer',
            outcome: 'succeeded',
          },
        ],
        parent: parentTranscript([]),
        children: { [RUNNING]: completedChildTranscript('Done') },
      }),
      backgroundJobBoard: board,
      hostFlavor: 'v2',
      shouldManageSession: () => false,
      onRecoveredTerminal: (parentSessionID, taskID) => {
        wakes.push(`${parentSessionID}:${taskID}`);
        return true;
      },
    });

    expect(result).toEqual([RUNNING]);
    expect(board.get(RUNNING)).toMatchObject({
      state: 'completed',
      resultSummary: 'Done',
    });
    expect(wakes).toEqual([`${PARENT}:${RUNNING}`]);
    await tick();
    await tick();
    configureBackgroundJobPersistence(storage);
    await loadInitialBackgroundJobPersistence();
    const restarted = new BackgroundJobBoard();
    const rerun = await recoverSubagentSessionsAtStartup({
      input: input({
        sessions: [
          { id: PARENT, agent: 'orchestrator' },
          {
            id: RUNNING,
            parentID: PARENT,
            agent: 'explorer',
            outcome: 'succeeded',
          },
        ],
        parent: parentTranscript([]),
        children: { [RUNNING]: completedChildTranscript('Done') },
      }),
      backgroundJobBoard: restarted,
      hostFlavor: 'v2',
      shouldManageSession: () => false,
      onRecoveredTerminal: (parentSessionID, taskID) => {
        wakes.push(`${parentSessionID}:${taskID}`);
        return true;
      },
    });
    expect(rerun).toEqual([]);
    expect(restarted.get(RUNNING)).toBeUndefined();
    expect(wakes).toEqual([`${PARENT}:${RUNNING}`]);
  });

  test('keeps an undelivered identity when a terminal wake is declined', async () => {
    const storage = memoryStorage();
    await seedPersistence(storage, [persistedChild(DONE)]);
    const scanInput = () =>
      input({
        sessions: [
          { id: PARENT, agent: 'orchestrator' },
          {
            id: DONE,
            parentID: PARENT,
            agent: 'explorer',
            outcome: 'succeeded',
          },
        ],
        parent: parentTranscript([]),
        children: { [DONE]: completedChildTranscript('Done') },
      });
    const firstBoard = new BackgroundJobBoard();
    await recoverSubagentSessionsAtStartup({
      input: scanInput(),
      backgroundJobBoard: firstBoard,
      hostFlavor: 'v2',
      shouldManageSession: () => false,
      onRecoveredTerminal: () => false,
    });

    expect(firstBoard.get(DONE)?.state).toBe('completed');
    expect(
      persistedBackgroundChildren().get(DONE)?.deliveredAt,
    ).toBeUndefined();

    await tick();
    await tick();
    configureBackgroundJobPersistence(storage);
    await loadInitialBackgroundJobPersistence();
    const restarted = new BackgroundJobBoard();
    let retried = 0;
    const result = await recoverSubagentSessionsAtStartup({
      input: scanInput(),
      backgroundJobBoard: restarted,
      hostFlavor: 'v2',
      shouldManageSession: () => false,
      onRecoveredTerminal: () => {
        retried += 1;
        return true;
      },
    });

    expect(result).toEqual([DONE]);
    expect(retried).toBe(1);
    expect(persistedBackgroundChildren().get(DONE)?.deliveredAt).toBeDefined();
  });

  test('keeps an undelivered identity when the terminal wake rejects', async () => {
    await seedPersistence(memoryStorage(), [persistedChild(DONE)]);
    const board = new BackgroundJobBoard();
    await recoverSubagentSessionsAtStartup({
      input: input({
        sessions: [
          { id: PARENT, agent: 'orchestrator' },
          {
            id: DONE,
            parentID: PARENT,
            agent: 'explorer',
            outcome: 'succeeded',
          },
        ],
        parent: parentTranscript([]),
        children: { [DONE]: completedChildTranscript('Done') },
      }),
      backgroundJobBoard: board,
      hostFlavor: 'v2',
      shouldManageSession: () => false,
      onRecoveredTerminal: async () => {
        throw new Error('transport failed');
      },
    });

    expect(board.get(DONE)?.state).toBe('completed');
    expect(
      persistedBackgroundChildren().get(DONE)?.deliveredAt,
    ).toBeUndefined();
  });

  test('keeps an undelivered identity when no wake callback is configured', async () => {
    await seedPersistence(memoryStorage(), [persistedChild(DONE)]);
    const board = new BackgroundJobBoard();
    await recoverSubagentSessionsAtStartup({
      input: input({
        sessions: [
          { id: PARENT, agent: 'orchestrator' },
          {
            id: DONE,
            parentID: PARENT,
            agent: 'explorer',
            outcome: 'succeeded',
          },
        ],
        parent: parentTranscript([]),
        children: { [DONE]: completedChildTranscript('Done') },
      }),
      backgroundJobBoard: board,
      hostFlavor: 'v2',
      shouldManageSession: () => false,
    });

    expect(board.get(DONE)?.state).toBe('completed');
    expect(
      persistedBackgroundChildren().get(DONE)?.deliveredAt,
    ).toBeUndefined();
  });

  test('marks delivery only after the accepted wake resolves', async () => {
    await seedPersistence(memoryStorage(), [persistedChild(DONE)]);
    let observedDuringWake: number | undefined;
    const board = new BackgroundJobBoard();
    await recoverSubagentSessionsAtStartup({
      input: input({
        sessions: [
          { id: PARENT, agent: 'orchestrator' },
          {
            id: DONE,
            parentID: PARENT,
            agent: 'explorer',
            outcome: 'succeeded',
          },
        ],
        parent: parentTranscript([]),
        children: { [DONE]: completedChildTranscript('Done') },
      }),
      backgroundJobBoard: board,
      hostFlavor: 'v2',
      shouldManageSession: () => false,
      onRecoveredTerminal: async () => {
        observedDuringWake =
          persistedBackgroundChildren().get(DONE)?.deliveredAt;
        return true;
      },
    });

    expect(observedDuringWake).toBeUndefined();
    expect(persistedBackgroundChildren().get(DONE)?.deliveredAt).toBeDefined();
  });

  test('clears the delivered marker on a new running generation', async () => {
    await seedPersistence(memoryStorage(), [
      persistedChild(DONE, { deliveredAt: 7 }),
    ]);
    const board = new BackgroundJobBoard();
    board.registerLaunch({
      taskID: DONE,
      parentSessionID: PARENT,
      agent: 'explorer',
      description: 'relaunched',
      background: true,
      now: 9,
    });

    expect(
      persistedBackgroundChildren().get(DONE)?.deliveredAt,
    ).toBeUndefined();
  });

  test('preserves a delivered marker when a running row is observed again', async () => {
    await seedPersistence(memoryStorage(), [persistedChild(RUNNING)]);
    const board = new BackgroundJobBoard();
    board.registerLaunch({
      taskID: RUNNING,
      parentSessionID: PARENT,
      agent: 'explorer',
      description: 'still running',
      background: true,
      now: 9,
    });
    markPersistedBackgroundChildDelivered(RUNNING, 12);
    board.registerLaunch({
      taskID: RUNNING,
      parentSessionID: PARENT,
      agent: 'explorer',
      description: 'still running',
      background: true,
      preserveRun: true,
      adopted: true,
      now: 10,
    });

    expect(persistedBackgroundChildren().get(RUNNING)?.deliveredAt).toBe(12);
  });

  test('rechecks the board after asynchronous classification', async () => {
    const board = new BackgroundJobBoard();
    let registered = false;
    const raceClient = {
      session: {
        list: async () => ({
          data: [
            { id: PARENT, agent: 'orchestrator' },
            { id: RUNNING, parentID: PARENT, agent: 'explorer' },
          ],
        }),
        get: async ({ path }: { path: { id: string } }) => ({
          data:
            path.id === PARENT
              ? { id: PARENT, agent: 'orchestrator' }
              : { id: path.id, parentID: PARENT, agent: 'explorer' },
        }),
        messages: async ({ path }: { path: { id: string } }) => {
          if (path.id === PARENT) {
            return parentTranscript([
              {
                callID: 'call-race',
                sessionID: RUNNING,
                value: launchText(RUNNING),
              },
            ]);
          }
          if (!registered) {
            registered = true;
            board.registerLaunch({
              taskID: RUNNING,
              parentSessionID: PARENT,
              agent: 'explorer',
              description: 'transform won the race',
              background: true,
              adopted: true,
              now: 1,
            });
          }
          return runningChildTranscript();
        },
      },
    };

    const result = await recoverSubagentSessionsAtStartup({
      input: {
        client: raceClient as never,
        directory: '/tmp',
        worktree: '/tmp',
      },
      backgroundJobBoard: board,
      hostFlavor: 'v2',
      shouldManageSession: () => false,
    });

    expect(result).toEqual([]);
    expect(board.get(RUNNING)).toMatchObject({
      state: 'running',
      recoveredAtStartup: true,
    });
  });

  test('adopts a delivered terminal child after it resumes as a live run', async () => {
    const storage = memoryStorage();
    await seedPersistence(storage, [
      persistedChild(RUNNING, { deliveredAt: 7 }),
    ]);
    const board = new BackgroundJobBoard();
    board.restoreRetainedSession({
      taskID: RUNNING,
      parentSessionID: PARENT,
      agent: 'explorer',
      description: 'delegated ses_running',
      state: 'completed',
      resultSummary: 'Done',
      background: true,
      launchedAt: 6,
    });
    board.markRunningFromLiveSession(RUNNING, 20);
    await tick();
    await tick();
    configureBackgroundJobPersistence(storage);
    await loadInitialBackgroundJobPersistence();

    const ctx = {
      location: {
        directory: '/tmp',
        project: {
          id: 'project',
          directory: '/tmp',
          canonical: '/tmp',
        },
      },
      session: {
        get: async ({ sessionID }: { sessionID: string }) => ({
          id: sessionID,
          parentID: PARENT,
          agent: 'explorer',
        }),
        context: async () => [
          {
            type: 'user',
            id: 'user-1',
            time: { created: 21 },
            content: [{ type: 'text', text: 'continue' }],
          },
        ],
      },
    };
    const pluginInput = buildPluginInput(ctx as never) as never;
    const freshBoard = new BackgroundJobBoard();
    const result = await recoverSubagentSessionsAtStartup({
      input: pluginInput,
      backgroundJobBoard: freshBoard,
      hostFlavor: 'v2',
      shouldManageSession: () => false,
    });

    expect(result).toEqual([RUNNING]);
    expect(freshBoard.get(RUNNING)).toMatchObject({
      state: 'running',
      recoveredAtStartup: true,
    });
  });

  test('does not let a prior delivery marker hide a new downtime round', async () => {
    const storage = memoryStorage();
    await seedPersistence(storage, [
      persistedChild(RUNNING, { launchedAt: 6, deliveredAt: 7 }),
    ]);
    const board = new BackgroundJobBoard();
    const result = await recoverSubagentSessionsAtStartup({
      input: input({
        sessions: [
          { id: PARENT, agent: 'orchestrator' },
          { id: RUNNING, parentID: PARENT, agent: 'explorer' },
        ],
        parent: { data: [] },
        children: { [RUNNING]: runningChildTranscript(21) },
      }),
      backgroundJobBoard: board,
      hostFlavor: 'v2',
      shouldManageSession: () => false,
    });

    expect(result).toEqual([RUNNING]);
    expect(board.get(RUNNING)).toMatchObject({
      state: 'running',
      recoveredAtStartup: true,
      launchedAt: 21,
    });
    expect(persistedBackgroundChildren().get(RUNNING)?.launchedAt).toBe(21);
    expect(
      persistedBackgroundChildren().get(RUNNING)?.deliveredAt,
    ).toBeUndefined();
  });

  test('does not adopt a v1 completed child with no persisted identity', async () => {
    const board = new BackgroundJobBoard();
    const result = await recoverSubagentSessionsAtStartup({
      input: input({
        sessions: [
          { id: PARENT, agent: 'orchestrator' },
          { id: DONE, parentID: PARENT, agent: 'explorer' },
        ],
        parent: {
          data: [
            {
              info: {
                id: 'assistant-v1',
                role: 'assistant',
                agent: 'orchestrator',
                time: { created: 10 },
              },
              parts: [
                {
                  type: 'tool',
                  tool: 'task',
                  state: {
                    input: {
                      subagent_type: 'explorer',
                      description: 'delegated',
                      prompt: 'find it',
                      background: true,
                    },
                    output: completedText(DONE),
                  },
                },
              ],
            },
          ],
        },
        children: { [DONE]: completedChildTranscript('Done') },
      }),
      backgroundJobBoard: board,
      hostFlavor: 'v1',
      shouldManageSession: () => false,
    });

    expect(result).toEqual([]);
    expect(board.get(DONE)).toBeUndefined();
  });

  test('recovers from persisted identity on a real v2 context without list', async () => {
    const storage = memoryStorage();
    await seedPersistence(storage, [persistedChild(RUNNING)]);
    const ctx = {
      location: {
        directory: '/tmp',
        project: {
          id: 'project',
          directory: '/tmp',
          canonical: '/tmp',
        },
      },
      session: {
        get: async ({ sessionID }: { sessionID: string }) => ({
          id: sessionID,
          parentID: PARENT,
          agent: 'explorer',
        }),
        context: async ({ sessionID }: { sessionID: string }) =>
          sessionID === RUNNING
            ? [
                {
                  type: 'user',
                  id: 'user-1',
                  time: { created: 12 },
                  content: [{ type: 'text', text: 'go' }],
                },
              ]
            : [],
      },
    };
    const pluginInput = buildPluginInput(ctx as never) as never;
    const board = new BackgroundJobBoard();
    const result = await recoverSubagentSessionsAtStartup({
      input: pluginInput,
      backgroundJobBoard: board,
      hostFlavor: 'v2',
      shouldManageSession: () => false,
    });

    expect(
      typeof (
        pluginInput as {
          client: { session: { list?: unknown } };
        }
      ).client.session.list,
    ).toBe('function');
    expect(result).toEqual([RUNNING]);
    expect(board.get(RUNNING)).toMatchObject({
      parentSessionID: PARENT,
      state: 'running',
      recoveredAtStartup: true,
    });
  });

  test('uses host session outcome for a persisted child without list', async () => {
    const storage = memoryStorage();
    await seedPersistence(storage, [persistedChild(DONE)]);
    const ctx = {
      location: {
        directory: '/tmp',
        project: {
          id: 'project',
          directory: '/tmp',
          canonical: '/tmp',
        },
      },
      session: {
        get: async ({ sessionID }: { sessionID: string }) => ({
          id: sessionID,
          parentID: PARENT,
          agent: 'explorer',
          outcome: 'succeeded',
        }),
        context: async () => [
          {
            type: 'user',
            id: 'user-1',
            time: { created: 12 },
            content: [{ type: 'text', text: 'go' }],
          },
        ],
      },
    };
    const pluginInput = buildPluginInput(ctx as never) as never;
    const board = new BackgroundJobBoard();
    const wakes: string[] = [];
    const result = await recoverSubagentSessionsAtStartup({
      input: pluginInput,
      backgroundJobBoard: board,
      hostFlavor: 'v2',
      shouldManageSession: () => false,
      onRecoveredTerminal: (_parentSessionID, taskID) => {
        wakes.push(taskID);
        return true;
      },
    });

    expect(result).toEqual([DONE]);
    expect(board.get(DONE)).toMatchObject({
      state: 'completed',
      resultSummary: 'The subagent ended during the plugin restart.',
    });
    expect(wakes).toEqual([DONE]);
  });

  test('does not expose live children without a storage backend', async () => {
    configureBackgroundJobPersistence(undefined);
    const stale = new BackgroundJobBoard();
    stale.registerLaunch({
      taskID: RUNNING,
      parentSessionID: PARENT,
      agent: 'explorer',
      description: 'stale launch',
      objective: 'stale launch',
      background: true,
      now: 1,
    });

    expect(persistedBackgroundChildren().size).toBe(0);
    const board = new BackgroundJobBoard();
    const result = await recoverSubagentSessionsAtStartup({
      input: input({
        sessions: [],
        parent: { data: [] },
        children: { [RUNNING]: runningChildTranscript() },
      }),
      backgroundJobBoard: board,
      hostFlavor: 'v2',
      shouldManageSession: () => false,
    });

    expect(result).toEqual([]);
    expect(board.get(RUNNING)).toBeUndefined();
  });

  test('excludes foreground, tombstoned, and unrelated children', async () => {
    const board = new BackgroundJobBoard();
    recordBackgroundJobSuppression(board, DONE);
    const result = await recoverSubagentSessionsAtStartup({
      input: input({
        sessions: [
          { id: PARENT, agent: 'orchestrator' },
          { id: RUNNING, parentID: PARENT, agent: 'explorer' },
          { id: DONE, parentID: PARENT, agent: 'explorer' },
          {
            id: FOREGROUND,
            parentID: PARENT,
            agent: 'explorer',
            outcome: 'succeeded',
          },
          { id: 'ses_orphan' },
        ],
        parent: parentTranscript([
          {
            callID: 'call-running',
            sessionID: RUNNING,
            value: launchText(RUNNING),
          },
          { callID: 'call-done', sessionID: DONE, value: launchText(DONE) },
          {
            callID: 'call-foreground',
            sessionID: FOREGROUND,
            value: completedText(FOREGROUND),
          },
        ]),
        children: {
          [RUNNING]: runningChildTranscript(),
          [DONE]: completedChildTranscript('Done'),
        },
      }),
      backgroundJobBoard: board,
      hostFlavor: 'v2',
      shouldManageSession: () => false,
    });

    expect(result).toEqual([RUNNING]);
    expect(board.get(DONE)).toBeUndefined();
    expect(board.get(FOREGROUND)).toBeUndefined();
    expect(board.get('ses_orphan')).toBeUndefined();
  });
});
