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
