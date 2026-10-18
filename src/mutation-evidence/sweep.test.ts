import { describe, expect, test } from 'bun:test';
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
