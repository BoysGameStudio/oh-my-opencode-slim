/**
 * Structural flavor split of the retirement observer (v2 boardless).
 *
 * The board render is gone on every host, so nothing here renders board
 * text. What remains pins the v2-structural split:
 *
 *   - v2 never registers jobs and never injects board text;
 *   - observed deliveries retire only completed, exact-run matches;
 *   - an undated trusted delivery cannot retire a terminal job.
 */

import { describe, expect, mock, test } from 'bun:test';
import { BackgroundJobBoard } from '../../utils/background-job-fixture';
import { createTaskSessionManagerHook } from './index';

const SESSION = 'ses_08f6be16dffednbwYD8dNDIfOI';
const BASE_TIME = 1752968000000;

// ── Realistic SDK-shaped fixtures (types.gen.d.ts UserMessage/AssistantMessage) ──

function userMsg(id: string, text: string, createdAt: number) {
  return {
    info: {
      id,
      sessionID: SESSION,
      role: 'user',
      time: { created: createdAt },
      agent: 'orchestrator',
      model: { providerID: 'github-copilot', modelID: 'gpt-6-luna' },
    },
    parts: [
      {
        id: `prt_${id}`,
        sessionID: SESSION,
        messageID: id,
        type: 'text',
        text,
        time: { start: createdAt },
      },
    ],
  };
}

function assistantMsg(
  id: string,
  text: string,
  createdAt: number,
  cost: number,
  inputTokens: number,
) {
  return {
    info: {
      id,
      sessionID: SESSION,
      role: 'assistant',
      time: { created: createdAt, completed: createdAt + 4321 },
      parentID: 'msg_u1',
      modelID: 'gpt-6-luna',
      providerID: 'github-copilot',
      mode: 'orchestrator',
      path: { cwd: '/work/repo', root: '/work/repo' },
      cost,
      tokens: {
        input: inputTokens,
        output: 350,
        reasoning: 0,
        cache: { read: 0, write: 0 },
      },
    },
    parts: [
      {
        id: `prt_${id}`,
        sessionID: SESSION,
        messageID: id,
        type: 'text',
        text,
      },
    ],
  };
}

// ── Serialization / diffing ────────────────────────────────────────────

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => typeof v !== 'function' && v !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([k, v]) => [k, sortValue(v)]),
    );
  }
  return value;
}

/** One JSON line per message so "prev is a byte prefix of next" is meaningful. */
function serializeMessages(messages: unknown[]): string {
  return `${messages.map((m) => JSON.stringify(sortValue(m))).join('\n')}\n`;
}

/**
 * Verbatim port of the text-message path of MessageV2.toModelMessagesEffect
 * (message-v2.ts:692-780, same-model branch). This is the code that turns the
 * transform hook's output into UI messages before provider serialization.
 */
function toUIMessages(messages: any[]): any[] {
  const result: any[] = [];
  for (const msg of messages) {
    if (!msg?.info || !Array.isArray(msg.parts) || msg.parts.length === 0) {
      continue;
    }
    if (msg.info.role === 'user') {
      const parts: any[] = [];
      for (const part of msg.parts) {
        if (part.type === 'text' && !part.ignored && part.text !== '') {
          parts.push({ type: 'text', text: part.text });
        }
      }
      if (parts.length > 0) {
        result.push({ id: msg.info.id, role: 'user', parts });
      }
    }
    if (msg.info.role === 'assistant') {
      if (msg.info.error) continue;
      const parts: any[] = [];
      for (const part of msg.parts) {
        if (part.type === 'text') {
          parts.push({
            type: 'text',
            text: part.text,
            providerMetadata: part.metadata,
          });
        }
      }
      if (parts.length > 0) {
        result.push({ id: msg.info.id, role: 'assistant', parts });
      }
    }
  }
  return result;
}

function toProviderBytes(messages: unknown[]): string {
  const modelMessages = toUIMessages(messages as never).map(
    ({ role, parts }: any) => ({
      role,
      content: parts.map(({ type, text }: any) => ({ type, text })),
    }),
  );
  return serializeMessages(modelMessages);
}

// ── Hook + turn runner ────────────────────────────────────────────────

function createHook(board: BackgroundJobBoard, hostFlavor?: string) {
  return createTaskSessionManagerHook(
    {
      client: { session: { status: mock(async () => ({ data: {} })) } },
      directory: '/tmp',
      worktree: '/tmp',
    } as never,
    {
      maxSessionsPerAgent: 4,
      hostFlavor,
      backgroundJobBoard: board,
      shouldManageSession: () => true,
    },
  );
}

type TurnResult = {
  injected: unknown[];
  transformBytes: string;
  providerBytes: string;
};

async function runTurn(
  hook: ReturnType<typeof createTaskSessionManagerHook>,
  history: unknown[],
): Promise<TurnResult> {
  // prompt.ts rebuilds msgs from storage every request; injected synthetic
  // board messages are never persisted, so each request starts from the
  // real history only.
  const request = { messages: structuredClone(history) };
  await hook.injectBackgroundJobBoard({}, request as never);
  return {
    injected: request.messages,
    transformBytes: serializeMessages(request.messages),
    providerBytes: toProviderBytes(request.messages),
  };
}

