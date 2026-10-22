import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  checkForUpdate,
  compareVersions,
  decideUpdate,
  fetchLatestVersion,
  LATEST_VERSION_URL,
  PACKAGE_NAME,
  parseVersion,
  registerUpdateNotice,
  resolveInstalledVersion,
  UPDATE_BADGE_SLOT,
} from './update-notice';

const wait = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Poll until `predicate` holds so the tests do not race the timer. */
async function waitFor(
  predicate: () => boolean,
  timeoutMs = 1_000,
): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) {
      throw new Error('condition not met in time');
    }
    await wait(5);
  }
}

/** A temp OpenCode cache root, removed by the caller. */
function makeCacheRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'omo-update-notice-'));
}

/** Write a package.json at `<cache>/<layout>/<stamp>/node_modules/<pkg>`. */
function writeCachedInstall(
  cacheRoot: string,
  layout: string,
  stamp: string,
  version: string,
): void {
  const dir = path.join(cacheRoot, layout, stamp, 'node_modules', PACKAGE_NAME);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({ name: PACKAGE_NAME, version }),
  );
}

describe('parseVersion', () => {
  test('parses plain triples, with or without a leading v and padding', () => {
    expect(parseVersion('3.0.4')).toEqual([3, 0, 4]);
    expect(parseVersion('v3.0.4')).toEqual([3, 0, 4]);
    expect(parseVersion(' 3.0.4 ')).toEqual([3, 0, 4]);
    expect(parseVersion('10.20.30')).toEqual([10, 20, 30]);
  });

  test('keeps only the numeric part of a prerelease/build suffix', () => {
    expect(parseVersion('3.0.4-beta.1')).toEqual([3, 0, 4]);
    expect(parseVersion('3.0.4+build.7')).toEqual([3, 0, 4]);
  });

  test('rejects dist-tags, git specs and partial versions', () => {
    for (const value of [
      'latest',
      'beta',
      'next',
      '3.0',
      '3',
      '3.0.x',
      'git+https://github.com/alvinunreal/oh-my-opencode-slim#v3.0.4',
      'github:alvinunreal/oh-my-opencode-slim#v3.0.4',
      'alvinunreal/oh-my-opencode-slim',
      '^3.0.4',
      '',
    ]) {
      expect(parseVersion(value)).toBeUndefined();
    }
  });

  test('rejects non-strings', () => {
    expect(parseVersion(undefined)).toBeUndefined();
    expect(parseVersion(null)).toBeUndefined();
    expect(parseVersion(304)).toBeUndefined();
    expect(parseVersion({ version: '3.0.4' })).toBeUndefined();
  });
});

describe('compareVersions', () => {
  test('orders by major, then minor, then patch', () => {
    expect(compareVersions([3, 0, 4], [3, 0, 4])).toBe(0);
    expect(compareVersions([3, 0, 4], [3, 0, 5])).toBe(-1);
    expect(compareVersions([3, 0, 5], [3, 0, 4])).toBe(1);
    expect(compareVersions([3, 1, 0], [3, 0, 9])).toBe(1);
    expect(compareVersions([2, 9, 9], [3, 0, 0])).toBe(-1);
    expect(compareVersions([10, 0, 0], [9, 99, 99])).toBe(1);
  });
});

