// Mutation evidence records: normalize a Stryker report into one record per
// mutant with a stable identity. See docs/mutation-evidence-spec.md.
//
// Identity is source location + mutator + original + replacement. It never
// depends on Stryker's numeric mutant id, which is recorded (observed.id) but
// must not be used alone to identify or match a mutation across runs.

/** 1-based line, 1-based column (half-open end), as reported by Stryker. */
export interface Position {
  line: number;
  column: number;
}

export interface SourceLocation {
  start: Position;
  end: Position;
}

/** Stable across runs; survives numeric-id churn. */
export interface MutationIdentity {
  fileName: string;
  location: SourceLocation;
  mutatorName: string;
  original: string;
  replacement: string;
}

export type StrykerStatus =
  | 'Killed'
  | 'Survived'
  | 'NoCoverage'
  | 'Timeout'
  | 'Error'
  | 'Ignored'
  | 'Pending';

export type Disposition =
  | 'Detected'
  | 'Equivalent-under-preconditions'
  | 'Unreachable-under-invariant'
  | 'Unresolved';

/** Raw, tool-observed evidence straight from the Stryker report. */
export interface ObservedEvidence {
  id: string;
  status: StrykerStatus;
  static: boolean;
  coveredBy: readonly string[];
  /**
   * Test ids the runner recorded as killing the mutant, or null when the
   * report carries no killedBy. First-failure attribution only: the runner
   * bails at the first failing test, so this is never unique causality.
   */
  killedBy?: readonly string[] | null;
}

/**
 * Human conclusions. The tool never infers these from a status; they are
 * authored and carried through. Present but null until a ledger fills them.
 */
export interface HumanConclusion {
  disposition: Disposition | null;
  contract: string | null;
  distinguishingCondition: string | null;
  reachableSetup: string | null;
  observableDifference: string | null;
  falsifierResult: string | null;
  rationale: string | null;
}

export interface MutationRecord {
  identity: MutationIdentity;
  /** Deterministic join key over the identity; excludes the numeric id. */
  identityKey: string;
  observed: ObservedEvidence;
  reviewed: HumanConclusion;
}

export interface StrykerMutant {
  id: string;
  mutatorName: string;
  replacement: string;
  status: StrykerStatus;
  static: boolean;
  coveredBy: string[];
  location: SourceLocation;
  /** Test ids that killed this mutant; present only on Killed mutants. */
  killedBy?: string[];
}

export interface StrykerFile {
  source: string;
  mutants: StrykerMutant[];
  language?: string;
}

export interface StrykerReport {
  files: Record<string, StrykerFile>;
}

/**
 * The result of comparing a baseline sweep against a current sweep.
 * Matching is by stable identity (identityKey), never by numeric mutant id.
 */
export interface SweepComparison {
  /** Mutations present in both sweeps, with their explicit transition. */
  matched: MatchedTransition[];
  /** Mutations only in the current sweep. */
  added: MutationRecord[];
  /** Mutations only in the baseline sweep. */
  removed: MutationRecord[];
}

/** How a matched mutation's status changed from baseline to current. */
export type TransitionKind =
  | 'newly-killed' // baseline not Killed -> current Killed
  | 'already-killed' // baseline Killed -> current Killed
  | 'newly-surviving' // baseline not Survived -> current Survived
  | 'still-surviving' // baseline Survived -> current Survived
  | 'other'; // any other status combination

/** One matched mutation with baseline + current observed evidence. */
export interface MatchedTransition {
  identity: MutationIdentity;
  identityKey: string;
  baseline: ObservedEvidence;
  current: ObservedEvidence;
  transition: TransitionKind;
  /** True when the covering test set changed between sweeps. */
  coverageChanged: boolean;
}

/**
 * Statuses that require flagging as distinct outcomes. They are never
 * folded into detection: spec says Timeout counts toward the score's
 * detected numerator, but a flag makes the distinction visible per
 * record instead of hiding it inside arithmetic.
 */
export type FlaggedStatus = 'Timeout' | 'Error' | 'NoCoverage';

/**
 * Per-record detection view derived from the raw status. Also carries the
 * first-failure attribution marker for killedBy.
 */
export interface DetectionView {
  /** 'Detected' only per Stryker score semantics (Killed + Timeout). */
  detected: boolean;
  /** Non-null only for Timeout / Error / NoCoverage outcomes. */
  flaggedStatus: FlaggedStatus | null;
  /**
   * 'first-failure' when killedBy is present: the runner bails at the
   * first failing test, so the recorded test is the first failure, not
   * proof of unique causality or that no other test would also kill.
   */
  killedByKind: 'first-failure' | null;
}

