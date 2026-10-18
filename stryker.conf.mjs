// @ts-check
/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
  appendPlugins: ['@hughescr/stryker-bun-runner'],
  testRunner: 'bun',
  coverageAnalysis: 'perTest',
  // Scope is set per run through env (the skill does this); the default
  // is the measured hotspot from docs/mutation-testing-poc.md.
  mutate: (
    process.env.MUTATION_MUTATE ?? 'src/hooks/foreground-fallback/index.ts'
  ).split(','),
  // No thresholds on purpose: the score is a reported view, never a gate.
  reporters: ['clear-text', 'json'],
  concurrency: 2,
  bun: {
    // Runner floor is bun >= 1.4.0; `bun add -d bun@1.4.3` locally when
    // the system bun is older.
    bunPath: 'bun',
    timeout: 30000,
    testFiles: (
      process.env.MUTATION_TESTS ??
      'src/hooks/foreground-fallback/index.test.ts'
    ).split(','),
  },
};
