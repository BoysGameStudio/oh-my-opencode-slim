import { describe, expect, test } from 'bun:test';
import type { PluginInput } from '@opencode-ai/plugin';
import {
  classifyAssistantTurnEvidence,
  classifyTerminalEvidence,
  classifyV2HistoricalRound,
  fetchChildTranscript,
  hostTranscriptRoundOf,
  latestInputAtOf,
  stringifyError,
} from './child-transcript';

function message(overrides: {
  id?: string;
  role?: string;
  finish?: string;
  completed?: number | null;
  error?: unknown;
  parts?: unknown[];
}) {
  return {
    info: {
      id: overrides.id ?? 'm1',
      role: overrides.role ?? 'assistant',
      ...(overrides.finish !== undefined ? { finish: overrides.finish } : {}),
      ...(overrides.completed !== null && overrides.completed !== undefined
        ? { time: { completed: overrides.completed } }
        : {}),
      ...(overrides.error !== undefined ? { error: overrides.error } : {}),
    },
    parts: overrides.parts ?? [{ type: 'text', text: 'the answer' }],
  };
}

describe('host transcript round helpers', () => {
  const transcript = {
    data: [
      {
        info: {
          role: 'user',
          sourceType: 'user',
          time: { created: 10 },
        },
        parts: [],
      },
      {
        info: {
          role: 'assistant',
          sourceType: 'assistant',
          time: { completed: 11 },
        },
        parts: [{ type: 'text', text: 'older answer' }],
      },
      {
        info: {
          role: 'synthetic',
          sourceType: 'synthetic',
          time: { created: 12 },
        },
        parts: [],
      },
      {
        info: {
          role: 'assistant',
          sourceType: 'assistant',
          time: { completed: 13 },
        },
        parts: [
          { type: 'text', text: ' latest ' },
          { type: 'text', text: 'answer ' },
        ],
      },
    ],
  };

  test('latestInputAtOf uses the newest user or synthetic boundary', () => {
    expect(latestInputAtOf(transcript)).toBe(12);
    expect(latestInputAtOf({ data: [] })).toBeUndefined();
    expect(latestInputAtOf(undefined)).toBeUndefined();
  });

  test('hostTranscriptRoundOf returns only text bound to the host idle', () => {
    expect(hostTranscriptRoundOf(transcript, 13)).toEqual({
      kind: 'ok',
      latestInputAt: 12,
      text: 'latest\nanswer',
    });
    expect(hostTranscriptRoundOf(transcript, 12)).toEqual({
      kind: 'newer-assistant',
      at: 13,
      latestInputAt: 12,
    });
    expect(
      hostTranscriptRoundOf({
        data: [transcript.data[0], transcript.data[1], transcript.data[2]],
      }),
    ).toEqual({ kind: 'ok', latestInputAt: 12, text: undefined });
    expect(
      hostTranscriptRoundOf({
        data: [
          transcript.data[2],
          { info: { role: 'assistant', sourceType: 'assistant' }, parts: [] },
        ],
      }),
    ).toEqual({ kind: 'unreadable', reason: 'assistant time is missing' });
  });

  test('malformed entries and malformed transcripts fail closed', () => {
    expect(
      hostTranscriptRoundOf(
        {
          data: [transcript.data[0], { info: null }, transcript.data[2]],
        },
        13,
      ),
    ).toEqual({ kind: 'unreadable', reason: 'malformed transcript entries' });
    expect(hostTranscriptRoundOf({ data: 'nope' }, 13)).toEqual({
      kind: 'unreadable',
      reason: 'malformed transcript response',
    });
    expect(hostTranscriptRoundOf(undefined, 13)).toEqual({
      kind: 'unreadable',
      reason: 'transcript source unavailable',
    });
  });

  test('textless assistant evidence is preserved as empty text', () => {
    expect(
      hostTranscriptRoundOf(
        {
          data: [
            transcript.data[0],
            {
              info: {
                role: 'assistant',
                sourceType: 'assistant',
                time: { created: 13 },
              },
              parts: [{ type: 'text', text: '   ' }],
            },
          ],
        },
        13,
      ),
    ).toEqual({ kind: 'ok', latestInputAt: 10, text: '' });
  });
});

