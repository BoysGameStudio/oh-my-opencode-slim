/**
 * Board injection subsystem for task session manager.
 *
 * Handles injecting Background Job Board state into the message stream
 * and processing synthetic injected completions.
 *
 * All injection logic must go through the cache-safe helpers in
 * ../cache-safe-injection.ts to ensure prompt cache safety.
 */
import { createHash } from 'node:crypto';
import { formatSystemReminder } from '../../config/constants';
import type {
  BackgroundJobExecution,
  BackgroundJobInjectedCompletionFence,
  BackgroundJobLifecycleLedger,
  BackgroundJobRecord,
  BackgroundJobStore,
  BackgroundJobSyntheticTerminalOccurrence,
  BackgroundJobSyntheticTerminalOccurrencePhase,
  ContextFile,
  TaskStatusOutput,
} from '../../utils';
import {
  isInternalInitiatorPart,
  parseTaskIdFromTaskOutput,
  parseTaskStateFromOutput,
  parseTaskStatusOutput,
  renderRunningTaskPlaceholder,
} from '../../utils';
import type { BackgroundJobTerminalGate } from '../../utils/background-job-terminal-gate';
import { isRecord } from '../../utils/guards';
import { log } from '../../utils/logger';
import {
  appendTaggedSyntheticPart,
  appendTrailingVolatileMessage,
  hasTaggedPart,
  isTaggedPart,
  isVolatileTaggedMessage,
} from '../cache-safe-injection';
import type { MessagePart, MessageWithParts } from '../types';
import { isMessageWithParts, isUserMessageWithParts } from '../types';
import {
  messageCreatedAt,
  NATIVE_DELIVERY_STATES,
  type NativeDelivery,
  parseNativeDelivery,
} from './native-delivery';
import { extractTaskSummary, isLateCancelledTaskError } from './status-utils';

// ── Constants ──────────────────────────────────────────────────────────

export const BACKGROUND_JOB_BOARD_METADATA_KEY =
  'oh-my-opencode-slim.backgroundJobBoard';

const BACKGROUND_COMPLETION_COMPLETED = /^Background task completed: /;
const BACKGROUND_COMPLETION_FAILED = /^Background task failed: /;

/**
 * A board the change-only scheme has already placed (and therefore already
 * sent to the provider) on a specific anchor message. Replayed byte-identically
 * on every later request once that anchor is no longer the tail, so a board
 * that was sent on a message the provider has cached never disappears.
 *
 * Only a board that rode as a trailing PART on a USER anchor is retained:
 * it can be reproduced without inserting a message mid-array (A1) or grafting
 * board text onto a non-user message (A3).
 */
type RetainedTailBoard = {
  anchorId: string;
  text: string;
};

type BoardAnchor = {
  message: MessageWithParts;
  id: string;
};

// ── State shape ────────────────────────────────────────────────────────

export type InjectedTerminalJobs = {
  executions: Map<string, BackgroundJobExecution>;
  /** Prompt shape when these executions were last surfaced to the model. */
  promptShapeKey: string;
};

export type InjectedCompletionFence = BackgroundJobInjectedCompletionFence;

export type SyntheticTerminalOccurrencePhase =
  BackgroundJobSyntheticTerminalOccurrencePhase;

export type SyntheticTerminalOccurrenceOrigin =
  BackgroundJobSyntheticTerminalOccurrence;

type SyntheticTerminalOccurrenceLookup =
  | {
      kind: 'matched';
      origin: SyntheticTerminalOccurrenceOrigin;
    }
  | {
      kind: 'ambiguous';
      reason: string;
    };

type SyntheticTerminalProvenanceKind = 'explicit' | 'host-message' | 'legacy';

/** A terminal run the parent consumed (reconciled): reused to detect a
 * reopen-to-running of the same run, which needs a corrective notice. */
type ReportedTerminalRun = {
  taskID: string;
  generation: number;
  /** Terminal state the parent saw (completed | error | cancelled). */
  terminalState?: string;
};

/** A corrective notice delivered on the parent's next eligible request. */
type ReopenCorrection = {
  taskID: string;
  generation: number;
  alias: string;
  priorTerminalState: string;
};

function reportedRunKey(taskID: string, generation: number): string {
  return `${taskID}:${generation}`;
}

/** Corrective notice text for a reconciled job that reopened to running.
 * Matches the board's system-reminder tone; carries the job identity and
 * the supersession verdict inline. */
export function formatReopenCorrectionText(
  correction: ReopenCorrection,
): string {
  return formatSystemReminder(
    [
      '### Background Job Board — Reopened Job',
      'A background job that previously reported a terminal result is running again; the earlier report is superseded.',
      `- ${correction.alias} / ${correction.taskID} / run ${correction.generation} / previously ${correction.priorTerminalState}, now running`,
      'Consult the Background Job Board for the current state before acting on the earlier result.',
    ].join('\n'),
  );
}

/** Board-injection-off variant of the reopen correction: same facts, but
 * the pointer goes to the pull channel (the board is not injected in this
 * mode, so pointing at it would reference a panel the model cannot see).
 * The correction itself is a staleness notice, not board status — the
 * native notifier covers terminal publications, not the reopen-to-running
 * transition (#1314's anti-narration scope is board status lines). */
export function formatReopenCorrectionTextNoBoard(
  correction: ReopenCorrection,
): string {
  return formatSystemReminder(
    [
      '### Background Job — Reopened',
      'A background job that previously reported a terminal result is running again; the earlier report is superseded.',
      `- ${correction.alias} / ${correction.taskID} / run ${correction.generation} / previously ${correction.priorTerminalState}, now running`,
      'Check `task_status` for the current state before acting on the earlier result.',
    ].join('\n'),
  );
}

/** Record that the parent consumed (reconciled) a terminal run, so a later
 * reopen-to-running of the same run can be corrected. */
function rememberReportedTerminalRun(
  state: InjectionState,
  parentSessionID: string,
  run: ReportedTerminalRun,
): void {
  const reported = state.reportedTerminalRunsByParent?.get(parentSessionID);
  if (reported) {
    reported.set(reportedRunKey(run.taskID, run.generation), run);
    return;
  }
  const map = new Map<string, ReportedTerminalRun>([
    [reportedRunKey(run.taskID, run.generation), run],
  ]);
  if (state.reportedTerminalRunsByParent) {
    state.reportedTerminalRunsByParent.set(parentSessionID, map);
  } else {
    state.reportedTerminalRunsByParent = new Map([[parentSessionID, map]]);
  }
}

/**
 * Deliver corrections for reported runs that reopened to running. Retire
 * delivered runs and prune runs whose job left the board or was superseded by
 * a newer generation. Called at injection time to reflect the current board
 * without a separate event seam on the board store.
 */
function deliverReopenCorrections(
  state: InjectionState,
  parentSessionID: string,
  messages: unknown[],
  baseInfo: MessageWithParts['info'],
): void {
  const reported = state.reportedTerminalRunsByParent?.get(parentSessionID);
  if (!reported || reported.size === 0) return;
  for (const [key, run] of reported) {
    const record = state.backgroundJobBoard.get(run.taskID);
    if (record?.generation === run.generation && record.state !== 'running') {
      continue;
    }
    reported.delete(key);
    if (!record || record.generation !== run.generation) continue;

    const correction: ReopenCorrection = {
      taskID: run.taskID,
      generation: run.generation,
      alias: record.alias,
      priorTerminalState: run.terminalState ?? 'completed',
    };
    log('[task-session-manager] queued reopen corrective notice', {
      parentSessionID,
      taskID: run.taskID,
      generation: run.generation,
      priorTerminalState: correction.priorTerminalState,
    });
    appendTrailingVolatileMessage(
      messages,
      {
        ...baseInfo,
        id: `${baseInfo.id ?? 'board'}-reopen-correction:${key}`,
      },
      {
        text:
          state.hostFlavor === 'v2' || state.boardInjection === false
            ? formatReopenCorrectionTextNoBoard(correction)
            : formatReopenCorrectionText(correction),
        metadataKey: state.metadataKey,
        extraMetadata: { reopenCorrection: true },
      },
    );
  }
  if (reported.size === 0) {
    state.reportedTerminalRunsByParent?.delete(parentSessionID);
  }
}

/**
 * Prune reopen-correction bookkeeping for a parent session (session end).
 * Reported runs must never surface in a recreated session.
 */
export function pruneReopenCorrectionState(
  state: InjectionState,
  parentSessionID: string,
): void {
  state.reportedTerminalRunsByParent?.delete(parentSessionID);
  // Delivery keys are content-addressed, so a stale key can never
  // mis-retire a recreated session — but retaining them leaks memory for
  // dead parents. Keys for a recreated session are fresh message IDs.
  state.observedNativeDeliveries?.delete(parentSessionID);
  // Same for the change-only digest: a recreated session must start with
  // no injected history, so its first board renders fresh.
  state.lastInjectedBoardTextByParent?.delete(parentSessionID);
}

const HOST_MESSAGE_OCCURRENCE_PREFIX = 'host-message:';