describe('decideUpdate', () => {
  test('notifies for a newer version on the same major', () => {
    expect(decideUpdate('3.0.4', '3.0.5')).toBe('3.0.5');
    expect(decideUpdate('3.0.4', '3.1.0')).toBe('3.1.0');
    expect(decideUpdate('v3.0.4', '3.0.5')).toBe('3.0.5');
  });

  test('stays silent when installed is equal or newer', () => {
    expect(decideUpdate('3.0.5', '3.0.5')).toBeUndefined();
    expect(decideUpdate('3.0.6', '3.0.5')).toBeUndefined();
    expect(decideUpdate('3.1.0', '3.0.9')).toBeUndefined();
  });

  test('stays silent for a new major: that is a migration, not a nudge', () => {
    expect(decideUpdate('3.0.4', '4.0.0')).toBeUndefined();
    expect(decideUpdate('4.0.0', '3.0.5')).toBeUndefined();
  });

  test('stays silent when either side is unknown or unparseable', () => {
    expect(decideUpdate(undefined, '3.0.5')).toBeUndefined();
    expect(decideUpdate('3.0.4', undefined)).toBeUndefined();
    expect(decideUpdate(undefined, undefined)).toBeUndefined();
    expect(decideUpdate('latest', '3.0.5')).toBeUndefined();
    expect(decideUpdate('3.0.4', 'latest')).toBeUndefined();
  });
});

describe('fetchLatestVersion', () => {
  test('reads version from a valid registry response', async () => {
    const seen: string[] = [];
    const version = await fetchLatestVersion({
      fetchImpl: (url) => {
        seen.push(url);
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ version: '3.0.5' }),
        });
      },
    });

    expect(version).toBe('3.0.5');
    expect(seen).toEqual([LATEST_VERSION_URL]);
    expect(LATEST_VERSION_URL).toContain(PACKAGE_NAME);
  });

  test('returns undefined on a non-OK response', async () => {
    expect(
      await fetchLatestVersion({
        fetchImpl: () =>
          Promise.resolve({ ok: false, json: () => Promise.resolve({}) }),
      }),
    ).toBeUndefined();
  });

  test('returns undefined when the fetch throws (offline)', async () => {
    expect(
      await fetchLatestVersion({
        fetchImpl: () => Promise.reject(new Error('ENOTFOUND')),
      }),
    ).toBeUndefined();
  });

  test('returns undefined when the body has no version', async () => {
    expect(
      await fetchLatestVersion({
        fetchImpl: () =>
          Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ name: PACKAGE_NAME }),
          }),
      }),
    ).toBeUndefined();
    expect(
      await fetchLatestVersion({
        fetchImpl: () =>
          Promise.resolve({
            ok: true,
            json: () => Promise.reject(new Error('invalid json')),
          }),
      }),
    ).toBeUndefined();
  });

  test('aborts a slow fetch at the timeout', async () => {
    let aborted = false;
    const version = await fetchLatestVersion({
      timeoutMs: 10,
      fetchImpl: (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            aborted = true;
            reject(new Error('aborted'));
          });
        }),
    });

    expect(version).toBeUndefined();
    expect(aborted).toBe(true);
  });

  test('still returns at the timeout when the fetch ignores the signal', async () => {
    const version = await fetchLatestVersion({
      timeoutMs: 10,
      fetchImpl: () => new Promise(() => {}),
    });

    expect(version).toBeUndefined();
  });
});

