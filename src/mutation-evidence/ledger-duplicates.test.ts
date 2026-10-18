import { describe, expect, test } from 'bun:test';
import type { StrykerMutant, StrykerReport } from './records';
import { applyLedger, collectMutationRecords } from './records';

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

describe('applyLedger duplicate guard', () => {
  test('throws on a ledger with two entries for one identityKey', () => {
    const report: StrykerReport = {
      files: { 'src/example.ts': { source: SOURCE, mutants: [mutant('1')] } },
    };
    const records = collectMutationRecords(report);
    const contradictory = [
      { identityKey: KEY_23, disposition: 'Detected' as const, rationale: 'a' },
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
});
