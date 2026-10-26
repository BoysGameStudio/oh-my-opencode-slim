/**
 * Native council seat assembly (boardless, managed lifecycle OFF).
 *
 * The resolver reads the host session domain directly: the parent
 * transcript once (to establish the synthesis-turn boundary), then one
 * `session.get` + one transcript per seat. Every read is bounded by one
 * whole-call deadline driven by the deterministic timer harness — no real
 * sleeps, no polling, no retries.
 */
import { describe, expect, test } from 'bun:test';

import type { PluginInput } from '@opencode-ai/plugin';

import { createTimerHarness } from '../../utils/test-timers';
import { createCouncilSeatHook } from './index';
import { createNativeSeatResolver, type NativeSeatTimers } from './native';

const PARENT = 'ses_parent';
const CHILD = 'ses_child';
const OTHER_PARENT = 'ses_other';

/** Build one transcript message. */
function message(input: {
  id: string;
  role: 'user' | 'assistant' | 'system';
  text?: string;
  created?: number;
  completed?: number;
  error?: unknown;
  finish?: string;
  parentID?: string;
}): Record<string, unknown> {
  return {
    info: {
      id: input.id,
      role: input.role,
      ...(input.parentID ? { parentID: input.parentID } : {}),
      ...(input.created !== undefined
        ? { time: { created: input.created } }
        : {}),
      ...(input.completed !== undefined
        ? { time: { created: input.created, completed: input.completed } }
        : {}),
      ...(input.error !== undefined ? { error: input.error } : {}),
      ...(input.finish !== undefined ? { finish: input.finish } : {}),
    },
    parts: input.text === undefined ? [] : [{ type: 'text', text: input.text }],
  };
}

/** A child transcript whose latest user input is at `at`. */
function childTranscript(at: number, text?: string): unknown {
  const messages = [
    message({ id: 'msg_seat', role: 'user', text: 'seat prompt', created: at }),
  ];
  if (text !== undefined) {
    messages.push(
      message({
        id: 'msg_seat_answer',
        role: 'assistant',
        text,
        created: at + 10,
        completed: at + 20,
      }),
    );
  }
  return { data: messages };
}

interface SeatFixture {
  transcripts?: Record<string, unknown>;
  hostInfos?: Record<string, Record<string, unknown>>;
  /** v2 host info writes outcome + idle; omit for a pending round. */
  parentTranscript?: unknown;
}

/** Fake host client. Any method not provided rejects never (so a budget
 * test can hold it open) — callers always pass what they need. */
function fakeInput(
  fixture: SeatFixture,
  options: { hostFlavor?: 'v2' } = {},
): PluginInput {
  const client = {
    session: {
      messages: async (args: Record<string, unknown>) => {
        const id = (args?.path as { id?: string } | undefined)?.id ?? '';
        return fixture.transcripts?.[id] ?? { data: [] };
      },
      get: async (args: Record<string, unknown>) => {
        const id = (args?.path as { id?: string } | undefined)?.id ?? '';
        return { data: fixture.hostInfos?.[id] ?? { id } };
      },
    },
  };
  return {
    client,
    directory: '/tmp',
    ...(options.hostFlavor ? { hostFlavor: options.hostFlavor } : {}),
  } as unknown as PluginInput;
}

/** Default: parent's latest input at 100, one completed child at 50. */
function defaultFixture(overrides: SeatFixture = {}): SeatFixture {
  return {
    transcripts: {
      [PARENT]: {
        data: [
          message({ id: 'msg_user', role: 'user', text: 'go', created: 100 }),
        ],
      },
      [CHILD]: childTranscript(50, 'CHILD VERBATIM TEXT'),
    },
    hostInfos: {
      [CHILD]: {
        id: CHILD,
        parentID: PARENT,
        agent: 'councillor-alpha',
        outcome: 'succeeded',
        time: { created: 1, idle: 90 },
      },
    },
    ...overrides,
  };
}

async function resolve(
  fixture: SeatFixture,
  refs: string[],
  options: {
    hostFlavor?: 'v2';
    timeoutMs?: number;
    now?: () => number;
    timers?: NativeSeatTimers;
  } = {},
) {
  const input = fakeInput(fixture, { hostFlavor: options.hostFlavor });
  const resolver = createNativeSeatResolver(input, {
    ...(options.timeoutMs !== undefined
      ? { timeoutMs: options.timeoutMs }
      : {}),
    ...(options.now ? { now: options.now } : {}),
    ...(options.timers ? { timers: options.timers } : {}),
  });
  return resolver(
    PARENT,
    refs.map((ref) => ({
      seat: ref,
      ...(ref.startsWith('ses_') ? { childID: ref } : {}),
    })),
  );
}

