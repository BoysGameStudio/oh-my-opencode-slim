/**
 * Plugin init health-check thresholds and helpers.
 *
 * Deliberately NOT re-exported from the package root (`src/index.ts`).
 * OpenCode's legacy plugin loader iterates every named export of the
 * root module and invokes each as a plugin factory with `PluginInput`.
 * A helper like `minimumExpectedToolCount` would then be called with a
 * `PluginInput` object instead of `string[]`, and its numeric return
 * value would be pushed into the hooks array as if it were a `Hooks`
 * object. Keeping this module internal (imported by, but not
 * re-exported from, `src/index.ts`) avoids that class of bug entirely;
 * see https://github.com/alvinunreal/oh-my-opencode-slim/issues/894.
 */

/**
 * Minimum expected registrations for a healthy plugin load.
 *
 * On v2 hosts `wait_for_user` and `task_revive` are unregistered (the native
 * `question` tool covers the blocking boundary, and retained sessions resume
 * through native `subagent(sessionID, prompt)`), so the v2 floor drops by
 * two relative to the v1 baseline.
 */
export const HEALTH_CHECK = {
  minAgents: 5,
  // Default v1 tool set when council and ACP agents are not configured:
  // task_cancel, task_message, task_revive, task_status,
  // task_reply, wait_for_user, webfetch, ast_grep_search, ast_grep_replace.
  minTools: 9,
  minMcps: 1,
} as const;

const BASELINE_TOOL_NAMES = new Set([
  'task_cancel',
  'task_message',
  'task_revive',
  'task_status',
  'task_reply',
  'wait_for_user',
  'webfetch',
  'ast_grep_search',
  'ast_grep_replace',
]);

/**
 * Compute the minimum tool count the health check should expect, accounting
 * for baseline tools the user has intentionally disabled.
 *
 * @param disabledTools - Tool names disabled via config; non-array/malformed
 *   values (which should never occur post-validation, but are not trusted at
 *   runtime) are treated as "nothing disabled".
 * @param webfetchEnabled - Whether the enhanced webfetch tool is registered.
 * @param hostFlavor - 'v2' on OpenCode v2 hosts; anything else renders the
 *   v1 baseline. v2 unregisters wait_for_user and task_revive, so both leave
 *   the baseline and must not lower the floor when the user lists them under
 *   disabled_tools.
 * @returns The adjusted minimum expected tool count
 */
export function minimumExpectedToolCount(
  disabledTools: readonly string[] = [],
  webfetchEnabled = true,
  hostFlavor?: string,
): number {
  const v2 = hostFlavor === 'v2';
  const waitForUserEnabled = !v2;
  const taskReviveEnabled = !v2;
  // Config values come from user-edited JSON/JSONC (and can be re-derived
  // via runtime preset switches); never trust the declared type at
  // runtime. Fall back to "no disabled tools" instead of crashing plugin
  // init if this isn't actually an array.
  const safeDisabledTools = Array.isArray(disabledTools) ? disabledTools : [];
  const disabledBaselineTools = new Set(
    safeDisabledTools.filter(
      (toolName) =>
        BASELINE_TOOL_NAMES.has(toolName) &&
        (toolName !== 'webfetch' || webfetchEnabled) &&
        (toolName !== 'wait_for_user' || waitForUserEnabled) &&
        (toolName !== 'task_revive' || taskReviveEnabled),
    ),
  );
  const webfetchAdjustment = webfetchEnabled ? 0 : 1;
  const waitForUserAdjustment = waitForUserEnabled ? 0 : 1;
  const taskReviveAdjustment = taskReviveEnabled ? 0 : 1;
  return (
    HEALTH_CHECK.minTools -
    webfetchAdjustment -
    waitForUserAdjustment -
    taskReviveAdjustment -
    disabledBaselineTools.size
  );
}