describe('classifyV2HistoricalRound (startup path)', () => {
  function v2Message(overrides: {
    id: string;
    sourceType: string;
    time?: Record<string, number>;
    outcome?: string;
    text?: string;
  }) {
    return {
      info: {
        id: overrides.id,
        role: overrides.sourceType === 'idle' ? 'system' : overrides.sourceType,
        sourceType: overrides.sourceType,
        ...(overrides.time !== undefined ? { time: overrides.time } : {}),
        ...(overrides.outcome !== undefined
          ? { outcome: overrides.outcome }
          : {}),
      },
      parts:
        overrides.text !== undefined
          ? [{ type: 'text', text: overrides.text }]
          : [],
    };
  }

  test('interrupted idle is interrupted without an assistant', () => {
    expect(
      classifyV2HistoricalRound({
        data: [
          v2Message({ id: 'u', sourceType: 'user', time: { created: 10 } }),
          v2Message({
            id: 'i',
            sourceType: 'idle',
            time: { created: 11 },
            outcome: 'interrupted',
          }),
        ],
      }),
    ).toMatchObject({ verdict: 'interrupted', startedAt: 10 });
  });

  test('failed idle keeps the fallback when no assistant text exists', () => {
    const round = classifyV2HistoricalRound({
      data: [
        v2Message({ id: 'u', sourceType: 'user', time: { created: 10 } }),
        v2Message({
          id: 'i',
          sourceType: 'idle',
          time: { created: 11 },
          outcome: 'failed',
        }),
      ],
    });
    expect(round).toMatchObject({
      verdict: 'error',
      text: 'The historical round failed before an assistant result.',
    });
    expect(round.text).not.toContain('ask');
  });

  test('succeeded idle without an assistant stays incomplete', () => {
    expect(
      classifyV2HistoricalRound({
        data: [
          v2Message({ id: 'u', sourceType: 'user', time: { created: 10 } }),
          v2Message({
            id: 'i',
            sourceType: 'idle',
            time: { created: 11 },
            outcome: 'succeeded',
          }),
        ],
      }),
    ).toMatchObject({ verdict: 'incomplete', startedAt: 10 });
  });

  test('a newer assistant after the closing idle is rejected', () => {
    const round = classifyV2HistoricalRound({
      data: [
        v2Message({ id: 'u', sourceType: 'user', time: { created: 10 } }),
        v2Message({
          id: 'a',
          sourceType: 'assistant',
          time: { created: 11, completed: 12 },
          text: 'ANSWER-A',
        }),
        v2Message({
          id: 'ia',
          sourceType: 'idle',
          time: { created: 13 },
          outcome: 'succeeded',
        }),
        v2Message({
          id: 'b',
          sourceType: 'assistant',
          time: { created: 14 },
          text: 'ANSWER-B',
        }),
      ],
    });
    expect(round.verdict).toBe('incomplete');
    expect(JSON.stringify(round)).not.toContain('ANSWER-A');
    expect(JSON.stringify(round)).not.toContain('ANSWER-B');
  });

  test('a newer synthetic blocks an older succeeded outcome', () => {
    const round = classifyV2HistoricalRound({
      data: [
        v2Message({ id: 'u', sourceType: 'user', time: { created: 10 } }),
        v2Message({
          id: 'a',
          sourceType: 'assistant',
          time: { created: 11, completed: 12 },
          text: 'OLD',
        }),
        v2Message({
          id: 'i',
          sourceType: 'idle',
          time: { created: 13 },
          outcome: 'succeeded',
        }),
        v2Message({
          id: 's',
          sourceType: 'synthetic',
          time: { created: 14 },
        }),
      ],
    });
    expect(round.verdict).toBe('incomplete');
    expect(JSON.stringify(round)).not.toContain('OLD');
  });
});

test('stringifyError never throws on unserializable empty-message errors', () => {
  const error = Object.assign(new Error(''), { name: 'E', self: {} });
  error.self = error;
  expect(stringifyError(error)).toBe('E');
});

test('stringifyError never returns undefined for unserializable values', () => {
  expect(typeof stringifyError(undefined)).toBe('string');
  expect(typeof stringifyError(Symbol('cause'))).toBe('string');
});

