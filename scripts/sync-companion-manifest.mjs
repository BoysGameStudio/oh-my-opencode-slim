#!/usr/bin/env node
import { appendFileSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  companionManifestsEqual,
  fetchCompanionRelease,
  publishedCompanionManifest,
  validateCompanionManifest,
} from './check-companion-release.mjs';
import { writeCompanionManifests } from './prepare-companion-release.mjs';

export async function syncCompanionManifest(options = {}) {
  const root = options.root ?? '.';
  const current = JSON.parse(
    readFileSync(`${root}/src/companion/companion-manifest.json`, 'utf8'),
  );
  validateCompanionManifest(current);
  const release = await fetchCompanionRelease(undefined, options);
  const manifest = await publishedCompanionManifest(release, options);
  const previous = current.version.split('.').map(Number);
  const next = manifest.version.split('.').map(Number);
  const firstDifference = next.findIndex(
    (part, index) => part !== previous[index],
  );
  if (
    firstDifference !== -1 &&
    next[firstDifference] < previous[firstDifference]
  ) {
    throw new Error('Refusing to downgrade the packaged Companion release.');
  }
  const changed = !companionManifestsEqual(current, manifest);
  if (current.tag === manifest.tag && changed) {
    throw new Error(
      'Published Companion release changed under an immutable tag.',
    );
  }
  if (changed) writeCompanionManifests(manifest, root);
  return { changed, version: manifest.version };
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  const result = await syncCompanionManifest();
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      `changed=${result.changed}\nversion=${result.version}\n`,
    );
  }
  console.log(
    result.changed
      ? `Synchronized Companion ${result.version}.`
      : `Companion ${result.version} is already aligned.`,
  );
}
