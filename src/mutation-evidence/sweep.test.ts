import { describe, expect, test } from 'bun:test';
import { baselinePathFor } from './report';
import { resolveTestFile } from './sweep';

describe('resolveTestFile', () => {
  test('pairs a target with its sibling test file', () => {
    expect(resolveTestFile('src/mutation-evidence/records.ts')).toBe(
      'src/mutation-evidence/records.test.ts',
    );
  });

  test('rejects a target with no sibling test file', () => {
    expect(() => resolveTestFile('src/mutation-evidence/nope.ts')).toThrow(
      'mutation sweep: no sibling test file for src/mutation-evidence/nope.ts',
    );
  });
});

describe('baselinePathFor', () => {
  test('maps the same file set to one baseline, any order', () => {
    expect(baselinePathFor(['src/a.ts', 'src/b.ts'])).toBe(
      baselinePathFor(['src/b.ts', 'src/a.ts']),
    );
  });

  test('separates different file sets', () => {
    expect(baselinePathFor(['src/a.ts'])).not.toBe(
      baselinePathFor(['src/a.ts', 'src/b.ts']),
    );
  });
});
