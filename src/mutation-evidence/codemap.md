# src/mutation-evidence/

## Responsibility

Normalizes Stryker mutation reports into evidence records with stable
identity, compares sweeps, derives status-semantics views and the mutation
score, carries human-authored dispositions through unchanged, and validates
the whole pipeline against real worked examples. Built as tracer-bullet
slices for tickets #1598-#1602 (parent #1597). Internal analysis tooling: not
part of the shipped plugin bundle.

## Design

Everything lives in one module (`records.ts`) plus per-slice test files and
JSON fixtures.

- **Identity** (`MutationIdentity`, `makeIdentityKey`): file, 1-based
  half-open source location, mutator, original (derived from source), and
  replacement. The numeric Stryker mutant id is recorded as observed
  evidence only; identity and matching never depend on it, so records
  survive id churn between runs. Two records under one identityKey in a
  sweep are rejected (`compareSweeps` throws) rather than collapsed.
- **Collection** (`collectMutationRecords`): one `MutationRecord` per
  mutant, grouped as `identity` / `identityKey` / `observed` (raw Stryker
  evidence incl. `killedBy`, first-failure attribution only) / `reviewed`
  (human conclusions, null until a ledger fills them).
- **Comparison** (`compareSweeps`): matches baseline vs current sweeps by
  identityKey, returns matched transitions (`newly-killed`, `already-killed`,
  `newly-surviving`, `still-surviving`, `other`), added/removed sets, and
  per-match `coverageChanged` (set comparison; test order is not stable
  across runs).
- **Status semantics** (`summarizeStatuses`): per-record `DetectionView`
  (detected = Killed/Timeout; Timeout/Error/NoCoverage flagged as distinct
  outcomes; `killedByKind: 'first-failure'`), raw status counts, and the
  Stryker score `(Killed + Timeout) / (Killed + Timeout + Survived +
  NoCoverage)` — always with the counts, null when nothing is scoreable.
- **Ledger** (`applyLedger`, `LedgerLine`): preservation-only. Matches
  authored dispositions by identityKey, copies them verbatim into
  `reviewed`, never infers a disposition from any status, rejects duplicate
  ledger keys (contradictory judgments), returns unmatched lines.

The tool-observed / human-concluded split is structural: the tool never
moves a value across that boundary in either direction.

## Tests and fixtures

Test files are split per slice: `records.test.ts` (identity derivation,
real-fixture ground truth), `comparison.test.ts`, `anomalies.test.ts`,
`ledger.test.ts`, `duplicates.test.ts` (duplicate-identityKey guards),
`pilot.test.ts` (end-to-end worked examples).

Fixtures under `__fixtures__/`: `real-worked-example.json` (16 real mutants
with independently computed `expectedOriginal` ground truth) and three
`pilot-*.json` worked examples (stale-model guard, host-retry ceiling,
coordinator cleanup) carrying real report slices plus hand-authored ledgers
matching the disposition tables in the design doc.

Design doc: `docs/mutation-evidence-spec.md` on branch
`omos/mutation-evidence-spec`.