/**
 * Mutation score as a derived view, always reported next to the raw
 * status counts it was computed from. Stryker semantics: Timeout counts
 * toward detection, Error is excluded entirely, NoCoverage counts as
 * undetected. Ignored/Pending are excluded (outside the scoreable set).
 */
export interface MutationScore {
  /** Killed + Timeout. */
  detected: number;
  /** Survived + NoCoverage. */
  undetected: number;
  /** detected + undetected; the score denominator. */
  total: number;
  /** detected / total, or null when total is zero (no scoreable set). */
  value: number | null;
}

/** Score plus the raw counts and per-record views it was derived from. */
export interface StatusSummary {
  records: Array<MutationRecord & { detection: DetectionView }>;
  /** Raw, untransformed status counts (the score is never reported alone). */
  statusCounts: Record<StrykerStatus, number>;
  score: MutationScore | null;
}

function lineStarts(source: string): number[] {
  const starts = [0];
  for (let i = 0; i < source.length; i++) {
    if (source.charCodeAt(i) === 10) starts.push(i + 1);
  }
  return starts;
}

// Stryker positions are 1-based line and column with a half-open end.
function offsetOf(starts: readonly number[], pos: Position): number {
  return starts[pos.line - 1] + (pos.column - 1);
}

function makeIdentityKey(identity: MutationIdentity): string {
  return JSON.stringify([
    identity.fileName,
    identity.location.start.line,
    identity.location.start.column,
    identity.location.end.line,
    identity.location.end.column,
    identity.mutatorName,
    identity.original,
    identity.replacement,
  ]);
}

export function collectMutationRecords(
  report: StrykerReport,
): MutationRecord[] {
  const records: MutationRecord[] = [];
  for (const [fileName, file] of Object.entries(report.files)) {
    if (typeof file.source !== 'string') {
      throw new Error(`mutation evidence: missing source for ${fileName}`);
    }
    const starts = lineStarts(file.source);
    for (const mutant of file.mutants) {
      const original = file.source.slice(
        offsetOf(starts, mutant.location.start),
        offsetOf(starts, mutant.location.end),
      );
      const identity: MutationIdentity = {
        fileName,
        location: mutant.location,
        mutatorName: mutant.mutatorName,
        original,
        replacement: mutant.replacement,
      };
      records.push({
        identity,
        identityKey: makeIdentityKey(identity),
        observed: {
          id: mutant.id,
          status: mutant.status,
          static: mutant.static,
          coveredBy: mutant.coveredBy,
          killedBy: mutant.killedBy ?? null,
        },
        reviewed: {
          disposition: null,
          contract: null,
          distinguishingCondition: null,
          reachableSetup: null,
          observableDifference: null,
          falsifierResult: null,
          rationale: null,
        },
      });
    }
  }
  return records;
}

function transitionOf(
  baseline: StrykerStatus,
  current: StrykerStatus,
): TransitionKind {
  const isKilled = (status: StrykerStatus) => status === 'Killed';
  const isSurvived = (status: StrykerStatus) => status === 'Survived';

  if (isKilled(current)) {
    return isKilled(baseline) ? 'already-killed' : 'newly-killed';
  }
  if (isSurvived(current)) {
    return isSurvived(baseline) ? 'still-surviving' : 'newly-surviving';
  }
  // Timeout, NoCoverage, Error, Ignored, Pending: statuses outside the
  // kill/survive axis. Raw baseline and current statuses carry the detail.
  return 'other';
}

// Coverage sets compare as sets: Stryker does not guarantee test order
// stability between runs, so order-sensitive equality would produce
// spurious coverage-change flags.
function sameCoverage(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const setB = new Set(b);
  for (const item of a) {
    if (!setB.has(item)) return false;
  }
  return true;
}

/**
 * Compare a baseline sweep and a current sweep of mutation records,
 * matched by stable identity. Numeric mutant ids never affect the
 * comparison outcome; they are carried through as observed evidence only.
 */
export function compareSweeps(
  baseline: MutationRecord[],
  current: MutationRecord[],
): SweepComparison {
  const byKey = (records: MutationRecord[]) => {
    const map = new Map<string, MutationRecord>();
    for (const record of records) map.set(record.identityKey, record);
    return map;
  };

  const baselineByKey = byKey(baseline);
  const currentByKey = byKey(current);

  const matched: MatchedTransition[] = [];
  for (const [idKey, baseRecord] of baselineByKey) {
    const currentRecord = currentByKey.get(idKey);
    if (currentRecord === undefined) continue;
    matched.push({
      identity: baseRecord.identity,
      identityKey: idKey,
      baseline: baseRecord.observed,
      current: currentRecord.observed,
      transition: transitionOf(
        baseRecord.observed.status,
        currentRecord.observed.status,
      ),
      coverageChanged: !sameCoverage(
        baseRecord.observed.coveredBy,
        currentRecord.observed.coveredBy,
      ),
    });
  }

  const added: MutationRecord[] = [];
  for (const [idKey, currentRecord] of currentByKey) {
    if (!baselineByKey.has(idKey)) added.push(currentRecord);
  }

  const removed: MutationRecord[] = [];
  for (const [idKey, baseRecord] of baselineByKey) {
    if (!currentByKey.has(idKey)) removed.push(baseRecord);
  }

  return { matched, added, removed };
}

