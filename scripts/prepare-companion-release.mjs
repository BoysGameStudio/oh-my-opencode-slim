#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  COMPANION_REPOSITORY,
  companionArchiveNames,
  validateCompanionManifest,
} from './check-companion-release.mjs';

export function writeCompanionManifests(manifest, root = '.') {
  validateCompanionManifest(manifest);
  const updaterPath = join(root, 'src/companion/updater.ts');
  const updater = readFileSync(updaterPath, 'utf8');
  const pattern =
    /export const COMPANION_MANIFEST: CompanionManifest = \{[\s\S]*?\n\};/;
  if (!pattern.test(updater)) {
    throw new Error(
      'Could not locate Companion fallback manifest in updater.ts',
    );
  }
  const fallback = [
    'export const COMPANION_MANIFEST: CompanionManifest = {',
    `  version: '${manifest.version}',`,
    `  tag: '${manifest.tag}',`,
    `  repo: '${manifest.repo}',`,
    '  checksums: {',
    ...Object.entries(manifest.checksums).flatMap(([archive, sha]) => [
      `    '${archive}':`,
      `      '${sha}',`,
    ]),
    '  },',
    '};',
  ].join('\n');
  writeFileSync(
    join(root, 'src/companion/companion-manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  writeFileSync(updaterPath, updater.replace(pattern, fallback));
}

export function prepareCompanionRelease(version, assetsDir, root = '.') {
  if (!assetsDir)
    throw new Error('Specify --assets-dir with published archives.');
  const checksums = {};
  for (const archive of companionArchiveNames(version)) {
    checksums[archive] = createHash('sha256')
      .update(readFileSync(join(assetsDir, archive)))
      .digest('hex');
  }
  writeCompanionManifests(
    {
      version,
      tag: `companion-v${version}`,
      repo: COMPANION_REPOSITORY,
      checksums,
    },
    root,
  );
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  const version = process.argv
    .find((arg) => arg.startsWith('--version='))
    ?.slice('--version='.length);
  const assetsDir = process.argv
    .find((arg) => arg.startsWith('--assets-dir='))
    ?.slice('--assets-dir='.length);
  prepareCompanionRelease(version, assetsDir);
  console.log(
    `Synchronized Companion ${version} from five published archives.`,
  );
}