// ── Scenario A: tool loop, board state changes across turns ──────────

describe('structural flavor split (v2 boardless)', () => {
  test('v2: no board text is injected even with active jobs', async () => {
    const board = new BackgroundJobBoard();
    board.registerLaunch({
      taskID: 'child-1',
      parentSessionID: SESSION,
      agent: 'explorer',
      description: 'map hooks',
    });
    const hook = createHook(board, 'v2');
    const turn = await runTurn(hook, [
      userMsg('msg_u_sw_off', 'Coordinate the refactor work', BASE_TIME),
    ]);
    expect(turn.transformBytes).not.toContain('Background Job Board');
  });

  test('v2: never registers jobs; observed deliveries retire only completed ones', async () => {
    const board = new BackgroundJobBoard();
    board.registerLaunch({
      taskID: 'child-done',
      parentSessionID: SESSION,
      agent: 'explorer',
      description: 'map hooks',
      now: BASE_TIME - 1_000,
    });
    board.updateStatus({
      taskID: 'child-done',
      state: 'completed',
      resultSummary: 'done',
      now: BASE_TIME + 60_000,
    });
    board.registerLaunch({
      taskID: 'child-stopped',
      parentSessionID: SESSION,
      agent: 'explorer',
      description: 'map hooks',
      now: BASE_TIME - 1_000,
    });
    board.updateStatus({
      taskID: 'child-stopped',
      state: 'stopped',
      resultSummary: 'stopped without a terminal result',
      now: BASE_TIME + 60_000,
    });
    const hook = createHook(board, 'v2');

    // First real turn: nothing registers against the prompt shape — both
    // jobs stay unreconciled (the stopped job for the recovery wake, the
    // completed job until its native delivery is observed).
    await runTurn(hook, [
      userMsg('msg_u_off_1', 'Coordinate the refactor work', BASE_TIME),
    ]);
    expect(board.getState('child-done')).toBe('completed');
    expect(board.getState('child-stopped')).toBe('stopped');
    expect(board.get('child-stopped')).toMatchObject({
      terminalUnreconciled: true,
    });

    // A later turn still retires nothing on its own: retirement is
    // observation-based, not prompt-shape-based. (The stale-terminal
    // fallback cannot fire here — the terminal reports are newer than the
    // fixture assistant turn.)
    await runTurn(hook, [
      userMsg('msg_u_off_1', 'Coordinate the refactor work', BASE_TIME),
      assistantMsg('msg_a_off_1', 'consumed the result', BASE_TIME + 1, 1, 10),
      userMsg('msg_u_off_2', 'next step', BASE_TIME + 2),
    ]);
    expect(board.getState('child-done')).toBe('completed');
    expect(board.getState('child-stopped')).toBe('stopped');
    expect(board.get('child-stopped')).toMatchObject({
      terminalUnreconciled: true,
    });

    // The host's native delivery for the completed job retires it; the
    // stopped job stays for the recovery flow.
    await runTurn(hook, [
      userMsg('msg_u_off_1', 'Coordinate the refactor work', BASE_TIME),
      assistantMsg('msg_a_off_1', 'consumed the result', BASE_TIME + 1, 1, 10),
      {
        info: {
          id: 'msg_native_1',
          sessionID: SESSION,
          role: 'user',
          time: { created: BASE_TIME + 60_005 },
        },
        parts: [
          {
            type: 'text',
            text: '<subagent sessionID="child-done" state="completed" description="map hooks">\ndone\n</subagent>',
            metadata: {
              source: 'subagent',
              childID: 'child-done',
              state: 'completed',
            },
          },
        ],
      },
      userMsg('msg_u_off_2', 'next step', BASE_TIME + 2),
    ]);
    expect(board.getState('child-done')).toBe('reconciled');
    expect(board.getState('child-stopped')).toBe('stopped');
    expect(board.get('child-stopped')).toMatchObject({
      terminalUnreconciled: true,
    });
  });

  test('v2: an undated trusted delivery cannot retire a terminal job', async () => {
    const board = new BackgroundJobBoard();
    board.registerLaunch({
      taskID: 'child-undated',
      parentSessionID: SESSION,
      agent: 'explorer',
      description: 'map hooks',
    });
    board.updateStatus({
      taskID: 'child-undated',
      state: 'completed',
      resultSummary: 'done',
      now: BASE_TIME + 60_000,
    });
    const hook = createHook(board, 'v2');

    await runTurn(hook, [
      userMsg('msg_u_off_1', 'Coordinate the refactor work', BASE_TIME),
      {
        info: {
          id: 'msg_native_undated',
          sessionID: SESSION,
          role: 'user',
        },
        parts: [
          {
            type: 'text',
            text: '<subagent sessionID="child-undated" state="completed" description="map hooks">\ndone\n</subagent>',
            metadata: {
              source: 'subagent',
              childID: 'child-undated',
              state: 'completed',
            },
          },
        ],
      },
      userMsg('msg_u_off_2', 'next step', BASE_TIME + 2),
    ]);

    expect(board.getState('child-undated')).toBe('completed');
  });
});
