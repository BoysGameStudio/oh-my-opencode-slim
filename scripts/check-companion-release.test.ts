import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  COMPANION_REPOSITORY,
  companionArchiveNames,
  fetchCompanionRelease,
  publishedCompanionManifest,
  validateCompanionManifest,
  validateCompanionRelease,
} from './check-companion-release.mjs';
import {
  archiveBytes,
  publishedRelease,
  releaseRequest,
} from './companion-release-fixtures';
import { verifyCompanionRelease } from './verify-companion-release.mjs';

test('release lookup reads the public native repo, not GITHUB_REPOSITORY', async () => {
  const calls: string[] = [];
  const release = await fetchCompanionRelease('companion-v0.1.5', {
    token: '',
    request: async (url, init) => {
      calls.push(url);
      expect(init.headers.Authorization).toBeUndefined();
      return Response.json(publishedRelease());
    },
  });
  expect(release.tag_name).toBe('companion-v0.1.5');
  expect(calls).toEqual([
    `https://api.github.com/repos/${COMPANION_REPOSITORY}/releases/tags/companion-v0.1.5`,
  ]);
});

test('latest discovery still requires a concrete numeric native tag', async () => {
  const request = async (url) => {
    expect(url).toEndWith('/releases/latest');
    return Response.json(publishedRelease());
  };
  expect((await fetchCompanionRelease(undefined, { request })).tag_name).toBe(
    'companion-v0.1.5',
  );
  const release = publishedRelease();
  release.tag_name = 'v1.2.3';
  await expect(
    fetchCompanionRelease(undefined, {
      request: async () => Response.json(release),
    }),
  ).rejects.toThrow('Invalid Companion release tag');
});

test('all API, JSON and transport errors fail closed', async () => {
  for (const status of [401, 403, 404, 429, 502, 503]) {
    await expect(
      fetchCompanionRelease(undefined, {
        request: async () => new Response('', { status }),
      }),
    ).rejects.toThrow(`HTTP ${status}`);
  }
  await expect(
    fetchCompanionRelease(undefined, {
      request: async () => new Response('not json'),
    }),
  ).rejects.toThrow();
  await expect(
    fetchCompanionRelease(undefined, {
      request: async () => {
        throw new Error('offline');
      },
    }),
  ).rejects.toThrow('offline');
});

test('release identity rejects wrong repo, tag, draft and prerelease', () => {
  const release = publishedRelease();
  for (const patch of [
    { id: 0 },
    { tag_name: 'companion-v0.1.6' },
    { html_url: release.html_url.replace('companion', 'other') },
    { draft: true },
    { prerelease: true },
    { published_at: null },
  ]) {
    expect(() =>
      validateCompanionRelease({ ...release, ...patch }, release.tag_name),
    ).toThrow('release identity');
  }
});

test('incomplete or ambiguous platform assets fail before downloads', async () => {
  for (const mutate of [
    (release) => release.assets.pop(),
    (release) => release.assets.push(release.assets[0]),
    (release) => (release.assets[0].size = 0),
    (release) => (release.assets[0].state = 'new'),
    (release) =>
      (release.assets[0].browser_download_url = 'https://wrong.test/a'),
  ]) {
    const release = publishedRelease();
    mutate(release);
    await expect(
      publishedCompanionManifest(release, {
        request: async () => {
          throw new Error('must not download');
        },
      }),
    ).rejects.toThrow('Incomplete Companion release asset');
  }
});

test('five actual archive byte hashes determine the manifest', async () => {
  const calls: string[] = [];
  const release = publishedRelease();
  const manifest = await publishedCompanionManifest(release, {
    request: releaseRequest(release, calls),
  });
  validateCompanionManifest(manifest);
  expect(calls).toHaveLength(5);
  expect(manifest.repo).toBe(COMPANION_REPOSITORY);
  for (const name of companionArchiveNames('0.1.5')) {
    expect(manifest.checksums[name]).toBe(
      createHash('sha256').update(archiveBytes(name)).digest('hex'),
    );
  }
});

test('download status, truncation and digest disagreements fail closed', async () => {
  const release = publishedRelease();
  for (const response of [
    new Response('', { status: 404 }),
    new Response('truncated'),
  ]) {
    await expect(
      publishedCompanionManifest(release, { request: async () => response }),
    ).rejects.toThrow();
  }
  release.assets[0].digest = `sha256:${'0'.repeat(64)}`;
  await expect(
    publishedCompanionManifest(release, { request: releaseRequest(release) }),
  ).rejects.toThrow('digest mismatch');
});

test('publish verifier checks pinned release bytes without local git or native source', async () => {
  const release = publishedRelease();
  const request = releaseRequest(release);
  const manifest = await publishedCompanionManifest(release, { request });
  const calls: string[] = [];
  await verifyCompanionRelease(manifest, {
    request: releaseRequest(release, calls),
  });
  expect(calls[0]).toEndWith('/releases/tags/companion-v0.1.5');
  expect(calls).toHaveLength(6);
  manifest.checksums[release.assets[0].name] = '0'.repeat(64);
  await expect(verifyCompanionRelease(manifest, { request })).rejects.toThrow(
    'differs from published archive checksums',
  );
});

test('offline manifest validation rejects wrong repo, version, assets and hashes', async () => {
  const release = publishedRelease();
  const manifest = await publishedCompanionManifest(release, {
    request: releaseRequest(release),
  });
  for (const patch of [
    { repo: 'alvinunreal/oh-my-opencode-slim' },
    { version: 'latest' },
    { tag: 'companion-v0.1.4' },
    { checksums: {} },
    { checksums: { ...manifest.checksums, extra: '0'.repeat(64) } },
    {
      checksums: { ...manifest.checksums, [release.assets[0].name]: 'invalid' },
    },
  ]) {
    expect(() =>
      validateCompanionManifest({ ...manifest, ...patch }),
    ).toThrow();
  }
});
