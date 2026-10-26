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
 * two relative to the v1 baseline. When the OMOS managed background-task
 * lifecycle is disabled (`backgroundJobs.enabled = false`), the four
 * background-task tools (`task_cancel`, `task_message`, `task_status`,
 * `task_reply`) plus the v1-only `task_revive` and `wait_for_user` are not
 * registered either, so the floor drops by six on v1 (four on v2, where the
 * last two were already gone).
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

/** Tools that disappear together when backgroundJobs.enabled is false. */
const BACKGROUND_TASK_TOOL_NAMES = new Set([
  'task_cancel',
  'task_message',
  'task_status',
  'task_reply',
]);

/**
 * Compute the minimum tool count the health check should expect, accounting
 * for baseline tools the user has intentionally disabled or that a
 * configured feature switch removes from the registration set.
 *
 * @param disabledTools - Tool names disabled via config; non-array/malformed
 *   values (which should never occur post-validation, but are not trusted at
 *   runtime) are treated as "nothing disabled".
 * @param webfetchEnabled - Whether the enhanced webfetch tool is registered.
 * @param hostFlavor - 'v2' on OpenCode v2 hosts; anything else renders the
 *   v1 baseline. v2 unregisters wait_for_user and task_revive, so both leave
 *   the baseline and must not lower the floor when the user lists them under
 *   disabled_tools.
 * @param backgroundJobsEnabled - Whether the OMOS managed background-task
 *   lifecycle registers its tools. When false, task_cancel, task_message,
 *   task_status and task_reply (plus the v1-only task_revive and
 *   wait_for_user) are never registered, so they must not be counted as
 *   missing. Defaults to true, so callers that predate the switch keep the
 *   old floor.
 * @returns The adjusted minimum expected tool count
 */
export function minimumExpectedToolCount(
  disabledTools: readonly string[] = [],
  webfetchEnabled = true,
  hostFlavor?: string,
  backgroundJobsEnabled = true,
): number {
  const v2 = hostFlavor === 'v2';
  const backgroundTaskToolsEnabled = backgroundJobsEnabled;
  const waitForUserEnabled = !v2 && backgroundJobsEnabled;
  const taskReviveEnabled = !v2 && backgroundJobsEnabled;
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
        (toolName !== 'task_revive' || taskReviveEnabled) &&
        (!BACKGROUND_TASK_TOOL_NAMES.has(toolName) ||
          backgroundTaskToolsEnabled),
    ),
  );
  const webfetchAdjustment = webfetchEnabled ? 0 : 1;
  const waitForUserAdjustment = waitForUserEnabled ? 0 : 1;
  const taskReviveAdjustment = taskReviveEnabled ? 0 : 1;
  const backgroundTaskToolsAdjustment = backgroundTaskToolsEnabled ? 0 : 4;
  return (
    HEALTH_CHECK.minTools -
    webfetchAdjustment -
    waitForUserAdjustment -
    taskReviveAdjustment -
    backgroundTaskToolsAdjustment -
    disabledBaselineTools.size
  );
}
