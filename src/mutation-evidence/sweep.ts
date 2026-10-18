// One-command sweep: scope -> stryker -> summary. The plumbing (env-scoped
// mutate/test lists, report path, test pairing) lives here so a run is just
// "name the files"; the judgment stays in the skill and with the human.

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { summarizeReport } from './report';

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
  const argv = process.argv.slice(2);
  const files: string[] = [];
  let baseline: string | undefined;
  let ledger: string | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--baseline' || arg === '--ledger') {
      const value = argv[i + 1];
      if (value === undefined) {
        throw new Error(`mutation sweep: ${arg} needs a value`);
      }
      if (arg === '--baseline') {
        baseline = value;
      } else {
        ledger = value;
      }
      i += 1;
    } else {
      files.push(arg);
    }
  }
  if (files.length === 0) {
    throw new Error(
      'usage: bun run mutation:sweep -- <files...> ' +
        '[--baseline <report.json>] [--ledger <ledger.json>]',
    );
  }
  const tests = files.map(resolveTestFile);
  const code = await runStryker(files, tests);
  if (code !== 0) {
    process.exit(code);
  }
  console.log(await summarizeReport(REPORT_PATH, { baseline, ledger }));
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
