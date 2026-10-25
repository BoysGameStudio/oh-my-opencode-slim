export function renderRoleRoutingBlock(
  routingBlock: string,
  roleId: string,
  runtimeName: string,
): string {
  return routingBlock.replace(
    new RegExp(`@${roleId}\\b`, 'g'),
    `@${runtimeName}`,
  );
}

/**
 * One-line routing verdicts — the single routing source for the
 * orchestrator's <Agents> block and marketplace package blocks. The
 * agents' `description` fields (shown in the host's subagent list) stay
 * short and don't repeat these criteria.
 */
export const ROLE_ROUTING_SLIM_LINES: Readonly<Record<string, string>> =
  Object.freeze({
    explorer: `@explorer — read-only codebase recon (glob/grep/AST) and external docs/web research (context7, gh_grep). Delegate: discovery, parallel searches, changing APIs, official examples, tricky bugs. Don't: known path / need full contents / stable facts already in context / library trivia you already know.`,
    oracle: `@oracle — architecture, risk, debugging strategy, review; an escalation, not a default verification step. Delegate: major long-term decisions, problems persisting after 2+ fix attempts, high-risk trade-offs, simplification. Don't: routine or time-sensitive calls.`,
    designer: `@designer — owns all UI/UX: layout, hierarchy, spacing, motion, responsive feel. Never do UI/design work yourself. Weak at copy: review and fix user-facing copy afterward without altering visuals; purely mechanical follow-ups go to @fixer.`,
    fixer: `@fixer — bounded, well-defined implementation. Delegate: multi-file or mechanical changes, parallel per-area lanes. Don't: discovery/decisions, one small (<20-line) change, anything needing design judgment, docs/prose built from context you already hold.`,
    council: `@council — multi-model consensus for high-stakes decisions. Send the full question plus context; preserve its structured report. Don't: routine work or single-specialist tasks; @council is never the only lane on a task.`,
    observer: `@observer — analyzes images/PDFs/diagrams, keeping media bytes out of your context. Always pass the full file path. Don't: plain-text files.`,
  });

/** Routing lines for every agent not disabled or excluded, blank-line separated. */
export function renderRoutingLines(
  disabledAgents?: ReadonlySet<string>,
  excludeDescriptions?: readonly string[],
): string {
  return Object.entries(ROLE_ROUTING_SLIM_LINES)
    .filter(([name]) => !disabledAgents?.has(name))
    .filter(([name]) => !excludeDescriptions?.includes(name))
    .map(([, line]) => line)
    .join('\n\n');
}