export interface InjectionState {
  backgroundJobBoard: BackgroundJobStore;
  terminalGate: BackgroundJobTerminalGate;
  lifecycleLedger: BackgroundJobLifecycleLedger;
  processedInjectedCompletions: Set<string>;
  processedInjectedCompletionOrder: string[];
  /**
   * Completion occurrences persist with the board so a recreated hook cannot
   * replay an old synthetic result into a newer task generation.
   */
  injectedCompletionFences?: Map<string, InjectedCompletionFence>;
  /**
   * Synthetic terminal parts observed by the runtime event stream. This is
   * separate from processed fences because an event may arrive before the
   * message transform that consumes the part.
   */
  syntheticTerminalOccurrences?: Map<string, SyntheticTerminalOccurrenceOrigin>;
  syntheticTerminalOccurrenceOrder?: string[];
  getLifecycleEpoch?: () => number;
  getDeletionEpoch?: (taskID: string) => number | undefined;
  terminalJobsInjectedByParent: Map<string, InjectedTerminalJobs>;
  pendingInjectedTerminalJobsByParent: Map<
    string,
    Map<string, BackgroundJobExecution>
  >;
  /**
   * Native v2 delivery parts already consumed by the observer
   * (`reconcileObservedNativeDeliveries`), keyed by parent session, then by
   * the delivery part's own message/part identity (byte-stable, persisted in
   * history) — never by prompt shape. Keys are consumed only once the
   * delivery can actually act (retire, or is provably stale vs
   * lastLaunchedAt, or its record already reconciled), so a delivery
   * observed while its record is still running retries on the next
   * transform. Per parent the keys are an LRU (cap
   * `NATIVE_DELIVERY_SEEN_CAP`): re-observation refreshes recency and the
   * oldest key is evicted, so a pathological history cannot grow the set
   * without bound while the deliveries a parent's history actually still
   * replays stay remembered. An eviction only re-opens the one-shot pairing
   * window for the oldest keys, which the reopen gate and the stale-terminal
   * fallback still cover. The whole per-parent set dies with the parent at
   * session end (pruneReopenCorrectionState). Optional for states built
   * before the field existed.
   */
  observedNativeDeliveries?: Map<string, Map<string, true>>;
  /** Host flavor marker ('v2' on OpenCode v2 hosts). v2 is structurally
   *  boardless: observation-based retirement plus reopen corrections only.
   *  v1 renders the board unless boardInjection is honoured-off. */
  hostFlavor?: string;
  /** v1-only honoured switch (schema default true; RuntimeConfig forces
   *  false on v2, so on v2 this field is always false and the dispatch
   *  already returned). `false` on v1 = boardless: no board part is
   *  placed and terminal retirement runs through prompt-shape consumption
   *  (covers cancelled, which has no native delivery and no timestamp
   *  fallback). */
  boardInjection?: boolean;
  /**
   * Last board text injected per parent session — the change-only digest.
   * A fresh tail board is placed only when the rendered text differs; an
   * unchanged digest replays frozen boards and reconciles consumed terminal
   * jobs but places nothing new (unchanged turns carry zero new
   * information). Cleared at session end (pruneReopenCorrectionState) so a
   * recreated session renders fresh. Optional for states built before the
   * field existed.
   */
  lastInjectedBoardTextByParent?: Map<string, string>;
  /**
   * Terminal runs this parent has already consumed (reconciled through
   * `reconcileExecutionBatch`), keyed `${taskID}:${generation}`. Used to
   * detect a reconciled job REOPENING to running (typically a child session
   * resumed by its own background-shell notification): the parent's
   * conversation still carries the earlier terminal report, so the reopen
   * needs a corrective trailing notice. Delivered runs and superseded
   * generations are retired on the next eligible request. Optional for
   * states built before the field existed.
   */
  reportedTerminalRunsByParent?: Map<string, Map<string, ReportedTerminalRun>>;
  metadataKey: string;
  shouldManageSession: (sessionID: string) => boolean;
  taskContextTracker: {
    pendingManagedTaskIds: Set<string>;
    contextFilesForPrompt(taskId: string): ContextFile[];
    prune(board: { taskIDs(): Set<string> }): void;
  };
  /**
   * Per-session log of boards the change-only scheme has placed on real
   * anchor messages, keyed by anchor message id. Once an anchor is no longer
   * the tail its board is replayed byte-identically every later request, so a
   * board sent on a now-mid-history message is never stripped (which would
   * rewrite already cached bytes and bust the provider prompt-cache prefix
   * from that message onward - the field bust in dumps 000086->000087).
   */
  retainedTailBoards: Map<string, Map<string, RetainedTailBoard>>;
}

// ── Helpers ────────────────────────────────────────────────────────────