const FLAGGED: ReadonlySet<StrykerStatus> = new Set([
  'Timeout',
  'Error',
  'NoCoverage',
] as FlaggedStatus[]);

const EMPTY_COUNTS: Record<StrykerStatus, number> = {
  Killed: 0,
  Survived: 0,
  NoCoverage: 0,
  Timeout: 0,
  Error: 0,
  Ignored: 0,
  Pending: 0,
};

function detectionView(record: MutationRecord): DetectionView {
  const status = record.observed.status;
  return {
    detected: status === 'Killed' || status === 'Timeout',
    flaggedStatus: FLAGGED.has(status) ? (status as FlaggedStatus) : null,
    killedByKind: record.observed.killedBy != null ? 'first-failure' : null,
  };
}

/**
 * Derive per-record detection views, raw status counts, and the Stryker
 * mutation score. The score is always returned alongside statusCounts —
 * it is a derived view, never a standalone verdict. Errors are excluded
 * from the score; Ignored and Pending are not scoreable. With no
 * scoreable mutants at all, score is null rather than a fake 0/0.
 */
export function summarizeStatuses(
  records: readonly MutationRecord[],
): StatusSummary {
  const statusCounts: Record<StrykerStatus, number> = { ...EMPTY_COUNTS };
  for (const record of records) {
    statusCounts[record.observed.status] += 1;
  }

  const detected = statusCounts.Killed + statusCounts.Timeout;
  const undetected = statusCounts.Survived + statusCounts.NoCoverage;
  const total = detected + undetected;
  const score: MutationScore | null =
    total === 0
      ? null
      : {
          detected,
          undetected,
          total,
          value: detected / total,
        };

  const withDetection = records.map((record) => ({
    ...record,
    detection: detectionView(record),
  }));

  return { records: withDetection, statusCounts, score };
}

/**
 * One authored row of the human-disposition ledger. `disposition` and
 * `rationale` are human judgments; a ledger entry is authored for a
 * mutation identified by its stable identityKey.
 */
export interface LedgerLine {
  identityKey: string;
  disposition: Disposition;
  rationale: string;
}

/**
 * Carry authored human dispositions onto records of a fresh sweep,
 * matched by stable identityKey. The tool never generates a disposition:
 * a record with no matching ledger line (or no ledger at all) keeps a
 * null `reviewed`, and a matched record takes the ledger's authored
 * fields verbatim. Observed fields are never touched by a ledger apply.
 *
 * Returns the merged records plus the ledger lines whose identityKey
 * matched no record (e.g. a mutation that stopped being generated), so
 * callers can review them instead of losing them silently.
 *
 * Throws an error if the ledger contains duplicate identityKeys: two
 * different judgments for one mutation is a contradictory ledger, not
 * something to resolve by pick-first.
 */
export function applyLedger(
  records: readonly MutationRecord[],
  ledger: readonly LedgerLine[],
): { records: MutationRecord[]; unmatchedLedgerLines: LedgerLine[] } {
  const ledgerByKey = new Map<string, LedgerLine>();
  for (const line of ledger) {
    if (ledgerByKey.has(line.identityKey)) {
      throw new Error(
        `ledger contains duplicate identityKey: ${line.identityKey}. ` +
          'Each mutation should have at most one ledger entry.',
      );
    }
    ledgerByKey.set(line.identityKey, line);
  }

  const matchedKeys = new Set<string>();
  const merged = records.map((record) => {
    const line = ledgerByKey.get(record.identityKey);
    if (line === undefined) return { ...record };
    matchedKeys.add(record.identityKey);
    return {
      ...record,
      reviewed: {
        disposition: line.disposition,
        contract: record.reviewed.contract,
        distinguishingCondition: record.reviewed.distinguishingCondition,
        reachableSetup: record.reviewed.reachableSetup,
        observableDifference: record.reviewed.observableDifference,
        falsifierResult: record.reviewed.falsifierResult,
        rationale: line.rationale,
      },
    };
  });

  const unmatchedLedgerLines = ledger.filter(
    (line) => !matchedKeys.has(line.identityKey),
  );

  return { records: merged, unmatchedLedgerLines };
}
