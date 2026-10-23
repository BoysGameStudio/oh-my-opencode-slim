/**
 * Terminal-publication wake (bounded, idle-parent-only).
 *
 * OpenCode's native notifier delivers a child's FIRST completion to the
 * parent. When the parent is idle at a later terminal publication — a child
 * that self-continues and finishes again, or any publication while the
 * parent sits idle — nothing nudges the parent until the periodic 5-minute
 * idle evaluation. The publication wake closes that gap with the SAME
 * delivery machinery and wake gate as the periodic scheduler:
 *
 * - trigger: published completed|error + parent idle + no input wait +
 *   per-parent throttle window (publicationWakeMinIntervalMs, default 30s);
 * - skip: busy parent (native steer already delivered the completion);
 * - share: one-flight, the two-wake no-progress cap, expectingWakeBusy;
 * - thread: a publication flag through classifyChildrenSnapshot so an idle
 *   parent with no active children is not classified 'no-work' (the same
 *   trap triggerStoppedJobRecovery solves with its recovery flag).
 */
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from 'bun:test';
import * as loggerModule from '../../utils/logger';
import { createTimerHarness } from '../../utils/test-timers';
import { isVolatileTaggedMessage } from '../cache-safe-injection';
import { resetUserWaitGateForTests } from '../task-session-manager/user-wait-gate';
import {
  createOrchestratorWakeScheduler,
  formatCompletedJobDelta,
  formatStoppedJobDelta,
  ORCHESTRATOR_PUBLICATION_WAKE_TEXT,
  ORCHESTRATOR_WAKE_TEXT,
  PUBLICATION_WAKE_METADATA_KEY,
  WAKE_ANTI_FORGERY_TEXT,
} from './index';
import {
  getWakeProgress,
  resetOrchestratorWakeGateForTests,
} from './wake-gate';

type SessionClient = {
  get?: ReturnType<typeof mock>;
  todo?: ReturnType<typeof mock>;
  children?: ReturnType<typeof mock>;
  status?: ReturnType<typeof mock>;
  list?: ReturnType<typeof mock>;
  promptAsync?: ReturnType<typeof mock>;
};

function createClock() {
  let now = 0;
  let nextID = 1;
  const timers = new Map<number, { at: number; callback: () => void }>();

  const setTimeoutImpl = ((callback: () => void, delay?: number) => {
    const id = nextID++;
    timers.set(id, { at: now + (delay ?? 0), callback });
    const handle = {
      __id: id,
      unref() {
        return handle;
      },
    };
    return handle as unknown as ReturnType<typeof setTimeout>;
  }) as unknown as typeof setTimeout;

  const clearTimeoutImpl = ((handle: unknown) => {
    if (handle == null) return;
    const id =
      typeof handle === 'object' &&
      handle !== null &&
      '__id' in handle &&
      typeof (handle as { __id: unknown }).__id === 'number'
        ? (handle as { __id: number }).__id
        : Number(handle);
    timers.delete(id);
  }) as unknown as typeof clearTimeout;

  async function flushMicrotasks(times = 30): Promise<void> {
    for (let i = 0; i < times; i++) {
      await Promise.resolve();
    }
  }

  return {
    now: () => now,
    setTimeout: setTimeoutImpl,
    clearTimeout: clearTimeoutImpl,
    async advance(ms: number) {
      now += ms;
      for (let round = 0; round < 5; round++) {
        const due = [...timers.entries()]
          .filter(([, t]) => t.at <= now)
          .sort((a, b) => a[1].at - b[1].at);
        if (due.length === 0) break;
        for (const [id, timer] of due) {
          timers.delete(id);
          timer.callback();
        }
        await flushMicrotasks();
      }
      await flushMicrotasks();
    },
  };
}

/** v2-flavored session surface: list + promptAsync (get optional). */
function makeV2Client(overrides?: {
  listChildren?: Array<Record<string, unknown>>;
  promptAsync?: ReturnType<typeof mock>;
  get?: ReturnType<typeof mock>;
}): SessionClient {
  const client: SessionClient = {
    promptAsync: overrides?.promptAsync ?? mock(async () => ({})),
  };
  client.list = mock(async () => ({
    data: overrides?.listChildren ?? [],
  }));
  if (overrides?.get) client.get = overrides.get;
  return client;
}

/** v1 session surface: todo/children/status/get/promptAsync. */
function makeV1Client(overrides?: {
  todos?: Array<Record<string, unknown>>;
  childrenData?: Array<Record<string, unknown>>;
  statusData?: Record<string, unknown>;
  promptAsync?: ReturnType<typeof mock>;
}): SessionClient {
  return {
    get: mock(async () => ({
      data: {
        model: { providerID: 'test', id: 'model-a', variant: 'high' },
      },
    })),
    todo: mock(async () => ({
      data: overrides?.todos ?? [{ id: 't1', status: 'pending' }],
    })),
    children: mock(async () => ({
      data: overrides?.childrenData ?? [],
    })),
    status: mock(async () => ({ data: overrides?.statusData ?? {} })),
    promptAsync: overrides?.promptAsync ?? mock(async () => ({})),
  };
}

function createPublicationScheduler(options: {
  hostFlavor?: string;
  intervalMs?: number;
  wakeOnTerminalPublication?: boolean;
  periodicWakeEnabled?: boolean;
  publicationWakeMinIntervalMs?: number;
  sessionClient: SessionClient;
  shouldManageSession?: (id: string) => boolean;
  hasInputWait?: (id: string) => boolean;
  isFallbackInProgress?: (id: string) => boolean;
  onPublicationAccepted?: Parameters<
    typeof createOrchestratorWakeScheduler
  >[1]['onPublicationAccepted'];
  isPublicationCurrent?: Parameters<
    typeof createOrchestratorWakeScheduler
  >[1]['isPublicationCurrent'];
  setTimeout?: Parameters<
    typeof createOrchestratorWakeScheduler
  >[1]['setTimeout'];
  clearTimeout?: Parameters<
    typeof createOrchestratorWakeScheduler
  >[1]['clearTimeout'];
  now?: () => number;
}) {
  const ctx = {
    directory: '/project',
    client: { session: options.sessionClient },
    ...(options.hostFlavor ? { hostFlavor: options.hostFlavor } : {}),
  } as never;

  const scheduler = createOrchestratorWakeScheduler(ctx, {
    config: {
      enabled: true,
      intervalMs: options.intervalMs ?? 60_000,
      ...(options.wakeOnTerminalPublication === undefined
        ? {}
        : { wakeOnTerminalPublication: options.wakeOnTerminalPublication }),
      ...(options.periodicWakeEnabled === undefined
        ? {}
        : { periodicWakeEnabled: options.periodicWakeEnabled }),
      ...(options.publicationWakeMinIntervalMs === undefined
        ? {}
        : {
            publicationWakeMinIntervalMs: options.publicationWakeMinIntervalMs,
          }),
    },
    intervalMs: options.intervalMs ?? 60_000,
    shouldManageSession: options.shouldManageSession ?? (() => true),
    hasInputWait: options.hasInputWait ?? (() => false),
    isFallbackInProgress: options.isFallbackInProgress,
    ...(options.onPublicationAccepted
      ? { onPublicationAccepted: options.onPublicationAccepted }
      : {}),
    ...(options.isPublicationCurrent
      ? { isPublicationCurrent: options.isPublicationCurrent }
      : {}),
    ...(options.setTimeout ? { setTimeout: options.setTimeout } : {}),
    ...(options.clearTimeout ? { clearTimeout: options.clearTimeout } : {}),
    now: options.now ?? clock.now,
  });

  return { scheduler };
}