describe('resolveInstalledVersion', () => {
  test('reads the row from the { data } wrapper that the SDK returns', async () => {
    const cacheRoot = makeCacheRoot();
    try {
      const context = {
        location: { directory: '/tmp/project' },
        client: {
          plugin: {
            list: () =>
              Promise.resolve({
                data: [
                  { id: 'other-plugin', source: { version: '9.9.9' } },
                  {
                    id: PACKAGE_NAME,
                    source: {
                      type: 'npm',
                      target: PACKAGE_NAME,
                      version: '3.0.4',
                    },
                  },
                ],
              }),
          },
        },
      };

      expect(
        await resolveInstalledVersion(context, {
          opencodeCacheDir: cacheRoot,
        }),
      ).toBe('3.0.4');
    } finally {
      fs.rmSync(cacheRoot, { recursive: true, force: true });
    }
  });

  test('accepts a bare array and matches on the source target', async () => {
    const cacheRoot = makeCacheRoot();
    try {
      const context = {
        client: {
          plugin: {
            list: () =>
              Promise.resolve([
                {
                  id: '-',
                  source: {
                    target: `${PACKAGE_NAME}@latest`,
                    version: '3.0.4',
                  },
                },
              ]),
          },
        },
      };

      expect(
        await resolveInstalledVersion(context, {
          opencodeCacheDir: cacheRoot,
        }),
      ).toBe('3.0.4');
    } finally {
      fs.rmSync(cacheRoot, { recursive: true, force: true });
    }
  });

  test('ignores rows for other packages', async () => {
    const cacheRoot = makeCacheRoot();
    try {
      const context = {
        client: {
          plugin: {
            list: () =>
              Promise.resolve({
                data: [
                  {
                    id: 'oh-my-opencode',
                    source: {
                      target: 'oh-my-opencode',
                      version: '1.0.0',
                    },
                  },
                ],
              }),
          },
        },
      };

      expect(
        await resolveInstalledVersion(context, {
          opencodeCacheDir: cacheRoot,
        }),
      ).toBeUndefined();
    } finally {
      fs.rmSync(cacheRoot, { recursive: true, force: true });
    }
  });

  test('falls back to the cache scan when plugin.list throws', async () => {
    const cacheRoot = makeCacheRoot();
    try {
      writeCachedInstall(
        cacheRoot,
        path.join('npm', `${PACKAGE_NAME}@latest`),
        'stamp-1',
        '3.0.4',
      );
      const context = {
        client: {
          plugin: {
            list: () => Promise.reject(new Error('no such method')),
          },
        },
      };

      expect(
        await resolveInstalledVersion(context, {
          opencodeCacheDir: cacheRoot,
        }),
      ).toBe('3.0.4');
    } finally {
      fs.rmSync(cacheRoot, { recursive: true, force: true });
    }
  });

  test('cache scan keeps the highest of every stamped layout', async () => {
    const cacheRoot = makeCacheRoot();
    try {
      writeCachedInstall(
        cacheRoot,
        path.join('npm', `${PACKAGE_NAME}@latest`),
        'stamp-old',
        '3.0.2',
      );
      writeCachedInstall(
        cacheRoot,
        path.join('npm', `${PACKAGE_NAME}@latest`),
        'stamp-new',
        '3.0.4',
      );
      // The v1 wrapper layout is lower here, so it must not win.
      writeCachedInstall(
        cacheRoot,
        path.join('packages', `${PACKAGE_NAME}@3.0.1`),
        '',
        '3.0.1',
      );

      expect(
        await resolveInstalledVersion({}, { opencodeCacheDir: cacheRoot }),
      ).toBe('3.0.4');
    } finally {
      fs.rmSync(cacheRoot, { recursive: true, force: true });
    }
  });

  test('cache scan tolerates a corrupt package.json next to a good one', async () => {
    const cacheRoot = makeCacheRoot();
    try {
      writeCachedInstall(
        cacheRoot,
        path.join('npm', `${PACKAGE_NAME}@latest`),
        'stamp-good',
        '3.0.3',
      );
      const broken = path.join(
        cacheRoot,
        'npm',
        `${PACKAGE_NAME}@latest`,
        'stamp-broken',
        'node_modules',
        PACKAGE_NAME,
      );
      fs.mkdirSync(broken, { recursive: true });
      fs.writeFileSync(path.join(broken, 'package.json'), '{ not json');

      expect(
        await resolveInstalledVersion({}, { opencodeCacheDir: cacheRoot }),
      ).toBe('3.0.3');
    } finally {
      fs.rmSync(cacheRoot, { recursive: true, force: true });
    }
  });

  test('returns undefined with no client and an empty cache', async () => {
    const cacheRoot = makeCacheRoot();
    try {
      expect(
        await resolveInstalledVersion({}, { opencodeCacheDir: cacheRoot }),
      ).toBeUndefined();
      expect(
        await resolveInstalledVersion(
          { client: {} },
          {
            opencodeCacheDir: cacheRoot,
          },
        ),
      ).toBeUndefined();
    } finally {
      fs.rmSync(cacheRoot, { recursive: true, force: true });
    }
  });
});