describe('classifyAssistantTurnEvidence', () => {
  test('trailing assistant with text is ready', () => {
    const messages = [
      message({ id: 'base' }),
      message({ id: 'last', completed: 5 }),
    ];
    const evidence = classifyAssistantTurnEvidence(
      messages,
      messages.length - 1,
      -1,
    );
    expect(evidence).toEqual({ kind: 'ready', text: 'the answer' });
  });

  test('trailing assistant without text is textless', () => {
    const messages = [message({ id: 'last', completed: 5, parts: [] })];
    const evidence = classifyAssistantTurnEvidence(
      messages,
      messages.length - 1,
      -1,
    );
    expect(evidence).toEqual({ kind: 'textless' });
  });

  test('finish tool-calls is pending', () => {
    const messages = [
      message({ id: 'last', completed: 5, finish: 'tool-calls' }),
    ];
    const evidence = classifyAssistantTurnEvidence(
      messages,
      messages.length - 1,
      -1,
    );
    expect(evidence).toEqual({ kind: 'pending' });
  });

  test('an in-flight tool part after the baseline is pending', () => {
    const messages = [
      message({ id: 'base', role: 'user' }),
      message({
        id: 'tool',
        role: 'assistant',
        completed: 4,
        parts: [{ type: 'tool', state: { status: 'running' } }],
      }),
      message({ id: 'last', completed: 5 }),
    ];
    const evidence = classifyAssistantTurnEvidence(
      messages,
      messages.length - 1,
      -1,
    );
    expect(evidence).toEqual({ kind: 'pending' });
  });

  test('completed tool parts do not block readiness', () => {
    const messages = [
      message({
        id: 'tool',
        role: 'assistant',
        completed: 4,
        parts: [
          { type: 'tool', state: { status: 'completed' } },
          { type: 'text', text: 'done summary' },
        ],
      }),
    ];
    const evidence = classifyAssistantTurnEvidence(
      messages,
      messages.length - 1,
      -1,
    );
    expect(evidence).toEqual({ kind: 'ready', text: 'done summary' });
  });

  test('trailing assistant error is error with text', () => {
    const messages = [
      message({ id: 'last', completed: 5, error: 'model exploded' }),
    ];
    const evidence = classifyAssistantTurnEvidence(
      messages,
      messages.length - 1,
      -1,
    );
    expect(evidence).toEqual({ kind: 'error', errorText: 'model exploded' });
  });

  test('error objects are stringified', () => {
    const messages = [
      message({ id: 'last', completed: 5, error: { code: 500 } }),
    ];
    const evidence = classifyAssistantTurnEvidence(
      messages,
      messages.length - 1,
      -1,
    );
    expect(evidence.kind).toBe('error');
    expect(evidence.errorText).toContain('500');
  });

  test('requireCompletionTime treats a missing completion time as pending', () => {
    const messages = [message({ id: 'last', completed: null })];
    expect(
      classifyAssistantTurnEvidence(messages, messages.length - 1, -1, true),
    ).toEqual({ kind: 'pending' });
    // v2 shim shape: info carries no time at all — tolerated when the
    // strictness flag is off (the host outcome gate already confirmed
    // terminal upstream).
    expect(
      classifyAssistantTurnEvidence(messages, messages.length - 1, -1, false),
    ).toEqual({ kind: 'ready', text: 'the answer' });
  });

  test('error: null is not an error (pinned semantics)', () => {
    // Old tracker code treated error:null as an error; the shared
    // extractor deliberately reads null as "no error" and extracts text.
    const messages = [message({ id: 'last', completed: 5, error: null })];
    const evidence = classifyAssistantTurnEvidence(
      messages,
      messages.length - 1,
      -1,
    );
    expect(evidence).toEqual({ kind: 'ready', text: 'the answer' });
  });

  test("finish 'unknown' is pending (not only 'tool-calls')", () => {
    const messages = [message({ id: 'last', completed: 5, finish: 'unknown' })];
    const evidence = classifyAssistantTurnEvidence(
      messages,
      messages.length - 1,
      -1,
    );
    expect(evidence).toEqual({ kind: 'pending' });
  });

  test('multi-part text is joined and the whole string trimmed', () => {
    const messages = [
      message({
        id: 'last',
        completed: 5,
        parts: [
          { type: 'text', text: '  first  ' },
          { type: 'tool', state: { status: 'error' } },
          { type: 'text', text: 'second  ' },
        ],
      }),
    ];
    const evidence = classifyAssistantTurnEvidence(
      messages,
      messages.length - 1,
      -1,
    );
    // Whole-string trim only: inner padding between parts is preserved.
    expect(evidence).toEqual({ kind: 'ready', text: 'first  \n\nsecond' });
  });
});

