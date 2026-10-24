/**
 * Reopen corrective notice for reconciled background jobs.
 *
 * When a job whose terminal report the parent already consumed (reconciled)
 * reopens to running — typically a child session resumed by its own
 * background-shell notification — the parent's conversation still carries
 * the earlier "completed" report. The board will show the job as running
 * again on the next request, but nothing tells the parent that its earlier
 * terminal report is superseded.
 *
 * The corrective notice closes that gap: the parent's next eligible request
 * appends EXACTLY ONE trailing volatile message (cache-safe tail zone via
 * appendTrailingVolatileMessage, tagged with the board metadata key), and
 * the reported run is retired. Bookkeeping is pruned when the parent ends.
 */
import { describe, expect, test } from 'bun:test';
import { BackgroundJobBoard } from '../../utils/background-job-fixture';
import { isVolatileTaggedMessage } from '../cache-safe-injection';
import {
  BACKGROUND_JOB_BOARD_METADATA_KEY,
  type InjectionState,
  injectBackgroundJobBoard,
  pruneReopenCorrectionState,
  reconcileObservedTerminalRun,
} from './board-injection';

const SESSION = 'ses_parent_1';
const BASE_TIME = 1752968000000;

function userMsg(id: string, text: string, createdAt: number) {
  return {
    info: {
      id,
      sessionID: SESSION,
      role: 'user',
      agent: 'orchestrator',
      time: { created: createdAt },
    },
    parts: [{ type: 'text', text }],
  };
}

function createInjectionState(
  board: BackgroundJobBoard,
  hostFlavor?: string,
): InjectionState {
  return {
    backgroundJobBoard: board,
    terminalGate: {} as never,
    lifecycleLedger: {} as never,
    hostFlavor,
    processedInjectedCompletions: new Set(),
    processedInjectedCompletionOrder: [],
    metadataKey: BACKGROUND_JOB_BOARD_METADATA_KEY,
    shouldManageSession: () => true,
    taskContextTracker: {
      pendingManagedTaskIds: new Set(),
      contextFilesForPrompt: () => [],
      prune: () => {},
    },
  } as unknown as InjectionState;
}

/** Terminal-part metadata of a message, when it has exactly one part. */
function solePartMetadata(
  message: unknown,
): Record<string, unknown> | undefined {
  const parts = (message as { parts?: Array<Record<string, unknown>> })?.parts;
  if (parts?.length !== 1) return undefined;
  return parts[0]?.metadata as Record<string, unknown> | undefined;
}

function reconciledAndRelaunched() {
  const board = new BackgroundJobBoard();
  const state = createInjectionState(board);
  const first = board.registerLaunch({
    taskID: 'child-1',
    parentSessionID: SESSION,
    agent: 'explorer',
    description: 'first run',
  });
  board.updateStatus({ taskID: 'child-1', state: 'completed' });
  // The parent observed the terminal run (host delivery or push delta):
  // that observation is what retires it and arms the reopen correction.
  reconcileObservedTerminalRun(state, SESSION, {
    taskID: 'child-1',
    generation: first.generation,
    terminalRevision: 1,
  });
  const second = board.registerLaunch({
    taskID: 'child-1',
    parentSessionID: SESSION,
    agent: 'explorer',
    description: 'second run',
  });
  return { board, state, first, second };
}

