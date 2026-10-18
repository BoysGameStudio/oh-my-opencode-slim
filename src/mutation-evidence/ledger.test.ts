import { describe, expect, test } from 'bun:test';
import type {
  Disposition,
  MutationRecord,
  StrykerMutant,
  StrykerReport,
} from './records';
import { applyLedger, collectMutationRecords } from './records';

const SOURCE = 'function f() { return true; }';

function mutant(
  id: string,
  status: 'Killed' | 'Survived',
  column = 23,
): StrykerMutant {
  return {
    id,
    mutatorName: 'BooleanLiteral',
    replacement: 'false',
    status,
    static: false,
    coveredBy: [],
    location: {
      start: { line: 1, column },
      end: { line: 1, column: column + 4 },
    },
  };
}

function wrap(mutants: StrykerMutant[]): StrykerReport {
  return {
    files: { 'src/example.ts': { source: SOURCE, mutants } },
  };
}

function ledgerLine(
  identityKey: string,
  disposition: Disposition,
  rationale: string,
) {
  return { identityKey, disposition, rationale };
}

// A mutation at column 23 deriving its canonical join key.
const KEY_23 = JSON.stringify([
  'src/example.ts',
  1,
  23,
  1,
  27,
  'BooleanLiteral',
  'true',
  'false',
]);

describe('ledger carry-through (#1601)', () => {
  test('carries authored dispositions onto matching records unchanged', () => {
    const records = collectMutationRecords(
      wrap([mutant(' Survivor-1 ', 'Survived')]),
    );
    const ledger = [
      ledgerLine(
        KEY_23,
        'Equivalent-under-preconditions',
        'flatMap merge order only matters under concurrent refresh; the distinguishing state is unreachable under the single-flight absorb.',
      ),
    ];
    const { records: merged } = applyLedger(records, ledger);
    expect(merged).toHaveLength(1);
    expect(merged[0].reviewed.disposition).toBe(
      'Equivalent-under-preconditions',
    );
    expect(merged[0].reviewed.rationale).toBe(
      'flatMap merge order only matters under concurrent refresh; the distinguishing state is unreachable under the single-flight absorb.',
    );
    // Tool-observed side untouched.
    expect(merged[0].observed.status).toBe('Survived');
    expect(merged[0].identityKey).toBe(KEY_23);
  });

  test('unmatched ledger lines and unreviewed records leave reviewed null', () => {
    const records = collectMutationRecords(
      wrap([mutant('s1', 'Survived'), mutant('s2', 'Survived', 32)]),
    );
    const ledger = [
      ledgerLine(KEY_23, 'Detected', 'verified against the stale-guard test'),
    ];
    const { records: merged, unmatchedLedgerLines } = applyLedger(
      records,
      ledger,
    );
    expect(merged).toHaveLength(2);
    expect(unmatchedLedgerLines).toHaveLength(0);
    const reviewed = merged.find((r) => r.reviewed.disposition !== null);
    const unreviewed = merged.filter((r) => r.reviewed.disposition === null);
    expect(reviewed).toBeDefined();
    expect(unreviewed).toHaveLength(1);
    expect(reviewed?.identityKey).toBe(KEY_23);
  });

  test('unmatched ledger lines are surfaced, not silently dropped', () => {
    const records = collectMutationRecords(wrap([mutant('s1', 'Survived')]));
    const ledger = [
      ledgerLine(KEY_23, 'Detected', 'a'),
      ledgerLine(
        '["src/other.ts",1,2,1,3,"X","a","b"]',
        'Unresolved',
        'ledger entry for a mutation that is no longer generated',
      ),
    ];
    const { records: merged, unmatchedLedgerLines } = applyLedger(
      records,
      ledger,
    );
    expect(merged).toHaveLength(1);
    expect(merged[0].reviewed.disposition).toBe('Detected');
    expect(unmatchedLedgerLines).toEqual([
      {
        identityKey: '["src/other.ts",1,2,1,3,"X","a","b"]',
        disposition: 'Unresolved',
        rationale: 'ledger entry for a mutation that is no longer generated',
      },
    ]);
  });

  test('ledger never infers a disposition from any status', () => {
    const records = collectMutationRecords(
      wrap([
        mutant('k1', 'Killed'),
        mutant('s1', 'Survived'),
        mutant('s2', 'Survived', 32),
      ]),
    );
    const { records: merged } = applyLedger(records, []);
    for (const r of merged) {
      expect(r.reviewed.disposition).toBeNull();
    }
    // Survived statuses never auto-convert to an equivalence claim.
    expect(
      merged.every((r) =>
        r.observed.status === 'Survived'
          ? r.reviewed.disposition === null
          : true,
      ),
    ).toBe(true);
  });

  test('a fresh run never overwrites authored conclusions', () => {
    const oldRecords = collectMutationRecords(
      wrap([mutant('old', 'Survived')]),
    );
    const newRecords = collectMutationRecords(wrap([mutant('new', 'Killed')]));
    const ledger = [
      ledgerLine(
        KEY_23,
        'Unreachable-under-invariant',
        'forever unreachable; sessionModel.delete only fires at line 1172',
      ),
    ];
    const { records: first } = applyLedger(oldRecords, ledger);
    const { records: second } = applyLedger(newRecords, ledger);
    expect(first[0].reviewed.disposition).toBe('Unreachable-under-invariant');
    expect(second[0].reviewed.disposition).toBe('Unreachable-under-invariant');
    // Statuses changed between runs (Survived -> Killed) but the authored
    // conclusion is identical both times — it is carried, not inferred.
    expect(first[0].observed.status).toBe('Survived');
    expect(second[0].observed.status).toBe('Killed');
  });

  test('tool-observed and human-concluded fields stay separate', () => {
    const records = collectMutationRecords(wrap([mutant('s1', 'Survived')]));
    const ledger = [ledgerLine(KEY_23, 'Detected', 'reasoned by hand')];
    const { records: merged } = applyLedger(records, ledger);
    const r = merged[0] as MutationRecord;
    expect(r.observed.status).toBe('Survived');
    expect(r.observed.id).toBe('s1');
    expect(r.reviewed.disposition).toBe('Detected');
    expect(r.reviewed.rationale).toBe('reasoned by hand');
    // The reviewed group contains nothing tool-observed:
    expect(Object.keys(r.reviewed).sort()).toEqual([
      'contract',
      'disposition',
      'distinguishingCondition',
      'falsifierResult',
      'observableDifference',
      'rationale',
      'reachableSetup',
    ]);
  });
});