describe('classifyTerminalEvidence', () => {
  test('a role-less message after the baseline is unrecognized, never an answer', () => {
    const response = {
      data: [
        message({ id: 'base', role: 'user' }),
        {
          info: { id: 'odd', time: { completed: 5 } },
          parts: [{ type: 'text', text: 'the answer' }],
        },
      ],
    };
    expect(
      classifyTerminalEvidence(response, { baselineMessageID: 'base' }),
    ).toEqual({ verdict: 'retry', reason: 'unrecognized segment shape' });
  });

  test('a compaction round after the baseline is not the answer', () => {
    const summary = message({
      id: 'sum',
      finish: 'stop',
      completed: 9,
      parts: [{ type: 'text', text: 'SUMMARY' }],
    });
    const response = {
      data: [
        message({ id: 'base', role: 'user' }),
        message({ id: 'main', finish: 'stop', completed: 5 }),
        message({ id: 'cut', role: 'user', parts: [{ type: 'compaction' }] }),
        { ...summary, info: { ...summary.info, summary: true } },
      ],
    };
    expect(
      classifyTerminalEvidence(response, { baselineMessageID: 'base' }),
    ).toEqual({ verdict: 'completed', text: 'the answer' });
  });
});

describe('fetchChildTranscript', () => {
  function clientWith(
    session: Record<string, unknown> | undefined,
  ): PluginInput['client'] {
    // Structural stand-in mirroring the v2 client-shim's degraded hosts.
    return { session } as PluginInput['client'];
  }

  test('returns the raw response on success', async () => {
    const response = { data: [] };
    const client = clientWith({ messages: () => response });
    await expect(
      fetchChildTranscript(client, 'ses_child', '/test'),
    ).resolves.toBe(response);
  });

  test('passes sessionID and directory through path and query', async () => {
    const seen: unknown[] = [];
    const client = clientWith({
      messages(...args: unknown[]) {
        seen.push(args[0]);
        return { data: [] };
      },
    });
    await fetchChildTranscript(client, 'ses_child', '/test');
    expect(seen[0]).toEqual({
      path: { id: 'ses_child' },
      query: { directory: '/test' },
    });
  });

  test('binds session.messages to the session object', async () => {
    const session: Record<string, unknown> = {};
    session.messages = function (this: unknown) {
      expect(this).toBe(session);
      return { data: [] };
    };
    await fetchChildTranscript(clientWith(session), 'ses_child', '/test');
  });

  test('returns undefined when session.messages is not callable', async () => {
    await expect(
      fetchChildTranscript(clientWith({}), 'ses_child', '/test'),
    ).resolves.toBeUndefined();
    await expect(
      fetchChildTranscript(clientWith(undefined), 'ses_child', '/test'),
    ).resolves.toBeUndefined();
  });

  test('propagates transport failures', async () => {
    const client = clientWith({
      messages: () => Promise.reject(new Error('transport down')),
    });
    await expect(
      fetchChildTranscript(client, 'ses_child', '/test'),
    ).rejects.toThrow('transport down');
  });

  test('string error payload is surfaced as-is', async () => {
    const client = clientWith({
      messages: () => ({ error: 'session not found' }),
    });
    await expect(
      fetchChildTranscript(client, 'ses_child', '/test'),
    ).rejects.toThrow('session not found');
  });

  test('Error payload is surfaced via its message', async () => {
    const client = clientWith({
      messages: () => ({ error: new Error('boom') }),
    });
    await expect(
      fetchChildTranscript(client, 'ses_child', '/test'),
    ).rejects.toThrow('boom');
  });

  test('object error payload is JSON-stringified', async () => {
    const client = clientWith({
      messages: () => ({ error: { code: 500, message: 'internal' } }),
    });
    await expect(
      fetchChildTranscript(client, 'ses_child', '/test'),
    ).rejects.toThrow('{"code":500,"message":"internal"}');
  });

  test('error: null is not an error (mirrors pinned extractor semantics)', async () => {
    const response = { data: [], error: null };
    const client = clientWith({ messages: () => response });
    await expect(
      fetchChildTranscript(client, 'ses_child', '/test'),
    ).resolves.toBe(response);
  });

  test('non-record responses are returned untouched', async () => {
    const client = clientWith({ messages: () => 'flat-shape' });
    await expect(
      fetchChildTranscript(client, 'ses_child', '/test'),
    ).resolves.toBe('flat-shape');
  });
});
