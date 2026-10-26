import { describe, expect, test } from 'bun:test';
import { minimumExpectedToolCount } from './health-check';

describe('plugin health thresholds', () => {
  test('accounts only for intentionally disabled baseline tools', () => {
    expect(minimumExpectedToolCount()).toBe(9);
    expect(minimumExpectedToolCount(['wait_for_user'])).toBe(8);
    expect(minimumExpectedToolCount(['wait_for_user', 'wait_for_user'])).toBe(
      8,
    );
    expect(minimumExpectedToolCount(['task_reply'])).toBe(8);
    expect(minimumExpectedToolCount(['unknown_tool'])).toBe(9);
    expect(minimumExpectedToolCount([], false)).toBe(8);
    expect(minimumExpectedToolCount(['wait_for_user'], false)).toBe(7);
    expect(minimumExpectedToolCount(['webfetch'], false)).toBe(8);
    expect(
      minimumExpectedToolCount(['task_cancel', 'task_message', 'task_revive']),
    ).toBe(6);
  });

  test('drops the floor by two on v2 (no wait_for_user, no task_revive)', () => {
    // minTools 9 already excludes task_result (folded into task_status);
    // v2 drops wait_for_user and task_revive → 7.
    expect(minimumExpectedToolCount([], true, 'v2')).toBe(7);
    // disabled_tools still wins when listed: no double-counting.
    expect(minimumExpectedToolCount(['wait_for_user'], true, 'v2')).toBe(7);
    expect(minimumExpectedToolCount(['task_reply'], true, 'v2')).toBe(6);
    expect(minimumExpectedToolCount([], false, 'v2')).toBe(6);
  });

  test('v2 never lowers the floor for the tools it does not register', () => {
    // task_revive and wait_for_user are unregistered on v2, so listing them
    // under disabled_tools must not mask a genuinely missing tool.
    expect(minimumExpectedToolCount(['task_revive'], true, 'v2')).toBe(7);
    expect(
      minimumExpectedToolCount(['task_revive', 'wait_for_user'], true, 'v2'),
    ).toBe(7);
    // v1 keeps both in the baseline.
    expect(minimumExpectedToolCount(['task_revive'], true, 'v1')).toBe(8);
  });

  test('keeps at least one tool of margin for the v2 registrations', () => {
    // v2 registers: task_cancel, task_message, task_reply, task_status,
    // interview_submit_state, acp_run, webfetch, ast_grep_search,
    // ast_grep_replace (9) + marketplace_inspect + marketplace_manage (2).
    const registered = 11;
    const defaultFloor = minimumExpectedToolCount([], true, 'v2');
    expect(registered - defaultFloor).toBeGreaterThanOrEqual(1);
    // disabled_commands:["interview"] removes interview_submit_state.
    const withoutInterview = registered - 1;
    expect(withoutInterview - defaultFloor).toBeGreaterThanOrEqual(1);
    // disabled_tools:["task_revive"] changes nothing on v2 (never registered).
    expect(
      registered - minimumExpectedToolCount(['task_revive'], true, 'v2'),
    ).toBeGreaterThanOrEqual(1);
  });

  test('never throws when disabledTools is not an array', () => {
    // Regression test: a malformed/non-array config.disabled_tools value
    // must degrade to "nothing disabled" instead of crashing plugin init.
    expect(minimumExpectedToolCount('' as any)).toBe(9);
    expect(minimumExpectedToolCount(null as any)).toBe(9);
    expect(minimumExpectedToolCount({} as any)).toBe(9);
  });

  test('defaults the lifecycle switch to true (additive parameter)', () => {
    // Existing callers pass three arguments; the fourth must not change
    // the floor they already computed.
    expect(minimumExpectedToolCount([], true, 'v1')).toBe(9);
    expect(minimumExpectedToolCount([], true, 'v2')).toBe(7);
    expect(minimumExpectedToolCount(['task_reply'])).toBe(8);
  });

  test('drops the floor by six on v1 when the managed lifecycle is off', () => {
    // task_cancel, task_message, task_status, task_reply, task_revive and
    // wait_for_user all disappear → 9 - 6 = 3.
    expect(minimumExpectedToolCount([], true, 'v1', false)).toBe(3);
    expect(minimumExpectedToolCount([], true, undefined, false)).toBe(3);
    // Listing the unregistered tools under disabled_tools must not
    // double-count them (v1 floor is already at 3).
    expect(
      minimumExpectedToolCount(
        ['task_cancel', 'task_message', 'task_status', 'task_reply'],
        true,
        'v1',
        false,
      ),
    ).toBe(3);
    expect(
      minimumExpectedToolCount(
        ['task_revive', 'wait_for_user'],
        true,
        'v1',
        false,
      ),
    ).toBe(3);
    // webfetch is independent of the lifecycle switch and still counted.
    expect(minimumExpectedToolCount([], false, 'v1', false)).toBe(2);
  });

  test('drops the floor by four on v2 when the managed lifecycle is off', () => {
    // v2 already drops wait_for_user and task_revive; off removes the four
    // remaining task tools → 9 - 2 - 4 = 3.
    expect(minimumExpectedToolCount([], true, 'v2', false)).toBe(3);
    expect(minimumExpectedToolCount(['task_reply'], true, 'v2', false)).toBe(3);
    // The v2-unregistered tools stay non-counting.
    expect(minimumExpectedToolCount(['task_revive'], true, 'v2', false)).toBe(
      3,
    );
    expect(minimumExpectedToolCount([], false, 'v2', false)).toBe(2);
  });
});
