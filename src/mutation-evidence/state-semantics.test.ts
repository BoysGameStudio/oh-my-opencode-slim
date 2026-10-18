import { describe, expect, test } from 'bun:test';
import type { MutationRecord } from './records';
import { renderReport } from './report';

function rec(id: string, status: string, fileName: string): MutationRecord {
  const column = 22 + Number(id);
  return {
    identity: {
      fileName,
      location: {
        start: { line: 1, column },
        end: { line: 1, column: column + 4 },
      },
      mutatorName: 'BooleanLiteral',
      original: 'true',
      replacement: 'false',
    },
    identityKey: JSON.stringify([
      fileName,
      1,
      column,
      1,
      column + 4,
      'BooleanLiteral',
      'true',
      'false',
    ]),
    observed: {
      id,
      status: status as MutationRecord['observed']['status'],
      static: false,
      coveredBy: [],
      killedBy: null,
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
  };
}

describe('state semantics: baseline per file set', () => {
  test('first sweep claims baseline', () => {
    const records = [rec('1', 'Survived', 'a.ts')];
    const out = renderReport({ records, baseline: undefined, ledger: [] });
    expect(out).toContain('baseline: reports/mutation/baselines/a_ts.json (this run is the reference)');
  });

  test('second sweep attaches to baseline only if same file set', () => {
    const records1 = [rec('1', 'Survived', 'a.ts')];
    const baselinePath = 'reports/mutation/baselines/a_ts.json';
    
    const out1 = renderReport({ records: records1, baseline: undefined, ledger: [] });
    expect(out1).toContain('(this run is the reference)');
    
    const records2 = [rec('2', 'Killed', 'a.ts')];
    const out2 = renderReport({ records: records2, baseline: records1, ledger: [] });
    expect(out2).toContain('baseline: reports/mutation/baselines/a_ts.json');
    expect(out2).not.toContain('(this run is the reference)');
  });

  test('different file set never borrows baseline', () => {
    const records1 = [rec('1', 'Survived', 'a.ts')];
    const out1 = renderReport({ records: records1, baseline: undefined, ledger: [] });
    expect(out1).toContain('(this run is the reference)');
    
    const records2 = [rec('1', 'Survived', 'b.ts')];
    const out2 = renderReport({ records: records2, baseline: records1, ledger: [] });
    expect(out2).toContain('baseline: reports/mutation/baselines/b_ts.json (this run is the reference)');
  });

  test('replacement resets the reference', () => {
    const records1 = [rec('1', 'Survived', 'a.ts')];
    const out1 = renderReport({ records: records1, baseline: undefined, ledger: [] });
    expect(out1).toContain('(this run is the reference)');
    
    const baselinePath = 'reports/mutation/baselines/a_ts.json';
    const records2 = [rec('2', 'Killed', 'a.ts')];
    const out2 = renderReport({ records: records2, baseline: records1, ledger: [] });
    expect(out2).toContain('baseline: reports/mutation/baselines/a_ts.json');
    expect(out2).not.toContain('(this run is the reference)');
  });
});

describe('state semantics: ledger attach + verbatim carry-through + duplicate identityKey surfacing', () => {
  test('carries ledger entries verbatim and never overwrites', () => {
    const survivor = rec('1', 'Survived', 'a.ts');
    const ledger = [
      {
        identityKey: survivor.identityKey,
        disposition: 'Unreachable-under-invariant',
        rationale: 'state forbidden by the lifecycle',
      },
    ];
    const out = renderReport({ records: [survivor], baseline: undefined, ledger });
    expect(out).toContain('Unreachable-under-invariant');
    expect(out).toContain('state forbidden by the lifecycle');
    expect(out).not.toContain('equivalent');
    expect(out).not.toContain('detected');
  });

  test('two ledger lines under one identityKey surface as contradiction', () => {
    const survivor = rec('1', 'Survived', 'a.ts');
    const contradictoryLedger = [
      {
        identityKey: survivor.identityKey,
        disposition: 'Unreachable-under-invariant',
        rationale: 'first judgment',
      },
      {
        identityKey: survivor.identityKey,
        disposition: 'Detected',
        rationale: 'second judgment',
      },
    ];
    const out = renderReport({ records: [survivor], baseline: undefined, ledger: contradictoryLedger });
    expect(out).toContain('identityKey');
    expect(out).toContain('Unreachable-under-invariant');
    expect(out).toContain('first judgment');
    expect(out).toContain('Detected');
    expect(out).toContain('second judgment');
  });

  test('survivor grouping for large sets', () => {
    const records = [];
    for (let i = 1; i <= 15; i++) {
      records.push(rec(i.toString(), 'Survived', `file${i}.ts`));
    }
    const out = renderReport({ records, baseline: undefined, ledger: [] });
    expect(out).toContain('survivors (15):');
    for (let i = 1; i <= 15; i++) {
      expect(out).toContain(`id=${i}`);
    }
  });

  test('score with Timeout counted detected and slow-under-mutant named', () => {
    const out = renderReport({
      records: [
        rec('1', 'Killed', 'a.ts'),
        rec('2', 'Timeout', 'a.ts'),
        rec('3', 'NoCoverage', 'a.ts'),
        rec('4', 'Error', 'a.ts'),
        rec('5', 'Survived', 'a.ts'),
      ],
      baseline: undefined,
      ledger: [],
    });
    expect(out).toContain('Timeout=1');
    expect(out).toContain('Error=1');
    expect(out).toContain('NoCoverage=1');
    expect(out).toContain('Survived=1');
    expect(out).toContain('Killed=1');
    expect(out).toContain('score:');
  });
});

describe('state semantics: identityKey stability across numeric ID churn', () => {
  test('identityKey depends on source, location, mutator, original, replacement only', () => {
    const out = renderReport({
      records: [
        rec('1', 'Survived', 'a.ts'),
        rec('2', 'Killed', 'a.ts'),
      ],
      baseline: undefined,
      ledger: [],
    });
    expect(out).toContain('id=1');
    expect(out).toContain('id=2');
  });
});

describe('state semantics: tool-observed vs human-concluded separation', () => {
  test('tool-observed fields (status, id, coveredBy) never change when ledger is attached', () => {
    const survivor = rec('1', 'Survived', 'a.ts');
    const ledger = [
      {
        identityKey: survivor.identityKey,
        disposition: 'Detected',
        rationale: 'hand-judged',
      },
    ];
    const out = renderReport({ records: [survivor], baseline: undefined, ledger });
    expect(out).toContain('Detected');
    expect(out).toContain('hand-judged');
    expect(out).toContain('disp=Detected');
    expect(out).not.toContain('unreviewed');
  });

  test('human-concluded fields (disposition, rationale, contract, etc.) come from ledger only', () => {
    const killed = rec('1', 'Killed', 'a.ts');
    const ledger = [
      {
        identityKey: killed.identityKey,
        disposition: 'Equivalent-under-preconditions',
        rationale: 'mutant never triggers in real system',
      },
    ];
    const out = renderReport({ records: [killed], baseline: undefined, ledger });
    expect(out).toContain('Equivalent-under-preconditions');
    expect(out).toContain('mutant never triggers in real system');
    expect(out).not.toContain('disp=unreviewed');
  });
});

describe('state semantics: transitions block against baseline', () => {
  test('transitions show against baseline (newly-killed, newly-surviving, etc.)', () => {
    const base = [rec('1', 'Survived', 'a.ts'), rec('2', 'Killed', 'a.ts')];
    const next = [rec('1', 'Killed', 'a.ts'), rec('2', 'Survived', 'a.ts')];
    const out = renderReport({ records: next, baseline: base, ledger: [] });
    expect(out).toContain('transitions');
    expect(out).toContain('newly-killed: 1');
    expect(out).toContain('newly-surviving: 1');
    expect(out).toContain('still-surviving: 0');
    expect(out).toContain('already-killed: 0');
  });
});