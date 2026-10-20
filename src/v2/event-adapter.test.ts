/**
 * Tests for the v2 → v1 event mapper.
 *
 * The synthesized v1 shapes here are pinned to what the v1 consumers
 * actually read:
 * - `session.created` early registration (task-session-manager
 *   event-router): `properties.info.{id,parentID,agent?}` — plugin
 *   relevance is gated on `info.parentID` (child sessions only).
 * - `message.updated` telemetry (cache-monitor parseCompletedAssistantMessage):
 *   `properties.info.{role:'assistant', sessionID, id, time.completed,
 *   tokens.input, tokens.cache.read, tokens.cache.write}`.
 */
import { describe, expect, test } from 'bun:test';
import { createCacheMonitorHook } from '../hooks/cache-monitor';
import { mapV2EventToV1 } from './event-adapter';

/**
 * Deterministic timer replacement (mirrors publication-wake.test.ts):
 * callbacks fire only on advance(), so scheduler timing assertions never
 * race real-clock jitter.
 */
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

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const key of Object.keys(value as object)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
}

function v2Usage(overrides: {
  input: number;
  read: number;
  write?: number;
  timestamp?: number;
}): Record<string, unknown> {
  return {
    type: 'session.usage.updated',
    properties: deepFreeze({
      sessionID: 'ses_map',
      ...(overrides.timestamp !== undefined
        ? { timestamp: overrides.timestamp }
        : {}),
      tokens: {
        input: overrides.input,
        output: 5,
        reasoning: 0,
        cache: { read: overrides.read, write: overrides.write ?? 0 },
      },
    }),
  };
}

/**
 * Plugin ctx for task-session-manager hooks built in this file. The
 * `client.session` stub (no `get`/`messages`) keeps the terminal gate's
 * reads inert by construction instead of relying on `{}` — a ctx without
 * `client` throws once another file's `mock.module` of
 * `utils/opencode-client` leaks into this one and dereferences
 * `ctx.client.session`.
 */
function createHookCtx(): never {
  return { client: { session: {} }, directory: '/tmp/proj' } as never;
}

