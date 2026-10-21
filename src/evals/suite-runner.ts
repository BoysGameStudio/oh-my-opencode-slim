#!/usr/bin/env bun
/**
 * Run a single eval suite through the full pipeline: stash git, collect
 * outputs, score, save results, restore git.
 *
 * Extracted from eval.ts's internal runSuite closure so the module is
 * independently callable (no implicit parseArgs values).
 */

import { execFileSync } from 'node:child_process';
import { collectSuite } from '../cli/auto-collect';
import { restoreAfterEvals, stashChanges } from '../cli/git-lifecycle';
import { formatResult } from './display';
import type { EvalSessionClient } from './eval-client';
import { saveResults } from './results';
import type { EvalSuiteResult, Transcript } from './schema';
import { executeSuite } from './scoring';
import { EvalQuiescenceError } from './session-quiescence';
import { loadEvalSuite } from './suites';

// ── Options ─────────────────────────────────────────────────────────

export interface RunSuiteOptions {
  suiteName: string;
  client?: EvalSessionClient;
  smoke: boolean;
  outputsFile?: string;
  excludeStr?: string;
}

// ── Execution ───────────────────────────────────────────────────────

/** Run a single eval suite: collect, score, save, return exit code. */
const suiteDependencies = {
  collectSuite,
  stashChanges,
  restoreAfterEvals,
  loadEvalSuite,
  executeSuite,
  saveResults,
  formatResult,
};

export async function runSuite(
  opts: RunSuiteOptions,
  deps = suiteDependencies,
): Promise<number> {
  const {
    suiteName,
    client,
    smoke,
    outputsFile: outputsFileOpt,
    excludeStr,
  } = opts;
  const exclude = buildExcludeSet(excludeStr);
  const runs = smoke ? 1 : 3;
  const concurrency = Number(process.env.EVAL_CONCURRENCY ?? 3);
  const cwd = process.cwd();
  const timeoutMs = 300_000;
  const suite = deps.loadEvalSuite(suiteName);
  if (!suite) {
    console.error(`Suite "${suiteName}" not found`);
    return 1;
  }
  if (!outputsFileOpt && !client) {
    throw new Error('Live eval collection requires an OpenCode client');
  }
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error('EVAL_CONCURRENCY must be a positive integer');
  }

  let outputs: Record<string, string | string[]> = {};
  let outputsFile = outputsFileOpt;
  let stash: string | null = null;
  let collectionStarted = false;
  let cleanupSafe = true;
  let result: EvalSuiteResult | undefined;

  // Validate before stashing. Restore only after collection proves its writers
  // stopped; an unconfirmed shutdown deliberately leaves user work stashed.
  try {
    if (!outputsFile) {
      const out = `/tmp/${suiteName}.json`;
      console.log('Stashing working tree for clean eval run...');
      stash = deps.stashChanges(`${suiteName}-eval-prestash`, cwd);
      collectionStarted = true;

      const effectiveRuns = smoke ? 1 : runs;
      const effectiveExclude = new Set(exclude);
      if (smoke) {
        for (const c of suite.evals) {
          if (!c.smoke) effectiveExclude.add(c.id);
        }
      }

      console.log(`Collecting fresh eval outputs for ${suiteName}...`);
      const collected = await deps.collectSuite({
        suite: {
          ...suite,
          evals: suite.evals.filter((e) => !effectiveExclude.has(e.id)),
        },
        client: client as EvalSessionClient,
        runs: effectiveRuns,
        concurrency,
        directory: cwd,
        outPath: out,
        timeoutMs,
      });
      outputs = collected.outputs;
      outputsFile = out;
      console.log(
        `\nLoaded ${Object.keys(outputs).length} eval outputs from ${out}`,
      );
    } else {
      outputs = JSON.parse(await Bun.file(outputsFile).text());
    }
    let transcripts: Record<string, Transcript[]> | undefined;
    if (outputsFile) {
      const transcriptPath = outputsFile.replace(
        /\.json$/,
        '-transcripts.json',
      );
      try {
        const raw = await Bun.file(transcriptPath).text();
        transcripts = JSON.parse(raw);
        console.log(`Loaded transcripts from ${transcriptPath}`);
      } catch {
        // doesn't exist
      }
    }

    const scoringExclude = new Set(exclude);
    if (smoke) {
      for (const c of suite.evals) {
        if (!c.smoke) scoringExclude.add(c.id);
      }
    }
    result = await deps.executeSuite(
      suiteName,
      outputs,
      transcripts,
      scoringExclude,
    );

    try {
      result.gitCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd })
        .toString()
        .trim();
      result.gitBranch = execFileSync(
        'git',
        ['rev-parse', '--abbrev-ref', 'HEAD'],
        { cwd },
      )
        .toString()
        .trim();
    } catch {
      // git unavailable
    }

    console.log(deps.formatResult(result));

    if (transcripts) {
      const agentUsage = new Map<
        string,
        { input: number; output: number; cost: number }
      >();
      for (const tList of Object.values(transcripts)) {
        for (const t of tList) {
          for (const [agent, usage] of Object.entries(t.agentTokens ?? {})) {
            const cur = agentUsage.get(agent) ?? {
              input: 0,
              output: 0,
              cost: 0,
            };
            cur.input += usage.input ?? 0;
            cur.output += usage.output ?? 0;
            cur.cost += usage.cost ?? 0;
            agentUsage.set(agent, cur);
          }
        }
      }
      if (agentUsage.size > 0) {
        console.log('\nToken/cost usage per agent (all runs):');
        for (const [agent, usage] of agentUsage) {
          console.log(
            `  ${agent}: in=${usage.input.toLocaleString()} out=${usage.output.toLocaleString()} cost=$${usage.cost.toFixed(4)}`,
          );
        }
      }
    }

    if (result.totalEvals > 0) {
      const resultsFile = deps.saveResults(suiteName, result);
      console.log(`\nResults saved to ${resultsFile}`);
    }
  } catch (error) {
    if (error instanceof EvalQuiescenceError) {
      cleanupSafe = false;
      console.error(
        `Eval shutdown could not be confirmed. No reset, clean, or stash restore was attempted. Working directory: ${cwd}. Preserved stash: ${stash ?? '(initial tree was clean)'}. Stop the listed eval sessions before recovering user work with git stash apply --index <stash>.`,
      );
    }
    throw error;
  } finally {
    if (collectionStarted && cleanupSafe) {
      console.log('Cleaning eval artifacts and restoring working tree...');
      deps.restoreAfterEvals(stash, cwd);
    }
  }

  if (!result) return 1;

  let exitCode =
    result.failed > 0 || result.skipped > 0 || result.totalEvals === 0 ? 1 : 0;
  const flaky = result.results.filter(
    (r) => r.passAtK === 1 && r.passKk === 0 && r.runs >= 3,
  );
  if (flaky.length > 0) {
    console.log(
      `\n\u26a0 ${flaky.length} flaky eval(s) detected (pass@k=1 but pass^k=0):`,
    );
    for (const f of flaky) {
      console.log(
        `  - ${f.evalId}: ${f.runs} runs, ${(f.passRate * 100).toFixed(0)}% pass rate`,
      );
    }
    exitCode = 2;
  }

  console.log(
    `\u2550\u2550\u2550 [done] ${suiteName} (exit ${exitCode}) \u2550\u2550\u2550`,
  );
  return exitCode;
}

// ── Helpers ─────────────────────────────────────────────────────────

function buildExcludeSet(excludeStr?: string): Set<string> | undefined {
  const ids = (excludeStr ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);
  return ids.length > 0 ? new Set(ids) : undefined;
}
