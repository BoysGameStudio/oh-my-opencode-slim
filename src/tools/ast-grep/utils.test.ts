import { expect, test } from 'bun:test';
import type { SgResult } from './types';
import { formatReplaceResult } from './utils';

test('a truncated parse error does not erase successful writes', () => {
  const result: SgResult = {
    matches: [],
    totalMatches: 0,
    truncated: true,
    truncatedReason: 'max_output_bytes',
    rewritesApplied: true,
    error: 'Output too large and could not be parsed',
  };

  expect(formatReplaceResult(result, false)).toBe(
    '\n[APPLIED] Replacements written. Report truncated (max_output_bytes); replacement and file totals unavailable.',
  );
});

test('truncated previews keep available snippets without claiming full totals', () => {
  const result: SgResult = {
    matches: [
      {
        file: 'repro.js',
        range: {
          byteOffset: { start: 0, end: 12 },
          start: { line: 0, column: 0 },
          end: { line: 0, column: 12 },
        },
        lines: 'console.log()',
        text: 'console.log()',
        replacement: 'console.error()',
        language: 'javascript',
      },
    ],
    totalMatches: 1,
    truncated: true,
    truncatedReason: 'max_output_bytes',
  };

  const output = formatReplaceResult(result, true);
  expect(output).toContain('"console.log()" → "console.error()"');
  expect(output).toContain('[DRY RUN] No files changed.');
  expect(output).toContain('replacement and file totals unavailable');
  expect(output).not.toContain('1 replacements in 1 files');
});