describe('checkForUpdate', () => {
  test('reports the decision for an outdated install', async () => {
    const cacheRoot = makeCacheRoot();
    try {
      const check = await checkForUpdate(
        {
          client: {
            plugin: {
              list: () =>
                Promise.resolve({
                  data: [{ id: PACKAGE_NAME, source: { version: '3.0.4' } }],
                }),
            },
          },
        },
        {
          opencodeCacheDir: cacheRoot,
          fetchImpl: () =>
            Promise.resolve({
              ok: true,
              json: () => Promise.resolve({ version: '3.0.5' }),
            }),
        },
      );

      expect(check).toEqual({
        installed: '3.0.4',
        latest: '3.0.5',
        notify: '3.0.5',
      });
    } finally {
      fs.rmSync(cacheRoot, { recursive: true, force: true });
    }
  });

  test('never throws and reports no notify without a host surface', async () => {
    const cacheRoot = makeCacheRoot();
    try {
      expect(
        await checkForUpdate(
          {},
          {
            opencodeCacheDir: cacheRoot,
            fetchImpl: () => Promise.reject(new Error('offline')),
          },
        ),
      ).toEqual({ installed: undefined, latest: undefined, notify: undefined });
    } finally {
      fs.rmSync(cacheRoot, { recursive: true, force: true });
    }
  });
});

