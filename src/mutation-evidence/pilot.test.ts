import { describe, expect, test } from 'bun:test';
import type {
  Disposition,
  MutationIdentity,
  StrykerMutant,
  StrykerReport,
} from './records';
import {
  applyLedger,
  collectMutationRecords,
  summarizeStatuses,
} from './records';

interface FixtureMutant {
  id: string;
  mutatorName: string;
  replacement: string;
  status: StrykerMutant['status'];
  static: boolean;
  coveredBy: string[];
  killedBy: string[] | null;
  location: MutationIdentity['location'];
  expectedOriginal: string;
}

interface FixtureLedgerLine {
  identity: MutationIdentity;
  disposition: Disposition;
  rationale: string;
}

interface PilotFixture {
  example: string;
  fileName: string;
  source: string;
  mutants: FixtureMutant[];
  ledger: FixtureLedgerLine[];
}

async function loadFixture(name: string): Promise<PilotFixture> {
  return (await Bun.file(
    `${import.meta.dir}/__fixtures__/pilot-${name}.json`,
  ).json()) as PilotFixture;
}

function sameIdentity(a: MutationIdentity, b: MutationIdentity): boolean {
  return (
    a.fileName === b.fileName &&
    a.location.start.line === b.location.start.line &&
    a.location.start.column === b.location.start.column &&
    a.location.end.line === b.location.end.line &&
    a.location.end.column === b.location.end.column &&
    a.mutatorName === b.mutatorName &&
    a.original === b.original &&
    a.replacement === b.replacement
  );
}

/**
 * Run one worked example end-to-end: collect records from the real
 * report fixture, carry the human-authored ledger dispositions through,
 * and return everything a reviewer checks.
 */
function runExample(fixture: PilotFixture) {
  const report: StrykerReport = {
    files: {
      [fixture.fileName]: {
        source: fixture.source,
        mutants: fixture.mutants as StrykerMutant[],
      },
    },
  };
  const records = collectMutationRecords(report);
  // Ledger lines are authored against stable identity; the pipeline joins
  // them to records through the identityKey the collector derived.
  const ledgerLines = fixture.ledger.map((line) => {
    const record = records.find((r) => sameIdentity(r.identity, line.identity));
    if (record === undefined) {
      throw new Error(
        `pilot fixture ${fixture.example}: no record for ledger identity`,
      );
    }
    return {
      identityKey: record.identityKey,
      disposition: line.disposition,
      rationale: line.rationale,
    };
  });
  const merged = applyLedger(records, ledgerLines);
  const summary = summarizeStatuses(merged.records);
  return { records, ledgerLines, merged, summary };
}

const EXAMPLES = [
  'stale-model-guard',
  'host-retry-ceiling',
  'coordinator-cleanup',
] as const;

describe('pilot validation: worked examples carried through unchanged (#1602)', () => {
  for (const name of EXAMPLES) {
    test(`${name}: dispositions come out unchanged, separate from statuses`, async () => {
      const fixture = await loadFixture(name);
      // Each worked example contributes a real report fixture and a
      // human-authored ledger fixture carrying its reviewed dispositions.
      expect(fixture.mutants.length).toBeGreaterThan(0);
      expect(fixture.ledger).toHaveLength(fixture.mutants.length);

      const { records, merged, summary } = runExample(fixture);

      // One record per mutant; originals match independent ground truth.
      expect(records).toHaveLength(fixture.mutants.length);
      for (const record of records) {
        const mutant = fixture.mutants.find((m) => m.id === record.observed.id);
        if (mutant === undefined) {
          throw new Error(`fixture missing mutant ${record.observed.id}`);
        }
        expect(record.identity.original).toBe(mutant.expectedOriginal);
      }

      // Human-authored dispositions come out unchanged, keyed by identity.
      for (const line of fixture.ledger) {
        const out = merged.records.find((r) =>
          sameIdentity(r.identity, line.identity),
        );
        expect(out?.reviewed.disposition).toBe(line.disposition);
        expect(out?.reviewed.rationale).toBe(line.rationale);
      }

      // Dispositions stay separate from tool-observed statuses: the
      // collector neither generates nor alters them.
      for (const record of merged.records) {
        const mutant = fixture.mutants.find((m) => m.id === record.observed.id);
        if (mutant === undefined) {
          throw new Error(`fixture missing mutant ${record.observed.id}`);
        }
        expect(record.observed.status).toBe(mutant.status);
      }

      // Per mutation, tool-observed evidence and the human conclusion sit
      // side by side in the output.
      for (const record of summary.records) {
        expect(record.observed).toBeDefined();
        expect(record.reviewed).toBeDefined();
        expect(record.reviewed.disposition).not.toBeNull();
      }
    });
  }

  test('stale-model-guard ledger shows six Detected and one Unreachable', async () => {
    const fixture = await loadFixture('stale-model-guard');
    const { merged } = runExample(fixture);
    const dispositions = merged.records.map((r) => r.reviewed.disposition);
    expect(dispositions.filter((d) => d === 'Detected')).toHaveLength(6);
    expect(
      dispositions.filter((d) => d === 'Unreachable-under-invariant'),
    ).toHaveLength(1);
  });

  test('an empty ledger never invents dispositions', async () => {
    const fixture = await loadFixture('stale-model-guard');
    const report: StrykerReport = {
      files: {
        [fixture.fileName]: {
          source: fixture.source,
          mutants: fixture.mutants as StrykerMutant[],
        },
      },
    };
    const records = collectMutationRecords(report);
    const merged = applyLedger(records, []);
    for (const record of merged.records) {
      expect(record.reviewed.disposition).toBeNull();
    }
  });

  test('a second apply of the same ledger repeats identically', async () => {
    const fixture = await loadFixture('coordinator-cleanup');
    const { records, merged, ledgerLines } = runExample(fixture);
    const again = applyLedger(records, ledgerLines);
    expect(again.records.map((r) => r.reviewed)).toEqual(
      merged.records.map((r) => r.reviewed),
    );
  });
});
