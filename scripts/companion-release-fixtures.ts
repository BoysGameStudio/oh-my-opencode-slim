import { createHash } from 'node:crypto';
import {
  COMPANION_REPOSITORY,
  companionArchiveNames,
} from './check-companion-release.mjs';

export function archiveBytes(name: string) {
  return Buffer.from(`published archive bytes for ${name}`);
}

export function publishedRelease(version = '0.1.5') {
  const tag = `companion-v${version}`;
  return {
    id: 12345,
    tag_name: tag,
    html_url: `https://github.com/${COMPANION_REPOSITORY}/releases/tag/${tag}`,
    draft: false,
    prerelease: false,
    published_at: '2026-01-01T00:00:00Z',
    assets: companionArchiveNames(version).map((name) => ({
      name,
      state: 'uploaded',
      size: archiveBytes(name).length,
      digest: `sha256:${createHash('sha256').update(archiveBytes(name)).digest('hex')}`,
      browser_download_url: `https://github.com/${COMPANION_REPOSITORY}/releases/download/${tag}/${name}`,
    })),
  };
}

export function releaseRequest(
  release = publishedRelease(),
  calls: string[] = [],
) {
  return async (url: string) => {
    calls.push(url);
    if (url.startsWith('https://api.github.com/')) {
      return Response.json(release);
    }
    const asset = release.assets.find(
      (entry) => entry.browser_download_url === url,
    );
    if (!asset) throw new Error(`Unexpected fixture URL: ${url}`);
    return new Response(archiveBytes(asset.name));
  };
}