describe('registerUpdateNotice', () => {
  test('never throws for an empty context and dispose is safe', async () => {
    let dispose: (() => void) | undefined;
    expect(() => {
      dispose = registerUpdateNotice({}, { delayMs: 0 });
    }).not.toThrow();
    expect(typeof dispose).toBe('function');
    expect(() => dispose?.()).not.toThrow();
    await wait(20);
  });

  test('never throws for a missing context', () => {
    expect(() => registerUpdateNotice(undefined)).not.toThrow();
    expect(() => registerUpdateNotice({ location: {} })).not.toThrow();
  });

  test('toasts and registers the footer badge for an outdated install', async () => {
    const cacheRoot = makeCacheRoot();
    const toasts: Array<Record<string, unknown>> = [];
    const slots: Array<{ append: string; render: () => unknown }> = [];
    const badgeCalls: Array<{ latest: string; color: unknown }> = [];
    let stopBadgeCalls = 0;
    let renders = 0;

    const dispose = registerUpdateNotice(
      {
        location: { directory: '/tmp/project' },
        client: {
          plugin: {
            list: () =>
              Promise.resolve({
                data: [{ id: PACKAGE_NAME, source: { version: '3.0.4' } }],
              }),
          },
        },
        ui: {
          toast: {
            show: (toast) => {
              toasts.push(toast as unknown as Record<string, unknown>);
            },
          },
          slot: (claim) => {
            slots.push(claim);
            return () => {
              stopBadgeCalls += 1;
            };
          },
        },
        theme: { text: { muted: '#8a8a8a', default: '#f0f0f0' } },
        renderer: {
          requestRender: () => {
            renders += 1;
          },
        },
      },
      {
        delayMs: 0,
        opencodeCacheDir: cacheRoot,
        fetchImpl: () =>
          Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ version: '3.0.5' }),
          }),
        renderBadge: (latest, color) => {
          badgeCalls.push({ latest, color });
          return { latest };
        },
      },
    );

    try {
      await waitFor(() => toasts.length > 0 && slots.length > 0);

      expect(toasts).toHaveLength(1);
      expect(toasts[0]).toEqual({
        title: 'OMO-Slim 3.0.5',
        message: 'v3.0.4 → v3.0.5 · run opencode plugin update',
        variant: 'info',
        duration: 10_000,
      });

      expect(slots).toHaveLength(1);
      expect(slots[0]?.append).toBe(UPDATE_BADGE_SLOT);
      expect(UPDATE_BADGE_SLOT).toBe('sidebar.footer');

      // The badge is only built when the host renders the slot.
      expect(badgeCalls).toHaveLength(0);
      expect(slots[0]?.render()).toEqual({ latest: '3.0.5' });
      expect(badgeCalls).toEqual([{ latest: '3.0.5', color: '#8a8a8a' }]);
      expect(renders).toBeGreaterThan(0);

      dispose();
      expect(stopBadgeCalls).toBe(1);
    } finally {
      dispose();
      fs.rmSync(cacheRoot, { recursive: true, force: true });
    }
  });

  test('shows nothing when the install is up to date', async () => {
    const cacheRoot = makeCacheRoot();
    const toasts: unknown[] = [];
    const slots: unknown[] = [];

    const dispose = registerUpdateNotice(
      {
        client: {
          plugin: {
            list: () =>
              Promise.resolve({
                data: [{ id: PACKAGE_NAME, source: { version: '3.0.5' } }],
              }),
          },
        },
        ui: {
          toast: { show: (toast) => void toasts.push(toast) },
          slot: (claim) => {
            slots.push(claim);
            return () => {};
          },
        },
      },
      {
        delayMs: 0,
        opencodeCacheDir: cacheRoot,
        fetchImpl: () =>
          Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ version: '3.0.5' }),
          }),
        renderBadge: () => ({}),
      },
    );

    try {
      await wait(40);
      expect(toasts).toEqual([]);
      expect(slots).toEqual([]);
    } finally {
      dispose();
      fs.rmSync(cacheRoot, { recursive: true, force: true });
    }
  });

  test('shows nothing for a new major or an unreachable registry', async () => {
    const cacheRoot = makeCacheRoot();
    const toasts: unknown[] = [];

    const makeContext = (version: string) => ({
      client: {
        plugin: {
          list: () =>
            Promise.resolve({
              data: [{ id: PACKAGE_NAME, source: { version } }],
            }),
        },
      },
      ui: { toast: { show: (toast: unknown) => void toasts.push(toast) } },
    });

    const newMajor = registerUpdateNotice(makeContext('3.0.4'), {
      delayMs: 0,
      opencodeCacheDir: cacheRoot,
      fetchImpl: () =>
        Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ version: '4.0.0' }),
        }),
    });
    const offline = registerUpdateNotice(makeContext('3.0.4'), {
      delayMs: 0,
      opencodeCacheDir: cacheRoot,
      fetchImpl: () => Promise.reject(new Error('offline')),
    });

    try {
      await wait(40);
      expect(toasts).toEqual([]);
    } finally {
      newMajor();
      offline();
      fs.rmSync(cacheRoot, { recursive: true, force: true });
    }
  });

  test('survives a throwing toast and a refusing slot', async () => {
    const cacheRoot = makeCacheRoot();
    let slotClaims = 0;

    const dispose = registerUpdateNotice(
      {
        client: {
          plugin: {
            list: () =>
              Promise.resolve({
                data: [{ id: PACKAGE_NAME, source: { version: '3.0.4' } }],
              }),
          },
        },
        ui: {
          toast: {
            show: () => {
              throw new Error('toast exploded');
            },
          },
          slot: () => {
            slotClaims += 1;
            throw new Error('no footer on this host');
          },
        },
      },
      {
        delayMs: 0,
        opencodeCacheDir: cacheRoot,
        fetchImpl: () =>
          Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ version: '3.0.5' }),
          }),
        renderBadge: () => ({}),
      },
    );

    try {
      await waitFor(() => slotClaims > 0);
      // Reaching this point means neither throw escaped the timer callback.
      expect(slotClaims).toBe(1);
    } finally {
      dispose();
      fs.rmSync(cacheRoot, { recursive: true, force: true });
    }
  });

  test('dispose clears the pending timer', async () => {
    let fetched = 0;
    const dispose = registerUpdateNotice(
      {},
      {
        delayMs: 30,
        fetchImpl: () => {
          fetched += 1;
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ version: '3.0.5' }),
          });
        },
      },
    );

    dispose();
    await wait(80);
    expect(fetched).toBe(0);
  });
});
