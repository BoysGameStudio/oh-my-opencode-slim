import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  companionArchiveNames,
  publishedCompanionManifest,
} from './check-companion-release.mjs';
import {
  archiveBytes,
  publishedRelease,
  releaseRequest,
} from './companion-release-fixtures';
import {
  prepareCompanionRelease,
  writeCompanionManifests,
} from './prepare-companion-release.mjs';
import { syncCompanionManifest } from './sync-companion-manifest.mjs';

const manifestPath = 'src/companion/companion-manifest.json';
const updaterPath = 'src/companion/updater.ts';

async function fixture(version = '0.1.4') {
  const root = mkdtempSync(join(tmpdir(), 'omo-companion-release-'));
  mkdirSync(join(root, 'src/companion'), { recursive: true });
  const release = publishedRelease(version);
  const manifest = await publishedCompanionManifest(release, {
    request: releaseRequest(release),
  });
  writeFileSync(
    join(root, updaterPath),
    'export const COMPANION_MANIFEST: CompanionManifest = {\n};\n',
  );
  writeCompanionManifests(manifest, root);
  return root;
}

test('preparation only synchronizes plugin manifests from real bytes, without native files or git', async () => {
  const root = await fixture();
  try {
    const assetsDir = join(root, 'assets');
    mkdirSync(assetsDir);
    for (const name of companionArchiveNames('0.1.5')) {
      writeFileSync(join(assetsDir, name), archiveBytes(name));
    }
    prepareCompanionRelease('0.1.5', assetsDir, root);
    const manifest = JSON.parse(readFileSync(join(root, manifestPath), 'utf8'));
    const release = publishedRelease();
    expect(manifest).toEqual(
      await publishedCompanionManifest(release, {
        request: releaseRequest(release),
      }),
    );
    expect(readFileSync(join(root, updaterPath), 'utf8')).toContain(
      Object.values(manifest.checksums)[0],
    );
    expect(existsSync(join(root, 'companion'))).toBe(false);
    expect(existsSync(join(root, '.git'))).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('preparation requires all assets and fallback location before any writes', async () => {
  const root = await fixture();
  try {
    const before = readFileSync(join(root, manifestPath), 'utf8');
    expect(() => prepareCompanionRelease('0.1.5', undefined, root)).toThrow(
      '--assets-dir',
    );
    expect(() => prepareCompanionRelease('0.1.5', root, root)).toThrow();
    expect(readFileSync(join(root, manifestPath), 'utf8')).toBe(before);
    writeFileSync(join(root, updaterPath), 'no fallback here');
    expect(() => writeCompanionManifests(JSON.parse(before), root)).toThrow(
      'fallback manifest',
    );
    expect(readFileSync(join(root, manifestPath), 'utf8')).toBe(before);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('sync updates once then leaves aligned manifest bytes untouched', async () => {
  const root = await fixture();
  try {
    const release = publishedRelease();
    const options = { root, request: releaseRequest(release) };
    expect(await syncCompanionManifest(options)).toEqual({
      changed: true,
      version: '0.1.5',
    });
    const before = readFileSync(join(root, manifestPath), 'utf8');
    const updater = readFileSync(join(root, updaterPath), 'utf8');
    expect(await syncCompanionManifest(options)).toEqual({
      changed: false,
      version: '0.1.5',
    });
    expect(readFileSync(join(root, manifestPath), 'utf8')).toBe(before);
    expect(readFileSync(join(root, updaterPath), 'utf8')).toBe(updater);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('sync refuses API errors, incomplete releases, downgrades and same-tag mutations without writes', async () => {
  const root = await fixture('0.1.5');
  try {
    const before = readFileSync(join(root, manifestPath), 'utf8');
    const partial = publishedRelease('0.1.6');
    partial.assets.pop();
    for (const request of [
      async () => new Response('', { status: 503 }),
      releaseRequest(partial),
      releaseRequest(publishedRelease('0.1.4')),
    ]) {
      await expect(syncCompanionManifest({ root, request })).rejects.toThrow();
      expect(readFileSync(join(root, manifestPath), 'utf8')).toBe(before);
    }
    const manifest = JSON.parse(before);
    manifest.checksums[Object.keys(manifest.checksums)[0]] = '0'.repeat(64);
    writeCompanionManifests(manifest, root);
    await expect(
      syncCompanionManifest({ root, request: releaseRequest() }),
    ).rejects.toThrow('immutable tag');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('offline verification is independent of native source, local tags and network', () => {
  const result = spawnSync('bun', ['scripts/verify-companion-manifest.ts'], {
    cwd: join(import.meta.dir, '..'),
    encoding: 'utf8',
    env: { ...process.env, GH_TOKEN: '', GITHUB_REPOSITORY: 'wrong/repo' },
  });
  expect(result.status).toBe(0);
  expect(result.stdout).toContain('verified offline');
});

test('plugin release hooks and sync workflow have no native build or same-repo provenance dependency', () => {
  const root = join(import.meta.dir, '..');
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  expect(pkg.scripts.preversion).toContain('verify:companion-release');
  expect(pkg.scripts.prepublishOnly).toContain('verify:companion-manifest');
  expect(pkg.scripts.prepublishOnly).toContain('verify:companion-release');
  expect(pkg.scripts['verify:companion-source']).toBeUndefined();
  for (const name of [
    'companion-ci',
    'companion-release',
    'companion-auto-release',
  ]) {
    expect(existsSync(join(root, `.github/workflows/${name}.yml`))).toBe(false);
  }
  const workflow = readFileSync(
    join(root, '.github/workflows/companion-manifest-sync.yml'),
    'utf8',
  );
  expect(workflow).toContain('workflow_dispatch:');
  expect(workflow).toContain('schedule:');
  expect(workflow).toContain("if: steps.sync.outputs.changed == 'true'");
  expect(workflow).not.toContain('cargo ');
  expect(workflow).not.toContain('companion/Cargo');
  expect(workflow).not.toContain('git fetch --tags');
});
