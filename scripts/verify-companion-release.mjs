#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  companionManifestsEqual,
  fetchCompanionRelease,
  publishedCompanionManifest,
  validateCompanionManifest,
} from './check-companion-release.mjs';

export async function verifyCompanionRelease(manifest, options = {}) {
  validateCompanionManifest(manifest);
  // Verify the pinned release, never "latest" or a tag in the plugin repo.
  const release = await fetchCompanionRelease(manifest.tag, options);
  const published = await publishedCompanionManifest(release, options);
  if (!companionManifestsEqual(manifest, published)) {
    throw new Error(
      'Companion manifest differs from published archive checksums.',
    );
  }
  return release;
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  const manifest = JSON.parse(
    readFileSync('src/companion/companion-manifest.json', 'utf8'),
  );
  await verifyCompanionRelease(manifest);
  console.log(`Published Companion release verified: ${manifest.tag}`);
}
