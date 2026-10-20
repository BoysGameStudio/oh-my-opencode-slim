import type { AgentConfig } from '@opencode-ai/sdk/v2';
import { renderRoutingLines } from './role-routing';

export interface AgentDefinition {
  name: string;
  displayName?: string;
  description?: string;
  config: AgentConfig;
  /** Priority-ordered model entries for runtime fallback resolution. */
  _modelArray?: Array<{ id: string; variant?: string }>;
}

/**
 * Resolve agent prompt from inline/file/append inputs.
 *
 * Precedence: inline prompt > file prompt > fallback. An explicit inline
 * `override.prompt` wins over a `<agent>.md` file; the file is the
 * shared default. `customAppendPrompt` always appends after whichever base
 * won. Deterministic per session (construction-time only) — cache-safe.
 */
export function resolvePrompt(
  agentName: string,
  inlinePrompt: string | undefined,
  filePrompt: string | undefined,
  fallback: string,
  customAppendPrompt?: string,
): string {
  if (inlinePrompt !== undefined && filePrompt !== undefined) {
    console.warn(
      `[oh-my-opencode] Agent '${agentName}': inline prompt overrides prompt file (${agentName}.md). Remove the inline prompt to use the file.`,
    );
  }
  const effectiveBase = inlinePrompt ?? filePrompt ?? fallback;
  return customAppendPrompt !== undefined
    ? `${effectiveBase}\n\n${customAppendPrompt}`
    : effectiveBase;
}

export interface OrchestratorPromptOptions {
  /** Agents to leave out of the <Agents> routing block. */
  disabledAgents?: ReadonlySet<string>;
  /** Agent names whose routing lines are omitted (e.g. council without councillors). */
  excludeDescriptions?: readonly string[];
  /** v1 only: `wait_for_user` is registered. v2 never registers it. */
  waitForUser?: boolean;
  /** `backgroundJobs.orchestratorWake.enabled`: the wake scheduler can resume the session. */
  wakeScheduler?: boolean;
  /** 'v2' on OpenCode v2 hosts; anything else renders v1 tool vocabulary. */
  hostFlavor?: string;
  /** false drops the whole <Agents> block. */
  routingBlock?: boolean;
}

/**
 * Build the orchestrator system prompt.
 *
 * One template for every host; only the delegation tool vocabulary and a few
 * tool-specific lines differ between v1 and v2. Output depends only on the
 * options (no time, randomness, or per-request state), so it stays
 * byte-stable for a session's lifetime — pinned by snapshot tests.
 */
export function buildOrchestratorPrompt({
  disabledAgents,
  excludeDescriptions,
  waitForUser = true,
  wakeScheduler = true,
  hostFlavor,
  routingBlock = true,
}: OrchestratorPromptOptions = {}): string {
  const v2 = hostFlavor === 'v2';

  const agentsSection = routingBlock
    ? `<Agents>
${renderRoutingLines(disabledAgents, excludeDescriptions)}
</Agents>

`
    : '';

  const resumeChannel = wakeScheduler
    ? 'completion notifications and the wake scheduler resume you'
    : 'completion notifications resume you';

  const delegateTool = v2 ? 'subagent' : 'task';

  const modelLine = v2
    ? `- Set \`model\` only when the user asks; look up IDs with the models tool
  first.
`
    : '';

  // wait_for_user exists only on v1, and only when not disabled.
  const manualStep =
    !v2 && waitForUser
      ? `For an
  external manual step, give concrete steps first, then call \`wait_for_user\`
  as your final tool action and end the turn. Never use it to wait for
  background tasks.`
      : `For an
  external manual step, give concrete steps first, then ask with \`question\`
  and end the turn.`;

  return `<Role>
You are Orchestrator, a workflow manager who plans, delegates, monitors,
reconciles, and verifies specialist work. Delegate non-trivial work to
specialists; act directly when you already hold the needed context and the
change is small and clear — a delegate starts cold and must re-load it.

Value productivity: prefer a working result now over a perfect plan later;
don't stall on decisions you can make and revisit.
</Role>

${agentsSection}<Workflow>
- Build in passes: a working outline first, then structure, then detail.
  Match review depth to how settled the work is, and stop once the request
  is met — no perfection loops.
- Split work into independent lanes and dispatch in parallel (multiple
  \`${delegateTool}\` calls in one message).
- Respect dependencies; parallel writers must not share write scopes.
- Every delegation names its scope and validation owner. Reference
  paths/lines instead of pasting file contents; brief the user in one line
  per batch of dispatches.
- Assign lanes focused checks for their scope, never the full suite. Run the
  full suite once yourself after reconciling writers, not per small change.
- Docs go to whoever holds the content: continue the specialist session that
  produced it, or write it yourself — never a fresh agent that must
  rediscover it.
- After dispatching, do non-overlapping work, then end the turn with a one-line
  launch summary; ${resumeChannel}.
- Don't echo task lists or notification contents back to the user.
${modelLine}
## File operations
- Prefer dedicated file tools for code work: glob/grep for discovery, read
  for contents, edit/write for changes. Avoid using cat/head/tail/sed/awk
  just to read code into context.
- Use bash for execution, automation, and bulk/mechanical filesystem changes.
  Before destructive or broad shell operations, verify the target set and
  quote paths (dry-run first when practical).

## Verify
- Subagent summaries are claims, not evidence: read the produced artifacts
  before relying on them. Missing scope and out-of-scope extras are both
  defects. Send corrections to the same session: \`task_message\` while it
  runs, continue it once finished.
- Reconcile all writer lanes before final validation; reuse still-valid
  evidence.
</Workflow>

<Communication>
- Use the \`question\` tool when the user's answer unblocks work. ${manualStep}
- Minimal replies: no preamble, no flattery, no restating the request, no
  narrating routine work.
- Honest pushback: state the concern and an alternative concisely; ask before
  proceeding.
</Communication>
`;
}

export function createOrchestratorAgent(
  model?: string | Array<string | { id: string; variant?: string }>,
  customPrompt?: string,
  customAppendPrompt?: string,
  promptOptions: OrchestratorPromptOptions = {},
): AgentDefinition {
  const prompt = resolvePrompt(
    'orchestrator',
    undefined,
    customPrompt,
    buildOrchestratorPrompt(promptOptions),
    customAppendPrompt,
  );

  const definition: AgentDefinition = {
    name: 'orchestrator',
    description:
      'AI coding orchestrator that delegates tasks to specialist agents for optimal quality, speed, and cost',
    config: {
      prompt,
    },
  };

  if (Array.isArray(model)) {
    definition._modelArray = model.map((m) =>
      typeof m === 'string' ? { id: m } : m,
    );
  } else if (typeof model === 'string' && model) {
    definition.config.model = model;
  }

  return definition;
}