async function runHook(
  fixture: SeatFixture,
  prompt: string,
  options: { hostFlavor?: 'v2'; timeoutMs?: number } = {},
): Promise<Record<string, unknown>> {
  const input = fakeInput(fixture, { hostFlavor: options.hostFlavor });
  const hook = createCouncilSeatHook({
    resolveSeats: createNativeSeatResolver(input, {
      ...(options.timeoutMs !== undefined
        ? { timeoutMs: options.timeoutMs }
        : {}),
    }),
  });
  const args: Record<string, unknown> = {
    subagent_type: 'council',
    prompt,
    background: false,
  };
  await hook['tool.execute.before'](
    { tool: 'task', sessionID: PARENT, callID: 'call_council' },
    { args },
  );
  return args;
}

describe('native council seat resolver (v2)', () => {
  test('a completed child inlines its answer text with the host agent label', async () => {
    const results = await resolve(defaultFixture(), [CHILD], {
      hostFlavor: 'v2',
    });
    expect(results).toEqual([
      {
        kind: 'completed',
        text: 'CHILD VERBATIM TEXT',
        label: 'councillor-alpha',
      },
    ]);
  });

  test('a child belonging to another parent is missing, never resolved', async () => {
    const fixture = defaultFixture();
    fixture.hostInfos = {
      [CHILD]: { id: CHILD, parentID: OTHER_PARENT, agent: 'councillor-alpha' },
    };
    const results = await resolve(fixture, [CHILD], { hostFlavor: 'v2' });
    expect(results[0]?.kind).toBe('missing');
  });

  test('a host round with no terminal outcome is still running', async () => {
    const fixture = defaultFixture();
    fixture.hostInfos = {
      [CHILD]: { id: CHILD, parentID: PARENT, agent: 'councillor-alpha' },
    };
    const results = await resolve(fixture, [CHILD], { hostFlavor: 'v2' });
    expect(results[0]?.kind).toBe('running');
  });

  test('a completed host round without answer text is empty, not completed', async () => {
    const fixture = defaultFixture();
    fixture.transcripts = {
      ...fixture.transcripts,
      [CHILD]: childTranscript(50),
    };
    const results = await resolve(fixture, [CHILD], { hostFlavor: 'v2' });
    expect(results[0]?.kind).toBe('empty');
  });

  test('a resumed child (latest input at/after the synthesis turn) is stale', async () => {
    // The parent's latest input is the synthesis boundary at 100; the
    // child was steered at 200 — after the synthesis turn started.
    const fixture = defaultFixture();
    fixture.transcripts = {
      ...fixture.transcripts,
      [CHILD]: childTranscript(200, 'RESUMED ANSWER'),
    };
    const results = await resolve(fixture, [CHILD], { hostFlavor: 'v2' });
    expect(results[0]?.kind).toBe('stale');
    expect(results[0]).not.toHaveProperty('text');
  });

  test('an unreadable session is ambiguous, never a guess', async () => {
    const input = fakeInput(defaultFixture(), { hostFlavor: 'v2' });
    const rejecting = {
      ...input,
      client: {
        session: {
          messages: async () => ({ data: [] }),
          get: async () => {
            throw new Error('host unavailable');
          },
        },
      },
    } as unknown as PluginInput;
    const resolver = createNativeSeatResolver(rejecting);
    const results = await resolver(PARENT, [{ seat: CHILD, childID: CHILD }]);
    expect(results[0]?.kind).toBe('ambiguous');
  });

  test('a missing session id ref never resolves', async () => {
    const results = await resolve(defaultFixture(), ['ses_absent'], {
      hostFlavor: 'v2',
    });
    expect(results[0]?.kind).toBe('ambiguous');
  });

  test('an unresolvable parent transcript makes every seat ambiguous', async () => {
    const fixture = defaultFixture();
    fixture.transcripts = {};
    const results = await resolve(fixture, [CHILD], { hostFlavor: 'v2' });
    expect(results[0]?.kind).toBe('ambiguous');
  });

  test('end-to-end through the hook: completed text is inlined', async () => {
    const args = await runHook(
      defaultFixture(),
      'Question?\nSeats: ses_child',
      { hostFlavor: 'v2' },
    );
    expect(args.prompt).toBe(
      [
        'Question?',
        '',
        '## Seat: councillor-alpha',
        'CHILD VERBATIM TEXT',
      ].join('\n'),
    );
  });

  test('non-session refs are missing', async () => {
    const results = await resolve(defaultFixture(), ['councillor-1'], {
      hostFlavor: 'v2',
    });
    expect(results[0]?.kind).toBe('missing');
  });

  test('the whole call is bounded by one deadline: a held host read yields placeholders', async () => {
    const timers = createTimerHarness();
    // A client whose reads never settle.
    const held = {
      client: {
        session: {
          messages: () => new Promise(() => {}),
          get: () => new Promise(() => {}),
        },
      },
      directory: '/tmp',
      hostFlavor: 'v2',
    } as unknown as PluginInput;
    const resolver = createNativeSeatResolver(held, {
      timeoutMs: 100,
      timers,
      now: timers.now,
    });
    const call = resolver(PARENT, [{ seat: CHILD, childID: CHILD }]);
    await timers.advance(100);
    const results = await call;
    expect(results[0]?.kind).toBe('ambiguous');
    // No timer is left pending: the budget released the whole call.
    expect(timers.pending()).toBe(0);
  });

  test('an exhausted budget degrades every seat without hanging', async () => {
    const timers = createTimerHarness();
    const resolver = createNativeSeatResolver(
      fakeInput(defaultFixture(), { hostFlavor: 'v2' }),
      { timeoutMs: 100, timers, now: timers.now },
    );
    const call = resolver(PARENT, [{ seat: CHILD, childID: CHILD }]);
    await timers.advance(100);
    const results = await call;
    expect(results[0]?.kind).toBe('ambiguous');
    expect(timers.pending()).toBe(0);
  });
});

