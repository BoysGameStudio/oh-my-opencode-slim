import { execFileSync } from 'node:child_process';

/**
 * Git lifecycle management for eval runs.
 *
 * Eval suites edit files and create untracked artifacts. The working tree
 * must be restored after each run. This module provides snapshot/restore
 * so callers don't duplicate the dangerous git reset + clean sequence.
 */

/**
 * Stash all tracked and untracked changes.
 * Return the exact stash commit, or null for a clean tree.
 */
export function stashChanges(
  msg = 'eval-prestash',
  cwd = process.cwd(),
): string | null {
  const status = execFileSync('git', ['status', '--porcelain'], {
    cwd,
    encoding: 'utf-8',
  });
  if (!status.trim()) return null;
  execFileSync(
    'git',
    ['stash', 'push', '--include-untracked', '--message', msg],
    { cwd, stdio: 'inherit' },
  );
  return execFileSync('git', ['rev-parse', 'refs/stash'], {
    cwd,
    encoding: 'utf-8',
  }).trim();
}

/**
 * Remove eval edits, then restore the captured stash including staged edits.
 * Only drop that stash after a successful apply; never pop someone else's.
 */
export function restoreAfterEvals(
  stash: string | null,
  cwd = process.cwd(),
): void {
  cleanEvalArtifacts(cwd);
  if (stash) {
    execFileSync('git', ['stash', 'apply', '--index', stash], {
      cwd,
      stdio: 'inherit',
    });
    const entries = execFileSync('git', ['stash', 'list', '--format=%gd %H'], {
      cwd,
      encoding: 'utf-8',
    });
    const entry = entries
      .split('\n')
      .find((line) => line.endsWith(` ${stash}`));
    if (entry) {
      execFileSync('git', ['stash', 'drop', entry.split(' ')[0]], {
        cwd,
        stdio: 'inherit',
      });
    }
  }
}

/**
 * Reset/clean without popping — for use between consecutive passes where
 * the stash remains alive (auto-collect.ts between-run cleanup).
 * Only call after preserving user changes. Ignored results are retained.
 */
export function cleanEvalArtifacts(cwd = process.cwd()): void {
  execFileSync('git', ['reset', '--hard', 'HEAD'], { cwd, stdio: 'inherit' });
  execFileSync('git', ['clean', '-fd'], { cwd, stdio: 'inherit' });
}