function djb2Hash(str: string): string {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = (hash << 5) + hash + str.charCodeAt(i);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function sha256Hash(str: string): string {
  return createHash('sha256').update(str).digest('hex');
}

/**
 * True when board text may ride on this message as a trailing PART.
 *
 * Board text may ONLY ever be appended to a `user` message. This is the single
 * hard requirement behind the `AI_InvalidPromptError` this guard exists to
 * prevent, and it is a property of the host's message conversion:
 *
 * - the USER branch of `MessageV2.toModelMessagesEffect` copies text parts as
 *   `{ type: 'text', text }` and DISCARDS `part.metadata`;
 * - the ASSISTANT branch copies it as
 *   `{ type: 'text', text, providerMetadata: part.metadata }`, which
 *   `convertToModelMessages` then forwards as `providerOptions`.
 *
 * `providerOptions` is validated as `Record<string, Record<string, JSONValue>>`.
 * A board part's metadata is `{ '<metadataKey>': true }` — a boolean, not a
 * nested record — so any board text landing on an assistant-role message fails
 * `ModelMessage[]` validation and aborts the request before it is sent.
 *
 * Tool parts do not disqualify a user message: the user branch of the converter
 * only emits text/file/compaction/subtask parts, so a user message's tool parts
 * never become tool-call or tool-result content and cannot be separated from a
 * pairing by appended text. Keeping such anchors eligible is what preserves the
 * #889 tail-breakpoint placement (A4).
 */
function canCarryBoardPart(message: MessageWithParts): boolean {
  return message.info.role === 'user';
}

function createOccurrenceId(
  part: MessagePart,
  message: MessageWithParts,
  partIndex: number,
): string {
  const explicitOccurrenceID = getExplicitOccurrenceID(part);
  if (explicitOccurrenceID) {
    return explicitOccurrenceID;
  }

  const sessionID = message.info.sessionID ?? 'unknown';
  const content = typeof part.text === 'string' ? part.text : '';

  const status = parseTaskStatusOutput(content);
  if (status) {
    const messageID = getCanonicalHostMessageID(part, message);
    if (messageID) {
      return hostMessageOccurrenceID(messageID, status.taskID, content);
    }

    if (typeof message.info.id === 'string') {
      return `${message.info.id}:${partIndex}`;
    }

    const stableKey = `${sessionID}:${status.taskID}:${status.state}:${status.result ?? ''}`;
    const hash = djb2Hash(stableKey);
    return `anon:${hash}`;
  }

  if (typeof message.info.id === 'string') {
    return `${message.info.id}:${partIndex}`;
  }

  const hash = djb2Hash(`${sessionID}:${content}`);
  return `anon:${hash}`;
}

function injectedCompletionKey(
  taskID: string,
  occurrenceId: string,
  provenanceKind: SyntheticTerminalProvenanceKind,
): string {
  return `${provenanceKind}\u001f${taskID}\u001f${occurrenceId}`;
}

function hasProvenanceKind(
  key: string,
  taskID: string,
  provenanceKind: SyntheticTerminalProvenanceKind,
): boolean {
  return key.startsWith(`${provenanceKind}\u001f${taskID}\u001f`);
}

function getExplicitOccurrenceID(part: MessagePart): string | undefined {
  for (const key of ['occurrenceID', 'occurrenceId', 'id']) {
    const value = part[key];
    if (typeof value === 'string' && value.trim() !== '') return value;
  }
  return undefined;
}

function getHostMessageID(part: MessagePart): string | undefined {
  return typeof part.messageID === 'string' && part.messageID.trim() !== ''
    ? part.messageID
    : undefined;
}

function getCanonicalHostMessageID(
  part: MessagePart,
  message?: MessageWithParts,
): string | undefined {
  return (
    getHostMessageID(part) ??
    (typeof message?.info.id === 'string' && message.info.id.trim() !== ''
      ? message.info.id
      : undefined)
  );
}

function hostMessageOccurrenceID(
  messageID: string,
  taskID: string,
  terminalPayload: string,
): string {
  return `${HOST_MESSAGE_OCCURRENCE_PREFIX}${djb2Hash(
    `${messageID}:${taskID}`,
  )}:${sha256Hash(terminalPayload)}`;
}

function provenanceKindForPart(
  part: MessagePart,
  message?: MessageWithParts,
): SyntheticTerminalProvenanceKind {
  if (getExplicitOccurrenceID(part)) return 'explicit';
  return getCanonicalHostMessageID(part, message) ? 'host-message' : 'legacy';
}

function isProcessableSyntheticTerminal(
  text: string,
  status: TaskStatusOutput,
): boolean {
  if (status.state !== 'completed' && status.state !== 'error') return false;

  const summary = extractTaskSummary(text);
  const isCompleted = summary
    ? BACKGROUND_COMPLETION_COMPLETED.test(summary)
    : status.state === 'completed';
  const isFailed = summary
    ? BACKGROUND_COMPLETION_FAILED.test(summary)
    : status.state === 'error';
  return (
    (!summary || isCompleted || isFailed) &&
    (!isCompleted || status.state === 'completed') &&
    (!isFailed || status.state === 'error')
  );
}

function observationOccurrenceID(
  part: MessagePart,
  status: TaskStatusOutput,
): { occurrenceID: string; reliable: boolean } {
  const explicitOccurrenceID = getExplicitOccurrenceID(part);
  if (explicitOccurrenceID) {
    return { occurrenceID: explicitOccurrenceID, reliable: true };
  }

  const messageID = getHostMessageID(part);
  if (messageID) {
    return {
      occurrenceID: hostMessageOccurrenceID(
        messageID,
        status.taskID,
        part.text ?? '',
      ),
      reliable: true,
    };
  }

  return {
    occurrenceID: `ambiguous:${djb2Hash(
      `unknown-message:${status.taskID}:${part.text ?? ''}`,
    )}`,
    reliable: false,
  };
}

function rememberSyntheticTerminalOccurrence(
  state: InjectionState,
  origin: SyntheticTerminalOccurrenceOrigin,
  provenanceKind: SyntheticTerminalProvenanceKind,
): void {
  const occurrences = state.syntheticTerminalOccurrences;
  const order = state.syntheticTerminalOccurrenceOrder;
  if (!occurrences || !order) return;

  const key = injectedCompletionKey(
    origin.taskID,
    origin.occurrenceID,
    provenanceKind,
  );
  const existing = occurrences.get(key);
  if (existing) {
    // The first observation owns the lifecycle provenance. A later event for
    // the same part must not refresh an old occurrence into a new generation.
    if (existing.phase === 'processed') return;
    if (existing.phase === 'observed') return;
    // An ambiguous first observation is a permanent fail-closed decision. A
    // late event can be an old part replayed after a same-ID relaunch, so it
    // must never upgrade the occurrence with the current generation.
    return;
  }

  occurrences.set(key, { ...origin });
  order.push(key);
}

function findSyntheticTerminalOccurrence(
  state: InjectionState,
  taskID: string,
  occurrenceID: string,
  provenanceKind: SyntheticTerminalProvenanceKind,
  explicitOccurrenceID: boolean,
  currentGeneration: number | undefined,
  currentTaskGeneration: number | undefined,
  deletionEpoch: number | undefined,
): SyntheticTerminalOccurrenceLookup | undefined {
  const occurrences = state.syntheticTerminalOccurrences;
  if (!occurrences) return undefined;

  const direct = occurrences.get(
    injectedCompletionKey(taskID, occurrenceID, provenanceKind),
  );
  if (explicitOccurrenceID) {
    return direct ? { kind: 'matched', origin: direct } : undefined;
  }
  if (direct && provenanceKind !== 'host-message') {
    return { kind: 'matched', origin: direct };
  }

  if (provenanceKind === 'host-message') {
    // Host message ids are weaker than part ids. Restrict them to the first
    // generation: unrelated tasks do not advance this task-local run proof.
    if (deletionEpoch !== undefined || currentTaskGeneration !== 1) {
      return direct ? { kind: 'matched', origin: direct } : undefined;
    }

    const candidates = [...occurrences.entries()]
      .filter(
        ([key, origin]) =>
          hasProvenanceKind(key, taskID, 'host-message') &&
          origin.taskID === taskID &&
          origin.generationAtObservation === currentGeneration,
      )
      .map(([, origin]) => origin);
    if (
      candidates.length === 1 &&
      candidates[0].occurrenceID === occurrenceID
    ) {
      return { kind: 'matched', origin: candidates[0] };
    }
    if (candidates.length > 1) {
      return {
        kind: 'ambiguous',
        reason: `multiple current-generation host message.part.updated origins (${candidates.length}) could not be uniquely matched`,
      };
    }

    return direct ? { kind: 'matched', origin: direct } : undefined;
  }

  // Older/runtime-derived parts may lack an id in the transform payload. Do
  // not guess ownership from an ambiguous event; the legacy path is allowed to
  // fail closed, but it may not manufacture a match from candidate count.
  const legacyCandidates = [...occurrences.entries()].filter(
    ([key, origin]) =>
      hasProvenanceKind(key, taskID, 'legacy') && origin.taskID === taskID,
  );
  if (legacyCandidates.length > 0) {
    return {
      kind: 'ambiguous',
      reason: 'legacy weak provenance did not match a canonical host identity',
    };
  }
  return undefined;
}

function rememberProcessedSyntheticTerminal(
  state: InjectionState,
  taskID: string,
  occurrenceID: string,
  provenanceKind: SyntheticTerminalProvenanceKind,
  origin: SyntheticTerminalOccurrenceOrigin | undefined,
  generation: number | undefined,
): void {
  if (origin) {
    origin.phase = 'processed';
    return;
  }

  rememberSyntheticTerminalOccurrence(
    state,
    {
      taskID,
      occurrenceID,
      generationAtObservation: generation,
      lifecycleEpochAtObservation: state.getLifecycleEpoch?.() ?? 0,
      phase: 'processed',
    },
    provenanceKind,
  );
}

function failClosedSyntheticTerminal(
  state: InjectionState,
  status: TaskStatusOutput,
  occurrenceID: string,
  provenanceKind: SyntheticTerminalProvenanceKind,
  existing: BackgroundJobRecord | undefined,
  reason: string,
): void {
  rememberSyntheticTerminalOccurrence(
    state,
    {
      taskID: status.taskID,
      occurrenceID,
      generationAtObservation: existing?.generation,
      lifecycleEpochAtObservation: state.getLifecycleEpoch?.() ?? 0,
      phase: 'ambiguous',
    },
    provenanceKind,
  );

  if (existing?.state === 'running') {
    markSyntheticTerminalUncertain(
      state,
      status.taskID,
      existing,
      `Synthetic terminal task output origin is ambiguous: ${reason}`,
    );
  }

  log('[task-session-manager] skipped ambiguous synthetic completion', {
    taskID: status.taskID,
    occurrenceID,
    generation: existing?.generation,
    lifecycleEpoch: state.getLifecycleEpoch?.() ?? 0,
    reason,
  });
}

function markSyntheticTerminalUncertain(
  state: InjectionState,
  taskID: string,
  existing: BackgroundJobRecord,
  reason: string,
): void {
  state.backgroundJobBoard.markStatusUncertain(
    taskID,
    reason,
    existing.generation,
  );
}

/**
 * Record a terminal synthetic task part at the runtime event boundary. The
 * part can be transformed later, after deletion and a same-ID relaunch, so
 * payload fields alone are not sufficient to recover its original generation.
 */
export function observeSyntheticTerminalPart(
  state: InjectionState,
  value: unknown,
): void {
  if (!isRecord(value)) return;
  const part = value as MessagePart;
  if (part.type !== 'text' || part.synthetic !== true) return;
  if (typeof part.text !== 'string') return;

  const status = parseTaskStatusOutput(part.text);
  if (!status || !isProcessableSyntheticTerminal(part.text, status)) return;

  const { occurrenceID, reliable } = observationOccurrenceID(part, status);
  const provenanceKind = provenanceKindForPart(part);
  const existing = state.backgroundJobBoard.get(status.taskID);
  const lifecycleEpoch = state.getLifecycleEpoch?.() ?? 0;
  const deletionEpoch = state.getDeletionEpoch?.(status.taskID);
  const occurrenceKey = injectedCompletionKey(
    status.taskID,
    occurrenceID,
    provenanceKind,
  );
  const priorOccurrence =
    state.syntheticTerminalOccurrences?.get(occurrenceKey);
  const hasPreDeletionProvenance =
    deletionEpoch === undefined ||
    (priorOccurrence !== undefined &&
      priorOccurrence.lifecycleEpochAtObservation < deletionEpoch &&
      priorOccurrence.phase !== 'ambiguous');
  const hostMessageProvenance = provenanceKind === 'host-message';
  const phase: SyntheticTerminalOccurrencePhase =
    !reliable ||
    !existing ||
    (hostMessageProvenance
      ? deletionEpoch !== undefined || existing.taskGeneration !== 1
      : !hasPreDeletionProvenance)
      ? 'ambiguous'
      : 'observed';

  rememberSyntheticTerminalOccurrence(
    state,
    {
      taskID: status.taskID,
      occurrenceID,
      generationAtObservation: existing?.generation,
      lifecycleEpochAtObservation: lifecycleEpoch,
      phase,
    },
    provenanceKind,
  );
}

function hasRememberedInjectedCompletion(
  state: InjectionState,
  taskID: string,
  occurrenceId: string,
  provenanceKind: SyntheticTerminalProvenanceKind,
  currentGeneration: number | undefined,
): boolean {
  const fence = state.injectedCompletionFences?.get(
    injectedCompletionKey(taskID, occurrenceId, provenanceKind),
  );
  if (!fence) return false;

  const deletionEpoch = state.getDeletionEpoch?.(taskID);
  const staleGeneration =
    currentGeneration !== undefined && currentGeneration !== fence.generation;
  const staleLifecycle =
    deletionEpoch !== undefined && fence.lifecycleEpoch < deletionEpoch;
  if (staleGeneration || staleLifecycle) {
    log('[task-session-manager] skipped stale injected completion', {
      taskID,
      occurrenceId,
      recordedGeneration: fence.generation,
      currentGeneration,
      recordedLifecycleEpoch: fence.lifecycleEpoch,
      deletionEpoch,
    });
  }

  // A known occurrence is either a duplicate in the same lifecycle or stale
  // history from an older generation. Neither may update the current board.
  return true;
}

function rememberInjectedCompletionFence(
  state: InjectionState,
  occurrenceId: string,
  provenanceKind: SyntheticTerminalProvenanceKind,
  fence: InjectedCompletionFence,
): void {
  const fences = state.injectedCompletionFences;
  if (!fences) return;

  fences.set(
    injectedCompletionKey(fence.taskID, occurrenceId, provenanceKind),
    { ...fence },
  );
}

// ── Exported functions ─────────────────────────────────────────────────

/**
 * Normalize the `output` of every still-running `task` tool result to a
 * static, deterministic placeholder keyed only on the task ID.
 *
 * OpenCode core stores a fixed running placeholder in `state.output` when a
 * background task launches and materializes the terminal result separately as
 * a synthetic completion message. However, the runtime is free to stream live
 * child progress into a running task part's `state.output` (foreground
 * promotion, future core versions). Any such mid-history mutation invalidates
 * the provider prompt cache from that byte onward, re-writing the entire tail
 * every request while a background lane runs (write-never-read loop).
 *
 * This makes running task parts byte-stable at the plugin layer: it only ever
 * touches parts whose parsed state is `running`, so terminal
 * (completed/error/cancelled) results — which must reach the orchestrator
 * intact and mutate exactly once on completion — are never altered. It is a
 * pure normalization: re-running it on an already-stabilized part is a no-op.
 * Foreground (`wait:true`) tasks block and return a terminal state, so their
 * parts are never running here and keep their real output.
 */
export function stabilizeRunningTaskParts(messages: unknown[]): void {
  for (const message of messages) {
    if (!isMessageWithParts(message)) continue;
    for (const part of message.parts) {
      if (part.type !== 'tool' || part.tool !== 'task') continue;
      const state = part.state;
      if (!isRecord(state)) continue;
      if (typeof state.output !== 'string') continue;

      // Only running task results are volatile. Terminal results (completed,
      // error, cancelled) are materialized exactly once and must stay intact.
      const status = parseTaskStatusOutput(state.output);
      const runningByStatus = status?.state === 'running';
      const runningByField =
        state.status === 'running' && (status === undefined || runningByStatus);
      if (!runningByStatus && !runningByField) continue;

      const taskID = status?.taskID;
      if (!taskID) continue;

      const placeholder = renderRunningTaskPlaceholder(taskID);
      if (state.output === placeholder) continue;
      state.output = placeholder;
    }
  }
}

export async function updateFromInjectedCompletion(
  state: InjectionState,
  part: MessagePart,
  message: MessageWithParts,
  _messageIndex: number,
  partIndex: number,
): Promise<BackgroundJobRecord | undefined> {
  if (part.type !== 'text' || typeof part.text !== 'string') {
    return undefined;
  }

  if (part.synthetic !== true) return undefined;

  const status = parseTaskStatusOutput(part.text);
  if (!status) {
    // Only flag text shaped like task-status output that failed to parse.
    // Native delegation prompts (e.g. OpenCode's "@agent" expansion) are
    // synthetic but never task-status shaped — skip silently.
    if (
      parseTaskIdFromTaskOutput(part.text) ||
      parseTaskStateFromOutput(part.text)
    ) {
      log('[task-session-manager] synthetic part missing task status', {
        textPreview: part.text.slice(0, 120),
      });
    }
    return undefined;
  }
  if (!isProcessableSyntheticTerminal(part.text, status)) {
    return undefined;
  }

  const summary = extractTaskSummary(part.text);
  const isCompleted = summary
    ? BACKGROUND_COMPLETION_COMPLETED.test(summary)
    : status.state === 'completed';
  const isFailed = summary
    ? BACKGROUND_COMPLETION_FAILED.test(summary)
    : status.state === 'error';
  if (summary && !isCompleted && !isFailed) return undefined;

  const occurrenceId = createOccurrenceId(part, message, partIndex);
  const provenanceKind = provenanceKindForPart(part, message);
  const hasExplicitOccurrenceID = provenanceKind === 'explicit';

  const existing = state.backgroundJobBoard.get(status.taskID);
  const deletionEpoch = state.getDeletionEpoch?.(status.taskID);
  const occurrenceLookup = findSyntheticTerminalOccurrence(
    state,
    status.taskID,
    occurrenceId,
    provenanceKind,
    hasExplicitOccurrenceID,
    existing?.generation,
    existing?.taskGeneration,
    deletionEpoch,
  );
  const origin =
    occurrenceLookup?.kind === 'matched' ? occurrenceLookup.origin : undefined;

  if (occurrenceLookup?.kind === 'ambiguous') {
    failClosedSyntheticTerminal(
      state,
      status,
      occurrenceId,
      provenanceKind,
      existing,
      occurrenceLookup.reason,
    );
    return undefined;
  }

  if (origin?.phase === 'processed') return undefined;

  if (origin?.phase === 'ambiguous') {
    failClosedSyntheticTerminal(
      state,
      status,
      occurrenceId,
      provenanceKind,
      existing,
      'message.part.updated origin was permanently ambiguous',
    );
    return undefined;
  }

  if (provenanceKind === 'host-message') {
    if (
      !origin ||
      !existing ||
      deletionEpoch !== undefined ||
      origin.phase !== 'observed' ||
      existing.taskGeneration !== 1 ||
      origin.generationAtObservation !== existing.generation
    ) {
      failClosedSyntheticTerminal(
        state,
        status,
        occurrenceId,
        provenanceKind,
        existing,
        'host messageID provenance did not identify exactly one current origin',
      );
      return undefined;
    }
  }

  if (origin?.phase === 'observed') {
    const generationChanged =
      origin.generationAtObservation !== undefined &&
      existing?.generation !== origin.generationAtObservation;
    const observationPredatesDeletion =
      deletionEpoch !== undefined &&
      origin.lifecycleEpochAtObservation < deletionEpoch;
    if (generationChanged || observationPredatesDeletion) {
      if (existing?.state === 'running') {
        markSyntheticTerminalUncertain(
          state,
          status.taskID,
          existing,
          'Synthetic terminal task output belongs to an older lifecycle.',
        );
      }
      log(
        '[task-session-manager] skipped stale observed synthetic completion',
        {
          taskID: status.taskID,
          occurrenceId,
          observedGeneration: origin.generationAtObservation,
          currentGeneration: existing?.generation,
          observationEpoch: origin.lifecycleEpochAtObservation,
          deletionEpoch,
        },
      );
      return undefined;
    }
  }

  // Fence-first: a remembered (possibly stale) completion occurrence must
  // skip CLEANLY before the deletion-epoch fail-closed branch below. A
  // known occurrence is either a duplicate in the same lifecycle or stale
  // history from an older generation — neither may update the current
  // board, and neither justifies poisoning the fresh generation with
  // markStatusUncertain when its occurrence bookkeeping is absent.
  if (
    hasRememberedInjectedCompletion(
      state,
      status.taskID,
      occurrenceId,
      provenanceKind,
      existing?.generation,
    )
  ) {
    return undefined;
  }

  if (deletionEpoch !== undefined && origin === undefined) {
    failClosedSyntheticTerminal(
      state,
      status,
      occurrenceId,
      provenanceKind,
      existing,
      'no message.part.updated origin was observed',
    );
    return undefined;
  }

  if (isFailed && isLateCancelledTaskError(existing, status.state)) {
    log('[task-session-manager] normalized late cancelled injected failure', {
      taskID: status.taskID,
      alias: existing?.alias,
      parsedState: status.state,
      boardState: existing?.state,
      terminalState: existing?.terminalState,
      result: status.result,
    });
    rememberProcessedInjectedCompletion(
      state,
      status.taskID,
      occurrenceId,
      provenanceKind,
      {
        taskID: status.taskID,
        generation: existing?.generation ?? 0,
        lifecycleEpoch: state.getLifecycleEpoch?.() ?? 0,
      },
    );
    rememberProcessedSyntheticTerminal(
      state,
      status.taskID,
      occurrenceId,
      provenanceKind,
      origin,
      existing?.generation,
    );
    if (existing?.terminalUnreconciled && existing?.parentSessionID) {
      rememberPendingInjectedTerminalJob(state, existing.parentSessionID, {
        taskID: existing.taskID,
        generation: existing.generation,
        terminalRevision: existing.terminalRevision,
      });
    }
    return existing;
  }

  if (isCompleted && status.state !== 'completed') return undefined;
  if (isFailed && status.state !== 'error') return undefined;

  const processedOccurrenceKey = injectedCompletionKey(
    status.taskID,
    occurrenceId,
    provenanceKind,
  );
  if (state.processedInjectedCompletions.has(processedOccurrenceKey)) {
    return undefined;
  }

  if (!existing) return undefined;
  // Reception deduplication is separate from terminal confirmation. A replay
  // without an observed execution owner can only request an inspection.
  rememberProcessedInjectedCompletion(
    state,
    status.taskID,
    occurrenceId,
    provenanceKind,
    {
      taskID: existing.taskID,
      generation: existing.generation,
      lifecycleEpoch: state.getLifecycleEpoch?.() ?? 0,
    },
  );
  const result = await state.terminalGate.reconcile(
    existing,
    origin?.generationAtObservation === existing.generation
      ? {
          kind: 'output',
          status,
          origin: {
            kind: 'synthetic',
            occurrenceID: occurrenceId,
            run: existing,
            provenance: provenanceKind,
          },
        }
      : { kind: 'inspect' },
  );
  const updated = result.kind === 'stale' ? undefined : result.record;
  if (!updated) return undefined;

  if (updated.terminalUnreconciled && updated.parentSessionID) {
    rememberPendingInjectedTerminalJob(state, updated.parentSessionID, {
      taskID: updated.taskID,
      generation: updated.generation,
      terminalRevision: updated.terminalRevision,
    });
  }

  log('[task-session-manager] processed injected background completion', {
    taskID: updated.taskID,
    alias: updated.alias,
    parentSessionID: updated.parentSessionID,
    state: updated.state,
    occurrenceId,
  });

  rememberProcessedSyntheticTerminal(
    state,
    updated.taskID,
    occurrenceId,
    provenanceKind,
    origin,
    updated.generation,
  );
  rememberProcessedInjectedCompletion(
    state,
    status.taskID,
    occurrenceId,
    provenanceKind,
    {
      taskID: updated.taskID,
      generation: updated.generation,
      lifecycleEpoch: state.getLifecycleEpoch?.() ?? 0,
    },
  );
  return updated;
}

export function rememberProcessedInjectedCompletion(
  state: InjectionState,
  taskID: string,
  occurrenceId: string,
  provenanceKind: SyntheticTerminalProvenanceKind,
  fence?: InjectedCompletionFence,
): void {
  const signature = injectedCompletionKey(taskID, occurrenceId, provenanceKind);
  state.processedInjectedCompletions.add(signature);
  state.processedInjectedCompletionOrder.push(signature);

  if (fence) {
    rememberInjectedCompletionFence(state, occurrenceId, provenanceKind, fence);
  }
}

export function isMissingRememberedSessionError(output: string): boolean {
  const firstLine = output.split(/\r?\n/, 1)[0]?.trim().toLowerCase() ?? '';
  return (
    firstLine.startsWith('[error]') &&
    firstLine.includes('session') &&
    (firstLine.includes('not found') || firstLine.includes('no session'))
  );
}

function executionKey(execution: BackgroundJobExecution): string {
  return `${execution.taskID}\u001f${execution.generation}\u001f${execution.terminalRevision}`;
}

function rememberPendingInjectedTerminalJob(
  state: InjectionState,
  parentSessionID: string,
  execution: BackgroundJobExecution,
): void {
  const pending =
    state.pendingInjectedTerminalJobsByParent.get(parentSessionID) ??
    new Map<string, BackgroundJobExecution>();
  pending.set(executionKey(execution), { ...execution });
  state.pendingInjectedTerminalJobsByParent.set(parentSessionID, pending);
}

function reconcileExecutionBatch(
  state: InjectionState,
  parentSessionID: string,
  executions: Iterable<BackgroundJobExecution>,
): void {
  for (const execution of executions) {
    const current = state.backgroundJobBoard.get(execution.taskID);
    if (
      !current ||
      current.generation !== execution.generation ||
      current.terminalRevision !== execution.terminalRevision
    ) {
      log('[task-session-manager] skipped stale terminal execution', {
        parentSessionID,
        execution,
        currentGeneration: current?.generation,
      });
      continue;
    }
    const reconciled = state.backgroundJobBoard.markReconciled(
      execution.taskID,
      undefined,
      execution.generation,
      execution.terminalRevision,
    );
    // The parent has now consumed this terminal report. Remember the run
    // so a later reopen-to-running (child session busy again) can be
    // corrected with exactly one trailing notice.
    if (reconciled) {
      rememberReportedTerminalRun(state, parentSessionID, {
        taskID: execution.taskID,
        generation: execution.generation,
        terminalState: reconciled.terminalState ?? reconciled.state,
      });
    }
  }
}

export function rememberInjectedTerminalJobs(
  state: InjectionState,
  parentSessionID: string,
  executions: readonly BackgroundJobExecution[],
  promptShapeKey: string,
): void {
  if (!parentSessionID || executions.length === 0) return;

  const uniqueExecutions = new Map(
    executions.map((execution) => [executionKey(execution), execution]),
  );
  if (uniqueExecutions.size === 0) return;

  const existing = state.terminalJobsInjectedByParent.get(parentSessionID);
  if (existing && existing.promptShapeKey === promptShapeKey) {
    // Same prompt shape: union the executions delivered by each payload.
    for (const [key, execution] of uniqueExecutions) {
      existing.executions.set(key, { ...execution });
    }
  } else {
    // A different shape is normally reconciled before this point. Replace
    // the entry defensively so executions from an older payload cannot leak
    // into the new delivered batch.
    state.terminalJobsInjectedByParent.set(parentSessionID, {
      executions: new Map(
        [...uniqueExecutions].map(([key, execution]) => [
          key,
          { ...execution },
        ]),
      ),
      promptShapeKey,
    });
  }

  const pending =
    state.pendingInjectedTerminalJobsByParent.get(parentSessionID);
  if (pending) {
    for (const key of uniqueExecutions.keys()) pending.delete(key);
    if (pending.size === 0) {
      state.pendingInjectedTerminalJobsByParent.delete(parentSessionID);
    }
  }

  log('[task-session-manager] terminal jobs injected for reconciliation', {
    parentSessionID,
    executions: [...uniqueExecutions.values()],
    promptShapeKey,
  });
}

export function reconcileInjectedTerminalJobs(
  state: InjectionState,
  parentSessionID: string,
): void {
  const entry = state.terminalJobsInjectedByParent.get(parentSessionID);
  const pending =
    state.pendingInjectedTerminalJobsByParent.get(parentSessionID);
  if (!entry && !pending) return;

  const executions = new Map<string, BackgroundJobExecution>();
  for (const [key, execution] of entry?.executions ?? []) {
    executions.set(key, execution);
  }
  for (const [key, execution] of pending ?? []) {
    executions.set(key, execution);
  }

  log('[task-session-manager] reconciling injected terminal jobs', {
    parentSessionID,
    executions: [...executions.values()],
  });

  reconcileExecutionBatch(state, parentSessionID, executions.values());
  state.terminalJobsInjectedByParent.delete(parentSessionID);
  state.pendingInjectedTerminalJobsByParent.delete(parentSessionID);
}

// ── Native delivery observer (v2 boardless primary; v1 never reaches it) ─
//
// On OpenCode v2 hosts the host itself delivers each background completion
// exactly once as a synthetic session message in the parent's history:
// `<subagent sessionID="..." state="completed|error|cancelled">…</subagent>`
// (host `SessionInbox` steer/queue delivery; the native notifier never
// delivers `stopped`). Observing that delivery retires the tracked record
// directly, replacing the prompt-shape registration bookkeeping
// (`rememberInjectedTerminalJobs` + `reconcileConsumedTerminalJobs`) on the
// v2 path. v1 is structurally board-on: its prompt-shape path owns
// retirement, so this pass never runs there.

type ObservedNativeDelivery = NativeDelivery & {
  /** Dedupe key: the delivery part's own message/part identity. */
  seenKey: string;
};

/**
 * Skew allowance for the current-publication check: the terminal event the
 * plugin observes and the host's delivery-message creation are concurrent
 * within one tick on the same clock, but either may land a few milliseconds
 * first. A delivery authored earlier than this before the current
 * publication's completedAt is unambiguously an older report.
 */
const NATIVE_DELIVERY_PUBLICATION_SKEW_MS = 2_000;

/**
 * LRU cap for one parent's consumed native-delivery keys. Far above any
 * normal session's live delivery count: the bound exists so a pathological
 * history (or a missed session-end prune) cannot grow the set without limit.
 * Eviction only re-opens the one-shot pairing window for the oldest keys,
 * which the reopen gate and the stale-terminal fallback still cover.
 */
const NATIVE_DELIVERY_SEEN_CAP = 1024;

/**
 * Byte-stable, persisted identity for one observed delivery part: the host
 * message id plus the part index, bound to the part text so an id reused
 * for different content cannot collide. Parts without a host message id
 * fall back to a content hash. Prompt shape never enters the key.
 */
function nativeDeliverySeenKey(
  message: MessageWithParts,
  partIndex: number,
  text: string,
): string {
  const messageID =
    typeof message.info.id === 'string' && message.info.id.trim() !== ''
      ? message.info.id
      : undefined;
  const textHash = sha256Hash(text);
  return messageID === undefined
    ? `anon:${textHash}`
    : `${messageID}:${partIndex}:${textHash}`;
}

/**
 * Reconcile tracked records against the native v2 deliveries already
 * present in the parent's message history. Pairing is ONE-SHOT: a delivery
 * key is remembered on first observation and can retire at most one
 * terminal publication — the record's CURRENT terminal run at that moment,
 * and only when the delivered state equals it. Deliveries observed earlier
 * (running, reconciled, mismatched, stopped) can never pair later (Greptile
 * P1-2). Untracked sessionIDs are idempotent no-ops. `stopped` records are
 * never retired here (native never delivers stops; they retire through the
 * recovery-wake + task_revive ack flow).
 */
function reconcileObservedNativeDeliveries(
  state: InjectionState,
  messages: unknown[],
): void {
  // Boardless only: v2 structurally, v1 via the honoured boardInjection
  // switch. On a v1 boardless parent the pass is a near no-op (completions
  // arrive untagged) but stays harmless and future-proof.
  if (state.hostFlavor !== 'v2' && state.boardInjection !== false) return;
  state.observedNativeDeliveries ??= new Map<string, Map<string, true>>();
  const seenByParent = state.observedNativeDeliveries;
  for (const message of messages) {
    if (!isMessageWithParts(message)) continue;
    const parentSessionID = message.info.sessionID;
    if (!parentSessionID || !state.shouldManageSession(parentSessionID)) {
      continue;
    }
    let seen = seenByParent.get(parentSessionID);
    if (!seen) {
      seen = new Map<string, true>();
      seenByParent.set(parentSessionID, seen);
    }
    message.parts.forEach((part, partIndex) => {
      if (part.type !== 'text' || typeof part.text !== 'string') return;
      if (isTaggedPart(part, state.metadataKey)) return;
      const delivery = parseNativeDelivery(part);
      if (!delivery) return;
      const seenKey = nativeDeliverySeenKey(message, partIndex, part.text);
      if (seen.has(seenKey)) {
        // LRU touch: a delivery the parent's history still replays must not
        // age out ahead of keys that stopped appearing in history.
        rememberDeliveryKey(seen, seenKey);
        return;
      }

      const record = state.backgroundJobBoard.get(delivery.taskID);
      if (!record || record.parentSessionID !== parentSessionID) {
        // Unknown child or parent mismatch: leave the key unobserved (a
        // later transform may know the child), bounded by session end.
        return;
      }
      // One-shot pairing with a reopen gate (Greptile P1-2): a delivery's
      // own publication causally precedes the record's later reopens, so a
      // delivery observed while its record runs after a reopen can never
      // report the CURRENT run. Remember such keys on first sight; never
      // let them pair later. Deliveries of the current run are either
      // observed when the record is already terminal (paired below), or
      // race the terminal gate (still retryable — no reopen happened yet,
      // so lastLiveBusyAt is unset). The current publication otherwise
      // retires via its own delivery or retireStaleTerminalRecords.
      const deliveryTime = messageCreatedAt(message);
      // Trusted metadata proves who authored the delivery, not WHICH run it
      // reports. Without a host timestamp no causal fence can be checked.
      if (deliveryTime === undefined) return;
      if (!record.terminalUnreconciled) {
        if (
          record.state === 'running' &&
          record.lastLiveBusyAt !== undefined &&
          deliveryTime !== undefined &&
          (deliveryTime < record.lastLiveBusyAt ||
            deliveryTime < record.lastLaunchedAt)
        ) {
          // Authored at or before the reopen (or the current launch): this
          // is a previous publication's report, stranded in history.
          rememberDeliveryKey(seen, seenKey);
        }
        return;
      }
      // Remember the key on first terminal observation: from here the
      // record can only reopen (bumping terminalRevision via
      // markRunningFromLiveSession) — any later same-state match would be
      // a NEWER publication this delivery cannot report.
      rememberDeliveryKey(seen, seenKey);
      // Provably stale: authored before the record's last launch, so it
      // predates the current run and every future one (lastLaunchedAt only
      // advances). A record can reopen and change terminal state, so state
      // equality alone is never proof of currency.
      if (deliveryTime !== undefined && deliveryTime < record.lastLaunchedAt) {
        return;
      }
      // Post-reopen runs: a delivery authored before the reopen can never
      // report the reopened run's completion. The seen-set only accelerates
      // this — causality must hold independently of LRU eviction (PR #1608
      // review). lastLiveBusyAt is set only by markRunningFromLiveSession.
      if (
        record.lastLiveBusyAt !== undefined &&
        deliveryTime !== undefined &&
        deliveryTime < record.lastLiveBusyAt
      ) {
        return;
      }
      // Predates the CURRENT publication: markRunningFromLiveSession clears
      // completedAt on reopen, so completedAt always marks the current
      // terminal publication. Both clocks are host-side, but the terminal
      // event and the message creation are concurrent within one tick —
      // allow a small skew so a same-publication delivery is never burned.
      if (
        record.completedAt !== undefined &&
        deliveryTime !== undefined &&
        deliveryTime < record.completedAt - NATIVE_DELIVERY_PUBLICATION_SKEW_MS
      ) {
        return;
      }
      // A delivery retires only the terminal run it reports: the record's
      // terminal state must equal the delivered state.
      const terminalState = record.terminalState ?? record.state;
      if (terminalState !== delivery.state) return;
      if (
        !NATIVE_DELIVERY_STATES.has(
          record.state as ObservedNativeDelivery['state'],
        )
      ) {
        // stopped: retires only through the recovery-wake + task_revive
        // ack flow; the remembered key never pairs.
        return;
      }
      reconcileExecutionBatch(state, parentSessionID, [
        {
          taskID: record.taskID,
          generation: record.generation,
          terminalRevision: record.terminalRevision,
        },
      ]);
    });
  }
}

/**
 * Remember (or refresh) one consumed native-delivery key. Map insertion
 * order is the recency order: delete+set moves the key to the newest
 * position, so a re-observed delivery never ages out ahead of keys that
 * stopped appearing in history. The oldest keys are evicted past
 * `NATIVE_DELIVERY_SEEN_CAP`.
 */
function rememberDeliveryKey(seen: Map<string, true>, seenKey: string): void {
  seen.delete(seenKey);
  seen.set(seenKey, true);
  while (seen.size > NATIVE_DELIVERY_SEEN_CAP) {
    const oldest = seen.keys().next().value;
    if (oldest === undefined) break;
    seen.delete(oldest);
  }
}

/**
 * Council risk #1 mitigation: a completed/error record whose terminal time
 * is older than the newest parent assistant turn retires unconditionally at
 * the next transform — the parent demonstrably moved past the terminal
 * report, so a missed observation (compaction/restart/steer race) cannot
 * wedge the hasTerminalUnreconciled consumers forever. `stopped` records
 * are excluded (recovery-wake ownership); `cancelled` retires only via an
 * observed delivery. Runs without comparable timestamps fail closed.
 */
function retireStaleTerminalRecords(
  state: InjectionState,
  messages: unknown[],
): void {
  // Boardless only: v2 structurally, v1 via the honoured boardInjection
  // switch (the owner's numeric-clock regression covers exactly this
  // combination). A v1 board-on parent retires through board consumption.
  if (state.hostFlavor !== 'v2' && state.boardInjection !== false) return;
  const newestAssistantTurnByParent = new Map<string, number>();
  for (const message of messages) {
    if (!isMessageWithParts(message)) continue;
    if (message.info.role !== 'assistant') continue;
    const parentSessionID = message.info.sessionID;
    if (!parentSessionID || !state.shouldManageSession(parentSessionID)) {
      continue;
    }
    const createdAt = messageCreatedAt(message);
    if (createdAt === undefined) continue;
    const newest = newestAssistantTurnByParent.get(parentSessionID);
    if (newest === undefined || createdAt > newest) {
      newestAssistantTurnByParent.set(parentSessionID, createdAt);
    }
  }
  if (newestAssistantTurnByParent.size === 0) return;
  for (const [
    parentSessionID,
    newestAssistantTurn,
  ] of newestAssistantTurnByParent) {
    for (const record of state.backgroundJobBoard.list(parentSessionID)) {
      if (!record.terminalUnreconciled) continue;
      if (record.state !== 'completed' && record.state !== 'error') continue;
      if (record.completedAt === undefined) continue;
      if (record.completedAt >= newestAssistantTurn) continue;
      reconcileExecutionBatch(state, parentSessionID, [
        {
          taskID: record.taskID,
          generation: record.generation,
          terminalRevision: record.terminalRevision,
        },
      ]);
    }
  }
}

function reconcileConsumedTerminalJobs(
  state: InjectionState,
  parentSessionID: string,
  promptShapeKey: string,
): void {
  const entry = state.terminalJobsInjectedByParent.get(parentSessionID);
  if (!entry || entry.promptShapeKey === promptShapeKey) return;
  // The model produced at least one new part after the request that carried
  // these completions, so it has consumed that shaped delivery. Pending
  // synthetic completions belong to a later delivery and remain pending.
  log('[task-session-manager] reconciling consumed terminal jobs', {
    parentSessionID,
    executions: [...entry.executions.values()],
  });
  reconcileExecutionBatch(state, parentSessionID, entry.executions.values());
  state.terminalJobsInjectedByParent.delete(parentSessionID);
}

export async function injectBackgroundJobBoard(
  state: InjectionState,
  _input: Record<string, never>,
  output: { messages?: unknown },
): Promise<void> {
  const messages = Array.isArray(output.messages) ? output.messages : [];

  // Native-delivery observation runs first on every boardless parent (v2
  // structurally, v1 via the honoured boardInjection switch): deliveries
  // already in history retire their records, and the stale-terminal
  // fallback bounds a missed observation. On v1 boardless the observer is a
  // near-no-op (completions are untagged) but the fallback retires
  // completed/error once the parent demonstrably moved past them; the
  // prompt-shape path inside injectLatestBoard covers cancelled, which has
  // no native delivery and no timestamp fallback. v1 board-on skips both
  // passes — its board render + consumption path owns retirement.
  reconcileObservedNativeDeliveries(state, messages);
  retireStaleTerminalRecords(state, messages);

  // Structural flavor split: v2 never renders a board (observer + fallback +
  // reopen corrections only); v1 renders the board unless the honoured
  // boardInjection switch says boardless.
  if (state.hostFlavor === 'v2') {
    deliverV2ReopenCorrections(state, messages);
    return;
  }

  injectLatestBoard(state, messages);
}

/**
 * v2 boardless tail: reopen corrections are staleness notices, not board
 * status, so they deliver here in the board-less variant (see
 * `formatReopenCorrectionTextNoBoard`). Gated exactly like the v1 path —
 * a managed parent's latest real user turn anchors the volatile trailing
 * notice — and delivered on internal-initiator turns too (a publication
 * wake makes the parent run on an internal trigger, and the correction is
 * exactly what that turn needs).
 */
function deliverV2ReopenCorrections(
  state: InjectionState,
  messages: unknown[],
): void {
  const trigger = findTriggeringUserMessage(messages, state.metadataKey);
  const sessionID = trigger?.info.sessionID;
  if (!trigger || !sessionID || !state.shouldManageSession(sessionID)) {
    return;
  }
  deliverReopenCorrections(state, sessionID, messages, trigger.info);
}

/**
 * Change-only board placement on the `latest` frozen-replay machinery: keep
 * exactly one FRESH board on the current tail while every board already sent
 * on an earlier (now mid-history) message stays put, byte-identical. A fresh
 * board is placed only when the rendered text differs from the last board
 * injected for the parent (`lastInjectedBoardTextByParent`); unchanged turns
 * place nothing.
 *
 * The board is never persisted, so opencode rebuilds real history board-free
 * each request. That means the plugin — not storage — must reproduce every
 * board it previously placed. The prior implementation instead STRIPPED the
 * old tail's board and re-appended a fresh board on the new tail
 * (`stripTailBoardContent` + append). Because the old tail was already sent to
 * the provider WITH its board, dropping it rewrote an already-cached message
 * and invalidated the provider prompt-cache prefix from that message onward —
 * the whole tail re-cached every turn (field bust: ses_11145863 dumps
 * 000086→000087, old-tail user message 1376B→652B as its board vanished).
 *
 * Fix (append-only w.r.t. already-sent messages):
 *   1. Strip the board ONLY from the current tail zone (the tail message's
 *      trailing board part + whole synthetic board messages trailing it). That
 *      zone re-caches every turn, so rewriting it is byte-safe.
 *   2. Replay every FROZEN board (one placed on a message that is no longer the
 *      tail) byte-identically on its original anchor, so an already-sent board
 *      never disappears.
 *   3. Add ONE fresh board to the current tail ONLY on a digest change,
 *      preserving the #889 placement (trailing PART on a user tail; separate
 *      trailing message on an assistant tail) so the tail breakpoint still
 *      lands on stable content, and record it so the NEXT request can
 *      freeze/replay it once the tail advances. A retry of the same request
 *      restores the tail's frozen copy instead (byte-identical).
 * A board on any earlier message is never mutated or stripped.
 */
function injectLatestBoard(state: InjectionState, messages: unknown[]): void {
  // The current tail anchor: the last real (non-fully-tagged) message. It is
  // the ONLY message whose board is volatile — the tail re-caches anyway, so
  // freshening its board is free. Every earlier message was already sent, so
  // its board must never change.
  const anchor = findBoardAnchor(messages, state.metadataKey);
  const anchorId = anchor?.id;

  // Strip the board from the current tail zone only (byte-safe volatile zone).
  stripCurrentTailBoard(messages, state.metadataKey, anchor?.message);

  // Eligibility follows the managed parent session, including host agents
  // such as Build that entered task management by delegating.
  const trigger = findTriggeringUserMessage(messages, state.metadataKey);
  const sessionID = trigger?.info.sessionID;

  // Replay frozen boards even when this turn is ineligible for a fresh board
  // (internal-initiator turn, empty board): an already-sent board must stay put
  // regardless of the current turn. The current tail anchor is skipped — its
  // board is (re)placed or restored below.
  if (sessionID !== undefined) {
    replayRetainedTailBoards(state, sessionID, messages, anchorId);
  }

  if (!trigger) return;
  if (!sessionID || !state.shouldManageSession(sessionID)) return;

  // Corrective notices are appended in the volatile tail zone before board
  // placement. With an assistant anchor the board follows the notice.
  deliverReopenCorrections(state, sessionID, messages, trigger.info);

  if (!anchor) return;

  // Hash the real history only when a prior terminal delivery needs
  // reconciliation or a new one is about to be registered.
  let shapeKey: string | undefined;
  if (state.terminalJobsInjectedByParent.has(sessionID)) {
    shapeKey = promptShapeKey(realMessages(messages, state.metadataKey));
    reconcileConsumedTerminalJobs(state, sessionID, shapeKey);
  }

  const textPart = trigger.parts.find(
    (part) => part.type === 'text' && typeof part.text === 'string',
  );
  if (!textPart || isInternalInitiatorPart(textPart)) return;

  if (state.boardInjection === false) {
    // v1 boardless (honoured switch; on v2 the dispatch already returned):
    // no board part is placed. The native-delivery observer and the
    // stale-terminal fallback ran above (v1 completions are untagged, so
    // the observer is a near-no-op here); terminal retirement rides the
    // prompt-shape consumption path — the only channel that covers
    // cancelled records (no native delivery, no timestamp fallback).
    // Stopped jobs are EXCLUDED: registering one would mark it reconciled
    // before the parent has seen it — the stopped-job recovery wake's
    // isCurrent check would then drop it and the stop would be silent.
    const nativeExecutions = (
      state.backgroundJobBoard.formatForPromptWithMetadata(sessionID)
        ?.terminalUnreconciledTaskIDs ?? []
    ).filter((execution) => {
      const record = state.backgroundJobBoard.get(execution.taskID);
      return (
        record !== undefined &&
        record.generation === execution.generation &&
        record.state !== 'stopped'
      );
    });
    if (nativeExecutions.length > 0) {
      rememberInjectedTerminalJobs(
        state,
        sessionID,
        nativeExecutions,
        shapeKey ?? promptShapeKey(realMessages(messages, state.metadataKey)),
      );
    }
    return;
  }

  const boardMeta =
    state.backgroundJobBoard.formatForPromptWithMetadata(sessionID);
  const reminder = boardMeta?.text;
  if (!reminder) {
    // Transition to an empty board set is a digest change: drop the stored
    // text so a recreated parent (or the next job wave) renders fresh.
    state.lastInjectedBoardTextByParent?.delete(sessionID);
    return;
  }

  // Change-only digest: a fresh tail board is placed only when the rendered
  // text differs from the last board injected for this parent AND that board
  // is still visible in this payload. A retained (user-anchor) board is
  // replayed frozen by the pass above, so an unchanged steady-state turn
  // carries zero new information and the tail gets no fresh board and no
  // terse marker. A non-retained (assistant-tail) placement never survives
  // the history rebuild, so the unchanged text re-renders on the volatile
  // tail instead of vanishing from the prompt entirely.
  const unchanged =
    state.lastInjectedBoardTextByParent?.get(sessionID) === reminder &&
    boardTextVisible(messages, state.metadataKey, reminder);

  // Placement rules — correctness first, then prompt-cache safety.
  //
  // Correctness (invariants A1-A3): the transformed array is converted to
  // `ModelMessage[]` and schema-validated before the request is sent, and a
  // violation raises `AI_InvalidPromptError` ("The messages do not match the
  // ModelMessage[] schema") before the HTTP call — a hard, unrecoverable turn
  // failure. Two rules keep the array valid:
  //
  //   * board text only ever rides on a `user` message (A3). The assistant
  //     branch of the host's converter forwards `part.metadata` as
  //     `providerMetadata`/`providerOptions`, which must be a nested record; a
  //     board part's `{ '<key>': true }` is a boolean and fails validation. The
  //     user branch drops metadata entirely, so it is safe.
  //   * a synthetic board MESSAGE is only ever appended at the very END of the
  //     array (A1). Inserting one mid-array can land between an assistant
  //     `task` tool_call and its tool_result and break the pairing the schema
  //     requires (A2); appending at the end cannot (A2 holds by construction).
  //
  // Cache safety (within the above):
  //
  // Provider caches read from the last two messages (Anthropic:
  // provider/transform.ts applyCaching → final.slice(-2)), and the provider
  // SDK coalesces adjacent same-role messages. A board injected as its own
  // trailing `user` message merges into a preceding user text message,
  // collapsing both tail breakpoints onto the merged block — so the only
  // readable breakpoint sits on the volatile board. Because the board moves to
  // a new tail every request, the deepest reusable breakpoint regresses to the
  // stable system boundary and the entire tail re-writes as cache every call.
  //
  // - If the tail is a user message, append the board as its trailing PART: the
  //   message COUNT stays identical to a board-free render, so the second tail
  //   breakpoint lands on the previous (byte-stable, real) message. This is
  //   also the only placement replayable later without inserting a message
  //   mid-array, so it is the only one recorded for replay.
  // - If the tail is an assistant message, NOTHING is placed (see the
  //   A5 branch below): an appended trailing board message can never be
  //   retained, so it would vanish from the next payload and break the
  //   byte prefix. The state change renders on the next user-side tail.
  const recordId = anchor.id;
  if (canCarryBoardPart(anchor.message)) {
    if (unchanged) {
      // Byte-identical replay: display-then-consume holds because
      // boardTextVisible proved these exact bytes are in the payload. Most
      // keys were registered at their placement; a same-text relaunch that
      // re-terminated into identical bytes (no rendered generation) is the
      // one gap — register only what the live entry does not cover.
      const live = state.terminalJobsInjectedByParent.get(sessionID);
      const uncovered = boardMeta.terminalUnreconciledTaskIDs.filter(
        (execution) => !live?.executions.has(executionKey(execution)),
      );
      if (uncovered.length > 0) {
        rememberInjectedTerminalJobs(
          state,
          sessionID,
          uncovered,
          shapeKey ?? promptShapeKey(realMessages(messages, state.metadataKey)),
        );
      }
      return;
    }
    appendTaggedSyntheticPart(anchor.message, {
      text: reminder,
      metadataKey: state.metadataKey,
    });
    // Recording the placement under the tail's anchor id lets the NEXT request
    // (once the tail advances) replay this exact board on this exact message,
    // so the bytes the provider just cached for this message never change.
    rememberTailBoard(state, sessionID, {
      anchorId: recordId,
      text: reminder,
    });
  } else {
    // A5, assistant tail: place NOTHING and register nothing. An appended
    // board can never be retained for replay, and registering here would
    // let the next shape change consume a stop that was never shown (and
    // starve the recovery wake's terminalUnreconciled check, Greptile P1).
    // The state change renders on the next user-side tail.
    return;
  }
  // A fresh board went out: its terminal facts are parent-visible, so they
  // register for prompt-shape consumption now — never before placement.
  if (boardMeta.terminalUnreconciledTaskIDs.length > 0) {
    rememberInjectedTerminalJobs(
      state,
      sessionID,
      boardMeta.terminalUnreconciledTaskIDs,
      shapeKey ?? promptShapeKey(realMessages(messages, state.metadataKey)),
    );
  }
  // Pin the digest for this parent.
  state.lastInjectedBoardTextByParent ??= new Map();
  state.lastInjectedBoardTextByParent.set(sessionID, reminder);
}

/** The last real (non-fully-tagged) message — the current tail anchor. */
function findBoardAnchor(
  messages: unknown[],
  metadataKey: string,
): BoardAnchor | undefined {
  return boardAnchors(messages, metadataKey).at(-1);
}

/**
 * True when the payload already carries the exact board text as a tagged
 * part — a frozen replay reproduced it mid-history, so the unchanged tail
 * needs no fresh copy. Runs AFTER the tail strip, so a board that existed
 * only on the (stripped) volatile tail does not count as visible.
 */
function boardTextVisible(
  messages: unknown[],
  metadataKey: string,
  text: string,
): boolean {
  for (const message of messages) {
    if (!isMessageWithParts(message)) continue;
    for (const part of message.parts) {
      if (
        part.type === 'text' &&
        part.text === text &&
        isTaggedPart(part, metadataKey)
      ) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Strip the board ONLY from the current tail zone: whole synthetic board
 * messages trailing the payload, plus a trailing board part on the current
 * tail anchor. This is the volatile zone (the tail re-caches every turn), so
 * rewriting it is byte-safe. A board on any earlier message is untouched —
 * removing it would rewrite already-sent, already-cached bytes.
 */
function stripCurrentTailBoard(
  messages: unknown[],
  metadataKey: string,
  anchor: MessageWithParts | undefined,
): void {
  // Drop whole synthetic board messages trailing the payload.
  let i = messages.length - 1;
  while (i >= 0) {
    const message = messages[i];
    if (!isVolatileTaggedMessage(message, metadataKey)) break;
    messages.splice(i, 1);
    i -= 1;
  }

  // Strip a trailing board part from the current tail anchor only.
  if (anchor) {
    anchor.parts = anchor.parts.filter(
      (part) => !isTaggedPart(part, metadataKey),
    );
  }
}

/**
 * A stable id for an anchor message that lacks an `info.id` (test fixtures,
 * legacy shapes). Derived from role + concatenated REAL text (tagged board
 * parts excluded) plus its append-order occurrence, so duplicate anonymous
 * messages remain distinct while appending a later message leaves existing
 * ids unchanged. The occurrence is internal and never enters the payload.
 */
function boardAnchorFallbackId(
  message: MessageWithParts,
  occurrence: number,
  metadataKey: string,
): string {
  return `anon:${djb2Hash(boardAnchorFallbackBase(message, metadataKey))}:${occurrence}`;
}

function boardAnchorFallbackBase(
  message: MessageWithParts,
  metadataKey: string,
): string {
  const text = message.parts
    .filter(
      (part) =>
        !isTaggedPart(part, metadataKey) &&
        part.type === 'text' &&
        typeof part.text === 'string',
    )
    .map((part) => part.text)
    .join('\u0000');
  return `${message.info.role}:${text}`;
}

/**
 * Build internal anchor identities in append order. Anonymous messages use an
 * occurrence suffix so duplicate content remains distinct, while appending a
 * later message leaves all existing identities unchanged. The identity never
 * enters the provider-visible message payload.
 */
function boardAnchors(messages: unknown[], metadataKey: string): BoardAnchor[] {
  const occurrences = new Map<string, number>();
  const anchors: BoardAnchor[] = [];

  for (const candidate of messages) {
    if (!isMessageWithParts(candidate)) continue;
    if (
      candidate.parts.length > 0 &&
      candidate.parts.every((part) => isTaggedPart(part, metadataKey))
    ) {
      continue;
    }

    if (candidate.info.id !== undefined) {
      anchors.push({ message: candidate, id: candidate.info.id });
      continue;
    }

    const base = boardAnchorFallbackBase(candidate, metadataKey);
    const occurrence = occurrences.get(base) ?? 0;
    occurrences.set(base, occurrence + 1);
    anchors.push({
      message: candidate,
      id: boardAnchorFallbackId(candidate, occurrence, metadataKey),
    });
  }

  return anchors;
}

/** Record (or refresh) a board placed on an anchor for later replay. */
function rememberTailBoard(
  state: InjectionState,
  sessionID: string,
  board: RetainedTailBoard,
): void {
  const perSession =
    state.retainedTailBoards.get(sessionID) ??
    new Map<string, RetainedTailBoard>();
  perSession.set(board.anchorId, board);
  state.retainedTailBoards.set(sessionID, perSession);
}

/**
/**
 * Re-append every FROZEN retained board onto its original anchor message,
 * exactly as first sent, so a board that was sent on a message which is no
 * longer the tail never disappears (its bytes are already in the provider's
 * cached prefix).
 *
 * Replay is strictly append-a-PART-to-an-existing-message. It never inserts a
 * message (A1) and therefore can never come between a tool_call and its
 * tool_result (A2), and it only ever targets a `user` message (A3).
 *
 * A retained board whose anchor cannot satisfy those invariants is DROPPED
 * (A5) rather than reproduced: losing a stale board costs one cache bust,
 * whereas an invalid message array raises `AI_InvalidPromptError` during
 * request validation and fails the turn outright.
 *
 * The current tail anchor (`currentAnchorId`) is skipped: its board is volatile
 * and is (re)placed fresh — or restored from its frozen copy on an unchanged
 * digest — by the caller. Anchors no longer present in history (compaction,
 * revert) are pruned — their bytes are gone from the provider's view too.
 * Replay is skipped when the anchor already carries a board, keeping the
 * operation idempotent under repeated transforms on a shared array.
 */
function replayRetainedTailBoards(
  state: InjectionState,
  sessionID: string,
  messages: unknown[],
  currentAnchorId: string | undefined,
): void {
  const perSession = state.retainedTailBoards.get(sessionID);
  if (!perSession || perSession.size === 0) return;

  const anchorById = new Map<string, MessageWithParts>();
  for (const anchor of boardAnchors(messages, state.metadataKey)) {
    anchorById.set(anchor.id, anchor.message);
  }

  for (const [anchorId, board] of [...perSession.entries()]) {
    // The current tail's board is volatile — the caller strips and re-places
    // (or restores) it. Never freeze/replay it here.
    if (anchorId === currentAnchorId) continue;

    const anchor = anchorById.get(anchorId);
    if (!anchor) {
      // Anchor gone from history (compaction/revert): its bytes are no longer
      // in the provider's view, so stop tracking it.
      perSession.delete(anchorId);
      continue;
    }

    // A5: a board whose anchor is no longer a user message cannot take the
    // replayable trailing-part path. Drop it rather than invalidating the turn.
    if (!canCarryBoardPart(anchor)) {
      perSession.delete(anchorId);
      continue;
    }

    if (!hasTaggedPart(anchor, state.metadataKey)) {
      appendTaggedSyntheticPart(anchor, {
        text: board.text,
        metadataKey: state.metadataKey,
      });
    }
  }

  if (perSession.size === 0) state.retainedTailBoards.delete(sessionID);
}

/**
 * The most recent real (non-board) user message that carries a text part —
 * used only to validate injection eligibility and derive session/text context.
 * Tool-result-only user turns (no text part) are skipped so a long tool loop
 * still resolves the triggering managed turn. Board placement targets the
 * tail (see injectBackgroundJobBoard).
 */
function findTriggeringUserMessage(
  messages: unknown[],
  metadataKey: string,
): MessageWithParts | undefined {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (!isMessageWithParts(message)) continue;
    if (
      message.parts.length > 0 &&
      message.parts.every((part) => isTaggedPart(part, metadataKey))
    ) {
      continue;
    }
    if (!isUserMessageWithParts(message)) continue;
    const hasText = message.parts.some(
      (part) => part.type === 'text' && typeof part.text === 'string',
    );
    if (!hasText) continue;
    return message;
  }
  return undefined;
}

function realMessages(
  messages: unknown[],
  metadataKey: string,
): MessageWithParts[] {
  return messages.flatMap((message) => {
    if (!isMessageWithParts(message)) return [];
    const parts = message.parts.filter(
      (part) => !isTaggedPart(part, metadataKey),
    );
    return parts.length > 0 ? [{ ...message, parts }] : [];
  });
}

/**
 * Identity of the real prompt content/structure for one request. Stable across
 * repeated transforms of the same request; changes as soon as relevant message
 * or non-synthetic part content changes. Counts alone are insufficient because
 * supported compaction can remove old content while a model turn appends new
 * content, preserving message/part counts.
 */
function promptShapeKey(realMessageList: MessageWithParts[]): string {
  const tokens: string[] = [];
  tokens.push(`messages:${realMessageList.length}`);
  for (const message of realMessageList) {
    tokens.push('message');
    tokens.push(`role:${message.info.role ?? ''}`);
    tokens.push(`agent:${message.info.agent ?? ''}`);
    tokens.push(`session:${message.info.sessionID ?? ''}`);
    const realParts = message.parts.filter((part) => part.synthetic !== true);
    tokens.push(`parts:${realParts.length}`);
    for (const part of realParts) {
      tokens.push('part');
      tokens.push(stablePromptPartSignature(part));
    }
  }
  return sha256Hash(tokens.join('\u001f'));
}

function stablePromptPartSignature(part: MessagePart): string {
  return stableSerializePromptValue(part);
}

function stableSerializePromptValue(value: unknown): string {
  if (value === null) return 'null';
  const valueType = typeof value;
  if (valueType === 'string') return JSON.stringify(value);
  if (valueType === 'number' || valueType === 'boolean') return String(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableSerializePromptValue(item)).join(',')}]`;
  }
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${stableSerializePromptValue(value[key])}`,
      )
      .join(',')}}`;
  }
  return valueType;
}
