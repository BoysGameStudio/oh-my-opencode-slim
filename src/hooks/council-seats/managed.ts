/**
 * Managed seat resolver: resolves `Seats:` refs against the caller's own
 * background job board, reproducing the historical council assembly
 * semantics byte-for-byte.
 *
 * Read-only over the board: no markUsed, no reconcile, no mutation, and
 * never a wait on a running seat (a still-running ref gets a
 * placeholder). The same parent-scoped invariant the control tools
 * enforce holds here — a ref owned by another parent never resolves, so
 * one parent's seat text never leaks into another's synthesis. Only a
 * completed terminal with non-empty text is a real response; lifecycle
 * diagnostics (cancelled/error/stopped text) are never injected as a
 * councillor's opinion.
 */
import type { BackgroundJobBoard } from '../../utils/background-job-board';
import { SEAT_REASONS } from './assemble';
import type { SeatResultResolver } from './types';

export function createManagedSeatResolver(
  board: BackgroundJobBoard,
): SeatResultResolver {
  return async (parentSessionID, seats) =>
    seats.map((seat) => {
      const ref = seat.childID ?? seat.seat;
      const record = board.resolve(parentSessionID, ref);
      const label = record?.agent ? record.agent : undefined;
      if (!record) {
        return { kind: 'missing', reason: SEAT_REASONS.missing };
      }
      if (record.state === 'running') {
        return {
          kind: 'running',
          reason: SEAT_REASONS.running,
          ...(label ? { label } : {}),
        };
      }
      const terminal =
        record.state === 'reconciled'
          ? (record.terminalState ?? 'reconciled')
          : record.state;
      if (
        terminal === 'completed' &&
        record.resultSummary &&
        record.resultSummary.trim() !== ''
      ) {
        // Verbatim: resultSummary holds the child's full terminal text.
        return {
          kind: 'completed',
          text: record.resultSummary,
          ...(label ? { label } : {}),
        };
      }
      // Historical shape preserved: non-completed terminals render as
      // `[no response — no output (<terminal>)]`; a completed terminal with
      // no text is `[no response — empty result]`.
      return {
        kind: terminal === 'completed' ? 'empty' : 'error',
        reason:
          terminal === 'completed'
            ? SEAT_REASONS.empty
            : `no output (${terminal})`,
        ...(label ? { label } : {}),
      };
    });
}