describe('reopen corrective notice', () => {
  test('a reconciled job reopening to running gets exactly ONE trailing volatile correction', async () => {
    const board = new BackgroundJobBoard();
    const state = createInjectionState(board);

    board.registerLaunch({
      taskID: 'child-1',
      parentSessionID: SESSION,
      agent: 'explorer',
      description: 'map hooks',
    });
    board.updateStatus({
      taskID: 'child-1',
      state: 'completed',
      resultSummary: 'mapped hooks',
    });

    // The parent consumed the completion report...
    reconcileObservedTerminalRun(state, SESSION, {
      taskID: 'child-1',
      generation: 1,
      terminalRevision: 1,
    });
    expect(board.getState('child-1')).toBe('reconciled');

    // ...then the child session became busy again (board reopens running).
    // A strictly-fresh timestamp is required: the board guards against
    // stale observations (now <= completedAt) reopening a terminal record.
    board.markRunningFromLiveSession('child-1', Date.now() + 60_000);
    expect(board.getState('child-1')).toBe('running');

    const request = {
      messages: [structuredClone(userMsg('msg_u1', 'continue', BASE_TIME))],
    };
    await injectBackgroundJobBoard(state, {}, request as never);

    const correction = (request.messages as unknown[]).find(
      (message) =>
        solePartMetadata(message)?.[
          'oh-my-opencode-slim.backgroundJobBoard'
        ] === true &&
        (solePartMetadata(message)?.reopenCorrection as boolean) === true,
    );
    expect(correction).toBeDefined();
    // Cache safety: the correction is a trailing volatile tagged message.
    expect(
      isVolatileTaggedMessage(correction, BACKGROUND_JOB_BOARD_METADATA_KEY),
    ).toBe(true);
    expect((request.messages as unknown[]).at(-1)).toBe(correction);
    const text = (correction as { parts: Array<{ text: string }> }).parts[0]
      .text;
    expect(text).toContain('child-1');
    expect(text).toContain('running again');
    expect(text).toContain('superseded');

    // Exactly one: the next request must not repeat the correction.
    const request2 = {
      messages: [structuredClone(userMsg('msg_u1', 'continue', BASE_TIME))],
    };
    await injectBackgroundJobBoard(state, {}, request2 as never);
    const repeats = (request2.messages as unknown[]).filter(
      (message) => solePartMetadata(message)?.reopenCorrection === true,
    );
    expect(repeats).toHaveLength(0);
  });

  test('a plain running job with no reconciled history gets no correction', async () => {
    const board = new BackgroundJobBoard();
    const state = createInjectionState(board);

    board.registerLaunch({
      taskID: 'child-fresh',
      parentSessionID: SESSION,
      agent: 'explorer',
      description: 'first run',
    });

    const request = {
      messages: [structuredClone(userMsg('msg_u1', 'continue', BASE_TIME))],
    };
    await injectBackgroundJobBoard(state, {}, request as never);
    const corrections = (request.messages as unknown[]).filter(
      (message) => solePartMetadata(message)?.reopenCorrection === true,
    );
    expect(corrections).toHaveLength(0);
  });

  test('a superseded generation is pruned without a reopen correction', async () => {
    const { state, first } = reconciledAndRelaunched();
    const request = {
      messages: [structuredClone(userMsg('msg_u1', 'continue', BASE_TIME))],
    };
    await injectBackgroundJobBoard(state, {}, request as never);

    const corrections = (request.messages as unknown[]).filter(
      (message) => solePartMetadata(message)?.reopenCorrection === true,
    );
    expect(corrections).toHaveLength(0);
    expect(
      state.reportedTerminalRunsByParent
        ?.get(SESSION)
        ?.has(`child-1:${first.generation}`) ?? false,
    ).toBe(false);
  });

  test('pruning a superseded generation preserves a later live reopen', async () => {
    const { board, state, second } = reconciledAndRelaunched();
    const initial = {
      messages: [structuredClone(userMsg('msg_u1', 'continue', BASE_TIME))],
    };
    await injectBackgroundJobBoard(state, {}, initial as never);

    board.updateStatus({ taskID: 'child-1', state: 'completed' });
    reconcileObservedTerminalRun(state, SESSION, {
      taskID: 'child-1',
      generation: second.generation,
      terminalRevision: 1,
    });
    // A request while gen2 is still reconciled must keep its live entry.
    await injectBackgroundJobBoard(state, {}, {
      messages: [structuredClone(userMsg('msg_u2', 'continue', BASE_TIME + 1))],
    } as never);
    board.markRunningFromLiveSession('child-1', Date.now() + 60_000);

    const request = {
      messages: [
        structuredClone(userMsg('msg_u2', 'continue', BASE_TIME + 1)),
        {
          info: {
            id: 'msg_a2',
            sessionID: SESSION,
            role: 'assistant',
            agent: 'orchestrator',
            time: { created: BASE_TIME + 2 },
          },
          parts: [{ type: 'text', text: 'acknowledged' }],
        },
      ],
    };
    await injectBackgroundJobBoard(state, {}, request as never);
    const corrections = (request.messages as unknown[]).filter(
      (message) => solePartMetadata(message)?.reopenCorrection === true,
    ) as Array<{ parts: Array<{ text: string }> }>;
    expect(corrections).toHaveLength(1);
    expect(corrections[0]?.parts[0]?.text).toContain(
      `run ${second.generation} / previously completed, now running`,
    );
    // Change-only: an assistant tail places no board (A5 skip), so the
    // corrective notice is the trailing message — the board defers to the
    // next user-side tail. (The correction part itself carries the board
    // metadata key plus reopenCorrection; a board PLACEMENT would carry the
    // key without the correction flag.)
    expect((request.messages as unknown[]).at(-1)).toBe(corrections[0]);
    expect(
      (request.messages as unknown[]).some((message) => {
        const meta = solePartMetadata(message);
        return (
          meta?.[BACKGROUND_JOB_BOARD_METADATA_KEY] && !meta?.reopenCorrection
        );
      }),
    ).toBe(false);
  });

  test('prune on parent end drops a live reported run', async () => {
    const board = new BackgroundJobBoard();
    const state = createInjectionState(board);

    board.registerLaunch({
      taskID: 'child-1',
      parentSessionID: SESSION,
      agent: 'oracle',
      description: 'review plan',
    });
    board.updateStatus({
      taskID: 'child-1',
      state: 'error',
      resultSummary: 'boom',
    });
    reconcileObservedTerminalRun(state, SESSION, {
      taskID: 'child-1',
      generation: 1,
      terminalRevision: 1,
    });
    board.markRunningFromLiveSession('child-1', Date.now() + 60_000);
    expect(board.getState('child-1')).toBe('running');
    expect(state.reportedTerminalRunsByParent?.get(SESSION)?.size).toBe(1);

    // Parent session ends before the reopen correction can be delivered.
    pruneReopenCorrectionState(state, SESSION);

    const request = {
      messages: [structuredClone(userMsg('msg_u1', 'continue', BASE_TIME))],
    };
    await injectBackgroundJobBoard(state, {}, request as never);
    const corrections = (request.messages as unknown[]).filter(
      (message) => solePartMetadata(message)?.reopenCorrection === true,
    );
    expect(corrections).toHaveLength(0);
  });

  test('v2 boardless hosts deliver the correction on the tail too', async () => {
    const board = new BackgroundJobBoard();
    const state = createInjectionState(board, 'v2');

    board.registerLaunch({
      taskID: 'child-1',
      parentSessionID: SESSION,
      agent: 'explorer',
      description: 'map hooks',
    });
    board.updateStatus({
      taskID: 'child-1',
      state: 'completed',
      resultSummary: 'mapped hooks',
    });
    reconcileObservedTerminalRun(state, SESSION, {
      taskID: 'child-1',
      generation: 1,
      terminalRevision: 1,
    });
    board.markRunningFromLiveSession('child-1', Date.now() + 60_000);

    const request = {
      messages: [structuredClone(userMsg('msg_u1', 'continue', BASE_TIME))],
    };
    await injectBackgroundJobBoard(state, {}, request as never);

    const correction = (request.messages as unknown[]).find(
      (message) => solePartMetadata(message)?.reopenCorrection === true,
    );
    expect(correction).toBeDefined();
    expect(
      isVolatileTaggedMessage(correction, BACKGROUND_JOB_BOARD_METADATA_KEY),
    ).toBe(true);
    expect((request.messages as unknown[]).at(-1)).toBe(correction);
  });
});