describe('mapV2EventToV1', () => {
  test('passes unknown events through unchanged (raw reference first)', () => {
    const ev = { type: 'permission.asked', properties: { sessionID: 's' } };
    const out = mapV2EventToV1(ev);
    expect(out).toHaveLength(1);
    expect(out[0]).toBe(ev);
  });

  test('does not map session.retry.scheduled into a v1 retry status', () => {
    // Mapping it to session.status retry would reactivate the broken abort path.
    const event = {
      type: 'session.retry.scheduled',
      properties: { sessionID: 's' },
    };
    expect(mapV2EventToV1(event)).toEqual([event]);
  });

  test('v2.0.7 location.shutdown (config reload) stays passthrough-only', () => {
    // Ephemeral host event (payload under `data`, live framing) published
    // when `opencode reload` tears down and rebuilds every location.
    // Nothing is synthesized from it: raw passthrough, no throw, no v1
    // shape fabrication — v1 consumers ignore event types they do not
    // know, and plugin teardown rides the dispose chain instead.
    const ev = deepFreeze({
      id: 'evt_shutdown',
      created: '2026-09-18T00:00:00.000Z',
      type: 'location.shutdown',
      durable: false,
      data: {},
    });
    const out = mapV2EventToV1(ev);
    expect(out).toHaveLength(1);
    expect(out[0]).toBe(ev);
  });

  test('never mutates the input event', () => {
    const ev = deepFreeze(
      v2Usage({ input: 10, read: 100, write: 20, timestamp: 1_700_000_000 }),
    );
    expect(() => mapV2EventToV1(ev)).not.toThrow();
  });

  test('maps session.created with parentID into v1 early-registration shape', () => {
    const ev = {
      type: 'session.created',
      properties: { sessionID: 'child_1', parentID: 'parent_1', title: 't' },
    };
    const out = mapV2EventToV1(ev);
    expect(out).toHaveLength(2);
    expect(out[0]).toBe(ev);
    // Exact shape event-router reads: info.id + info.parentID gate the
    // early board registration; info.agent disambiguates parallel task
    // calls (absent here → omitted).
    expect(out[1]).toEqual({
      type: 'session.created',
      properties: { info: { id: 'child_1', parentID: 'parent_1', title: 't' } },
    });
  });

  test('passes agent through on session.created when the host provides it', () => {
    const out = mapV2EventToV1({
      type: 'session.created',
      properties: {
        sessionID: 'child_1',
        parentID: 'parent_1',
        agent: 'fixer',
      },
    });
    expect(out[1]).toEqual({
      type: 'session.created',
      properties: {
        info: { id: 'child_1', parentID: 'parent_1', agent: 'fixer' },
      },
    });
  });

  test('session.created without parentID stays passthrough-only', () => {
    // Root sessions are not plugin-relevant for early registration —
    // event-router gates on info.parentID, so no v1 shape is synthesized.
    expect(
      mapV2EventToV1({
        type: 'session.created',
        properties: { sessionID: 'root_1', title: 't' },
      }),
    ).toHaveLength(1);
  });

  test('maps usage telemetry into v1 message.updated shape for cache-monitor', () => {
    const out = mapV2EventToV1(v2Usage({ input: 10, read: 100, write: 20 }));
    expect(out).toHaveLength(2);
    // Exact field paths parseCompletedAssistantMessage reads. The id is a
    // deterministic fingerprint (v2 usage events carry no message id) so
    // replays and the step.ended/usage.updated pair for one request dedup.
    expect(out[1]).toEqual({
      type: 'message.updated',
      properties: {
        info: {
          id: 'v2-usage:ses_map:10:5:100:20',
          role: 'assistant',
          sessionID: 'ses_map',
          time: { completed: 0 },
          tokens: {
            input: 10,
            output: 5,
            reasoning: 0,
            cache: { read: 100, write: 20 },
          },
        },
      },
    });
  });

  test('maps session.step.ended telemetry with timestamp passthrough', () => {
    const out = mapV2EventToV1({
      type: 'session.step.ended',
      properties: {
        sessionID: 'ses_map',
        timestamp: 1_700_000_000,
        tokens: { input: 7, output: 3, cache: { read: 40, write: 5 } },
      },
    });
    expect(out[1]).toEqual({
      type: 'message.updated',
      properties: {
        info: {
          id: 'v2-usage:ses_map:7:3:40:5',
          role: 'assistant',
          sessionID: 'ses_map',
          time: { completed: 1_700_000_000 },
          tokens: {
            input: 7,
            output: 3,
            reasoning: 0,
            cache: { read: 40, write: 5 },
          },
        },
      },
    });
  });

  test('usage telemetry with incomplete tokens synthesizes nothing', () => {
    // Fail-open like the consumers: partial token blocks are dropped
    // rather than mapped into a shape cache-monitor would half-read.
    expect(
      mapV2EventToV1({
        type: 'session.usage.updated',
        properties: { sessionID: 's', tokens: { input: 10 } },
      }),
    ).toHaveLength(1);
    expect(
      mapV2EventToV1({
        type: 'session.usage.updated',
        properties: { sessionID: 's' },
      }),
    ).toHaveLength(1);
  });

  test('mapped message.updated feeds the real cache-monitor (bust warning fires)', async () => {
    const warnings: string[] = [];
    const monitor = createCacheMonitorHook({
      logger: (message) => warnings.push(message),
    });
    await monitor.event({
      event: mapV2EventToV1(v2Usage({ input: 8000, read: 0, write: 7000 }))[1],
    });
    await monitor.event({
      event: mapV2EventToV1(v2Usage({ input: 500, read: 9000 }))[1],
    });
    await monitor.event({
      event: mapV2EventToV1(v2Usage({ input: 12000, read: 0 }))[1],
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('prompt-cache bust');
  });

  test('raw session.status events stay passthrough-only', () => {
    const ev = deepFreeze({
      id: 'evt_status',
      created: 1_788_961_637_000,
      type: 'session.status',
      data: { sessionID: 'ses_status', status: { type: 'idle' } },
    });
    const out = mapV2EventToV1(ev);
    expect(out).toHaveLength(1);
    expect(out[0]).toBe(ev);
  });
});

describe('mapV2EventToV1 session.execution.* lifecycle synthesis', () => {
  // v2 hosts publish durable
  // session.execution.* events and stream no busy/idle
  // session.status — these tests pin the synthesized v1 lifecycle shapes
  // the wake scheduler / task-session-manager / fallback consumers read.
  test('execution.started synthesizes v1 busy session.status', () => {
    const ev = deepFreeze({
      type: 'session.execution.started',
      properties: { sessionID: 'ses_exec' },
    });
    const out = mapV2EventToV1(ev);
    expect(out).toHaveLength(2);
    expect(out[0]).toBe(ev);
    expect(out[1]).toEqual({
      type: 'session.status',
      properties: { sessionID: 'ses_exec', status: { type: 'busy' } },
    });
  });

  test('execution.succeeded synthesizes idle session.status + session.idle', () => {
    const ev = deepFreeze({
      type: 'session.execution.succeeded',
      properties: { sessionID: 'ses_exec' },
    });
    const out = mapV2EventToV1(ev);
    expect(out).toHaveLength(3);
    expect(out[0]).toBe(ev);
    expect(out[1]).toEqual({
      type: 'session.status',
      properties: { sessionID: 'ses_exec', status: { type: 'idle' } },
    });
    expect(out[2]).toEqual({
      type: 'session.idle',
      properties: { sessionID: 'ses_exec' },
    });
  });

  test('execution.interrupted synthesizes the same idle pair as succeeded', () => {
    const out = mapV2EventToV1({
      type: 'session.execution.interrupted',
      properties: { sessionID: 'ses_exec', reason: 'user cancel' },
    });
    expect(out).toHaveLength(3);
    expect(out.slice(1)).toEqual([
      {
        type: 'session.status',
        properties: { sessionID: 'ses_exec', status: { type: 'idle' } },
      },
      { type: 'session.idle', properties: { sessionID: 'ses_exec' } },
    ]);
  });

  test.each([
    ['succeeded', ['session.status', 'session.idle']],
    ['interrupted', ['session.status', 'session.idle']],
    ['failed', ['session.error', 'session.status', 'session.idle']],
  ] as const)(
    'execution.%s stamps every synthesized terminal event with envelope `created` in exact order',
    (subtype, expectedTypes) => {
      const created = 1_788_961_638_000;
      const ev = deepFreeze({
        id: `evt_terminal_${subtype}`,
        created,
        type: `session.execution.${subtype}`,
        data: { sessionID: 'ses_exec' },
      });
      const out = mapV2EventToV1(ev);
      expect(out.map((mapped) => mapped.type)).toEqual([
        `session.execution.${subtype}`,
        ...expectedTypes,
      ]);
      expect(out[0]).toBe(ev);
      expect(out[out.length - 2]).toEqual({
        type: 'session.status',
        properties: {
          sessionID: 'ses_exec',
          status: { type: 'idle' },
          activityAt: created,
        },
      });
      // Every synthesized event from the terminal envelope carries the
      // same host activity boundary. A companion without it would fall
      // back to local receipt time and could act on a newer run.
      for (const synthesized of out.slice(1)) {
        expect(
          (synthesized as { properties: Record<string, unknown> }).properties,
        ).toMatchObject({ activityAt: created });
      }
      expect(out[out.length - 1]).toEqual({
        type: 'session.idle',
        properties: { sessionID: 'ses_exec', activityAt: created },
      });
    },
  );

  test.each([
    ['succeeded', ['session.status', 'session.idle']],
    ['interrupted', ['session.status', 'session.idle']],
    ['failed', ['session.error', 'session.status', 'session.idle']],
  ] as const)(
    'execution.%s without a usable envelope `created` omits activityAt in exact order',
    (subtype, expectedTypes) => {
      const missing = Symbol('missing');
      for (const created of [
        missing,
        undefined,
        null,
        'nope',
        -1,
        Number.NaN,
        Number.POSITIVE_INFINITY,
      ]) {
        const ev: Record<string, unknown> = {
          id: `evt_terminal_${subtype}`,
          type: `session.execution.${subtype}`,
          data: { sessionID: 'ses_exec' },
        };
        if (created !== missing) ev.created = created;
        const out = mapV2EventToV1(ev);
        expect(out.map((mapped) => mapped.type)).toEqual([
          `session.execution.${subtype}`,
          ...expectedTypes,
        ]);
        for (const synthesized of out.slice(1)) {
          expect(
            Object.hasOwn(
              (synthesized as { properties: Record<string, unknown> })
                .properties,
              'activityAt',
            ),
          ).toBe(false);
        }
        const status = out[out.length - 2];
        expect(status).toEqual({
          type: 'session.status',
          properties: {
            sessionID: 'ses_exec',
            status: { type: 'idle' },
          },
        });
      }
    },
  );

  test('execution.failed emits v1 session.error (host error verbatim) before the idle pair', () => {
    const ev = deepFreeze({
      type: 'session.execution.failed',
      properties: {
        sessionID: 'ses_exec',
        error: { message: 'rate limited', statusCode: 429 },
      },
    });
    const out = mapV2EventToV1(ev);
    expect(out).toHaveLength(4);
    expect(out[0]).toBe(ev);
    // Error-before-idle: the event-router's deferred-inline-error flow
    // expects the error first and terminalizes on the following idle.
    expect(out[1]).toEqual({
      type: 'session.error',
      properties: {
        sessionID: 'ses_exec',
        error: { message: 'rate limited', statusCode: 429 },
      },
    });
    expect(out[2]).toEqual({
      type: 'session.status',
      properties: { sessionID: 'ses_exec', status: { type: 'idle' } },
    });
    expect(out[3]).toEqual({
      type: 'session.idle',
      properties: { sessionID: 'ses_exec' },
    });
  });

  test('execution.failed without an error field degrades to a best-effort message', async () => {
    const out = mapV2EventToV1({
      type: 'session.execution.failed',
      properties: { sessionID: 'ses_exec' },
    });
    expect(out[1]).toEqual({
      type: 'session.error',
      properties: {
        sessionID: 'ses_exec',
        error: { message: 'v2 session execution failed' },
      },
    });
    // The fallback message must NOT classify as a failover error.
    const { isFailoverError } = await import('../hooks/foreground-fallback');
    expect(
      isFailoverError(
        (out[1] as { properties: { error: unknown } }).properties.error,
      ),
    ).toBe(false);
  });

  test('execution events without a sessionID synthesize nothing', () => {
    for (const type of [
      'session.execution.started',
      'session.execution.succeeded',
      'session.execution.failed',
      'session.execution.interrupted',
    ]) {
      expect(mapV2EventToV1({ type, properties: {} })).toHaveLength(1);
    }
  });

  test('unrelated session.execution.* subtypes stay passthrough-only', () => {
    // Only the four verified subtypes map; an unknown variant must not
    // guess a lifecycle meaning.
    const ev = deepFreeze({
      type: 'session.execution.resumed',
      properties: { sessionID: 'ses_exec' },
    });
    expect(mapV2EventToV1(ev)).toEqual([ev]);
  });

  test('synthesized lifecycle pair feeds the real task-session-manager busy path', async () => {
    // End-to-end against the consumer: the synthesized busy status must
    // mark a tracked child running-from-live-session on the board.
    const { createTaskSessionManagerHook } = await import(
      '../hooks/task-session-manager'
    );
    const { BackgroundJobBoard } = await import('../utils');
    const board = new BackgroundJobBoard();
    const hook = createTaskSessionManagerHook(createHookCtx(), {
      maxSessionsPerAgent: 2,
      backgroundJobBoard: board,
      shouldManageSession: (id: string) => id === 'parent-1',
    });
    board.registerLaunch({
      taskID: 'child-1',
      parentSessionID: 'parent-1',
      agent: 'fixer',
      description: 'exec lifecycle e2e',
      now: 0,
    });
    for (const mapped of mapV2EventToV1({
      type: 'session.execution.started',
      properties: { sessionID: 'child-1' },
    })) {
      await hook.event({ event: mapped });
    }
    // Busy observation landed: lastLiveBusyAt recorded on the running job.
    expect(board.get('child-1')).toMatchObject({ state: 'running' });
    expect(board.get('child-1')?.lastLiveBusyAt).toBeDefined();
  });
});

describe('mapV2EventToV1 live wire shape (payload under `data`)', () => {
  // Live v2 hosts deliver plugin/SSE events as
  // `{id, created, type, location?, durable?, metadata?, data}` with the
  // payload always under `data`. The `properties`
  // spelling used by the tests above is the legacy fallback. These tests
  // pin the live-observed shapes end-to-end through the exact wake-arming
  // chain: execution.succeeded → idle pair → beginContinuousIdle, and
  // session.created → child registration.
  function liveEvent(
    type: string,
    data: Record<string, unknown>,
  ): Record<string, unknown> {
    return deepFreeze({
      id: `evt_${type.replace(/\./g, '_')}`,
      created: 1_788_961_637_000,
      type,
      durable: { aggregateID: data.sessionID ?? 'agg', seq: 1, version: 1 },
      data,
    });
  }

  test('live execution.succeeded synthesizes the v1 idle pair from `data`', () => {
    const ev = liveEvent('session.execution.succeeded', {
      sessionID: 'ses_live',
    });
    const out = mapV2EventToV1(ev);
    expect(out).toHaveLength(3);
    expect(out[0]).toBe(ev);
    expect(out.slice(1)).toEqual([
      {
        type: 'session.status',
        properties: {
          sessionID: 'ses_live',
          status: { type: 'idle' },
          activityAt: 1_788_961_637_000,
        },
      },
      {
        type: 'session.idle',
        properties: {
          sessionID: 'ses_live',
          activityAt: 1_788_961_637_000,
        },
      },
    ]);
  });

  test('live execution.started synthesizes v1 busy from `data`', () => {
    const out = mapV2EventToV1(
      liveEvent('session.execution.started', { sessionID: 'ses_live' }),
    );
    expect(out.slice(1)).toEqual([
      {
        type: 'session.status',
        properties: {
          sessionID: 'ses_live',
          status: { type: 'busy' },
          activityAt: 1_788_961_637_000,
        },
      },
    ]);
  });

  test.each([0, 1_788_961_637_000])(
    'live execution.started preserves a valid envelope `created` as activityAt: %d',
    (created) => {
      const ev = {
        ...liveEvent('session.execution.started', { sessionID: 'ses_live' }),
        created,
      };
      const out = mapV2EventToV1(ev);
      expect(out[0]).toBe(ev);
      expect(out[1]).toEqual({
        type: 'session.status',
        properties: {
          sessionID: 'ses_live',
          status: { type: 'busy' },
          activityAt: created,
        },
      });
    },
  );

  test.each([
    undefined,
    null,
    'nope',
    -1,
    Number.NaN,
    Number.POSITIVE_INFINITY,
  ])(
    'live execution.started without a usable `created` synthesizes no receipt time: %j',
    (created) => {
      const ev = {
        ...liveEvent('session.execution.started', { sessionID: 'ses_live' }),
        created,
      };
      const out = mapV2EventToV1(ev);
      expect(out[1]).toEqual({
        type: 'session.status',
        properties: { sessionID: 'ses_live', status: { type: 'busy' } },
      });
    },
  );

  test('live session.created (flat `data` fields incl. parentID) maps to the v1 early-registration shape', () => {
    // Shape captured from a live v2 host: a subagent child
    // session.created with data.parentID linking it to the orchestrator.
    const out = mapV2EventToV1(
      liveEvent('session.created', {
        sessionID: 'ses_child',
        projectID: 'prj_1',
        location: { directory: '/tmp/proj' },
        subpath: '',
        parentID: 'ses_parent',
        slug: 'playful-orchid',
        title: 'live child detection',
        agent: 'general',
        version: '2.0.2',
      }),
    );
    expect(out).toHaveLength(2);
    expect(out[1]).toEqual({
      type: 'session.created',
      properties: {
        info: {
          id: 'ses_child',
          parentID: 'ses_parent',
          title: 'live child detection',
          agent: 'general',
        },
      },
    });
  });

  test('live usage.updated telemetry maps to message.updated from `data`', () => {
    const out = mapV2EventToV1(
      liveEvent('session.usage.updated', {
        sessionID: 'ses_live',
        cost: 0,
        tokens: {
          input: 1,
          output: 1,
          reasoning: 0,
          cache: { read: 0, write: 0 },
        },
      }),
    );
    expect(out).toHaveLength(2);
    expect(out[1]).toEqual({
      type: 'message.updated',
      properties: {
        info: {
          id: 'v2-usage:ses_live:1:1:0:0',
          role: 'assistant',
          sessionID: 'ses_live',
          time: { completed: 0 },
          tokens: {
            input: 1,
            output: 1,
            reasoning: 0,
            cache: { read: 0, write: 0 },
          },
        },
      },
    });
  });

  test('live-shape wake chain end-to-end: idle arms the real wake scheduler with a tracked child', async () => {
    // The exact live-observed break: raw `data`-keyed events must reach
    // the v1 consumers. Arm the real scheduler with the synthesized idle
    // for a managed orchestrator whose child was registered from a live
    // session.created, then advance a fake clock past the interval and
    // require the queued v2 wake prompt.
    const { createOrchestratorWakeScheduler } = await import(
      '../hooks/orchestrator-wake'
    );
    const { resetOrchestratorWakeGateForTests } = await import(
      '../hooks/orchestrator-wake/wake-gate'
    );
    // The wake gate is process-global (Symbol.for): a prior test file that
    // tripped the two-wake no-progress cap for this session id leaks into
    // this run. Reset it so arming state starts clean.
    resetOrchestratorWakeGateForTests();
    const prompted: Array<Record<string, unknown>> = [];
    const sessionSdk = {
      list: async (args: Record<string, unknown>) => {
        // In-process v2 hosts expose no session.list → shim-level honest
        // empty page; the event-tracked fallback must cover enumeration.
        void args;
        return { data: [] };
      },
      promptAsync: async (args: Record<string, unknown>) => {
        prompted.push(args);
        return {};
      },
    };
    // Children-driven periodic wakes are a STALLED-child watchdog with a
    // real-time staleness bound (intervalMs * CHILD_STALENESS_INTERVALS).
    // Real setTimeout jitter made the second evaluation race that bound —
    // deterministic only under a fake clock, where the child's evidence can
    // never go stale mid-test. Mirrors publication-wake.test.ts's clock.
    const realSetTimeout = globalThis.setTimeout;
    const realClearTimeout = globalThis.clearTimeout;
    const clock = createClock();
    globalThis.setTimeout = clock.setTimeout;
    globalThis.clearTimeout = clock.clearTimeout;
    try {
      const scheduler = createOrchestratorWakeScheduler(
        {
          client: { session: sessionSdk },
          directory: '/tmp/proj',
          hostFlavor: 'v2',
        } as never,
        {
          config: {
            enabled: true,
            intervalMs: 10,
            periodicWakeEnabled: true,
            mode: 'children',
          },
          shouldManageSession: (id: string) => id === 'ses_parent',
          hasInputWait: () => false,
          intervalMs: 10,
        },
      );
      // The exact mapped events feed the scheduler; the busy pair from the
      // child's execution.started must be recorded BEFORE the parent's idle
      // arms the periodic timer (the children fingerprint needs both).
      for (const mapped of mapV2EventToV1(
        liveEvent('session.created', {
          sessionID: 'ses_child',
          parentID: 'ses_parent',
          slug: 's',
          version: 'v',
        }),
      )) {
        await scheduler.event({ event: mapped as never });
      }
      for (const mapped of mapV2EventToV1(
        liveEvent('session.execution.started', { sessionID: 'ses_child' }),
      )) {
        await scheduler.event({ event: mapped as never });
      }
      for (const mapped of mapV2EventToV1(
        liveEvent('session.execution.succeeded', { sessionID: 'ses_parent' }),
      )) {
        await scheduler.event({ event: mapped as never });
      }
      // First tick: the fresh child classifies as progressing, the periodic
      // wake defers to establish its baseline, and the scheduler re-arms.
      await clock.advance(10);
      expect(prompted.length).toBe(0);
      // Second tick: unchanged fingerprint → the stalled-child wake commits
      // and fires as a queued v2 prompt.
      await clock.advance(10);
      expect(prompted.length).toBe(1);
      expect(prompted[0]?.delivery).toBe('queue');
      const body = prompted[0]?.body as {
        parts: Array<{ type: string; text: string }>;
      };
      expect(body.parts[0]?.type).toBe('text');
      expect(body.parts[0]?.text).toContain(
        'unfinished background child sessions',
      );
    } finally {
      globalThis.setTimeout = realSetTimeout;
      globalThis.clearTimeout = realClearTimeout;
    }
  });
});

describe('mapV2EventToV1 form → question bridge', () => {
  test('form.created synthesizes v1 question.asked with QuestionV1 shape', () => {
    const ev = deepFreeze({
      type: 'form.created',
      properties: {
        form: {
          id: 'frm_1',
          sessionID: 'ses_q',
          title: 'Pick one',
          fields: [
            {
              key: 'flavor',
              type: 'string',
              title: 'Which flavor?',
              options: [
                { value: 'a', label: 'Vanilla', description: 'plain' },
                { value: 'b', label: 'Chocolate' },
              ],
            },
            {
              key: 'extras',
              type: 'multiselect',
              title: 'Extras',
              options: [{ value: 'x', label: 'Sprinkles' }],
            },
          ],
        },
      },
    });
    const out = mapV2EventToV1(ev);
    expect(out).toHaveLength(2);
    expect(out[0]).toBe(ev);
    // Exact fields the v1 consumers read (input-wait tracker: id +
    // sessionID as the ask requestID) plus the v1 QuestionV1 questions
    // contract (question/header ≤30 chars/options/multiple).
    expect(out[1]).toEqual({
      type: 'question.asked',
      properties: {
        id: 'frm_1',
        sessionID: 'ses_q',
        questions: [
          {
            question: 'Which flavor?',
            header: 'Which flavor?',
            // The form field key rides along: form replies must key
            // answers by this exact value.
            key: 'flavor',
            options: [
              { label: 'Vanilla', description: 'plain' },
              { label: 'Chocolate', description: '' },
            ],
          },
          {
            question: 'Extras',
            header: 'Extras',
            key: 'extras',
            options: [{ label: 'Sprinkles', description: '' }],
            multiple: true,
          },
        ],
      },
    });
  });

  test('form.created falls back to the field key and caps the header', () => {
    const out = mapV2EventToV1({
      type: 'form.created',
      properties: {
        form: {
          id: 'frm_2',
          sessionID: 'ses_q',
          title: 't',
          fields: [
            {
              key: 'a-very-long-identifier-key-name-over-limit',
              type: 'string',
            },
          ],
        },
      },
    });
    const question = (
      out[1] as {
        properties: { questions: Array<{ header: string; question: string }> };
      }
    ).properties.questions[0];
    expect(question.question).toBe(
      'a-very-long-identifier-key-name-over-limit',
    );
    expect(question.header).toHaveLength(30);
  });

  test('"global"-owned forms (MCP elicitation) synthesize nothing', () => {
    expect(
      mapV2EventToV1({
        type: 'form.created',
        properties: {
          form: { id: 'frm_g', sessionID: 'global', title: 't', fields: [] },
        },
      }),
    ).toHaveLength(1);
    expect(
      mapV2EventToV1({
        type: 'form.replied',
        properties: { id: 'frm_g', sessionID: 'global', answer: {} },
      }),
    ).toHaveLength(1);
    expect(
      mapV2EventToV1({
        type: 'form.cancelled',
        properties: { id: 'frm_g', sessionID: 'global' },
      }),
    ).toHaveLength(1);
  });

  test('form.replied synthesizes v1 question.replied with requestID + answers', () => {
    const out = mapV2EventToV1({
      type: 'form.replied',
      properties: {
        id: 'frm_1',
        sessionID: 'ses_q',
        answer: {
          flavor: 'Vanilla',
          count: 2,
          approved: true,
          extras: ['Sprinkles', 'Fudge'],
        },
      },
    });
    expect(out).toHaveLength(2);
    // input-wait-tracker resolves the ask keyed `question:<id>` by reading
    // properties.requestID — must be the form id, not a fresh value.
    expect(out[1]).toEqual({
      type: 'question.replied',
      properties: {
        sessionID: 'ses_q',
        requestID: 'frm_1',
        answers: [['Vanilla'], ['2'], ['true'], ['Sprinkles', 'Fudge']],
      },
    });
  });

  test('form.cancelled synthesizes v1 question.rejected', () => {
    const out = mapV2EventToV1({
      type: 'form.cancelled',
      properties: { id: 'frm_1', sessionID: 'ses_q' },
    });
    expect(out).toHaveLength(2);
    expect(out[1]).toEqual({
      type: 'question.rejected',
      properties: { sessionID: 'ses_q', requestID: 'frm_1' },
    });
  });

  test('malformed form events synthesize nothing (fail-open)', () => {
    expect(
      mapV2EventToV1({ type: 'form.created', properties: {} }),
    ).toHaveLength(1);
    expect(
      mapV2EventToV1({
        type: 'form.created',
        properties: { form: { sessionID: 'ses_q' } }, // no id
      }),
    ).toHaveLength(1);
    expect(
      mapV2EventToV1({
        type: 'form.replied',
        properties: { sessionID: 'ses_q', answer: {} }, // no id
      }),
    ).toHaveLength(1);
  });

  test('ask/reply round-trip arms then resolves the real input-wait tracker', async () => {
    // End-to-end against the consumer that matters: the task-session-
    // manager input-wait gate must arm on the synthesized ask and clear
    // on the synthesized reply.
    const { createTaskSessionManagerHook } = await import(
      '../hooks/task-session-manager'
    );
    const hook = createTaskSessionManagerHook(createHookCtx(), {
      maxSessionsPerAgent: 2,
      shouldManageSession: (id: string) => id === 'parent-1',
    });
    const asked = mapV2EventToV1({
      type: 'form.created',
      properties: {
        form: {
          id: 'frm_w',
          sessionID: 'parent-1',
          title: 't',
          fields: [{ key: 'k', type: 'string' }],
        },
      },
    })[1];
    await hook.event({ event: asked });
    expect(hook.hasInputWait('parent-1')).toBe(true);
    const replied = mapV2EventToV1({
      type: 'form.replied',
      properties: { id: 'frm_w', sessionID: 'parent-1', answer: { k: 'v' } },
    })[1];
    await hook.event({ event: replied });
    expect(hook.hasInputWait('parent-1')).toBe(false);
  });
});

describe('mapV2EventToV1 permission field mapping', () => {
  test('permission.asked synthesizes the v1 field names after the raw event', () => {
    const ev = deepFreeze({
      type: 'permission.asked',
      properties: {
        id: 'per_1',
        sessionID: 'ses_p',
        action: 'execute',
        resources: ['bash'],
        metadata: { callID: 'call_1' },
      },
    });
    const out = mapV2EventToV1(ev);
    expect(out).toHaveLength(2);
    expect(out[0]).toBe(ev);
    // v1 PermissionV1 names: permission ← action, patterns ← resources.
    // The repo consumers (input-wait tracker, wake scheduler, companion)
    // read {id, sessionID} — present on both shapes.
    expect(out[1]).toEqual({
      type: 'permission.asked',
      properties: {
        id: 'per_1',
        sessionID: 'ses_p',
        permission: 'execute',
        patterns: ['bash'],
        metadata: { callID: 'call_1' },
        always: [],
      },
    });
  });

  test('permission.asked maps save → always and degrades missing fields', () => {
    const out = mapV2EventToV1({
      type: 'permission.asked',
      properties: {
        id: 'per_2',
        sessionID: 'ses_p',
        action: 'edit',
        resources: ['file:///a', 42],
        save: ['file:///a'],
      },
    });
    expect(out[1]).toEqual({
      type: 'permission.asked',
      properties: {
        id: 'per_2',
        sessionID: 'ses_p',
        permission: 'edit',
        patterns: ['file:///a'],
        metadata: {},
        always: ['file:///a'],
      },
    });
  });

  test('permission.asked without id/sessionID stays passthrough-only', () => {
    expect(
      mapV2EventToV1({
        type: 'permission.asked',
        properties: { sessionID: 'ses_p' },
      }),
    ).toHaveLength(1);
    expect(
      mapV2EventToV1({ type: 'permission.asked', properties: {} }),
    ).toHaveLength(1);
  });

  test('permission.replied passes through raw — v2 shape already matches v1', () => {
    // v2 replied {sessionID, requestID, reply} IS the v1 PermissionV1
    // event shape; the consumers read sessionID + requestID directly.
    const ev = deepFreeze({
      type: 'permission.replied',
      properties: { sessionID: 'ses_p', requestID: 'per_1', reply: 'once' },
    });
    expect(mapV2EventToV1(ev)).toEqual([ev]);
  });

  test('permission.replied with data payload plus empty properties still synthesizes (#1375)', () => {
    const ev = deepFreeze({
      type: 'permission.replied',
      data: { sessionID: 'ses_p', requestID: 'per_1', reply: 'once' },
      properties: {},
    });
    const out = mapV2EventToV1(ev);
    expect(out).toHaveLength(2);
    expect(out[0]).toBe(ev);
    expect(out[1]).toEqual({
      type: 'permission.replied',
      properties: { sessionID: 'ses_p', requestID: 'per_1', reply: 'once' },
    });
  });

  test('permission.replied with data payload plus foreign properties still synthesizes (#1375)', () => {
    const out = mapV2EventToV1({
      type: 'permission.replied',
      data: { sessionID: 'ses_p', requestID: 'per_1', reply: 'always' },
      properties: { sessionID: 'ses_p', requestID: 'per_other' },
    });
    expect(out).toHaveLength(2);
    expect(out[1]).toEqual({
      type: 'permission.replied',
      properties: { sessionID: 'ses_p', requestID: 'per_1', reply: 'always' },
    });
  });

  test('permission.replied accepts id as a requestID fallback (#1375)', () => {
    const out = mapV2EventToV1({
      type: 'permission.replied',
      data: { sessionID: 'ses_p', id: 'per_1', reply: 'once' },
    });
    expect(out).toHaveLength(2);
    expect(out[1]).toEqual({
      type: 'permission.replied',
      properties: { sessionID: 'ses_p', requestID: 'per_1', reply: 'once' },
    });
  });

  test('permission.replied with id-only properties still synthesizes (#1375)', () => {
    // Reply consumers read `properties.requestID`, never `properties.id`,
    // so an envelope carrying the id under the ask spelling must not
    // suppress synthesis.
    const out = mapV2EventToV1({
      type: 'permission.replied',
      data: { sessionID: 'ses_p', requestID: 'per_1', reply: 'once' },
      properties: { sessionID: 'ses_p', id: 'per_1' },
    });
    expect(out).toHaveLength(2);
    expect(out[1]).toEqual({
      type: 'permission.replied',
      properties: { sessionID: 'ses_p', requestID: 'per_1', reply: 'once' },
    });
  });

  test('permission.replied without identity stays passthrough-only (#1375)', () => {
    expect(
      mapV2EventToV1({
        type: 'permission.replied',
        data: { sessionID: 'ses_p', reply: 'once' },
      }),
    ).toHaveLength(1);
    expect(
      mapV2EventToV1({ type: 'permission.replied', properties: {} }),
    ).toHaveLength(1);
  });

  test('synthesized ask/replied pair arms then resolves the input-wait tracker', async () => {
    const { createTaskSessionManagerHook } = await import(
      '../hooks/task-session-manager'
    );
    const hook = createTaskSessionManagerHook(createHookCtx(), {
      maxSessionsPerAgent: 2,
      shouldManageSession: (id: string) => id === 'parent-1',
    });
    const asked = mapV2EventToV1({
      type: 'permission.asked',
      properties: {
        id: 'per_w',
        sessionID: 'parent-1',
        action: 'execute',
        resources: [],
      },
    })[1];
    await hook.event({ event: asked });
    expect(hook.hasInputWait('parent-1')).toBe(true);
    await hook.event({
      event: {
        type: 'permission.replied',
        properties: {
          sessionID: 'parent-1',
          requestID: 'per_w',
          reply: 'once',
        },
      },
    });
    expect(hook.hasInputWait('parent-1')).toBe(false);
  });
});

describe('mapV2EventToV1 session.deleted synthesis', () => {
  // v2 delivers deletion flat ({sessionID}) under `data` on live hosts;
  // without synthesis the v1 deletion cleanup (task-session-manager
  // rememberDeletedSession + cache-monitor deletedSessionID) never fires on
  // v2. The v1 consumers read two different spellings of the session id —
  // properties.info.id (cache-monitor) and properties.sessionID (event
  // router) — so the synthesized event must carry BOTH.
  function liveDeletedEvent(sessionID: string): Record<string, unknown> {
    return deepFreeze({
      id: 'evt_session_deleted',
      created: 1_788_961_637_000,
      type: 'session.deleted',
      durable: { aggregateID: sessionID, seq: 1, version: 1 },
      data: { sessionID },
    });
  }

  test('legacy `properties` spelling synthesizes the dual-spelling v1 shape', () => {
    const ev = deepFreeze({
      type: 'session.deleted',
      properties: { sessionID: 'ses_del' },
    });
    const out = mapV2EventToV1(ev);
    expect(out).toHaveLength(2);
    expect(out[0]).toBe(ev);
    expect(out[1]).toEqual({
      type: 'session.deleted',
      properties: {
        info: { id: 'ses_del' },
        sessionID: 'ses_del',
      },
    });
  });

  test('live `data` spelling synthesizes the same dual-spelling v1 shape', () => {
    const ev = liveDeletedEvent('ses_gone');
    const out = mapV2EventToV1(ev);
    expect(out).toHaveLength(2);
    expect(out[0]).toBe(ev);
    expect(out[1]).toEqual({
      type: 'session.deleted',
      properties: {
        info: { id: 'ses_gone' },
        sessionID: 'ses_gone',
      },
    });
  });

  test('session.deleted without a sessionID stays passthrough-only', () => {
    const ev = deepFreeze({ type: 'session.deleted', properties: {} });
    expect(mapV2EventToV1(ev)).toEqual([ev]);
    const emptyData = deepFreeze({
      type: 'session.deleted',
      data: {},
    });
    expect(mapV2EventToV1(emptyData)).toEqual([emptyData]);
  });

  test('synthesized session.deleted feeds the real task-session-manager cleanup (tombstone)', async () => {
    const { createTaskSessionManagerHook } = await import(
      '../hooks/task-session-manager'
    );
    const { BackgroundJobBoard, getBackgroundJobLifecycleLedger } =
      await import('../utils');
    const board = new BackgroundJobBoard();
    const hook = createTaskSessionManagerHook(createHookCtx(), {
      maxSessionsPerAgent: 2,
      backgroundJobBoard: board,
      shouldManageSession: (id: string) => id === 'parent-1',
    });
    board.registerLaunch({
      taskID: 'child-del',
      parentSessionID: 'parent-1',
      agent: 'fixer',
      description: 'deletion synthesis e2e',
      now: 0,
    });
    // Dispatch like the v2 pump: raw first, then every synthesized product.
    // The raw data-keyed event is inert in the v1 handler (no properties);
    // only the synthesized dual-spelling shape can record the tombstone.
    for (const mapped of mapV2EventToV1(liveDeletedEvent('child-del'))) {
      await hook.event({ event: mapped });
    }
    expect(
      getBackgroundJobLifecycleLedger(board).tombstones.has('child-del'),
    ).toBe(true);
  });
});
