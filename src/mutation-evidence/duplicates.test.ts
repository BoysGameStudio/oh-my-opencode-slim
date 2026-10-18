import { describe, expect, test } from 'bun:test';
import type { StrykerMutant, StrykerReport } from './records';
import { applyLedger, collectMutationRecords, compareSweeps } from './records';

const SOURCE = 'function f() { return true; }';
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

function mutant(id: string): StrykerMutant {
  return {
    id,
    mutatorName: 'BooleanLiteral',
    replacement: 'false',
    status: 'Survived',
    static: false,
    coveredBy: [],
    location: {
      start: { line: 1, column: 23 },
      end: { line: 1, column: 27 },
    },
  };
}

function report(mutants: StrykerMutant[]): StrykerReport {
  return {
    files: { 'src/example.ts': { source: SOURCE, mutants } },
  };
}

describe('duplicate identityKey guards', () => {
  test('applyLedger throws on a ledger with two entries for one key', () => {
    const records = collectMutationRecords(report([mutant('1')]));
    const contradictory = [
      {
        identityKey: KEY_23,
        disposition: 'Detected' as const,
        rationale: 'a',
      },
      {
        identityKey: KEY_23,
        disposition: 'Unresolved' as const,
        rationale: 'b',
      },
    ];
    expect(() => applyLedger(records, contradictory)).toThrow(
      /duplicate identityKey/,
    );
  });

  test('compareSweeps throws when one sweep carries two records of one key', () => {
    // Two report mutants with different numeric ids but one identity: the
    // collector transcribes both faithfully, so a sweep may reach the
    // comparison with contradictory statuses under one key. Dropping one
    // silently would falsify evidence; the matcher rejects instead.
    const records = collectMutationRecords(report([mutant('1'), mutant('2')]));
    expect(records).toHaveLength(2);
    expect(records[0].identityKey).toBe(records[1].identityKey);
    expect(() => compareSweeps(records, [])).toThrow(
      /duplicate mutation identity/,
    );
    expect(() => compareSweeps([], records)).toThrow(
      /duplicate mutation identity/,
    );
  });
});
