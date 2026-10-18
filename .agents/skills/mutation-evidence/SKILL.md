---
name: mutation-evidence
description: Audit, critique, fix, or baseline the mutation evidence for a file or change set — sweep survivors, judge them with the four evidence questions, and carry human dispositions in the ledger.
disable-model-invocation: true
---

# Mutation evidence

A sweep answers one question per survivor: is this a missing test, an
equivalent mutant, or an unreachable state? The collector reports; the
human judges. The ledger and the baseline are set state, never passed.

## Commands

| Command | Does |
|---|---|
| `audit` | Sweep and report the facts: counts, score, transitions vs the baseline, and the survivors grouped when they are many. Read-only. |
| `critique` | Present the survivors as options, judge the ones the user picks with the four evidence questions. Read-only. |
| `fix` | Persist the endorsed verdicts as ledger lines, land the killing tests, re-sweep once. |
| `baseline` | Make the latest run the reference. |

Every phase runs the same sweep: `bun run mutation:sweep -- <files>`.
A later command includes the earlier phases.

## Routing

Resolve in this order, and say what you resolved:

1. **The word** — exactly what they said, else the nearest ("criteria"
   → `critique`, "fixes" → `fix`, "compare" → `audit`), else the whole
   session: audit, then critique, then fix. Ask once only when two
   words fit.
2. **The target** — the one the conversation is about, else the last
   sweep's file set (`reports/mutation/mutation.json`), else ask.

A target is a file with a sibling test, or a change they name — their
branch, a PR, uncommitted work, a commit range — resolved to its files
that have tests. Stryker mutates whole files: when the change is
narrower than its file, say so. Asking for the state re-renders the
saved report with
`bun src/mutation-evidence/report.ts reports/mutation/mutation.json` —
no sweep.

## State

- `reports/mutation/baselines/` — the reference run per file set. The
  first sweep for a set claims it; `baseline` replaces it by copying the
  fresh report over the path the sweep prints.
- `docs/mutation-ledger.json` — human memory. Attaches to every summary
  automatically; `fix` appends to it.

## The four evidence questions

critique works them in order, per survivor:

1. **Semantic difference** — the state where original and replacement
   behave differently.
2. **Reachability** — can that state occur through real entry points, or
   does an invariant forbid it? Reachability precedes any equivalence
   claim.
3. **Observable difference** — how the internal change reaches a
   contract-level effect.
4. **Detection** — which test fails against the exact mutant, and what
   that failure proves.

The score counts `Timeout` as detected, but not every timeout is a hang:
name the slow-under-mutant cases when they show.

## fix

Record each endorsed verdict as a ledger line, `{ identityKey,
disposition, rationale }`, with the disposition the user chose —
`Detected`, `Equivalent-under-preconditions`,
`Unreachable-under-invariant`, or `Unresolved`. A status alone never
picks a disposition. Carry existing entries verbatim; two lines under
one identityKey is a contradiction to resolve with the user, never a
silent overwrite.

For `Detected`, land the test that kills the exact mutant. When the
picked set is done, re-sweep once: `newly-killed` against the baseline
is the proof. Survivors the user did not pick stay unreviewed and the
run says how many — `Unresolved` is a verdict someone endorsed, never
the name for silence.

Done when: every picked survivor has a ledger line with a rationale, the
run states how many survivors stayed unreviewed, and the re-sweep shows
the new lines attached with no existing entry changed.
