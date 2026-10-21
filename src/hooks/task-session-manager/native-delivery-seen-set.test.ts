import { describe, expect, test } from 'bun:test';
import { BackgroundJobBoard } from '../../utils/background-job-fixture';
import {
  BACKGROUND_JOB_BOARD_METADATA_KEY,
  type InjectionState,
  injectBackgroundJobBoard,
} from './board-injection';

const PARENT_SESSION_ID = 'ses_parent_1';
const SEEN_CAP = 1024; // Mirrors NATIVE_DELIVERY_SEEN_CAP in board-injection.ts.

function createInjectionState(board: BackgroundJobBoard): InjectionState {
  return {
    backgroundJobBoard: board,
    terminalGate: {} as never,
    lifecycleLedger: {} as never,
    hostFlavor: 'v2',
    processedInjectedCompletions: new Set(),
    processedInjectedCompletionOrder: [],
    terminalJobsInjectedByParent: new Map(),
    pendingInjectedTerminalJobsByParent: new Map(),
    metadataKey: BACKGROUND_JOB_BOARD_METADATA_KEY,
    shouldManageSession: () => true,
    taskContextTracker: {
      pendingManagedTaskIds: new Set(),
      contextFilesForPrompt: () => [],
      prune: () => {},
    },
    retainedTailBoards: new Map(),
  } as unknown as InjectionState;
}

function deliveryMessage(index: number) {
  return {
    info: {
      id: `delivery-${index}`,
      sessionID: PARENT_SESSION_ID,
      role: 'user',
      time: { created: 1_800_000_000_000 + index },
    },
    parts: [
      {
        type: 'text',
        text: `<subagent sessionID="child-1" state="error" description="map hooks">\nfailed ${index}\n</subagent>`,
        metadata: { source: 'subagent', childID: 'child-1', state: 'error' },
      },
    ],
  };
}

function deliveryIndexes(seen: Map<string, true> | undefined): number[] {
  if (!seen) throw new Error('Expected a seen-set map for the parent');
  return [...seen.keys()].map((key) => {
    const match = /^delivery-(\d+):/.exec(key);
    if (!match) throw new Error(`Unexpected native-delivery key: ${key}`);
    return Number(match[1]);
  });
}

describe('native delivery seen-set LRU', () => {
  test('bounds each parent to 1024 keys and refreshes recency on a seen hit', async () => {
    const board = new BackgroundJobBoard();
    board.registerLaunch({
      taskID: 'child-1',
      parentSessionID: PARENT_SESSION_ID,
      agent: 'explorer',
      description: 'map hooks',
    });
    // Mismatched terminal state remembers every delivery without retiring the
    // record, letting this test exercise the full cap through the public path.
    board.updateStatus({
      taskID: 'child-1',
      state: 'completed',
      resultSummary: 'done',
    });
    const state = createInjectionState(board);
    const inject = (messages: unknown[]) =>
      injectBackgroundJobBoard(state, {}, { messages });

    await inject(
      Array.from({ length: SEEN_CAP + 1 }, (_, index) =>
        deliveryMessage(index + 1),
      ),
    );
    let seen = state.observedNativeDeliveries?.get(PARENT_SESSION_ID);
    expect(seen?.size).toBe(SEEN_CAP);
    expect(deliveryIndexes(seen)).toEqual(
      Array.from({ length: SEEN_CAP }, (_, index) => index + 2),
    );

    // Replaying the oldest retained key touches it; the next insertion evicts
    // the next-oldest key instead.
    await inject([deliveryMessage(2)]);
    await inject([deliveryMessage(SEEN_CAP + 2)]);
    seen = state.observedNativeDeliveries?.get(PARENT_SESSION_ID);
    expect(seen?.size).toBe(SEEN_CAP);
    expect(deliveryIndexes(seen)).toEqual([
      ...Array.from({ length: SEEN_CAP - 2 }, (_, index) => index + 4),
      2,
      SEEN_CAP + 2,
    ]);
  });

  test('re-observing an evicted reconciled delivery stays a no-op', async () => {
    const board = new BackgroundJobBoard();

    board.registerLaunch({
      taskID: 'child-reconciled',
      parentSessionID: PARENT_SESSION_ID,
      agent: 'explorer',
      description: 'map hooks',
    });
    board.updateStatus({
      taskID: 'child-reconciled',
      state: 'completed',
      resultSummary: 'done',
    });

    board.registerLaunch({
      taskID: 'child-1',
      parentSessionID: PARENT_SESSION_ID,
      agent: 'explorer',
      description: 'map hooks',
    });
    board.updateStatus({
      taskID: 'child-1',
      state: 'completed',
      resultSummary: 'done',
    });

    const originalMarkReconciled = board.markReconciled.bind(board);
    let reconcileCount = 0;
    board.markReconciled = ((
      ...args: Parameters<typeof board.markReconciled>
    ) => {
      reconcileCount += 1;
      return originalMarkReconciled(...args);
    }) as typeof board.markReconciled;

    const state = createInjectionState(board);
    const completedDelivery = {
      info: {
        id: 'delivery-1',
        sessionID: PARENT_SESSION_ID,
        role: 'user',
        time: { created: 1_800_000_000_001 },
      },
      parts: [
        {
          type: 'text',
          text: '<subagent sessionID="child-reconciled" state="completed" description="map hooks">\ndone\n</subagent>',
          metadata: {
            source: 'subagent',
            childID: 'child-reconciled',
            state: 'completed',
          },
        },
      ],
    };

    await injectBackgroundJobBoard(
      state,
      {},
      {
        messages: [
          completedDelivery,
          ...Array.from({ length: SEEN_CAP + 1 }, (_, index) =>
            deliveryMessage(index + 1),
          ),
        ],
      },
    );

    expect(board.getState('child-reconciled')).toBe('reconciled');
    expect(reconcileCount).toBe(1);

    await injectBackgroundJobBoard(
      state,
      {},
      {
        messages: [completedDelivery],
      },
    );

    expect(board.getState('child-reconciled')).toBe('reconciled');
    expect(reconcileCount).toBe(1);
  });
});