describe('native council seat resolver (v1)', () => {
  test('a completed assistant turn is classified as completed text', async () => {
    const fixture = defaultFixture();
    const results = await resolve(fixture, [CHILD]);
    expect(results[0]?.kind).toBe('completed');
  });

  test('a finished turn without text is empty', async () => {
    const fixture = defaultFixture();
    fixture.transcripts = {
      ...fixture.transcripts,
      [CHILD]: {
        data: [
          message({ id: 'msg_seat', role: 'user', created: 50 }),
          message({
            id: 'msg_seat_answer',
            role: 'assistant',
            created: 60,
            completed: 70,
          }),
        ],
      },
    };
    const results = await resolve(fixture, [CHILD]);
    expect(results[0]?.kind).toBe('empty');
  });

  test('a still-open round is running', async () => {
    const fixture = defaultFixture();
    fixture.transcripts = {
      ...fixture.transcripts,
      [CHILD]: {
        data: [
          message({ id: 'msg_seat', role: 'user', created: 50 }),
          message({
            id: 'msg_seat_answer',
            role: 'assistant',
            created: 60,
            finish: 'tool-calls',
          }),
        ],
      },
    };
    const results = await resolve(fixture, [CHILD]);
    expect(results[0]?.kind).toBe('running');
  });

  test('a terminal error is an error seat, never an opinion', async () => {
    const fixture = defaultFixture();
    fixture.transcripts = {
      ...fixture.transcripts,
      [CHILD]: {
        data: [
          message({ id: 'msg_seat', role: 'user', created: 50 }),
          message({
            id: 'msg_seat_answer',
            role: 'assistant',
            text: 'host blew up',
            created: 60,
            completed: 70,
            error: { message: 'provider exploded' },
          }),
        ],
      },
    };
    const results = await resolve(fixture, [CHILD]);
    expect(results[0]?.kind).toBe('error');
    expect(results[0]).not.toHaveProperty('text');
  });

  test('the selfPromptAt boundary also applies on v1', async () => {
    const fixture = defaultFixture();
    fixture.transcripts = {
      ...fixture.transcripts,
      [CHILD]: childTranscript(200, 'RESUMED ANSWER'),
    };
    const results = await resolve(fixture, [CHILD]);
    expect(results[0]?.kind).toBe('stale');
  });
});
