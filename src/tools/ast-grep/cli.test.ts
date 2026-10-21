import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { RunOptions } from './cli';
import type { SgResult } from './types';
import { formatReplaceResult } from './utils';

const SOURCE = 'function add(a, b) {\n  console.log("add", a, b);\n}\n';

// The sg entry is a shim that looks up ast-grep on PATH. Use the real binary.
const astGrepBin = join(
  dirname(createRequire(import.meta.url).resolve('@ast-grep/cli/package.json')),
  process.platform === 'win32' ? 'ast-grep.exe' : 'ast-grep',
);

// Other suites mock utils/compat process-wide. Isolate real CLI executions.
async function runSgInChild(
  options: RunOptions,
  applyError?: string,
): Promise<SgResult> {
  const source = `
    if (process.env.SG_APPLY_ERROR) {
      const { mock } = await import('bun:test');
      mock.module(process.env.APPLY_URL, () => ({
        applyRewrites: async () => process.env.SG_APPLY_ERROR,
      }));
    }
    const { runSg } = await import(process.env.CLI_URL);
    const { setSgCliPath } = await import(process.env.CONSTANTS_URL);
    setSgCliPath(process.env.SG_PATH);
    console.log(JSON.stringify(await runSg(JSON.parse(process.env.SG_OPTIONS))));
  `;
  const proc = Bun.spawn([process.execPath, '-e', source], {
    env: {
      ...process.env,
      CLI_URL: pathToFileURL(join(import.meta.dir, 'cli.ts')).href,
      CONSTANTS_URL: pathToFileURL(join(import.meta.dir, 'constants.ts')).href,
      APPLY_URL: pathToFileURL(join(import.meta.dir, 'apply-rewrites.ts')).href,
      SG_PATH: astGrepBin,
      SG_OPTIONS: JSON.stringify(options),
      SG_APPLY_ERROR: applyError ?? '',
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(`runSg child exited with ${exitCode}: ${stderr}`);
  }
  return JSON.parse(stdout) as SgResult;
}

describe('runSg rewrite', () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'omos-ast-grep-'));
    file = join(dir, 'repro.js');
    writeFileSync(file, SOURCE);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('writes the rewrite to disk when updateAll is set', async () => {
    const result = await runSgInChild({
      pattern: 'console.log($$$ARGS)',
      rewrite: 'console.error($$$ARGS)',
      lang: 'javascript',
      paths: [file],
      updateAll: true,
    });

    expect(result.error).toBeUndefined();
    expect(result.totalMatches).toBe(1);
    expect(result.matches[0].replacement).toBe('console.error("add", a, b)');
    expect(readFileSync(file, 'utf8')).toBe(
      SOURCE.replace('console.log', 'console.error'),
    );
  });

  test('writes even when the first match exceeds the report limit', async () => {
    // More than the 1 MiB report budget; no complete match fits in the report.
    const big = `console.log("${'x'.repeat(1024 * 1024 + 1)}");\n`;
    writeFileSync(file, big);

    const result = await runSgInChild({
      pattern: 'console.log($$$ARGS)',
      rewrite: 'console.error($$$ARGS)',
      lang: 'javascript',
      paths: [file],
      updateAll: true,
    });

    expect(result.error).toBeUndefined();
    expect(result.matches).toEqual([]);
    expect(result.truncated).toBe(true);
    expect(result.truncatedReason).toBe('max_output_bytes');
    expect(readFileSync(file, 'utf8')).toBe(
      big.replace('console.log', 'console.error'),
    );
  });

  test('leaves the file alone without updateAll', async () => {
    const result = await runSgInChild({
      pattern: 'console.log($$$ARGS)',
      rewrite: 'console.error($$$ARGS)',
      lang: 'javascript',
      paths: [file],
    });

    expect(result.error).toBeUndefined();
    expect(result.totalMatches).toBe(1);
    expect(result.matches[0].replacement).toBe('console.error("add", a, b)');
    expect(readFileSync(file, 'utf8')).toBe(SOURCE);
  });

  test('search still reports matches without changing the file', async () => {
    const result = await runSgInChild({
      pattern: 'console.log($$$ARGS)',
      lang: 'javascript',
      paths: [file],
    });

    expect(result.error).toBeUndefined();
    expect(result.totalMatches).toBe(1);
    expect(result.matches[0].text).toBe('console.log("add", a, b)');
    expect(readFileSync(file, 'utf8')).toBe(SOURCE);
  });

  test('applies only files selected by the same paths and globs', async () => {
    const excluded = join(dir, 'excluded.js');
    writeFileSync(excluded, SOURCE);
    const result = await runSgInChild({
      pattern: 'console.log($$$ARGS)',
      rewrite: 'console.error($$$ARGS)',
      lang: 'javascript',
      paths: [dir],
      globs: ['!excluded.js'],
      updateAll: true,
    });

    expect(result.error).toBeUndefined();
    expect(result.totalMatches).toBe(1);
    expect(readFileSync(file, 'utf8')).toBe(
      SOURCE.replace('console.log', 'console.error'),
    );
    expect(readFileSync(excluded, 'utf8')).toBe(SOURCE);
  });

  test.each(['Permission denied', 'Rewrite timeout after 300000ms'])(
    'surfaces apply errors instead of reporting applied: %s',
    async (applyError) => {
      const result = await runSgInChild(
        {
          pattern: 'console.log($$$ARGS)',
          rewrite: 'console.error($$$ARGS)',
          lang: 'javascript',
          paths: [file],
          updateAll: true,
        },
        applyError,
      );

      expect(result.error).toBe(applyError);
      expect(result.matches).toEqual([]);
      expect(formatReplaceResult(result, false)).toBe(`Error: ${applyError}`);
      expect(readFileSync(file, 'utf8')).toBe(SOURCE);
    },
  );
});
