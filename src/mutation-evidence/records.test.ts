import { describe, expect, test } from 'bun:test';
import { collectMutationRecords, type StrykerReport } from './records';

// Real worked-example sweep data. expectedOriginal is real ground truth
// (independent of our derivation), so it catches identity/derivation bugs.
const realFixture = (await Bun.file(
  `${import.meta.dir}/__fixtures__/real-worked-example.json`,
).json()) as {
  fileName: string;
  source: string;
  mutants: Array<Record<string, any>>;
};

function wrap(fileName: string, source: string, mutants: any): StrykerReport {
  return { files: { [fileName]: { source, mutants } } } as StrykerReport;
}

describe('collectMutationRecords', () => {
  test('collects one record per mutant carrying identity fields and raw status', () => {
    const source = 'function f(a, b) {\n  return a && b;\n}\n';
    const records = collectMutationRecords(
      wrap('a.ts', source, [
        {
          id: '1',
          mutatorName: 'LogicalOperator',
          replacement: 'a || b',
          status: 'Killed',
          static: false,
          coveredBy: ['t1'],
          location: {
            start: { line: 2, column: 10 },
            end: { line: 2, column: 16 },
          },
        },
      ]),
    );
    expect(records).toHaveLength(1);
    const r = records[0];
    expect(r.identity.fileName).toBe('a.ts');
    expect(r.identity.mutatorName).toBe('LogicalOperator');
    expect(r.identity.replacement).toBe('a || b');
    expect(r.identity.location).toEqual({
      start: { line: 2, column: 10 },
      end: { line: 2, column: 16 },
    });
    expect(r.observed.id).toBe('1');
    expect(r.observed.status).toBe('Killed');
  });

  test('derives original from source using 1-based columns', () => {
    const source = 'function f(a, b) {\n  return a && b;\n}\n';
    const records = collectMutationRecords(
      wrap('a.ts', source, [
        {
          id: '1',
          mutatorName: 'LogicalOperator',
          replacement: 'a || b',
          status: 'Killed',
          static: false,
          coveredBy: [],
          location: {
            start: { line: 2, column: 10 },
            end: { line: 2, column: 16 },
          },
        },
      ]),
    );
    expect(records[0].identity.original).toBe('a && b');
  });

  test('derives multi-line original across line breaks', () => {
    const source = 'function f(a, b) {\n  return (\n    a &&\n    b\n  );\n}\n';
    const records = collectMutationRecords(
      wrap('a.ts', source, [
        {
          id: '1',
          mutatorName: 'LogicalOperator',
          replacement: 'a ||\n    b',
          status: 'Survived',
          static: false,
          coveredBy: [],
          location: {
            start: { line: 3, column: 5 },
            end: { line: 4, column: 6 },
          },
        },
      ]),
    );
    expect(records[0].identity.original).toBe('a &&\n    b');
  });

  test('identity distinguishes mutants that share a start but span different expressions', () => {
    const source = 'function f(a, b) {\n  return a && b;\n}\n';
    const records = collectMutationRecords(
      wrap('a.ts', source, [
        {
          id: '1',
          mutatorName: 'ConditionalExpression',
          replacement: 'true',
          status: 'Survived',
          static: false,
          coveredBy: [],
          location: {
            start: { line: 2, column: 10 },
            end: { line: 2, column: 16 },
          },
        },
        {
          id: '2',
          mutatorName: 'BooleanLiteral',
          replacement: 'true',
          status: 'Survived',
          static: false,
          coveredBy: [],
          location: {
            start: { line: 2, column: 10 },
            end: { line: 2, column: 11 },
          },
        },
      ]),
    );
    const [whole, conjunct] = records;
    expect(whole.identity.original).toBe('a && b');
    expect(conjunct.identity.original).toBe('a');
    expect(whole.identityKey).not.toBe(conjunct.identityKey);
  });

  test('identity key records but does not depend on the numeric mutant id', () => {
    const source = 'function f(a, b) {\n  return a && b;\n}\n';
    const mutant = {
      id: '1',
      mutatorName: 'LogicalOperator',
      replacement: 'a || b',
      status: 'Killed',
      static: false,
      coveredBy: [],
      location: {
        start: { line: 2, column: 10 },
        end: { line: 2, column: 16 },
      },
    };
    const a = collectMutationRecords(wrap('a.ts', source, [mutant]))[0];
    const b = collectMutationRecords(
      wrap('a.ts', source, [{ ...mutant, id: '99' }]),
    )[0];
    expect(a.identityKey).toBe(b.identityKey);
    expect(a.observed.id).toBe('1');
    expect(b.observed.id).toBe('99');
  });

  test('real worked-example fixture: one record per mutant, original matches ground truth', () => {
    const records = collectMutationRecords(
      wrap(realFixture.fileName, realFixture.source, realFixture.mutants),
    );
    expect(records).toHaveLength(realFixture.mutants.length);
    for (let i = 0; i < records.length; i++) {
      expect(records[i].identity.original).toBe(
        realFixture.mutants[i].expectedOriginal,
      );
      expect(records[i].identity.mutatorName).toBe(
        realFixture.mutants[i].mutatorName,
      );
      expect(records[i].identity.replacement).toBe(
        realFixture.mutants[i].replacement,
      );
      expect(records[i].observed.status).toBe(realFixture.mutants[i].status);
    }
    const keys = records.map((r) => r.identityKey);
    expect(new Set(keys).size).toBe(records.length);
  });

  test('real worked-example fixture: identity is stable across id churn', () => {
    const base = collectMutationRecords(
      wrap(realFixture.fileName, realFixture.source, realFixture.mutants),
    );
    const churned = collectMutationRecords(
      wrap(
        realFixture.fileName,
        realFixture.source,
        realFixture.mutants.map((m, i) => ({ ...m, id: `churn-${i}` })),
      ),
    );
    expect(churned.map((r) => r.identityKey).sort()).toEqual(
      base.map((r) => r.identityKey).sort(),
    );
  });

  test('keeps tool-observed fields separate from empty human conclusions', () => {
    const [record] = collectMutationRecords(
      wrap(realFixture.fileName, realFixture.source, realFixture.mutants),
    );
    expect(record.observed.id).toBeTruthy();
    expect(record.observed.status).toBeTruthy();
    expect(Array.isArray(record.observed.coveredBy)).toBe(true);
    expect(record.reviewed.disposition).toBeNull();
    expect(record.reviewed.contract).toBeNull();
    expect(record.reviewed.distinguishingCondition).toBeNull();
    expect(record.reviewed.reachableSetup).toBeNull();
    expect(record.reviewed.observableDifference).toBeNull();
    expect(record.reviewed.falsifierResult).toBeNull();
    expect(record.reviewed.rationale).toBeNull();
  });
});
