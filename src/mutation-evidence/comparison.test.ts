import { describe, expect, test } from 'bun:test';
import type { StrykerReport } from './records';
import { collectMutationRecords, compareSweeps } from './records';

function wrap(fileName: string, source: string, mutants: any): StrykerReport {
  return { files: { [fileName]: { source, mutants } } } as StrykerReport;
}

describe('compareSweeps', () => {
  test('matches mutations by stable identity despite numeric ID differences', () => {
    const source = 'function f() { return true; }';
    const baselineReport = wrap('src/example.ts', source, [
      {
        id: '100',
        mutatorName: 'BooleanLiteral',
        replacement: 'false',
        status: 'Survived',
        static: false,
        coveredBy: [],
        location: {
          start: { line: 1, column: 23 },
          end: { line: 1, column: 27 },
        },
      },
    ]);
    const currentReport = wrap('src/example.ts', source, [
      {
        id: '200',
        mutatorName: 'BooleanLiteral',
        replacement: 'false',
        status: 'Killed',
        static: false,
        coveredBy: ['test.js'],
        location: {
          start: { line: 1, column: 23 },
          end: { line: 1, column: 27 },
        },
      },
    ]);

    const baselineRecords = collectMutationRecords(baselineReport);
    const currentRecords = collectMutationRecords(currentReport);
    const comparison = compareSweeps(baselineRecords, currentRecords);

    // Should have one matched mutation (same identity despite different IDs)
    expect(comparison.matched).toHaveLength(1);
    expect(comparison.added).toHaveLength(0);
    expect(comparison.removed).toHaveLength(0);

    const matched = comparison.matched[0];
    // Identity should match (same file, location, mutator, original, replacement)
    expect(matched.identity.fileName).toBe('src/example.ts');
    expect(matched.identity.mutatorName).toBe('BooleanLiteral');
    expect(matched.identity.original).toBe('true');
    expect(matched.identity.replacement).toBe('false');
    // Should show transition from survived to killed (newly killed)
    expect(matched.transition).toBe('newly-killed');
    // Observed evidence should reflect baseline and current statuses
    expect(matched.baseline.status).toBe('Survived');
    expect(matched.current.status).toBe('Killed');
    // Coverage changed (was empty, now has test.js)
    expect(matched.coverageChanged).toBe(true);
  });

  test('distinguishes newly-killed from already-killed', () => {
    const source = 'function f() { return true; }';
    const baselineKilled = wrap('src/example.ts', source, [
      {
        id: '100',
        mutatorName: 'BooleanLiteral',
        replacement: 'false',
        status: 'Killed',
        static: false,
        coveredBy: ['test.js'],
        location: {
          start: { line: 1, column: 23 },
          end: { line: 1, column: 27 },
        },
      },
    ]);
    const currentKilled = wrap('src/example.ts', source, [
      {
        id: '200',
        mutatorName: 'BooleanLiteral',
        replacement: 'false',
        status: 'Killed',
        static: false,
        coveredBy: ['test.js'],
        location: {
          start: { line: 1, column: 23 },
          end: { line: 1, column: 27 },
        },
      },
    ]);

    const baselineRecords = collectMutationRecords(baselineKilled);
    const currentRecords = collectMutationRecords(currentKilled);
    const comparison = compareSweeps(baselineRecords, currentRecords);

    expect(comparison.matched).toHaveLength(1);
    const matched = comparison.matched[0];
    expect(matched.transition).toBe('already-killed');
    expect(matched.baseline.status).toBe('Killed');
    expect(matched.current.status).toBe('Killed');
  });

  test('surfaces newly-surviving mutants distinctly', () => {
    const source = 'function f() { return true; }';
    const baselineKilled = wrap('src/example.ts', source, [
      {
        id: '100',
        mutatorName: 'BooleanLiteral',
        replacement: 'false',
        status: 'Killed',
        static: false,
        coveredBy: ['test.js'],
        location: {
          start: { line: 1, column: 23 },
          end: { line: 1, column: 27 },
        },
      },
    ]);
    const currentSurvived = wrap('src/example.ts', source, [
      {
        id: '200',
        mutatorName: 'BooleanLiteral',
        replacement: 'false',
        status: 'Survived',
        static: false,
        coveredBy: [],
        location: {
          start: { line: 1, column: 23 },
          end: { line: 1, column: 27 },
        },
      },
    ]);

    const baselineRecords = collectMutationRecords(baselineKilled);
    const currentRecords = collectMutationRecords(currentSurvived);
    const comparison = compareSweeps(baselineRecords, currentRecords);

    expect(comparison.matched).toHaveLength(1);
    const matched = comparison.matched[0];
    expect(matched.transition).toBe('newly-surviving');
    expect(matched.baseline.status).toBe('Killed');
    expect(matched.current.status).toBe('Survived');
    expect(matched.coverageChanged).toBe(true); // coverage went from ['test.js'] to []
  });

  test('surfaces coverage changes distinctly', () => {
    const source = 'function f() { return true; }';
    const baseline = wrap('src/example.ts', source, [
      {
        id: '100',
        mutatorName: 'BooleanLiteral',
        replacement: 'false',
        status: 'Survived',
        static: false,
        coveredBy: ['test1.js'],
        location: {
          start: { line: 1, column: 23 },
          end: { line: 1, column: 27 },
        },
      },
    ]);
    const current = wrap('src/example.ts', source, [
      {
        id: '200',
        mutatorName: 'BooleanLiteral',
        replacement: 'false',
        status: 'Survived',
        static: false,
        coveredBy: ['test1.js', 'test2.js'],
        location: {
          start: { line: 1, column: 23 },
          end: { line: 1, column: 27 },
        },
      },
    ]);

    const baselineRecords = collectMutationRecords(baseline);
    const currentRecords = collectMutationRecords(current);
    const comparison = compareSweeps(baselineRecords, currentRecords);

    expect(comparison.matched).toHaveLength(1);
    const matched = comparison.matched[0];
    // Same status (both survived) so transition should be still-surviving
    expect(matched.transition).toBe('still-surviving');
    // But coverage changed
    expect(matched.coverageChanged).toBe(true);
    expect(matched.baseline.coveredBy).toEqual(['test1.js']);
    expect(matched.current.coveredBy).toEqual(['test1.js', 'test2.js']);
  });

  test('reports added and removed mutants', () => {
    const source = 'function f() { return true; }';
    const baseline = wrap('src/example.ts', source, [
      {
        id: '100',
        mutatorName: 'BooleanLiteral',
        replacement: 'false',
        status: 'Survived',
        static: false,
        coveredBy: [],
        location: {
          start: { line: 1, column: 23 },
          end: { line: 1, column: 27 },
        },
      },
    ]);
    const current = wrap('src/example.ts', source, [
      {
        id: '100',
        mutatorName: 'BooleanLiteral',
        replacement: 'false',
        status: 'Survived',
        static: false,
        coveredBy: [],
        location: {
          start: { line: 1, column: 23 },
          end: { line: 1, column: 27 },
        },
      },
      {
        id: '300',
        mutatorName: 'BooleanLiteral',
        replacement: 'false',
        status: 'Killed',
        static: false,
        coveredBy: ['new-test.js'],
        location: {
          start: { line: 1, column: 24 },
          end: { line: 1, column: 30 },
        },
      }, // Different location
    ]);

    const baselineRecords = collectMutationRecords(baseline);
    const currentRecords = collectMutationRecords(current);
    const comparison = compareSweeps(baselineRecords, currentRecords);

    expect(comparison.matched).toHaveLength(1); // first mutant matched
    expect(comparison.added).toHaveLength(1); // second mutant added
    expect(comparison.removed).toHaveLength(0);

    // Check added mutant
    const added = comparison.added[0];
    expect(added.identity.mutatorName).toBe('BooleanLiteral');
    expect(added.identity.replacement).toBe('false');
    expect(added.identity.location.start.line).toBe(1);
    expect(added.identity.location.start.column).toBe(24);
    expect(added.observed.status).toBe('Killed');
    expect(added.observed.id).toBe('300');
  });

  test('does not rely on numeric mutant IDs for matching', () => {
    const source = 'function f() { return true && false; }';
    // Two mutants at different locations
    const baselineReport = wrap('src/example.ts', source, [
      {
        id: 'AAA',
        mutatorName: 'BooleanLiteral',
        replacement: 'false',
        status: 'Survived',
        static: false,
        coveredBy: [],
        location: {
          start: { line: 1, column: 23 },
          end: { line: 1, column: 27 },
        },
      }, // first boolean
      {
        id: 'BBB',
        mutatorName: 'BooleanLiteral',
        replacement: 'true',
        status: 'Killed',
        static: false,
        coveredBy: ['test.js'],
        location: {
          start: { line: 1, column: 31 },
          end: { line: 1, column: 35 },
        },
      }, // second boolean
    ]);
    // Same mutants but with completely different IDs
    const currentReport = wrap('src/example.ts', source, [
      {
        id: 'XYZ789',
        mutatorName: 'BooleanLiteral',
        replacement: 'false',
        status: 'Killed',
        static: false,
        coveredBy: ['new-test.js'],
        location: {
          start: { line: 1, column: 23 },
          end: { line: 1, column: 27 },
        },
      },
      {
        id: 'XYZ123',
        mutatorName: 'BooleanLiteral',
        replacement: 'true',
        status: 'Survived',
        static: false,
        coveredBy: [],
        location: {
          start: { line: 1, column: 31 },
          end: { line: 1, column: 35 },
        },
      },
    ]);

    const baselineRecords = collectMutationRecords(baselineReport);
    const currentRecords = collectMutationRecords(currentReport);
    const comparison = compareSweeps(baselineRecords, currentRecords);
    const first = comparison.matched.find(
      (m) => m.identity.location.start.column === 23,
    );
    expect(first).toBeDefined();
    expect(first?.transition).toBe('newly-killed');
    expect(first?.baseline.status).toBe('Survived');
    expect(first?.current.status).toBe('Killed');

    // Second mutant: Killed -> Survived (newly surviving)
    const second = comparison.matched.find(
      (m) => m.identity.location.start.column === 31,
    );
    expect(second).toBeDefined();
    expect(second?.transition).toBe('newly-surviving');
    expect(second?.baseline.status).toBe('Killed');
    expect(second?.current.status).toBe('Survived');
  });
});
