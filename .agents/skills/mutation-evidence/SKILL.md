---
name: mutation-evidence
description: Sweep a file or change set for surviving mutants and walk each one to a human disposition in the ledger.
disable-model-invocation: true
---

# Mutation evidence sweep

A sweep answers one question per survivor: is this a missing test, an
equivalent mutant, or an unreachable state? The collector reports; the
human judges.

## Scope

The user names a file to sweep. When they name a change instead — their
branch, a PR, uncommitted work, a commit range — resolve it to the files
it touches. Stryker mutates whole files: when the change is narrower than
its file, say so in the summary.

## Steps

### 1. Lock the scope

Resolve the request to a file list, keep the source files that have tests,
and show the list to the user.

Done when: the user has confirmed the file list.

### 2. Sweep

```
MUTATION_MUTATE=<files> MUTATION_TESTS=<test files> bunx stryker run
```

The Stryker toolchain is pinned in `package.json` and `stryker.conf.mjs`
on purpose; keep the pins. The json reporter writes
`reports/mutation.json`.

Done when: the report exists and its files match the scoped list.

### 3. Summarize

```
bun src/mutation-evidence/report.ts reports/mutation.json \
  [--baseline <previous report.json>] [--ledger docs/mutation-ledger.json]
```

Read the summary to the user: counts and score together, transitions
against the baseline sweep when given (`newly-surviving` is the regression
signal), and every survivor with its identityKey.

Done when: the user has seen counts, score, transitions when a baseline
was given, and every survivor.

### 4. Triage each survivor

Work the four evidence questions with the user, in order, per survivor:

1. **Semantic difference** — the state where original and replacement
   behave differently.
2. **Reachability** — can that state occur through real entry points, or
   does an invariant forbid it? Reachability precedes any equivalence
   claim.
3. **Observable difference** — how the internal change reaches a
   contract-level effect.
4. **Detection** — which test fails against the exact mutant, and what
   that failure proves.

Record one disposition per survivor with a rationale the user endorses:
`Detected`, `Equivalent-under-preconditions`,
`Unreachable-under-invariant`, or `Unresolved`. A status alone never picks
a disposition.

Done when: every survivor carries a disposition and a rationale, or the
user explicitly defers it as `Unresolved`.

### 5. Write the ledger

Append the accepted lines to `docs/mutation-ledger.json`, each
`{ identityKey, disposition, rationale }`. Carry existing entries through
verbatim; two entries under one identityKey is a contradiction to resolve
with the user, never a silent overwrite.

Done when: rerunning step 3 with `--ledger` shows every new disposition
attached and no existing entry changed.
