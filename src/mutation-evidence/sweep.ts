// One-command sweep: scope -> stryker -> summary. A run carries its own
// state: the first run for a file set becomes its baseline and later runs
// compare against it; the human ledger attaches whenever it exists. No
// options — the user's words (audit/critique/fix/baseline) live in the
// skill, the judgment with the human.

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { baselinePathFor, summarizeReport } from './report';

const REPORT_PATH = 'reports/mutation/mutation.json';

export function resolveTestFile(target: string): string {
  const testFile = target.replace(/\.ts$/, '.test.ts');
  if (testFile === target || !existsSync(testFile)) {
    throw new Error(`mutation sweep: no sibling test file for ${target}`);
  }
  return testFile;
}

function runStryker(
  files: readonly string[],
  tests: readonly string[],
): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn('bunx', ['stryker', 'run', '--reporters', 'json'], {
      stdio: 'inherit',
      env: {
        ...process.env,
        MUTATION_MUTATE: files.join(','),
        MUTATION_TESTS: tests.join(','),
      },
    });
    child.on('error', reject);
    child.on('exit', (code) => resolve(code ?? 1));
  });
}

async function main(): Promise<void> {
  const files = process.argv.slice(2);
  if (files.length === 0) {
    throw new Error('usage: bun run mutation:sweep -- <files...>');
  }
  const tests = files.map(resolveTestFile);
  const code = await runStryker(files, tests);
  if (code !== 0) {
    process.exit(code);
  }

  const baselinePath = baselinePathFor(files);
  const firstRun = !existsSync(baselinePath);
  if (firstRun) {
    await Bun.write(baselinePath, Bun.file(REPORT_PATH));
  }
  console.log(await summarizeReport(REPORT_PATH));
  console.log(
    `baseline: ${baselinePath}` +
      (firstRun ? ' (this run is the reference)' : ''),
  );
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
