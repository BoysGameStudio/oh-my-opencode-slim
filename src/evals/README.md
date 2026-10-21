# Eval development

For commands, server ownership, and limitations, see
[docs/evals.md](../../docs/evals.md).

This is a routing/reliability harness, not proof of correct task delivery.
Transcript assertions observe routing and tool activity; file assertions are
limited snapshots, not isolated per-trial execution oracles. Council judgments
are advisory and never determine the exit code.

## Modules

- `schema.ts`: Zod schemas for suites, cases, assertions, and transcripts.
- `suites.ts`: discovers `<suite>/eval.json` files and validates them.
- `suite-runner.ts`: validates the suite before stashing, collects live outputs
  or loads saved outputs, scores, saves results, and restores the worktree.
- `session-manager.ts`: creates sessions and submits prompts.
- `polling-session.ts`: polls messages with stalls, timeout, and grace handling.
- `session-messages.ts`: terminal-state and assistant-text helpers.
- `run-case.ts`: trial retries and lock detection.
- `assertions.ts`: deterministic output/transcript/file assertions.
- `scoring.ts`: case and suite scoring, pass@k, pass^k, and partial credit.
- `results.ts` / `display.ts`: result persistence, formatting, and comparison.
- `judge.ts` / `judge-rubric.md`: advisory council assessment.
- `eval-client.ts`: the OpenCode v1 SDK client subset.
- `../cli/eval.ts`: consolidated command entry point.
- `../cli/auto-collect.ts`: automated collection and between-pass cleanup.
- `../cli/eval-server.ts`: connect-only URL overrides and owned-child lifecycle.
- `../cli/git-lifecycle.ts`: tracked/untracked stash capture and restoration.

Results are ignored under `src/evals/results/`. Do not commit file changes made
by eval sessions as product code.

## Adding cases

Create `src/evals/<suite-name>/eval.json`:

```json
{
  "name": "my-suite",
  "description": "Routing contract",
  "category": "capability",
  "evals": [
    {
      "id": "my-case",
      "prompt": "A neutral prompt describing the task",
      "agent": "orchestrator",
      "category": "natural-routing",
      "assertions": [
        { "type": "agent_routed", "value": "fixer", "description": "Uses fixer" }
      ],
      "smoke": true
    }
  ]
}
```

No registration is needed. Run `bun run eval --precheck` after editing suites.
Neutral capability categories warn if the prompt names an `@agent` and leaks
the expected routing. Instruction-following and regression cases may be explicit.

Live runs use three trials per case; smoke runs select `smoke: true` cases and
use one trial. pass@k means at least one trial passed; pass^k requires all trials
to pass. Neither metric establishes correctness beyond the declared assertions.

Add assertion types to `schema.ts` and `checkAssertion` in `assertions.ts`, with
unit coverage in `__tests__/eval.test.ts`. Scheduling tests use injected clocks
and waits rather than real delays. Suite-runner tests inject dependencies rather
than replacing shared modules globally.

## Focused offline checks

```bash
bun test src/evals/__tests__ src/cli/eval-server.test.ts src/cli/git-lifecycle.test.ts
bun run eval --precheck
```

These checks do not invoke models or start OpenCode services.
