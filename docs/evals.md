# Routing and reliability evals

This source-checkout developer harness runs prompts through the OpenCode v1 SDK,
records transcripts, and scores declared assertions. It does **not** establish
that agents deliver correct implementations. Council judgments are advisory;
they do not change deterministic scores or exit status. No v2 benchmark or
cross-model performance claim is made.

## Offline commands (no model calls)

```bash
bun run eval --precheck
bun run eval --suite orchestrator-direct-execution --outputs-file /path/outputs.json
bun run eval --diff --suite orchestrator-direct-execution
bun run eval --diff --suite orchestrator-direct-execution --baseline /path/result.json
bun run eval --collect --suite orchestrator-direct-execution
```

Saved outputs map case IDs to strings or arrays of trial strings. Matching
`outputs-transcripts.json` beside `outputs.json` supplies optional transcripts.
File assertions still inspect the checkout, so offline scoring is not a replay
of historical filesystem state. Missing outputs fail the command.

## Live commands (spend model tokens)

Use a **disposable checkout**, not a worktree with concurrent editors or active
agent sessions. Eval prompts can edit files. Collection stashes tracked and
untracked work, resets/cleans between passes, and restores staged and unstaged
work after scoring or collection failure. Ignored files are not preserved by
the stash and can still be modified by agents. Never run live suites as part of
ordinary unit validation without explicit authorization.

```bash
bun run eval --suite orchestrator-natural-routing
bun run eval --smoke --suite orchestrator-direct-execution
bun run eval --suite orchestrator-natural-routing --exclude case-id,other-case
OPENCODE_URL=http://127.0.0.1:8765 bun run eval --suite orchestrator-natural-routing
```

Omitting `--suite` runs every discovered suite. Full collection uses three
trials per case; smoke runs only tagged cases once. `EVAL_CONCURRENCY` sets a
positive integer worker count (default 3).

With `OPENCODE_URL`, the harness only connects to that URL: it never starts or
stops a local server on its behalf. Without it, the target is
`http://127.0.0.1:4096`: reuse a healthy server, otherwise attempt to start an
owned `opencode serve` child. No existing listener is killed, even when unhealthy.
Startup failure cleans up only that child. Saved-output scoring does not contact
a server unless `--judge` is also requested.

`--judge` adds token-costing council feedback and oracle synthesis over the same
client and keeps the owned server alive until both are finished. Judge failures
are advisory. Deterministic suite failures exit 1; observed flaky trials exit 2.
Results are ignored timestamped JSON files in `src/evals/results/`; `--diff`
compares the latest two suite results or an explicit baseline.

For schemas and module responsibilities, see [eval development](../src/evals/README.md).