/** A terminal child entry as v2 session.list reports it post-completion. */
function terminalChild(id: string): Record<string, unknown> {
  return {
    id,
    parentID: 'p1',
    directory: '/project',
    outcome: 'succeeded',
    time: { updated: Date.now() },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}

function captureWakeLogs() {
  const entries: Array<{ message: string; data: Record<string, unknown> }> = [];
  const spy = spyOn(loggerModule, 'log').mockImplementation(
    (message: string, data?: unknown) => {
      entries.push({ message, data: (data ?? {}) as Record<string, unknown> });
    },
  );
  return {
    entries,
    restore: () => spy.mockRestore(),
    matching: (message: string) =>
      entries.filter(
        (entry) => entry.message === `[orchestrator-wake] ${message}`,
      ),
  };
}

const originalSetTimeout = globalThis.setTimeout;
const originalClearTimeout = globalThis.clearTimeout;
let clock = createClock();

beforeEach(() => {
  resetUserWaitGateForTests();
  resetOrchestratorWakeGateForTests();
  clock = createClock();
  globalThis.setTimeout = clock.setTimeout;
  globalThis.clearTimeout = clock.clearTimeout;
});

afterEach(() => {
  globalThis.setTimeout = originalSetTimeout;
  globalThis.clearTimeout = originalClearTimeout;
});

describe('terminal-publication wake', () => {
  function publicationIDs(promptAsync: ReturnType<typeof mock>, index: number) {
    const call = promptAsync.mock.calls[index]?.[0] as {
      body: { parts: Array<{ text: string }> };
    };
    return [
      ...call.body.parts
        .map((part) => part.text)
        .join('\n')
        .matchAll(
          /Later result: task_status \{ sessionID: "([^"]+)", result: true \}/g,
        ),
    ].map((match) => match[1]);
  }

  test('two completed children produce distinct, tagged trailing result pointers', async () => {
    const promptAsync = mock(async (_args: unknown) => ({}));
    const { scheduler } = createPublicationScheduler({
      hostFlavor: 'v2',
      now: clock.now,
      publicationWakeMinIntervalMs: 0,
      sessionClient: makeV2Client({
        promptAsync,
        listChildren: [terminalChild('child-1'), terminalChild('child-2')],
      }),
    });
    await scheduler.triggerTerminalPublicationWake('p1', 'child-1', 2);
    await scheduler.triggerTerminalPublicationWake('p1', 'child-2', 2);
    expect(promptAsync).toHaveBeenCalledTimes(2);
    expect(publicationIDs(promptAsync, 0)).toEqual(['child-1']);
    expect(publicationIDs(promptAsync, 1)).toEqual(['child-2']);
    for (const [call] of promptAsync.mock.calls) {
      const parts = (call as { body: { parts: unknown[] } }).body.parts;
      expect(
        isVolatileTaggedMessage(
          { info: { role: 'user' }, parts },
          PUBLICATION_WAKE_METADATA_KEY,
        ),
      ).toBe(true);
      expect((parts[0] as { text: string }).text).toStartWith(
        ORCHESTRATOR_PUBLICATION_WAKE_TEXT,
      );
    }
    expect(ORCHESTRATOR_PUBLICATION_WAKE_TEXT).not.toContain('child-1');
    expect(ORCHESTRATOR_PUBLICATION_WAKE_TEXT).not.toContain('child-2');
  });

  test('coalesced publications retain exactly both affected child IDs', async () => {
    const heldRead = deferred<{ data: Array<Record<string, unknown>> }>();
    const promptAsync = mock(async (_args: unknown) => ({}));
    const client = makeV2Client({ promptAsync });
    let reads = 0;
    client.list = mock(async () =>
      ++reads === 1 ? heldRead.promise : { data: [] },
    );
    const { scheduler } = createPublicationScheduler({
      hostFlavor: 'v2',
      now: clock.now,
      sessionClient: client,
    });
    const first = scheduler.triggerTerminalPublicationWake('p1', 'child-1', 2);
    await clock.advance(0);
    await scheduler.triggerTerminalPublicationWake('p1', 'child-2', 2);
    heldRead.resolve({
      data: [
        terminalChild('child-1'),
        terminalChild('child-2'),
        terminalChild('unaffected'),
      ],
    });
    await first;
    await clock.advance(0);
    expect(promptAsync).toHaveBeenCalledTimes(1);
    expect(publicationIDs(promptAsync, 0)).toEqual(['child-1', 'child-2']);
  });

  test('child deletion during evaluation cannot send an identity-less publication wake', async () => {
    const heldRead = deferred<{ data: Array<Record<string, unknown>> }>();
    const promptAsync = mock(async (_args: unknown) => ({}));
    const client = makeV2Client({ promptAsync });
    let reads = 0;
    client.list = mock(async () =>
      ++reads === 1 ? heldRead.promise : { data: [] },
    );
    const { scheduler } = createPublicationScheduler({
      hostFlavor: 'v2',
      now: clock.now,
      sessionClient: client,
    });
    const publication = scheduler.triggerTerminalPublicationWake(
      'p1',
      'child-1',
      2,
    );
    await clock.advance(0);
    await scheduler.event({
      event: { type: 'session.deleted', properties: { sessionID: 'child-1' } },
    });
    heldRead.resolve({ data: [] });
    await publication;
    await clock.advance(0);
    expect(promptAsync).not.toHaveBeenCalled();
  });

  test('SDK failure and input-wait coalescing retain both IDs for the timer retry', async () => {
    let fail = true;
    let waiting = false;
    const promptAsync = mock(async (_args: unknown) => {
      if (fail) throw new Error('transport down');
      return {};
    });
    const { scheduler } = createPublicationScheduler({
      hostFlavor: 'v2',
      now: clock.now,
      periodicWakeEnabled: false,
      hasInputWait: () => waiting,
      sessionClient: makeV2Client({ promptAsync }),
    });
    await scheduler.triggerTerminalPublicationWake('p1', 'child-1', 2);
    waiting = true;
    await scheduler.triggerTerminalPublicationWake('p1', 'child-2', 2);
    waiting = false;
    fail = false;
    await clock.advance(60_000);
    expect(promptAsync).toHaveBeenCalledTimes(2);
    expect(publicationIDs(promptAsync, 0)).toEqual(['child-1']);
    expect(publicationIDs(promptAsync, 1)).toEqual(['child-1', 'child-2']);
  });

  test.each(['child-2', 'child-1'])(
    '%s publishing during transport survives acceptance and throttling',
    async (nextChild) => {
      const heldSend = deferred<unknown>();
      const promptAsync = mock(async (_args: unknown) => {
        if (promptAsync.mock.calls.length === 1) return heldSend.promise;
        return {};
      });
      const { scheduler } = createPublicationScheduler({
        hostFlavor: 'v2',
        now: clock.now,
        periodicWakeEnabled: false,
        publicationWakeMinIntervalMs: 60_000,
        sessionClient: makeV2Client({ promptAsync }),
      });
      const first = scheduler.triggerTerminalPublicationWake(
        'p1',
        'child-1',
        2,
      );
      await clock.advance(0);
      expect(promptAsync).toHaveBeenCalledTimes(1);
      await scheduler.triggerTerminalPublicationWake('p1', nextChild, 3);
      heldSend.resolve({});
      await first;
      await clock.advance(0);
      expect(promptAsync).toHaveBeenCalledTimes(1);
      await clock.advance(60_000);
      expect(promptAsync).toHaveBeenCalledTimes(2);
      expect(publicationIDs(promptAsync, 0)).toEqual(['child-1']);
      expect(publicationIDs(promptAsync, 1)).toEqual([nextChild]);
      const second = promptAsync.mock.calls[1]?.[0] as {
        body: { parts: Array<{ metadata: { publications: unknown } }> };
      };
      expect(second.body.parts[0]?.metadata.publications).toEqual([
        { taskID: nextChild, generation: 3 },
      ]);
    },
  );

  test('a later terminal revision during transport retains its exact pointer and acknowledgement', async () => {
    const heldSend = deferred<unknown>();
    const accepted: Array<Record<string, unknown>> = [];
    let revision = 1;
    const promptAsync = mock(async (_args: unknown) =>
      promptAsync.mock.calls.length === 1 ? heldSend.promise : {},
    );
    const { scheduler } = createPublicationScheduler({
      hostFlavor: 'v2',
      periodicWakeEnabled: false,
      publicationWakeMinIntervalMs: 60_000,
      sessionClient: makeV2Client({ promptAsync }),
      isPublicationCurrent: (publication) =>
        publication.terminalRevision === revision,
      onPublicationAccepted: (publication) => accepted.push(publication),
    });

    const first = scheduler.triggerTerminalPublicationWake(
      'p1',
      'child-1',
      2,
      1,
    );
    await clock.advance(0);
    revision = 2;
    await scheduler.triggerTerminalPublicationWake('p1', 'child-1', 2, 2);
    heldSend.resolve({});
    await first;
    expect(accepted).toEqual([]);

    await clock.advance(60_000);
    expect(promptAsync).toHaveBeenCalledTimes(2);
    expect(publicationIDs(promptAsync, 1)).toEqual(['child-1']);
    const second = promptAsync.mock.calls[1]?.[0] as {
      body: { parts: unknown[] };
    };
    expect(second.body.parts[0]).toMatchObject({
      metadata: {
        publications: [
          { taskID: 'child-1', generation: 2, terminalRevision: 2 },
        ],
      },
    });
    expect(accepted).toEqual([
      {
        sessionID: 'p1',
        taskID: 'child-1',
        generation: 2,
        terminalRevision: 2,
      },
    ]);
  });

  test('a throttled second child is delivered after spacing even with periodic wakes off', async () => {
    const promptAsync = mock(async (_args: unknown) => ({}));
    const { scheduler } = createPublicationScheduler({
      hostFlavor: 'v2',
      now: clock.now,
      periodicWakeEnabled: false,
      publicationWakeMinIntervalMs: 60_000,
      sessionClient: makeV2Client({ promptAsync }),
    });
    await scheduler.triggerTerminalPublicationWake('p1', 'child-1', 2);
    await scheduler.triggerTerminalPublicationWake('p1', 'child-2', 2);
    expect(promptAsync).toHaveBeenCalledTimes(1);
    await clock.advance(60_000);
    expect(promptAsync).toHaveBeenCalledTimes(2);
    expect(publicationIDs(promptAsync, 1)).toEqual(['child-2']);
  });

  test.each([false, true])(
    'a failed publication retries after busy with periodic=%s',
    async (periodicWakeEnabled) => {
      let fail = true;
      const promptAsync = mock(async () => {
        if (fail) throw new Error('transport unavailable');
        return {};
      });
      const { scheduler } = createPublicationScheduler({
        hostFlavor: 'v2',
        periodicWakeEnabled,
        sessionClient: makeV2Client({
          promptAsync,
          listChildren: [terminalChild('child-1')],
        }),
      });
      await scheduler.triggerTerminalPublicationWake('p1', 'child-1', 2);
      expect(promptAsync).toHaveBeenCalledTimes(1);
      await scheduler.event({
        event: {
          type: 'session.status',
          properties: { sessionID: 'p1', status: { type: 'busy' } },
        },
      });
      fail = false;
      await scheduler.event({
        event: {
          type: 'session.status',
          properties: { sessionID: 'p1', status: { type: 'idle' } },
        },
      });
      await scheduler.event({
        event: { type: 'session.idle', properties: { sessionID: 'p1' } },
      });
      await clock.advance(60_000);
      expect(promptAsync).toHaveBeenCalledTimes(2);
      await clock.advance(60_000);
      expect(promptAsync).toHaveBeenCalledTimes(2);
    },
  );

  test.each(['input-wait', 'fallback-in-progress'] as const)(
    'G3a publication blocked by %s reports its task identity',
    async (reason) => {
      const capture = captureWakeLogs();
      try {
        const promptAsync = mock(async () => ({}));
        const { scheduler } = createPublicationScheduler({
          hostFlavor: 'v2',
          hasInputWait: () => reason === 'input-wait',
          isFallbackInProgress: () => reason === 'fallback-in-progress',
          sessionClient: makeV2Client({ promptAsync }),
        });
        await scheduler.triggerTerminalPublicationWake('p1', 'child-1', 2);
        expect(promptAsync).not.toHaveBeenCalled();
        expect(capture.matching('terminal publication wake skipped')).toEqual([
          {
            message: '[orchestrator-wake] terminal publication wake skipped',
            data: {
              sessionID: 'p1',
              taskID: 'child-1',
              generation: 2,
              trigger: 'terminal-publication',
              verdict: 'skipped',
              reason,
            },
          },
        ]);
      } finally {
        capture.restore();
      }
    },
  );

  test.each(['v1', 'v2'] as const)(
    'G1a %s: a timer-delivered publication retry consumes the throttle',
    async (flavor) => {
      const capture = captureWakeLogs();
      try {
        let fail = true;
        const promptAsync = mock(async () => {
          if (fail) throw new Error('transport unavailable');
          return {};
        });
        const { scheduler } = createPublicationScheduler({
          hostFlavor: flavor,
          publicationWakeMinIntervalMs: 3_600_000,
          sessionClient:
            flavor === 'v2'
              ? makeV2Client({
                  promptAsync,
                  listChildren: [
                    terminalChild('child-1'),
                    terminalChild('child-2'),
                  ],
                })
              : makeV1Client({
                  promptAsync,
                  todos: [{ id: 't1', status: 'completed' }],
                }),
        });
        await scheduler.triggerTerminalPublicationWake('p1', 'child-1', 1);
        expect(promptAsync).toHaveBeenCalledTimes(1);
        fail = false;
        await clock.advance(60_000);
        expect(promptAsync).toHaveBeenCalledTimes(2);

        await scheduler.triggerTerminalPublicationWake('p1', 'child-2', 1);
        expect(promptAsync).toHaveBeenCalledTimes(2);
        expect(
          capture.matching('terminal publication wake skipped'),
        ).toContainEqual({
          message: '[orchestrator-wake] terminal publication wake skipped',
          data: expect.objectContaining({
            taskID: 'child-2',
            generation: 1,
            reason: 'throttled',
          }),
        });
      } finally {
        capture.restore();
      }
    },
  );

  test.each(['v1', 'v2'] as const)(
    'G1b %s: a publication delivered by a one-flight waiter consumes the throttle',
    async (flavor) => {
      const capture = captureWakeLogs();
      try {
        const firstRead = deferred<{ data: Array<Record<string, unknown>> }>();
        const promptAsync = mock(async () => ({}));
        const client =
          flavor === 'v2'
            ? makeV2Client({ promptAsync })
            : makeV1Client({ promptAsync });
        let reads = 0;
        if (flavor === 'v2') {
          client.list = mock(async () => {
            if (++reads === 1) return firstRead.promise;
            return {
              data: [terminalChild('child-1'), terminalChild('child-2')],
            };
          });
        } else {
          client.todo = mock(async () => {
            if (++reads === 1) return firstRead.promise;
            return { data: [{ id: 't1', status: 'pending' }] };
          });
        }
        const { scheduler } = createPublicationScheduler({
          hostFlavor: flavor,
          publicationWakeMinIntervalMs: 3_600_000,
          sessionClient: client,
        });
        await scheduler.event({
          event: { type: 'session.idle', properties: { sessionID: 'p1' } },
        });
        await clock.advance(60_000);
        expect(reads).toBe(1);
        await scheduler.triggerTerminalPublicationWake('p1', 'child-1', 2);
        expect(promptAsync).not.toHaveBeenCalled();
        firstRead.resolve({ data: [] });
        await clock.advance(0);
        expect(promptAsync).toHaveBeenCalledTimes(1);

        await scheduler.triggerTerminalPublicationWake('p1', 'child-2', 2);
        expect(promptAsync).toHaveBeenCalledTimes(1);
        expect(
          capture.matching('terminal publication wake skipped'),
        ).toContainEqual({
          message: '[orchestrator-wake] terminal publication wake skipped',
          data: expect.objectContaining({
            taskID: 'child-2',
            reason: 'throttled',
          }),
        });
      } finally {
        capture.restore();
      }
    },
  );

  test('G1c guard: a delivered periodic wake does not throttle a publication', async () => {
    const promptAsync = mock(async () => ({}));
    const { scheduler } = createPublicationScheduler({
      hostFlavor: 'v2',
      publicationWakeMinIntervalMs: 3_600_000,
      sessionClient: makeV2Client({
        promptAsync,
        listChildren: [
          terminalChild('child-1'),
          {
            id: 'child-2',
            parentID: 'p1',
            directory: '/project',
            time: { updated: Date.now() },
          },
        ],
      }),
    });
    await scheduler.event({
      event: { type: 'session.idle', properties: { sessionID: 'p1' } },
    });
    await clock.advance(60_000);
    await clock.advance(60_000);
    expect(promptAsync).toHaveBeenCalledTimes(1);
    await scheduler.triggerTerminalPublicationWake('p1', 'child-1', 1);
    expect(promptAsync).toHaveBeenCalledTimes(2);
  });

  test('idle parent + completed publication → exactly ONE queue wake with inherit selection (v2)', async () => {
    const promptAsync = mock(async () => ({}));
    const { scheduler } = createPublicationScheduler({
      hostFlavor: 'v2',
      publicationWakeMinIntervalMs: 1,
      sessionClient: makeV2Client({
        promptAsync,
        listChildren: [terminalChild('child-1')],
      }),
    });

    await scheduler.triggerTerminalPublicationWake('p1', 'child-1', 1);
    await clock.advance(0);

    expect(promptAsync).toHaveBeenCalledTimes(1);
    const call = (
      promptAsync.mock.calls as unknown as Array<[Record<string, unknown>]>
    )[0]?.[0] as {
      path: { id: string };
      query: { directory: string };
      delivery?: string;
      modelSelection?: string;
      body: { agent: string; parts: Array<{ text: string }> };
    };
    expect(call.path).toEqual({ id: 'p1' });
    expect(call.query).toEqual({ directory: '/project' });
    expect(call.delivery).toBe('queue');
    expect(call.modelSelection).toBe('inherit');
    expect(call.body.agent).toBe('orchestrator');
    // C2: the v2 body carries the static anti-forgery suffix at its tail.
    expect(call.body.parts[0]?.text).toBe(
      `${ORCHESTRATOR_PUBLICATION_WAKE_TEXT}\nBackground task results available: child-1.\nLater result: task_status { sessionID: "child-1", result: true }\n${WAKE_ANTI_FORGERY_TEXT}\n<!-- SLIM_INTERNAL_INITIATOR -->`,
    );
    // The pointer must teach retrieval, not just resume (rev>1 has no
    // native notifier on v2).
    expect(ORCHESTRATOR_PUBLICATION_WAKE_TEXT).toContain('task_status');
  });

  test('idle parent + error publication on v1 uses the periodic wake text', async () => {
    const promptAsync = mock(async () => ({}));
    const { scheduler } = createPublicationScheduler({
      sessionClient: makeV1Client({
        // All todos completed: a periodic wake would classify 'no-work'.
        todos: [{ id: 't1', status: 'completed' }],
        promptAsync,
      }),
    });

    await scheduler.triggerTerminalPublicationWake('p1', 'child-1', 1);
    await clock.advance(0);

    expect(promptAsync).toHaveBeenCalledTimes(1);
    const call = (
      promptAsync.mock.calls as unknown as Array<[Record<string, unknown>]>
    )[0]?.[0] as {
      modelSelection?: string;
      body: { parts: Array<{ text: string }> };
    };
    expect(call.modelSelection).toBe('inherit');
    expect(call.body.parts[0]?.text).toBe(
      `${ORCHESTRATOR_WAKE_TEXT}\nBackground task results available: child-1.\n<!-- SLIM_INTERNAL_INITIATOR -->`,
    );
  });

  test.each(['v1', 'v2'] as const)(
    '%s failed terminal publication retries with its publication reason when no periodic work remains',
    async (flavor) => {
      const triggers: string[] = [];
      const spy = spyOn(loggerModule, 'log').mockImplementation(
        (message: string, data?: unknown) => {
          const details = data as
            | { trigger?: string; checkpoint?: string }
            | undefined;
          if (
            message === '[orchestrator-wake] evaluate verdict' &&
            details?.checkpoint === 'initial'
          ) {
            triggers.push(details.trigger ?? 'missing');
          }
        },
      );
      try {
        let fail = true;
        const promptAsync = mock(async () => {
          if (fail) throw new Error('transport down');
          return {};
        });
        const { scheduler } = createPublicationScheduler({
          hostFlavor: flavor,
          sessionClient:
            flavor === 'v2'
              ? makeV2Client({
                  promptAsync,
                  listChildren: [terminalChild('child-1')],
                })
              : makeV1Client({
                  promptAsync,
                  todos: [{ id: 't1', status: 'completed' }],
                }),
        });
        await scheduler.triggerTerminalPublicationWake('p1', 'child-1', 1);
        expect(promptAsync).toHaveBeenCalledTimes(1);
        fail = false;
        await clock.advance(60_000);
        expect(promptAsync).toHaveBeenCalledTimes(2);
        expect(getWakeProgress('p1').stopped).toBe(false);
        expect(triggers).toEqual(['publication', 'publication']);
      } finally {
        spy.mockRestore();
      }
    },
  );

  test('parent busy preserves the failed-publication retry for the next idle', async () => {
    let fail = true;
    const promptAsync = mock(async () => {
      if (fail) throw new Error('transport down');
      return {};
    });
    const { scheduler } = createPublicationScheduler({
      hostFlavor: 'v2',
      sessionClient: makeV2Client({
        promptAsync,
        listChildren: [terminalChild('child-1')],
      }),
    });
    await scheduler.triggerTerminalPublicationWake('p1', 'child-1', 1);
    expect(promptAsync).toHaveBeenCalledTimes(1);
    await scheduler.event({
      event: {
        type: 'session.status',
        properties: { sessionID: 'p1', status: { type: 'busy' } },
      },
    });
    await scheduler.event({
      event: {
        type: 'session.status',
        properties: { sessionID: 'p1', status: { type: 'idle' } },
      },
    });
    await scheduler.event({
      event: { type: 'session.idle', properties: { sessionID: 'p1' } },
    });
    fail = false;
    await clock.advance(120_000);
    expect(promptAsync).toHaveBeenCalledTimes(2);
  });

  test('a deleted parent cancels a failed-publication retry retained across busy', async () => {
    const promptAsync = mock(async () => {
      throw new Error('transport down');
    });
    const { scheduler } = createPublicationScheduler({
      hostFlavor: 'v2',
      sessionClient: makeV2Client({
        promptAsync,
        listChildren: [terminalChild('child-1')],
      }),
    });
    await scheduler.triggerTerminalPublicationWake('p1', 'child-1', 1);
    await scheduler.event({
      event: {
        type: 'session.status',
        properties: { sessionID: 'p1', status: { type: 'busy' } },
      },
    });
    await scheduler.event({
      event: { type: 'session.deleted', properties: { sessionID: 'p1' } },
    });
    await scheduler.event({
      event: {
        type: 'session.status',
        properties: { sessionID: 'p1', status: { type: 'idle' } },
      },
    });
    await scheduler.event({
      event: { type: 'session.idle', properties: { sessionID: 'p1' } },
    });
    await clock.advance(120_000);
    expect(promptAsync).toHaveBeenCalledTimes(1);
  });

  test('a delivered publication retry clears its reason before the next timer', async () => {
    let fail = true;
    const promptAsync = mock(async () => {
      if (fail) throw new Error('temporary transport failure');
      return {};
    });
    const { scheduler } = createPublicationScheduler({
      hostFlavor: 'v2',
      sessionClient: makeV2Client({
        promptAsync,
        listChildren: [terminalChild('child-1')],
      }),
    });
    await scheduler.triggerTerminalPublicationWake('p1', 'child-1', 1);
    fail = false;
    await clock.advance(60_000);
    expect(promptAsync).toHaveBeenCalledTimes(2);
    await clock.advance(60_000);
    expect(promptAsync).toHaveBeenCalledTimes(2);
  });

  test('a failed publication retained across busy is delivered after idle with periodic wakes disabled', async () => {
    // Repo timer harness: fully deterministic, no real delay. The scheduler
    // takes the timer seam directly so unrelated hooks that still schedule on
    // the global timers cannot enqueue work into this harness.
    const harness = createTimerHarness();
    let fail = true;
    const bodies: string[] = [];
    const promptAsync = mock(async (args: Record<string, unknown>) => {
      if (fail) throw new Error('transport down');
      const body = args.body as { parts?: Array<{ text?: string }> };
      bodies.push(body.parts?.[0]?.text ?? '');
      return {};
    });
    const accepted: Array<Record<string, unknown>> = [];
    const { scheduler } = createPublicationScheduler({
      hostFlavor: 'v2',
      intervalMs: 1_000,
      // The bug: the idle reschedule would take the periodic path, which
      // is disabled by default on v2 hosts, and drop the retained fact.
      periodicWakeEnabled: false,
      publicationWakeMinIntervalMs: 0,
      setTimeout: harness.setTimeout as unknown as Parameters<
        typeof createOrchestratorWakeScheduler
      >[1]['setTimeout'],
      clearTimeout: harness.clearTimeout as unknown as Parameters<
        typeof createOrchestratorWakeScheduler
      >[1]['clearTimeout'],
      sessionClient: makeV2Client({
        promptAsync,
        listChildren: [terminalChild('child-1')],
      }),
      onPublicationAccepted: (publication) => accepted.push(publication),
    });

    await scheduler.triggerTerminalPublicationWake('p1', 'child-1', 3, 4);
    await harness.tick();
    expect(promptAsync).toHaveBeenCalledTimes(1);
    expect(accepted).toHaveLength(0);

    // Busy bumps the generation and clears the generation-scoped retry
    // reason. The execution stays retained and must survive to idle.
    await scheduler.event({
      event: {
        type: 'session.status',
        properties: { sessionID: 'p1', status: { type: 'busy' } },
      },
    });
    await scheduler.event({
      event: {
        type: 'session.status',
        properties: { sessionID: 'p1', status: { type: 'idle' } },
      },
    });

    fail = false;
    await harness.advance(1_000);
    expect(promptAsync).toHaveBeenCalledTimes(2);
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toContain('Background task results available: child-1.');
    expect(accepted).toEqual([
      {
        sessionID: 'p1',
        taskID: 'child-1',
        generation: 3,
        terminalRevision: 4,
      },
    ]);

    // The periodic gate is still disabled: no extra idle evaluation runs.
    await harness.advance(1_000);
    expect(promptAsync).toHaveBeenCalledTimes(2);
  });

  test('late failure after busy cannot stamp a retry reason on the new generation', async () => {
    let rejectFirst: ((error: Error) => void) | undefined;
    const promptAsync = mock(() =>
      promptAsync.mock.calls.length > 1
        ? Promise.resolve({})
        : new Promise<unknown>((_resolve, reject) => {
            rejectFirst = reject;
          }),
    );
    const { scheduler } = createPublicationScheduler({
      hostFlavor: 'v2',
      sessionClient: makeV2Client({
        promptAsync,
        listChildren: [terminalChild('child-1')],
      }),
    });
    const publication = scheduler.triggerTerminalPublicationWake(
      'p1',
      'child-1',
      1,
    );
    await clock.advance(0);
    expect(promptAsync).toHaveBeenCalledTimes(1);
    await scheduler.event({
      event: {
        type: 'session.status',
        properties: { sessionID: 'p1', status: { type: 'busy' } },
      },
    });
    rejectFirst?.(new Error('late rejection'));
    await publication;
    // The failed attempt belongs to the pre-busy generation: it must not
    // stamp its reason on the new one.
    expect(
      scheduler._test.localSessions.get('p1')?.retryReason,
    ).toBeUndefined();
    await scheduler.event({
      event: {
        type: 'session.status',
        properties: { sessionID: 'p1', status: { type: 'idle' } },
      },
    });
    await scheduler.event({
      event: { type: 'session.idle', properties: { sessionID: 'p1' } },
    });
    await clock.advance(60_000);
    expect(promptAsync).toHaveBeenCalledTimes(2);
    expect(publicationIDs(promptAsync, 1)).toEqual(['child-1']);
  });

  test('P6b: repeated failed publications on an unchanged terminal snapshot keep the backstop alive', async () => {
    const promptAsync = mock(async () => {
      throw Object.assign(new Error(''), { name: 'Session.SomeError' });
    });
    const { scheduler } = createPublicationScheduler({
      hostFlavor: 'v2',
      intervalMs: 120_000,
      sessionClient: makeV2Client({
        promptAsync,
        listChildren: [
          terminalChild('child-a'),
          { id: 'child-b', time: { updated: Date.now() - 3_600_000 } },
        ],
      }),
    });
    await scheduler.event({
      event: { type: 'session.idle', properties: { sessionID: 'p1' } },
    });
    await scheduler.triggerTerminalPublicationWake('p1', 'child-a', 4);
    await clock.advance(40_000);
    await scheduler.triggerTerminalPublicationWake('p1', 'child-a', 5);
    for (let i = 0; i < 5; i++) {
      await clock.advance(120_000);
      expect(promptAsync).toHaveBeenCalledTimes(i + 3);
      expect(getWakeProgress('p1').stopped).toBe(false);
    }
  });

  test('throttle window blocks a second publication wake', async () => {
    const promptAsync = mock(async () => ({}));
    const { scheduler } = createPublicationScheduler({
      hostFlavor: 'v2',
      publicationWakeMinIntervalMs: 60_000,
      sessionClient: makeV2Client({
        promptAsync,
        listChildren: [terminalChild('child-1'), terminalChild('child-2')],
      }),
    });

    await scheduler.triggerTerminalPublicationWake('p1', 'child-1', 1);
    await clock.advance(0);
    expect(promptAsync).toHaveBeenCalledTimes(1);

    // A second publication inside the window must not wake again.
    await scheduler.triggerTerminalPublicationWake('p1', 'child-2', 1);
    await clock.advance(0);
    expect(promptAsync).toHaveBeenCalledTimes(1);
  });

  test('busy publication retains its execution until the timer lands', async () => {
    const promptAsync = mock(async () => ({}));
    const accepted: Array<Record<string, unknown>> = [];
    const { scheduler } = createPublicationScheduler({
      hostFlavor: 'v2',
      intervalMs: 1_000,
      publicationWakeMinIntervalMs: 1,
      sessionClient: makeV2Client({
        promptAsync,
        listChildren: [terminalChild('child-1')],
      }),
      onPublicationAccepted: (publication) => accepted.push(publication),
    });

    await scheduler.event({
      event: {
        type: 'session.status',
        properties: { sessionID: 'p1', status: { type: 'busy' } },
      },
    });
    await scheduler.triggerTerminalPublicationWake('p1', 'child-1', 3, 4);
    await clock.advance(0);
    expect(promptAsync).not.toHaveBeenCalled();
    expect(accepted).toHaveLength(0);

    await scheduler.event({
      event: {
        type: 'session.status',
        properties: { sessionID: 'p1', status: { type: 'idle' } },
      },
    });
    await clock.advance(1_000);
    expect(promptAsync).toHaveBeenCalledTimes(1);
    expect(accepted).toEqual([
      {
        sessionID: 'p1',
        taskID: 'child-1',
        generation: 3,
        terminalRevision: 4,
      },
    ]);
  });

  test('acknowledges only the publications named in the accepted body', async () => {
    const gate = deferred<void>();
    const bodies: string[] = [];
    const promptAsync = mock(async (args: Record<string, unknown>) => {
      const body = args.body as { parts?: Array<{ text?: string }> };
      bodies.push(body.parts?.[0]?.text ?? '');
      if (bodies.length === 1) await gate.promise;
      return {};
    });
    const accepted: Array<Record<string, unknown>> = [];
    const { scheduler } = createPublicationScheduler({
      hostFlavor: 'v2',
      intervalMs: 1_000,
      publicationWakeMinIntervalMs: 1_000,
      sessionClient: makeV2Client({
        promptAsync,
        listChildren: [terminalChild('child-a'), terminalChild('child-b')],
      }),
      onPublicationAccepted: (publication) => accepted.push(publication),
    });

    const first = scheduler.triggerTerminalPublicationWake(
      'p1',
      'child-a',
      1,
      1,
    );
    await clock.advance(0);
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toContain('child-a');
    expect(bodies[0]).not.toContain('child-b');
    expect(publicationIDs(promptAsync, 0)).toEqual(['child-a']);

    // B arrives while A's send is in flight: it was not covered by A's
    // body and must remain pending.
    const second = scheduler.triggerTerminalPublicationWake(
      'p1',
      'child-b',
      2,
      1,
    );
    await clock.advance(0);
    expect(bodies).toHaveLength(1);

    gate.resolve();
    await first;
    expect(accepted.map((entry) => entry.taskID)).toEqual(['child-a']);
    await second;

    await scheduler.event({
      event: {
        type: 'session.status',
        properties: { sessionID: 'p1', status: { type: 'idle' } },
      },
    });
    await clock.advance(1_000);
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toContain('child-b');
    expect(bodies[1]).not.toContain('child-a');
    expect(publicationIDs(promptAsync, 1)).toEqual(['child-b']);
    expect(accepted.map((entry) => entry.taskID)).toEqual([
      'child-a',
      'child-b',
    ]);
  });

  test('throttled publication is acknowledged only after its retry lands', async () => {
    const promptAsync = mock(async () => ({}));
    const accepted: Array<Record<string, unknown>> = [];
    const { scheduler } = createPublicationScheduler({
      hostFlavor: 'v2',
      intervalMs: 60_000,
      publicationWakeMinIntervalMs: 60_000,
      sessionClient: makeV2Client({
        promptAsync,
        listChildren: [terminalChild('child-1'), terminalChild('child-2')],
      }),
      onPublicationAccepted: (publication) => accepted.push(publication),
    });

    await scheduler.triggerTerminalPublicationWake('p1', 'child-1', 1, 1);
    await clock.advance(0);
    expect(promptAsync).toHaveBeenCalledTimes(1);
    expect(accepted.map((entry) => entry.taskID)).toEqual(['child-1']);

    await scheduler.triggerTerminalPublicationWake('p1', 'child-2', 2, 1);
    await clock.advance(0);
    expect(accepted.map((entry) => entry.taskID)).toEqual(['child-1']);

    await clock.advance(60_000);
    expect(promptAsync).toHaveBeenCalledTimes(2);
    expect(accepted.map((entry) => entry.taskID)).toEqual([
      'child-1',
      'child-2',
    ]);
  });

  test('a stale retained publication is dropped without acknowledgement', async () => {
    const promptAsync = mock(async () => ({}));
    const accepted: Array<Record<string, unknown>> = [];
    let current = false;
    const { scheduler } = createPublicationScheduler({
      hostFlavor: 'v2',
      intervalMs: 1_000,
      publicationWakeMinIntervalMs: 60_000,
      sessionClient: makeV2Client({
        promptAsync,
        listChildren: [terminalChild('child-1')],
      }),
      isPublicationCurrent: () => current,
      onPublicationAccepted: (publication) => accepted.push(publication),
    });

    await scheduler.event({
      event: {
        type: 'session.status',
        properties: { sessionID: 'p1', status: { type: 'busy' } },
      },
    });
    await scheduler.triggerTerminalPublicationWake('p1', 'child-1', 3, 4);
    await scheduler.event({
      event: {
        type: 'session.status',
        properties: { sessionID: 'p1', status: { type: 'idle' } },
      },
    });
    await clock.advance(1_000);
    expect(promptAsync).not.toHaveBeenCalled();
    expect(accepted).toHaveLength(0);

    current = true;
    await scheduler.triggerTerminalPublicationWake('p1', 'child-1', 5, 1);
    await clock.advance(0);
    expect(accepted.map((entry) => entry.generation)).toEqual([5]);
  });

  test('an empty stale batch gives back the wake reservation', async () => {
    const promptAsync = mock(async () => ({}));
    const accepted: Array<Record<string, unknown>> = [];
    let current = false;
    const { scheduler } = createPublicationScheduler({
      hostFlavor: 'v2',
      intervalMs: 1_000,
      publicationWakeMinIntervalMs: 1_000,
      sessionClient: makeV2Client({
        promptAsync,
        listChildren: [terminalChild('child-1')],
      }),
      isPublicationCurrent: () => current,
      onPublicationAccepted: (publication) => accepted.push(publication),
    });

    await scheduler.event({
      event: {
        type: 'session.status',
        properties: { sessionID: 'p1', status: { type: 'busy' } },
      },
    });
    await scheduler.triggerTerminalPublicationWake('p1', 'child-1', 3, 4);
    await scheduler.event({
      event: {
        type: 'session.status',
        properties: { sessionID: 'p1', status: { type: 'idle' } },
      },
    });
    await clock.advance(1_000);
    // Repeated stale attempts must not consume the no-progress cap.
    await scheduler.triggerTerminalPublicationWake('p1', 'child-1', 3, 4);
    await scheduler.triggerTerminalPublicationWake('p1', 'child-1', 3, 4);
    await scheduler.triggerTerminalPublicationWake('p1', 'child-1', 3, 4);

    current = true;
    await scheduler.triggerTerminalPublicationWake('p1', 'child-1', 5, 1);
    await clock.advance(0);
    expect(accepted.map((entry) => entry.generation)).toEqual([5]);
  });

  test('chunks overflow publications instead of evicting pending facts', async () => {
    const promptAsync = mock(async () => ({}));
    const accepted: Array<Record<string, unknown>> = [];
    const ids = Array.from({ length: 257 }, (_, index) => `child-${index}`);
    const { scheduler } = createPublicationScheduler({
      hostFlavor: 'v2',
      intervalMs: 1_000,
      publicationWakeMinIntervalMs: 1,
      sessionClient: makeV2Client({
        promptAsync,
        listChildren: ids.map((id) => terminalChild(id)),
      }),
      onPublicationAccepted: (publication) => accepted.push(publication),
    });

    await scheduler.event({
      event: {
        type: 'session.status',
        properties: { sessionID: 'p1', status: { type: 'busy' } },
      },
    });
    for (const id of ids) {
      await scheduler.triggerTerminalPublicationWake('p1', id, 1, 1);
    }
    expect(promptAsync).not.toHaveBeenCalled();

    await scheduler.event({
      event: {
        type: 'session.status',
        properties: { sessionID: 'p1', status: { type: 'idle' } },
      },
    });
    await clock.advance(1_000);
    expect(promptAsync).toHaveBeenCalledTimes(1);
    const first = (
      promptAsync.mock.calls as unknown as Array<[Record<string, unknown>]>
    )[0]?.[0] as { body: { parts: Array<{ text: string }> } };
    expect(first.body.parts[0]?.text).toContain(
      'Background task results available:',
    );
    expect(first.body.parts[0]?.text).toContain('child-0');
    expect(first.body.parts[0]?.text).not.toContain('child-256');
    expect(first.body.parts[0]?.text).toContain('1 more pending delivery.');
    expect(publicationIDs(promptAsync, 0)).toEqual(ids.slice(0, 256));
    expect(first.body.parts[0]).toMatchObject({
      metadata: {
        publications: ids.slice(0, 256).map((taskID) => ({
          taskID,
          generation: 1,
          terminalRevision: 1,
        })),
      },
    });
    expect(accepted).toHaveLength(256);

    await clock.advance(1_000);
    expect(promptAsync).toHaveBeenCalledTimes(2);
    const second = (
      promptAsync.mock.calls as unknown as Array<[Record<string, unknown>]>
    )[1]?.[0] as { body: { parts: Array<{ text: string }> } };
    expect(second.body.parts[0]?.text).toContain('child-256');
    expect(second.body.parts[0]?.text).not.toContain('more pending delivery');
    expect(publicationIDs(promptAsync, 1)).toEqual(['child-256']);
    expect(second.body.parts[0]).toMatchObject({
      metadata: {
        publications: [
          { taskID: 'child-256', generation: 1, terminalRevision: 1 },
        ],
      },
    });
    expect(accepted.map((entry) => entry.taskID)).toContain('child-256');
    expect(accepted).toHaveLength(257);
  });

  test('busy parent is skipped entirely (native steer already delivered)', async () => {
    const promptAsync = mock(async () => ({}));
    const { scheduler } = createPublicationScheduler({
      hostFlavor: 'v2',
      publicationWakeMinIntervalMs: 1,
      sessionClient: makeV2Client({
        promptAsync,
        listChildren: [terminalChild('child-1')],
      }),
    });

    await scheduler.event({
      event: {
        type: 'session.status',
        properties: { sessionID: 'p1', status: { type: 'busy' } },
      },
    });

    await scheduler.triggerTerminalPublicationWake('p1', 'child-1', 1);
    await clock.advance(0);
    expect(promptAsync).not.toHaveBeenCalled();
  });

  test('hasInputWait suppresses the publication wake', async () => {
    const promptAsync = mock(async () => ({}));
    const { scheduler } = createPublicationScheduler({
      hostFlavor: 'v2',
      publicationWakeMinIntervalMs: 1,
      hasInputWait: () => true,
      sessionClient: makeV2Client({
        promptAsync,
        listChildren: [terminalChild('child-1')],
      }),
    });

    await scheduler.triggerTerminalPublicationWake('p1', 'child-1', 1);
    await clock.advance(0);
    expect(promptAsync).not.toHaveBeenCalled();
  });

  test('input-wait suppression does not consume the throttle window', async () => {
    const promptAsync = mock(async () => ({}));
    let inputWait = true;
    const { scheduler } = createPublicationScheduler({
      hostFlavor: 'v2',
      // A wide window: the second publication below lands WELL inside it,
      // so it may only wake when the suppressed attempt burned nothing.
      publicationWakeMinIntervalMs: 60_000,
      hasInputWait: (id) => id === 'p1' && inputWait,
      sessionClient: makeV2Client({
        promptAsync,
        listChildren: [terminalChild('child-1'), terminalChild('child-2')],
      }),
    });

    // First publication while an input wait is open: suppressed.
    const suppressed = await scheduler.triggerTerminalPublicationWake(
      'p1',
      'child-1',
      1,
    );
    await clock.advance(0);
    expect(suppressed).toBe(false);
    expect(promptAsync).not.toHaveBeenCalled();

    // The wait clears; the very next publication still wakes: the
    // suppressed attempt must not have consumed the throttle window.
    inputWait = false;
    const delivered = await scheduler.triggerTerminalPublicationWake(
      'p1',
      'child-2',
      1,
    );
    await clock.advance(0);
    expect(delivered).toBe(true);
    expect(promptAsync).toHaveBeenCalledTimes(1);
  });

  test('evaluation vetoed mid-evaluate (SDK error) burns no throttle and logs no waking verdict', async () => {
    let failDelivery = true;
    const promptAsync = mock(async () => {
      if (failDelivery) throw new Error('sdk unavailable');
      return {};
    });
    const entries: Array<{ message: string; data: unknown }> = [];
    const spy = spyOn(loggerModule, 'log').mockImplementation(
      (message: string, data?: unknown) => {
        entries.push({ message, data });
      },
    );
    const { scheduler } = createPublicationScheduler({
      hostFlavor: 'v2',
      // A wide window: the second publication below lands WELL inside
      // it, so it may only wake when the vetoed evaluation burned
      // nothing.
      publicationWakeMinIntervalMs: 60_000,
      sessionClient: makeV2Client({
        promptAsync,
        listChildren: [terminalChild('child-1'), terminalChild('child-2')],
      }),
    });
    const wakingLogs = () =>
      entries.filter(
        (entry) =>
          entry.message === '[orchestrator-wake] terminal publication wake' &&
          (entry.data as { verdict?: string } | undefined)?.verdict ===
            'waking',
      );

    try {
      // First publication: canSchedule passes, but the evaluation is
      // vetoed at the delivery step (promptAsync rejects → the SDK
      // error no-delivery exit). Nothing may be logged or consumed.
      await scheduler.triggerTerminalPublicationWake('p1', 'child-1', 1);
      await clock.advance(0);
      expect(promptAsync).toHaveBeenCalledTimes(1);
      expect(wakingLogs()).toHaveLength(0);

      // Second publication well inside the 60s window: the vetoed
      // first attempt must not have consumed the throttle, and once the
      // transport recovers the wake delivers — logging exactly one
      // waking verdict.
      failDelivery = false;
      await scheduler.triggerTerminalPublicationWake('p1', 'child-2', 1);
      await clock.advance(0);
      expect(promptAsync).toHaveBeenCalledTimes(2);
      expect(wakingLogs()).toHaveLength(1);
    } finally {
      spy.mockRestore();
    }
  });

  test('no waking log unless a wake is actually delivered', async () => {
    const promptAsync = mock(async () => ({}));
    const entries: Array<{ message: string; data: unknown }> = [];
    const spy = spyOn(loggerModule, 'log').mockImplementation(
      (message: string, data?: unknown) => {
        entries.push({ message, data });
      },
    );
    let inputWait = true;
    const { scheduler } = createPublicationScheduler({
      hostFlavor: 'v2',
      publicationWakeMinIntervalMs: 60_000,
      hasInputWait: (id) => id === 'p1' && inputWait,
      sessionClient: makeV2Client({
        promptAsync,
        listChildren: [terminalChild('child-1')],
      }),
    });
    const wakingLogs = () =>
      entries.filter(
        (entry) =>
          entry.message === '[orchestrator-wake] terminal publication wake' &&
          (entry.data as { verdict?: string } | undefined)?.verdict ===
            'waking',
      );

    try {
      // Suppressed by the input wait: no wake may be logged as waking.
      await scheduler.triggerTerminalPublicationWake('p1', 'child-1', 1);
      await clock.advance(0);
      expect(wakingLogs()).toHaveLength(0);
      expect(promptAsync).not.toHaveBeenCalled();

      // Delivered once the wait clears: exactly one waking log line.
      inputWait = false;
      entries.length = 0;
      await scheduler.triggerTerminalPublicationWake('p1', 'child-1', 1);
      await clock.advance(0);
      expect(wakingLogs()).toHaveLength(1);
      expect(promptAsync).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });

  test('wakeOnTerminalPublication=false disables the wake', async () => {
    const promptAsync = mock(async () => ({}));
    const { scheduler } = createPublicationScheduler({
      hostFlavor: 'v2',
      wakeOnTerminalPublication: false,
      publicationWakeMinIntervalMs: 1,
      sessionClient: makeV2Client({
        promptAsync,
        listChildren: [terminalChild('child-1')],
      }),
    });

    await scheduler.triggerTerminalPublicationWake('p1', 'child-1', 1);
    await clock.advance(0);
    expect(promptAsync).not.toHaveBeenCalled();
  });

  test('shares the two-wake no-progress cap with the periodic scheduler', async () => {
    const promptAsync = mock(async () => ({}));
    const { scheduler } = createPublicationScheduler({
      hostFlavor: 'v2',
      // 0 disables the throttle so the shared cap is the only bound.
      publicationWakeMinIntervalMs: 0,
      sessionClient: makeV2Client({
        promptAsync,
        // Both children already terminal in every snapshot: the children
        // fingerprint never changes across the three publications below.
        listChildren: [terminalChild('child-1'), terminalChild('child-2')],
      }),
    });

    await scheduler.triggerTerminalPublicationWake('p1', 'child-1', 1);
    await clock.advance(0);
    expect(promptAsync).toHaveBeenCalledTimes(1);

    await scheduler.triggerTerminalPublicationWake('p1', 'child-2', 1);
    await clock.advance(0);
    expect(promptAsync).toHaveBeenCalledTimes(2);

    // Third publication, unchanged fingerprint: the shared cap must stop it.
    await scheduler.triggerTerminalPublicationWake('p1', 'child-1', 2);
    await clock.advance(0);
    expect(promptAsync).toHaveBeenCalledTimes(2);
  });

  test('publication flag threads the no-work classifier; periodic wakes stay suppressed', async () => {
    const promptAsync = mock(async () => ({}));
    const { scheduler } = createPublicationScheduler({
      hostFlavor: 'v2',
      intervalMs: 60_000,
      // 0 disables the throttle so only the classifier behavior is observed.
      publicationWakeMinIntervalMs: 0,
      sessionClient: makeV2Client({
        promptAsync,
        listChildren: [terminalChild('child-1')],
      }),
    });

    // Without the publication flag, an idle parent whose children are all
    // terminal classifies 'no-work' and the wake silently no-ops.
    await scheduler.triggerTerminalPublicationWake('p1', 'child-1', 1);
    await clock.advance(0);
    expect(promptAsync).toHaveBeenCalledTimes(1);

    // The periodic scheduler in the same state must NOT wake: the flag is
    // exclusive to the publication path.
    await clock.advance(60_000);
    await clock.advance(60_000);
    await clock.advance(60_000);
    expect(promptAsync).toHaveBeenCalledTimes(1);
  });

  test('completed-result pushes honor publication spacing and coalesce instead of dropping', async () => {
    // Repo timer harness on both seams: deterministic, no real delay.
    const harness = createTimerHarness();
    const bodies: string[] = [];
    const promptAsync = mock(async (args: Record<string, unknown>) => {
      const body = args.body as { parts?: Array<{ text?: string }> };
      bodies.push(body.parts?.[0]?.text ?? '');
      return {};
    });
    const { scheduler } = createPublicationScheduler({
      publicationWakeMinIntervalMs: 30_000,
      setTimeout: harness.setTimeout as unknown as Parameters<
        typeof createOrchestratorWakeScheduler
      >[1]['setTimeout'],
      clearTimeout: harness.clearTimeout as unknown as Parameters<
        typeof createOrchestratorWakeScheduler
      >[1]['clearTimeout'],
      now: harness.now,
      sessionClient: makeV1Client({
        todos: [],
        promptAsync,
        childrenData: [{ id: 'child-busy' }],
        statusData: { 'child-busy': { type: 'busy' } },
      }),
    });
    const push = (taskID: string, result: string) =>
      scheduler.triggerCompletedJobPublication(
        'p1',
        formatCompletedJobDelta({
          alias: taskID,
          taskID,
          state: 'completed',
          resultSummary: result,
        }),
        `${taskID}:2`,
        { taskID, generation: 2, terminalRevision: 3, state: 'completed' },
      );

    push('ses_a', 'result-a');
    await harness.tick();
    expect(promptAsync).toHaveBeenCalledTimes(1);

    // Inside the window: both results stay queued, no extra model turn.
    push('ses_b', 'result-b');
    await harness.tick();
    push('ses_c', 'result-c');
    await harness.tick();
    expect(promptAsync).toHaveBeenCalledTimes(1);

    await harness.advance(29_999);
    expect(promptAsync).toHaveBeenCalledTimes(1);

    // Window elapsed: ONE wake carries both deferred results.
    await harness.advance(1);
    expect(promptAsync).toHaveBeenCalledTimes(2);
    expect(bodies[1]).toContain('result: result-b');
    expect(bodies[1]).toContain('result: result-c');
    expect(bodies[1]).not.toContain('result-a');
  });

  test('results queued while a send is in flight are re-driven after an idle invalidates the flight', async () => {
    // Repo timer harness on both seams: deterministic, no real delay.
    const harness = createTimerHarness();
    const bodies: string[] = [];
    const sends: Array<ReturnType<typeof deferred<unknown>>> = [];
    const promptAsync = mock((args: Record<string, unknown>) => {
      const body = args.body as { parts?: Array<{ text?: string }> };
      bodies.push(body.parts?.[0]?.text ?? '');
      const send = deferred<unknown>();
      sends.push(send);
      return send.promise;
    });
    const { scheduler } = createPublicationScheduler({
      publicationWakeMinIntervalMs: 30_000,
      setTimeout: harness.setTimeout as unknown as Parameters<
        typeof createOrchestratorWakeScheduler
      >[1]['setTimeout'],
      clearTimeout: harness.clearTimeout as unknown as Parameters<
        typeof createOrchestratorWakeScheduler
      >[1]['clearTimeout'],
      now: harness.now,
      sessionClient: makeV1Client({
        todos: [],
        promptAsync,
        childrenData: [{ id: 'child-busy' }],
        statusData: { 'child-busy': { type: 'busy' } },
      }),
    });
    const push = (taskID: string, result: string) =>
      scheduler.triggerCompletedJobPublication(
        'p1',
        formatCompletedJobDelta({
          alias: taskID,
          taskID,
          state: 'completed',
          resultSummary: result,
        }),
        `${taskID}:2`,
        { taskID, generation: 2, terminalRevision: 3, state: 'completed' },
      );

    push('ses_a', 'result-a');
    await harness.tick();
    expect(promptAsync).toHaveBeenCalledTimes(1);

    // While the send is pending: two more results queue and the parent
    // reports idle. Both re-drives lose the one-flight race and wait behind
    // the committed send, which never releases its waiters.
    push('ses_b', 'result-b');
    push('ses_c', 'result-c');
    await scheduler.event({
      event: { type: 'session.idle', properties: { sessionID: 'p1' } },
    });
    await harness.tick();
    sends[0]?.resolve({});
    await harness.tick();
    expect(promptAsync).toHaveBeenCalledTimes(1);

    // The accepted send consumed the spacing window: the leftover results
    // are delivered together, once, when it elapses — not stranded.
    await harness.advance(30_000);
    expect(promptAsync).toHaveBeenCalledTimes(2);
    expect(bodies[1]).toContain('result: result-b');
    expect(bodies[1]).toContain('result: result-c');
    expect(bodies[1]).not.toContain('result-a');
    sends[1]?.resolve({});
    await harness.advance(30_000);
    expect(promptAsync).toHaveBeenCalledTimes(2);
  });

  test('a stop queued while a send is in flight is re-driven after an idle invalidates the flight', async () => {
    // Repo timer harness on both seams: deterministic, no real delay.
    const harness = createTimerHarness();
    const bodies: string[] = [];
    const sends: Array<ReturnType<typeof deferred<unknown>>> = [];
    const promptAsync = mock((args: Record<string, unknown>) => {
      const body = args.body as { parts?: Array<{ text?: string }> };
      bodies.push(body.parts?.[0]?.text ?? '');
      const send = deferred<unknown>();
      sends.push(send);
      return send.promise;
    });
    const { scheduler } = createPublicationScheduler({
      intervalMs: 60_000,
      setTimeout: harness.setTimeout as unknown as Parameters<
        typeof createOrchestratorWakeScheduler
      >[1]['setTimeout'],
      clearTimeout: harness.clearTimeout as unknown as Parameters<
        typeof createOrchestratorWakeScheduler
      >[1]['clearTimeout'],
      now: harness.now,
      sessionClient: makeV1Client({
        todos: [],
        promptAsync,
        childrenData: [{ id: 'child-busy' }],
        statusData: { 'child-busy': { type: 'busy' } },
      }),
    });
    const stop = (taskID: string, generation: number) =>
      scheduler.triggerStoppedJobRecovery(
        'p1',
        formatStoppedJobDelta({
          alias: taskID,
          taskID,
          generation,
          state: 'stopped',
          reason: 'stopped without a terminal result',
        }),
        `${taskID}:${generation}`,
      );

    stop('ses_a', 1);
    await harness.tick();
    expect(promptAsync).toHaveBeenCalledTimes(1);

    stop('ses_b', 2);
    await scheduler.event({
      event: { type: 'session.idle', properties: { sessionID: 'p1' } },
    });
    await harness.tick();
    sends[0]?.resolve({});
    await harness.tick();
    // No back-to-back prompt: after a commit a timer controls cadence.
    expect(promptAsync).toHaveBeenCalledTimes(1);

    await harness.advance(60_000);
    expect(promptAsync).toHaveBeenCalledTimes(2);
    expect(bodies[1]).toContain('task: ses_b');
    expect(bodies[1]).not.toContain('task: ses_a');
  });
});
