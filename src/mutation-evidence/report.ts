// Thin reporting entry over the collector. Piping Stryker JSON reports
// through collect/compare/summarize is mechanical; the judgment lives in
// the skill (`.agents/skills/mutation-evidence/`) and with the human.
// Nothing here infers a disposition or mutates a ledger. The baseline and
// the ledger are set state: attached automatically whenever they exist.

import { existsSync } from 'node:fs';
import type {
  LedgerLine,
  MutationRecord,
  StrykerReport,
  TransitionKind,
} from './records';
import {
  applyLedger,
  collectMutationRecords,
  compareSweeps,
  summarizeStatuses,
} from './records';

export const LEDGER_PATH = 'docs/mutation-ledger.json';
const BASELINE_DIR = 'reports/mutation/baselines';

// A baseline holds for exactly one file set: sorted, so the same
// targets map to the same reference however they are named.
export function baselinePathFor(files: readonly string[]): string {
  const slug = [...files]
    .sort()
    .map((f) => f.replace(/[^a-zA-Z0-9]+/g, '_'))
    .join('+');
  return `${BASELINE_DIR}/${slug}.json`;
}

function fileSetOf(records: readonly MutationRecord[]): string[] {
  return [...new Set(records.map((r) => r.identity.fileName))].sort();
}

export interface ReportInput {
  records: readonly MutationRecord[];
  baseline?: readonly MutationRecord[];
  ledger: readonly LedgerLine[];
}

const TRANSITION_ORDER: TransitionKind[] = [
  'newly-killed',
  'already-killed',
  'newly-surviving',
  'still-surviving',
  'other',
];

export function renderReport(input: ReportInput): string {
  const { records, baseline, ledger } = input;
  const { records: merged, unmatchedLedgerLines } = applyLedger(
    records,
    ledger,
  );
  const { records: viewed, statusCounts, score } = summarizeStatuses(merged);

  const lines: string[] = [];
  lines.push(`records: ${records.length}`);
  lines.push(
    `counts: Killed=${statusCounts.Killed} Timeout=${statusCounts.Timeout} ` +
      `Survived=${statusCounts.Survived} NoCoverage=${statusCounts.NoCoverage} ` +
      `Error=${statusCounts.Error} Ignored=${statusCounts.Ignored} ` +
      `Pending=${statusCounts.Pending}`,
  );
  lines.push(
    `score: ${
      score === null
        ? 'n/a (nothing scoreable)'
        : `${((score.value ?? 0) * 100).toFixed(1)}% (${score.detected}/${score.total})`
    }`,
  );

  if (baseline !== undefined) {
    const comparison = compareSweeps([...baseline], [...records]);
    const counts = new Map<TransitionKind, number>();
    for (const m of comparison.matched) {
      counts.set(m.transition, (counts.get(m.transition) ?? 0) + 1);
    }
    lines.push(
      `transitions — ${TRANSITION_ORDER.map(
        (k) => `${k}: ${counts.get(k) ?? 0}`,
      ).join(
        ', ',
      )}, added: ${comparison.added.length}, removed: ${comparison.removed.length}`,
    );
  }

  const survivors = viewed.filter((r) => r.observed.status === 'Survived');
  lines.push(`survivors (${survivors.length}):`);
  for (const r of survivors) {
    const loc = `${r.identity.fileName}:${r.identity.location.start.line}:${r.identity.location.start.column}`;
    lines.push(
      `  id=${r.observed.id} ${loc} ${r.identity.mutatorName} ` +
        `${r.identity.original}->${r.identity.replacement} ` +
        `disp=${r.reviewed.disposition ?? 'unreviewed'} ` +
        `key=${r.identityKey}`,
    );
    if (r.reviewed.rationale !== null) {
      lines.push(`    rationale: ${r.reviewed.rationale}`);
    }
  }

  if (unmatchedLedgerLines.length > 0) {
    lines.push(`unmatched ledger lines: ${unmatchedLedgerLines.length}`);
    for (const line of unmatchedLedgerLines) {
      lines.push(
        `  ${line.identityKey} disp=${line.disposition} ` +
          `rationale: ${line.rationale}`,
      );
    }
  }

  return lines.join('\n');
}

async function readReport(path: string): Promise<MutationRecord[]> {
  return collectMutationRecords((await Bun.file(path).json()) as StrykerReport);
}

export async function summarizeReport(reportPath: string): Promise<string> {
  const records = await readReport(reportPath);
  const baselinePath = baselinePathFor(fileSetOf(records));
  const [baseline, ledger] = await Promise.all([
    existsSync(baselinePath) ? readReport(baselinePath) : undefined,
    existsSync(LEDGER_PATH)
      ? (Bun.file(LEDGER_PATH).json() as Promise<LedgerLine[]>)
      : Promise.resolve([] as LedgerLine[]),
  ]);
  return renderReport({ records, baseline, ledger });
}

if (import.meta.main) {
  const reportPath = process.argv[2];
  if (reportPath === undefined) {
    console.error('usage: bun src/mutation-evidence/report.ts <report.json>');
    process.exit(1);
  }
  console.log(await summarizeReport(reportPath));
}
