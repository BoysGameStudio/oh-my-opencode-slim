#!/usr/bin/env bun
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { COMPANION_MANIFEST } from '../src/companion/updater';
import {
  companionManifestsEqual,
  validateCompanionManifest,
} from './check-companion-release.mjs';

const manifest = JSON.parse(
  readFileSync(
    resolve(import.meta.dir, '../src/companion/companion-manifest.json'),
    'utf8',
  ),
);
validateCompanionManifest(manifest);
if (!companionManifestsEqual(manifest, COMPANION_MANIFEST)) {
  throw new Error(
    'Bundled companion-manifest.json does not match COMPANION_MANIFEST in updater.ts.',
  );
}
console.log(`Companion manifest verified offline: ${manifest.tag}`);