describe('boardless hosts (v1 and v2)', () => {
  test('the reopen correction delivers in the board-free variant (#1443 review)', async () => {
    const board = new BackgroundJobBoard();
    const state = createInjectionState(board, 'v2');

    board.registerLaunch({
      taskID: 'child-1',
      parentSessionID: SESSION,
      agent: 'explorer',
      description: 'map hooks',
    });
    board.updateStatus({
      taskID: 'child-1',
      state: 'completed',
      resultSummary: 'mapped hooks',
    });
    reconcileObservedTerminalRun(state, SESSION, {
      taskID: 'child-1',
      generation: 1,
      terminalRevision: 1,
    });
    expect(board.getState('child-1')).toBe('reconciled');
    board.markRunningFromLiveSession('child-1', Date.now() + 60_000);
    expect(board.getState('child-1')).toBe('running');

    const request = {
      messages: [structuredClone(userMsg('msg_u1', 'continue', BASE_TIME))],
    };
    await injectBackgroundJobBoard(state, {}, request as never);

    // The staleness correction still delivers — the native notifier covers
    // terminal publications, not the reopen-to-running transition — but in
    // the board-free wording: no board reference, task_status pointer.
    const corrections = (request.messages as unknown[]).filter(
      (message) => solePartMetadata(message)?.reopenCorrection === true,
    );
    expect(corrections).toHaveLength(1);
    expect(
      (request.messages as unknown[]).some((message) =>
        JSON.stringify(message).includes('Background Job Board'),
      ),
    ).toBe(false);
    const correctionText = (
      corrections[0] as { parts: Array<{ text: string }> }
    ).parts[0].text;
    expect(correctionText).toContain('superseded');
    expect(correctionText).toContain('`task_status`');
    expect((request.messages as unknown[]).at(-1)).toBe(corrections[0]);
  });

  test('every host delivers the correction without any board reference', async () => {
    // The board no longer exists on any host (issue #1647), so the
    // correction always uses the pull-channel wording.
    const board = new BackgroundJobBoard();
    const state = createInjectionState(board);

    board.registerLaunch({
      taskID: 'child-1',
      parentSessionID: SESSION,
      agent: 'explorer',
      description: 'map hooks',
    });
    board.updateStatus({
      taskID: 'child-1',
      state: 'completed',
      resultSummary: 'mapped hooks',
    });
    reconcileObservedTerminalRun(state, SESSION, {
      taskID: 'child-1',
      generation: 1,
      terminalRevision: 1,
    });
    board.markRunningFromLiveSession('child-1', Date.now() + 60_000);
    expect(board.getState('child-1')).toBe('running');

    const request = {
      messages: [structuredClone(userMsg('msg_u1', 'continue', BASE_TIME))],
    };
    await injectBackgroundJobBoard(state, {}, request as never);

    const corrections = (request.messages as unknown[]).filter(
      (message) => solePartMetadata(message)?.reopenCorrection === true,
    );
    expect(corrections).toHaveLength(1);
    expect(
      (request.messages as unknown[]).some((message) =>
        JSON.stringify(message).includes('Background Job Board'),
      ),
    ).toBe(false);
    const correctionText = (
      corrections[0] as { parts: Array<{ text: string }> }
    ).parts[0].text;
    expect(correctionText).toContain('superseded');
    expect(correctionText).toContain('`task_status`');
    expect((request.messages as unknown[]).at(-1)).toBe(corrections[0]);
  });
});
