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

  test('drops the floor by one when wait_for_user is unregistered (v2 default)', () => {
    // minTools 9 already excludes task_result (folded into task_status);
    // v2 additionally drops wait_for_user → 8.
    expect(minimumExpectedToolCount([], true, false)).toBe(8);
    // disabled_tools still wins when listed: no double-counting.
    expect(minimumExpectedToolCount(['wait_for_user'], true, false)).toBe(8);
    expect(minimumExpectedToolCount(['task_reply'], true, false)).toBe(7);
    expect(minimumExpectedToolCount([], false, false)).toBe(7);
  });

  test('never throws when disabledTools is not an array', () => {
    // Regression test: a malformed/non-array config.disabled_tools value
    // must degrade to "nothing disabled" instead of crashing plugin init.
    expect(minimumExpectedToolCount('' as any)).toBe(9);
    expect(minimumExpectedToolCount(null as any)).toBe(9);
    expect(minimumExpectedToolCount({} as any)).toBe(9);
  });
});
