#!/usr/bin/env bun
/**
 * Run eval suites — one with --suite, or all. Optionally judge and synthesize.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { diffResults } from '../evals/display';
import { createEvalClient } from '../evals/eval-client';
import { runJudge } from '../evals/judge';
import { loadAllResults, loadLatestResultPath } from '../evals/results';
import type { EvalSuiteResult } from '../evals/schema';
import { EvalSuiteSchema } from '../evals/schema';
import { runWithSession } from '../evals/session-manager';
import { runSuite } from '../evals/suite-runner';
import { loadEvalSuite, loadEvalSuites } from '../evals/suites';
import { startEvalServer, stopEvalServer } from './eval-server';

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    suite: { type: 'string' },
    'outputs-file': { type: 'string' },
    exclude: { type: 'string' },
    judge: { type: 'boolean' },
    smoke: { type: 'boolean' },
    collect: { type: 'boolean' },
    diff: { type: 'boolean' },
    baseline: { type: 'string' },
    precheck: { type: 'boolean' },
  },
  strict: true,
  allowPositionals: true,
});

const allSuites = loadEvalSuites().map((s) => s.name);

if (allSuites.length === 0) {
  console.error('eval — no eval suites found');
  process.exit(1);
}

const suites = values.suite ? [values.suite] : allSuites;

// ── --precheck: validate all suites ──────────────────────────────────
if (values.precheck) {
  const EVALS_DIR = join(import.meta.dir, '..', 'evals');
  const entries = readdirSync(EVALS_DIR, { withFileTypes: true });
  const suiteDirs = entries.filter(
    (e) => e.isDirectory() && e.name !== 'results' && e.name !== '__tests__',
  );

  const NEUTRAL_CATEGORIES = new Set([
    'natural-routing',
    'direct-execution',
    'skill-trigger',
    'response-quality',
    'execution',
  ]);
  const AGENT_MENTION = /@([a-zA-Z-]+)/;

  let totalCases = 0;
  let issues = 0;
  for (const dir of suiteDirs) {
    const suitePath = join(EVALS_DIR, dir.name, 'eval.json');
    let raw: string;
    try {
      raw = readFileSync(suitePath, 'utf-8');
    } catch {
      console.error(`✗ ${dir.name}: eval.json not found`);
      issues++;
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      console.error(`✗ ${dir.name}: invalid JSON`);
      issues++;
      continue;
    }
    const result = EvalSuiteSchema.safeParse(parsed);
    if (!result.success) {
      console.error(`✗ ${dir.name}: schema validation failed`);
      issues++;
      continue;
    }
    const evals = (parsed as { evals?: unknown[] }).evals ?? [];
    totalCases += evals.length;

    // Non-fatal warning: neutral-category evals must not name @agent
    for (const c of result.data.evals) {
      if (c.category && NEUTRAL_CATEGORIES.has(c.category)) {
        const match = c.prompt.match(AGENT_MENTION);
        if (match) {
          console.warn(
            `[warn] ${dir.name}/${c.id}: prompt names @${match[1]} but category ${c.category} expects neutral routing`,
          );
        }
      }
    }

    for (const c of result.data.evals) {
      if (!c.id || !c.prompt) {
        console.error(`✗ ${dir.name}/${c.id}: missing id or prompt`);
        issues++;
      }
      for (const a of c.assertions) {
        if (a.type === 'references_read' && !a.value) {
          console.error(`✗ ${dir.name}/${c.id}: references_read missing value`);
          issues++;
        }
      }
    }
  }
  if (issues === 0) {
    const label = suiteDirs.length === 1 ? 'suite' : 'suites';
    console.log(
      `${totalCases} eval cases across ${suiteDirs.length} ${label}. All valid.`,
    );
  } else {
    console.error(`${issues} issue${issues > 1 ? 's' : ''} found.`);
    process.exit(1);
  }
  process.exit(0);
}

// ── --diff: compare latest results ──────────────────────────────────
if (values.diff) {
  if (!values.suite) {
    console.error('--diff requires --suite');
    process.exit(1);
  }
  let baseline: EvalSuiteResult | undefined;
  if (values.baseline) {
    try {
      baseline = JSON.parse(
        readFileSync(values.baseline, 'utf-8'),
      ) as EvalSuiteResult;
    } catch {
      console.error(`Failed to read baseline file: ${values.baseline}`);
      process.exit(1);
    }
  }
  const currentResult = loadLatestResultPath(values.suite);
  if (!currentResult) {
    console.error(`No results found for suite "${values.suite}"`);
    process.exit(1);
  }
  const raw = readFileSync(currentResult, 'utf-8');
  const current = JSON.parse(raw) as EvalSuiteResult;
  if (!baseline) {
    const all = loadAllResults(values.suite);
    if (all.length < 2) {
      console.error(
        `Need at least 2 results to diff suite "${values.suite}" (found ${all.length})`,
      );
      process.exit(1);
    }
    baseline = all[1];
  }
  console.log(diffResults(baseline, current));
  process.exit(0);
}

// ── --collect: interactive prompt collection ────────────────────────
if (values.collect) {
  const suite = values.suite ? loadEvalSuite(values.suite) : null;
  if (!suite) {
    console.error('--collect requires --suite <name>');
    process.exit(1);
  }
  const runs = 1;
  const outPath = `/tmp/${suite.name}-outputs.json`;
  console.log(
    `\nSuite: ${suite.name} (${suite.evals.length} cases × ${runs} runs)`,
  );
  console.log(`Agent: ${suite.evals[0]?.agent ?? 'orchestrator'}`);
  console.log(`Output: ${outPath}`);
  console.log('');
  console.log('For each prompt below, run it in OpenCode and paste the full');
  console.log('agent response here. End each response with a line containing');
  console.log('only "." (period). Type "skip" as the first line to skip.\n');

  const outputs: Record<string, string | string[]> = {};
  for (const evalCase of suite.evals) {
    console.log(`─── ${evalCase.id} ───`);
    console.log(`Agent: ${evalCase.agent}`);
    if (evalCase.description) console.log(`Expect: ${evalCase.description}`);
    console.log(
      `Assertions: ${evalCase.assertions.map((a) => `${a.type}:${a.value}`).join(', ')}`,
    );
    console.log('');
    console.log('Prompt:');
    console.log(evalCase.prompt);
    console.log('');
    console.log('Paste response (end with "." on its own line):');

    const lines: string[] = [];
    for await (const line of console) {
      if (line.trim() === '.') break;
      lines.push(line);
    }
    const response = lines.join('\n').trim();
    outputs[evalCase.id] = response.toLowerCase() === 'skip' ? '' : response;
    console.log(`  → ${response.length} chars captured\n`);
  }

  await Bun.write(outPath, JSON.stringify(outputs, null, 2));
  console.log(
    `\nWrote ${Object.keys(outputs).length} eval outputs to ${outPath}`,
  );
  console.log(
    `\nNext: bun run eval --suite ${suite.name} --outputs-file ${outPath}`,
  );
  process.exit(0);
}

const RUBRIC_PATH = join(import.meta.dir, '..', 'evals', 'judge-rubric.md');
const resultsDir = join(import.meta.dir, '..', 'evals', 'results');

const failed: string[] = [];

let beforeFiles = new Set<string>();
try {
  beforeFiles = new Set(readdirSync(resultsDir));
} catch {
  // no stale data
}

// Scoring saved outputs is offline unless an advisory judge is requested.
const server =
  !values['outputs-file'] || values.judge
    ? await startEvalServer({
        url: process.env.OPENCODE_URL,
        executable: process.env.OPENCODE_V1_EXECUTABLE,
      })
    : null;

const judgeResults = new Map<string, string>();

try {
  const client = server
    ? createEvalClient(server.url, process.cwd())
    : undefined;
  for (const suite of suites) {
    const code = await runSuite({
      suiteName: suite,
      client,
      smoke: values.smoke ?? false,
      outputsFile: values['outputs-file'],
      excludeStr: values.exclude,
    });
    if (code !== 0) failed.push(suite);

    if (values.judge && client) {
      const resultsFile = loadLatestResultPath(suite, beforeFiles);
      if (resultsFile) {
        const result = await runJudge({
          suite,
          rubricPath: RUBRIC_PATH,
          resultsFile,
          directory: process.cwd(),
          client,
        });
        if (result.success && result.text) {
          judgeResults.set(suite, result.text);
          console.log(`Judge ${suite} — completed`);
        } else {
          console.log(
            `Judge ${suite} — failed (${result.error ?? 'unknown error'})`,
          );
        }
      } else {
        console.log(`\nNo results for ${suite} — skipping judge.`);
      }
    }
  }
  if (values.judge && client) {
    if (judgeResults.size === 0) {
      console.log('\nNo judge results — skipping oracle synthesis.');
    } else {
      const synthesized: string[] = [];
      for (const suite of suites) {
        const text = judgeResults.get(suite);
        if (text) {
          synthesized.push(`## ${suite}\n\n${text}`);
        }
      }

      if (synthesized.length > 0) {
        const prompt = `@oracle Review the per-suite council judge feedback below and synthesize a big-picture assessment of the agent orchestration system. Identify cross-suite patterns, the highest-priority fixes, and systemic weaknesses. Be direct and concise.\n\n${synthesized.join('\n\n')}`;

        console.log('\nSynthesizing big-picture assessment via oracle...');
        const response = await runWithSession(
          client,
          'orchestrator',
          prompt,
          'oracle synthesis',
          1,
          process.cwd(),
          600_000,
        );
        console.log('\n=== Oracle Big-Picture Assessment ===');
        console.log(response.response || response.error || '(empty response)');
      }
    }
  }
} finally {
  await stopEvalServer(server?.proc ?? null);
}

interface SuiteScore {
  suite: string;
  score: string;
  failed: boolean;
  skipped: boolean;
}
const scoreboard: SuiteScore[] = [];
for (const suite of suites) {
  let files: string[] = [];
  try {
    files = readdirSync(resultsDir)
      .filter((f) => f.startsWith(`${suite}-`) && f.endsWith('.json'))
      .filter((f) => !beforeFiles.has(f))
      .sort()
      .reverse();
  } catch {
    // no results dir
  }
  if (files.length === 0) {
    scoreboard.push({
      suite,
      score: '(no result file)',
      failed: false,
      skipped: true,
    });
    continue;
  }
  try {
    const data = JSON.parse(
      await Bun.file(join(resultsDir, files[0])).text(),
    ) as Record<string, unknown>;
    const p = data.passed ?? '?';
    const t = data.totalEvals ?? '?';
    const score = data.avgPartialScore ?? '';
    scoreboard.push({
      suite,
      score: `passed ${p}/${t}  partial ${score}`,
      failed: failed.includes(suite),
      skipped: false,
    });
  } catch {
    scoreboard.push({
      suite,
      score: '(parse error)',
      failed: false,
      skipped: true,
    });
  }
}
const passed = scoreboard.filter((s) => !s.failed && !s.skipped).length;

console.log(
  `\u2550\u2550\u2550 eval complete: ${passed}/${suites.length} suites passed \u2550\u2550\u2550`,
);
console.log('');
console.log('\u2500\u2500 Scoreboard \u2500\u2500');
for (const s of scoreboard) {
  const badge = s.failed ? '\u274c' : s.skipped ? '\u26a0\ufe0f' : '\u2705';
  console.log(`  ${badge}  ${s.suite}: ${s.score}`);
}
if (failed.length > 0) {
  console.error(`Failed suites: ${failed.join(', ')}`);
  process.exitCode = 1;
}
