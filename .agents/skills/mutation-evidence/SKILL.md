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
| `audit` | Sweep and report the facts: counts, score, transitions vs the baseline, every survivor. Read-only. |
| `critique` | Judge the survivors with the four evidence questions and present the review. Read-only. |
| `fix` | Take the survivors the user picks (some or all) to dispositions, land the killing tests, write the ledger. |
| `baseline` | Sweep and make this run the reference; later runs compare against it automatically. |

Every phase runs the same sweep: `bun run mutation:sweep -- <files>`.
The user names the file in their own words — nothing to parse. With no
command word, run the full session: audit, then critique, then fix. When
they name a change instead of a file (their branch, a PR, uncommitted
work, a commit range), resolve it to the files it touches. Stryker
mutates whole files: when the change is narrower than its file, say so.

## State

- `reports/mutation/baseline.json` — the reference run. The first sweep
  sets it; `baseline` replaces it. Every sweep compares automatically.
- `docs/mutation-ledger.json` — human memory. Attaches to every summary
  automatically; `fix` appends to it.

## The four evidence questions

Work them in order, per survivor:

1. **Semantic difference** — the state where original and replacement
   behave differently.
2. **Reachability** — can that state occur through real entry points, or
   does an invariant forbid it? Reachability precedes any equivalence
   claim.
3. **Observable difference** — how the internal change reaches a
   contract-level effect.
4. **Detection** — which test fails against the exact mutant, and what
   that failure proves.

## fix

Present the survivors as options, grouped where they share a boundary;
the user picks some or all. For each picked survivor record a
disposition the user endorses — `Detected`,
`Equivalent-under-preconditions`, `Unreachable-under-invariant`, or
`Unresolved` — with a rationale. A status alone never picks a
disposition.

For `Detected`, land the test that kills the exact mutant and re-sweep:
`newly-killed` against the baseline is the proof. Append each accepted
line to `docs/mutation-ledger.json`, `{ identityKey, disposition,
rationale }`. Carry existing entries verbatim; two lines under one
identityKey is a contradiction to resolve with the user, never a silent
overwrite. Unpicked survivors end the run as `Unresolved` — say so.

Done when: every picked survivor has a disposition and a rationale, the
unpicked are explicitly deferred, and a re-sweep shows the new ledger
lines attached with no existing entry changed.
