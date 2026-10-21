import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { restoreAfterEvals, stashChanges } from './git-lifecycle';

function withRepo(
  run: (cwd: string, git: (...args: string[]) => string) => void,
) {
  const cwd = mkdtempSync(join(tmpdir(), 'eval-git-'));
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim();
  try {
    git('init', '-q');
    git('config', 'user.email', 'eval@example.test');
    git('config', 'user.name', 'Eval Test');
    writeFileSync(join(cwd, 'tracked.txt'), 'original\n');
    writeFileSync(join(cwd, '.gitignore'), 'results/\n');
    git('add', '.');
    git('commit', '-qm', 'initial');
    run(cwd, git);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

test('eval cleanup restores tracked, staged and untracked work and preserves other stashes', () => {
  withRepo((cwd, git) => {
    writeFileSync(join(cwd, 'tracked.txt'), 'older stash\n');
    git('stash', 'push', '-m', 'older');
    const older = git('rev-parse', 'refs/stash');
    writeFileSync(join(cwd, 'tracked.txt'), 'staged\n');
    git('add', 'tracked.txt');
    writeFileSync(join(cwd, 'tracked.txt'), 'unstaged\n');
    writeFileSync(join(cwd, 'user.txt'), 'untracked\n');
    const status = git('status', '--porcelain');
    const staged = git('diff', '--cached');
    const stash = stashChanges('eval', cwd);
    expect(stash).not.toBeNull();
    expect(git('status', '--porcelain')).toBe('');
    writeFileSync(join(cwd, 'other.txt'), 'another stash\n');
    git('stash', 'push', '-u', '-m', 'newer');
    const newer = git('rev-parse', 'refs/stash');
    writeFileSync(join(cwd, 'tracked.txt'), 'eval edit\n');
    writeFileSync(join(cwd, 'eval.txt'), 'eval artifact\n');
    restoreAfterEvals(stash, cwd);
    expect(git('status', '--porcelain')).toBe(status);
    expect(git('diff', '--cached')).toBe(staged);
    expect(readFileSync(join(cwd, 'tracked.txt'), 'utf-8')).toBe('unstaged\n');
    expect(readFileSync(join(cwd, 'user.txt'), 'utf-8')).toBe('untracked\n');
    expect(git('stash', 'list', '--format=%H').split('\n')).toEqual([
      newer,
      older,
    ]);
  });
});

test('untracked-only work is stashed and restored', () => {
  withRepo((cwd, git) => {
    writeFileSync(join(cwd, 'user.txt'), 'user work');
    const stash = stashChanges('eval', cwd);
    expect(stash).not.toBeNull();
    restoreAfterEvals(stash, cwd);
    expect(readFileSync(join(cwd, 'user.txt'), 'utf-8')).toBe('user work');
    expect(git('stash', 'list')).toBe('');
  });
});

test('clean-tree eval artifacts are removed without applying an older stash', () => {
  withRepo((cwd, git) => {
    const stash = stashChanges('eval', cwd);
    expect(stash).toBeNull();
    writeFileSync(join(cwd, 'tracked.txt'), 'eval edit');
    writeFileSync(join(cwd, 'eval.txt'), 'eval artifact');
    restoreAfterEvals(stash, cwd);
    expect(git('status', '--porcelain')).toBe('');
    expect(readFileSync(join(cwd, 'tracked.txt'), 'utf-8')).toBe('original\n');
  });
});
