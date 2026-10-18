// @ts-check
import { existsSync } from 'node:fs';
import path from 'node:path';

/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
  appendPlugins: ['@hughescr/stryker-bun-runner'],
  testRunner: 'bun',
  coverageAnalysis: 'perTest',
  // Points outside the project file set on purpose: Stryker's tsconfig
  // rewrite is the toolchain's only `typescript` consumer and calls
  // ts.parseConfigFileTextToJson (removed in TS 7). Our flat tsconfig has
  // no extends/references to rewrite, so the rewrite must never run.
  tsconfigFile: 'tsconfig.stryker-unused.json',
  // Scope is set per run through env (the skill does this); the default
  // is the measured hotspot from docs/mutation-testing-poc.md.
  mutate: (
    process.env.MUTATION_MUTATE ?? 'src/hooks/foreground-fallback/index.ts'
  ).split(','),
  // No thresholds on purpose: the score is a reported view, never a gate.
  reporters: ['clear-text', 'json'],
  concurrency: 2,
  bun: {
    // Runner floor is bun >= 1.4.0. The pinned devDep `bun` (1.4.3) is
    // preferred so a fresh install sweeps without system-bun upgrades;
    // bare `bun` (>= 1.4.0) is the fallback.
    bunPath: existsSync('node_modules/.bin/bun')
      ? path.resolve('node_modules/.bin/bun')
      : 'bun',
    timeout: 30000,
    testFiles: (
      process.env.MUTATION_TESTS ??
      'src/hooks/foreground-fallback/index.test.ts'
    ).split(','),
  },
};
