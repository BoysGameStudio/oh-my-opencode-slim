import { describe, expect, test } from 'bun:test';
import type {
  MutationRecord,
  ObservedEvidence,
  StrykerMutant,
  StrykerReport,
} from './records';
import { collectMutationRecords, summarizeStatuses } from './records';

const realFixture = await Bun.file(
  `${import.meta.dir}/__fixtures__/real-worked-example.json`,
).json();

function mutant(overrides: Partial<StrykerMutant>): StrykerMutant {
  return {
    id: '1',
    mutatorName: 'BooleanLiteral',
    replacement: 'false',
    status: 'Survived',
    static: false,
    coveredBy: [],
    location: {
      start: { line: 1, column: 23 },
      end: { line: 1, column: 27 },
    },
    ...overrides,
  } as StrykerMutant;
}

function report(mutants: StrykerMutant[]): StrykerReport {
  return {
    files: {
      'src/example.ts': { source: 'function f() { return true; }', mutants },
    },
  };
}

function record(partial: {
  observed: Partial<ObservedEvidence> & Pick<ObservedEvidence, 'id' | 'status'>;
}): MutationRecord {
  return {
    identity: {
      fileName: 'src/example.ts',
      location: {
        start: { line: 1, column: 23 },
        end: { line: 1, column: 27 },
      },
      mutatorName: 'BooleanLiteral',
      original: 'true',
      replacement: 'false',
    },
    identityKey: `key-${partial.observed.id}`,
    observed: {
      static: false,
      coveredBy: [],
      ...partial.observed,
    } as ObservedEvidence,
    reviewed: {
      disposition: null,
      contract: null,
      distinguishingCondition: null,
      reachableSetup: null,
      observableDifference: null,
      falsifierResult: null,
      rationale: null,
    },
  } as MutationRecord;
}

describe('status semantics + score (#1600)', () => {
  test('flagged statuses never fold into detected sets', () => {
    const records = collectMutationRecords(
      report([
        mutant({ id: 't1', status: 'Timeout' }),
        mutant({ id: 'e1', status: 'Error' }),
        mutant({ id: 'n1', status: 'NoCoverage' }),
        mutant({ id: 'k1', status: 'Killed' }),
        mutant({ id: 's1', status: 'Survived' }),
      ]),
    );
    const summary = summarizeStatuses(records);
    expect(summary.statusCounts).toEqual({
      Killed: 1,
      Timeout: 1,
      Survived: 1,
      NoCoverage: 1,
      Error: 1,
      Ignored: 0,
      Pending: 0,
    });
  });

  test('killedBy recorded from report and marked first-failure', () => {
    const records = collectMutationRecords(
      report([
        mutant({
          id: 'k1',
          status: 'Killed',
          killedBy: ['278', '279'] as unknown as never,
        }),
        mutant({
          id: 'k2',
          status: 'Killed',
          killedBy: ['15'] as unknown as never,
        }),
      ]),
    );
    const summary = summarizeStatuses(records);
    const first = summary.records[0];
    const second = summary.records[1];
    expect(first.observed.killedBy).toEqual(['278', '279']);
    expect(first.detection.killedByKind).toBe('first-failure');
    expect(second.observed.killedBy).toEqual(['15']);
    expect(second.detection.killedByKind).toBe('first-failure');
  });

  test('no killedBy field yields killedByKind null', () => {
    const records = collectMutationRecords(
      report([mutant({ id: 's1', status: 'Survived' })]),
    );
    const summary = summarizeStatuses(records);
    expect(summary.records[0].observed.killedBy).toBeNull();
    expect(summary.records[0].detection.killedByKind).toBeNull();
  });

  test('score follows Stryker semantics with raw counts', () => {
    const records = [
      record({ observed: { id: '1', status: 'Killed' } }),
      record({ observed: { id: '2', status: 'Timeout' } }),
      record({ observed: { id: '3', status: 'Survived' } }),
      record({ observed: { id: '4', status: 'NoCoverage' } }),
      record({ observed: { id: '5', status: 'Error' } }),
      record({ observed: { id: '6', status: 'Ignored' } }),
    ];
    const summary = summarizeStatuses(records);
    expect(summary.score).not.toBeNull();
    expect(summary.score?.detected).toBe(2); // Killed + Timeout
    expect(summary.score?.undetected).toBe(2); // Survived + NoCoverage
    expect(summary.score?.total).toBe(4); // Error + Ignored excluded
    expect(summary.score?.value).toBeCloseTo(0.5);
    // Score is never reported alone: raw counts sit alongside it.
    expect(summary.statusCounts.Killed).toBe(1);
    expect(summary.statusCounts.Timeout).toBe(1);
    expect(summary.statusCounts.Survived).toBe(1);
    expect(summary.statusCounts.NoCoverage).toBe(1);
    expect(summary.statusCounts.Error).toBe(1);
  });

  test('score is null when no scoreable statuses exist', () => {
    const records = [
      record({ observed: { id: '1', status: 'Error' } }),
      record({ observed: { id: '2', status: 'Ignored' } }),
      record({ observed: { id: '3', status: 'Pending' } }),
    ];
    const summary = summarizeStatuses(records);
    expect(summary.score).toBeNull();
    expect(summary.statusCounts.Error).toBe(1);
    expect(summary.statusCounts.Ignored).toBe(1);
    expect(summary.statusCounts.Pending).toBe(1);
  });

  test('real fixture: counts match the authoritative sweep baseline', () => {
    const report = {
      files: {
        [realFixture.fileName]: {
          source: realFixture.source,
          mutants: realFixture.mutants.map((m: Record<string, any>) => ({
            id: m.id,
            mutatorName: m.mutatorName,
            replacement: m.replacement,
            status: m.status,
            static: m.static,
            coveredBy: m.coveredBy ?? [],
            location: m.location,
          })),
        },
      },
    } as StrykerReport;
    const records = collectMutationRecords(report);
    const summary = summarizeStatuses(records);
    expect(summary.records).toHaveLength(16);
    const killed = summary.records.filter(
      (r) => r.observed.status === 'Killed',
    );
    const survived = summary.records.filter(
      (r) => r.observed.status === 'Survived',
    );
    expect(summary.statusCounts.Killed).toBe(killed.length);
    expect(summary.statusCounts.Survived).toBe(survived.length);
    // Every record's flagged outcome is distinct from its detection state.
    for (const r of summary.records) {
      if (r.observed.status === 'Timeout') {
        expect(r.detection.flaggedStatus).toBe('Timeout');
      }
      if (r.observed.status === 'NoCoverage') {
        expect(r.detection.flaggedStatus).toBe('NoCoverage');
      }
      if (r.observed.status === 'Killed') {
        expect(r.detection.flaggedStatus).toBeNull();
      }
    }
  });
});
