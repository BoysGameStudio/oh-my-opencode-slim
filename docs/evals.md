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

Live collection and `--judge` require a **compatible OpenCode 1.x runtime**.
The installed/default `opencode` may be v2 (for example 2.0.28); this harness
does not implement its API and never auto-selects that executable. Supply either
`OPENCODE_URL` for an existing v1 endpoint or `OPENCODE_V1_EXECUTABLE` for an
explicit v1 binary. The harness does not install a runtime or change your normal
OpenCode setup. Offline commands above need neither.

Compatibility is checked before stashing or creating any eval session: explicit
binaries must report a 1.x `--version`; endpoints must report a healthy 1.x
`/global/health` response and expose the v1 `/session` array API. A missing,
unverifiable, or v2 runtime fails immediately rather than starting a token-costing
run. These checks establish the API baseline, not a live-model benchmark.

Use a **disposable checkout**, not a worktree with concurrent editors or active
agent sessions. Eval prompts can edit files. Collection stashes tracked and
untracked work, resets/cleans between passes, and restores staged and unstaged
work after scoring or collection failure. Ignored files are not preserved by
the stash and can still be modified by agents. Never run live suites as part of
ordinary unit validation without explicit authorization.

Before a trial returns (including success, stall, or timeout), the harness
awaits abort acknowledgements for its created session and recursively verified
descendants. It rechecks the child tree and runtime status until two consecutive
scans are idle. Only those owned IDs are aborted; unrelated sessions in the
server's status map are ignored. All concurrent workers finish shutdown before
between-pass cleanup or final restoration.

Shutdown is bounded to 10 seconds with bounded individual requests. If abort,
child enumeration, or status checks fail, or prompt submission did not receive a
positive HTTP acknowledgement, the command fails **without reset, clean, or
stash restore**. This includes transport rejection: a rejected client promise
does not prove the host discarded the request, and it may admit the prompt after
idle scans. A late success after client timeout is likewise not an acknowledgement
observed by the trial.
It prints the checkout and preserved stash commit. This deliberately prefers
recoverable stashed work to restoring it underneath a possible active writer.
Stop only the reported eval sessions and their descendants using the selected
server; confirm they have stopped before inspecting/discarding eval edits and
applying the printed stash with `git stash apply --index <commit>`. Do not stop
unrelated production sessions or blindly pop another stash. Abrupt process
termination likewise requires checking the eval sessions before recovery.

```bash
# Connect only to an already running compatible v1 server:
OPENCODE_URL=http://127.0.0.1:8765 bun run eval --suite orchestrator-natural-routing

# Or explicitly select an installed v1 executable to manage a local server:
OPENCODE_V1_EXECUTABLE=/path/to/opencode-v1 bun run eval --smoke --suite orchestrator-direct-execution
OPENCODE_V1_EXECUTABLE=/path/to/opencode-v1 bun run eval --suite orchestrator-natural-routing --exclude case-id,other-case
```

Omitting `--suite` runs every discovered suite. Full collection uses three
trials per case; smoke runs only tagged cases once. `EVAL_CONCURRENCY` sets a
positive integer worker count (default 3).

With `OPENCODE_URL`, the harness only connects to that URL: it never starts or
stops a local server on its behalf, even if `OPENCODE_V1_EXECUTABLE` is also set.
With only `OPENCODE_V1_EXECUTABLE`, the target is `http://127.0.0.1:4096`: reuse a
compatible healthy v1 server, otherwise attempt to start an owned child using
that exact executable. No existing listener is killed, even when unhealthy.
Startup failure cleans up only that child. Saved-output scoring does not contact
a server unless `--judge` is also requested.

`--judge` adds token-costing council feedback and oracle synthesis over the same
client and keeps the owned server alive until both are finished. Judge scoring
failures are advisory, but an unconfirmed judge-session shutdown is fatal for
safety. Deterministic suite failures exit 1; observed flaky trials exit 2.
Results are ignored timestamped JSON files in `src/evals/results/`; `--diff`
compares the latest two suite results or an explicit baseline.

For schemas and module responsibilities, see [eval development](../src/evals/README.md).
