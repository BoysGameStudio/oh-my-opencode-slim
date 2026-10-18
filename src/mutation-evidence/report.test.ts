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

describe('renderReport', () => {
  test('renders counts, score, and every survivor with its evidence', () => {
    const out = renderReport({
      records: [
        rec('1', 'Survived', 'a.ts'),
        rec('2', 'Killed', 'a.ts'),
        rec('3', 'Timeout', 'a.ts'),
      ],
      ledger: [],
    });
    expect(out).toContain('Survived=1');
    expect(out).toContain('Killed=1');
    expect(out).toContain('Timeout=1');
    // Score is never alone: counts sit in the same output.
    expect(out).toContain('score:');
    // Every survivor appears with its identity for triage.
    expect(out).toContain('id=1');
    expect(out).toContain('a.ts:1:23');
    expect(out).toContain('unreviewed');
    expect(out).not.toContain('id=2');
  });

  test('carries ledger dispositions beside survivors and flags no-match lines', () => {
    const survivor = rec('1', 'Survived', 'a.ts');
    const out = renderReport({
      records: [survivor],
      ledger: [
        {
          identityKey: survivor.identityKey,
          disposition: 'Unreachable-under-invariant',
          rationale: 'state forbidden by the lifecycle',
        },
        {
          identityKey: '["gone",1,1,1,2,"X","a","b"]',
          disposition: 'Unresolved',
          rationale: 'orphaned',
        },
      ],
    });
    expect(out).toContain('Unreachable-under-invariant');
    expect(out).toContain('state forbidden by the lifecycle');
    expect(out).toContain('unmatched ledger lines: 1');
    expect(out).toContain('orphaned');
  });

  test('renders transitions when a baseline sweep is given', () => {
    const base = [rec('1', 'Survived', 'a.ts'), rec('2', 'Killed', 'a.ts')];
    const next = [rec('1', 'Killed', 'a.ts'), rec('2', 'Survived', 'a.ts')];
    const out = renderReport({
      records: next,
      baseline: base,
      ledger: [],
    });
    expect(out).toContain('transitions');
    expect(out).toContain('newly-killed: 1');
    expect(out).toContain('newly-surviving: 1');
  });
});
