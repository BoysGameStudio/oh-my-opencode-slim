import { afterEach, describe, expect, mock, test } from 'bun:test';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildCacheKey, CACHE } from './cache';
import { createWebfetchTool } from './tool';
import type { CachedFetch } from './types';

/**
 * Post-slimming webfetch contract.
 *
 * Pins the surface callers can rely on after the secondary-model chain,
 * inline-image path and metadata key sprawl were removed:
 *  - `execute` always returns a plain string (no attachments object);
 *  - the status header before the body carries only an allowlisted key set;
 *  - `format: html` is the untouched raw page (no Readability, no header);
 *  - unsaved binaries degrade to a one-line kind+size+guidance message;
 *  - the error branches keep their operator-facing copy.
 */

function createExecutionContext() {
  return {
    ask: mock(async () => undefined),
    metadata: mock(() => undefined),
    abort: new AbortController().signal,
    directory: '/tmp/smartfetch-contract',
  } as any;
}

/** Top-level `key:` entries of the leading `---` status header, if any. */
function statusHeaderKeys(result: string): string[] {
  const match = result.match(/^---\n([\s\S]*?)\n---\n/);
  if (!match) return [];
  return match[1]
    .split('\n')
    .filter((line) => /^[a-z_]+:/.test(line))
    .map((line) => line.slice(0, line.indexOf(':')))
    .sort();
}

function seedCached(url: string, entry: Partial<CachedFetch>) {
  CACHE.set(buildCacheKey(url, { format: 'markdown', save_binary: false }), {
    finalUrl: url,
    contentType: 'text/plain',
    rawContent: 'seeded body',
    markdown: 'seeded body',
    text: 'seeded body',
    html: 'seeded body',
    extractedMain: false,
    usedLlmsTxt: false,
    sourceKind: 'text',
    truncated: false,
    wordCount: 2,
    ...entry,
  });
}

describe('smartfetch/contract', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    CACHE.clear();
    mock.restore();
  });

  test('a cached text response returns a plain string with only allowlisted status keys', async () => {
    const url = 'https://example.com/page';
    seedCached(url, {
      title: 'Seed Title',
      finalUrl: 'https://example.com/final',
      truncated: true,
      qualitySignals: ['possible_paywall'],
    });
    const result = await createWebfetchTool({ client: {} } as any).execute(
      { url },
      createExecutionContext(),
    );
    expect(typeof result).toBe('string');
    expect(statusHeaderKeys(result)).toEqual([
      'final_url',
      'quality_signals',
      'title',
      'truncated',
    ]);
    expect(result).toContain('final_url: "https://example.com/final"');
    expect(result).toContain('quality_signals:');
    expect(result).toContain('  - "possible_paywall"');
    // Every removed key stays removed.
    for (const key of [
      'requested_url',
      'canonical_url',
      'status_code',
      'source_content_type',
      'charset',
      'etag',
      'last_modified',
      'content_length',
      'filename',
      'headings',
      'source_kind',
      'used_llms_txt',
      'extracted_main',
      'redirect_chain',
      'upgraded_to_https',
      'llms_probe_error',
      'llms_probe_truncated',
      'cache_hit',
      'revalidated',
      'word_count',
      'decoded_charset',
      'decode_fallback',
      'decode_warning',
      'secondary_model',
    ]) {
      expect(result).not.toContain(`${key}:`);
    }
  });

  test('an empty quality_signals list and an unchanged URL emit no header keys for them', async () => {
    const url = 'https://example.com/plain';
    seedCached(url, { title: 'Only Title', qualitySignals: [] });
    const result = await createWebfetchTool({ client: {} } as any).execute(
      { url },
      createExecutionContext(),
    );
    expect(statusHeaderKeys(result)).toEqual(['title']);
    expect(result).not.toContain('quality_signals');
    expect(result).not.toContain('final_url');
    expect(result).not.toContain('truncated');
  });

  test('a response with nothing to report carries no status header at all', async () => {
    const url = 'https://example.com/bare';
    seedCached(url, {});
    const result = await createWebfetchTool({ client: {} } as any).execute(
      { url },
      createExecutionContext(),
    );
    expect(result).toBe('seeded body');
  });

  test('format html returns the untouched raw page without a status header', async () => {
    const raw =
      '<!DOCTYPE html><html><head><title>Raw Page</title></head>' +
      '<body><nav>NAVTOKEN</nav><article>ARTICLETOKEN</article></body></html>';
    globalThis.fetch = mock(
      async () =>
        new Response(raw, { headers: { 'content-type': 'text/html' } }),
    ) as typeof fetch;
    const result = await createWebfetchTool({ client: {} } as any).execute(
      { url: 'https://example.com/raw', format: 'html' },
      createExecutionContext(),
    );
    expect(typeof result).toBe('string');
    expect(result).toContain('NAVTOKEN');
    expect(result).toContain('ARTICLETOKEN');
    expect(result).toContain('<nav>');
    expect(result).not.toContain('---\n');
    expect(result).not.toContain('title:');
  });

  test('the default format extracts the main content and drops boilerplate', async () => {
    globalThis.fetch = mock(
      async () =>
        new Response(
          `<html><head><title>Docs</title></head><body><nav>Navigation only</nav><article><h1>Welcome</h1><p>${'Documentation content with useful details. '.repeat(30)}</p></article></body></html>`,
          { headers: { 'content-type': 'text/html' } },
        ),
    ) as typeof fetch;
    const result = await createWebfetchTool({ client: {} } as any).execute(
      { url: 'https://example.com/page' },
      createExecutionContext(),
    );
    expect(result).toContain('Welcome');
    expect(result).not.toContain('Navigation only');
    expect(statusHeaderKeys(result)).toEqual(['title']);
    expect(result).toContain('title: "Docs"');
  });

  test('unsaved binary data degrades to a kind+size+guidance line', async () => {
    const image = Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10, 42);
    globalThis.fetch = mock(
      async () =>
        new Response(image, { headers: { 'content-type': 'image/png' } }),
    ) as typeof fetch;
    const result = await createWebfetchTool({ client: {} } as any).execute(
      { url: 'https://example.com/figure.png' },
      createExecutionContext(),
    );
    expect(typeof result).toBe('string');
    expect(result).toContain('IMAGE content fetched (9 bytes).');
    expect(result).toContain('Re-run with save_binary=true to persist it.');
    expect(result).not.toContain('data:image/png;base64');
    expect(statusHeaderKeys(result)).toEqual([]);
  });

  test('an oversized binary reports the limit and the guidance without writing to disk', async () => {
    globalThis.fetch = mock(
      async () =>
        new Response(Uint8Array.of(137, 80, 78, 71), {
          headers: {
            'content-type': 'image/png',
            'content-length': '3000000',
          },
        }),
    ) as typeof fetch;
    const result = await createWebfetchTool({ client: {} } as any).execute(
      { url: 'https://example.com/oversized.png' },
      createExecutionContext(),
    );
    expect(typeof result).toBe('string');
    expect(result).toContain(
      'IMAGE content omitted because it exceeds the download limit (3000000 bytes).',
    );
    expect(result).toContain('Re-run with save_binary=true to persist it.');
  });

  test('save_binary keeps the disk path and reports where the payload landed', async () => {
    const directory = await mkdtemp(
      path.join(tmpdir(), 'smartfetch-contract-'),
    );
    const image = Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10, 42);
    try {
      globalThis.fetch = mock(
        async () =>
          new Response(image, { headers: { 'content-type': 'image/png' } }),
      ) as typeof fetch;
      const result = await createWebfetchTool({ client: {} } as any, {
        binaryDir: directory,
      }).execute(
        { url: 'https://example.com/image.png', save_binary: true },
        createExecutionContext(),
      );
      expect(typeof result).toBe('string');
      expect(result).toContain('IMAGE content saved to');
      const files = await readdir(directory);
      expect(files).toHaveLength(1);
      expect(await readFile(path.join(directory, files[0]))).toEqual(
        Buffer.from(image),
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test('a blocked cross-origin redirect keeps its operator copy', async () => {
    globalThis.fetch = mock(
      async () =>
        new Response(null, {
          status: 302,
          headers: { location: 'https://elsewhere.example.org/x' },
        }),
    ) as typeof fetch;
    const result = await createWebfetchTool({ client: {} } as any).execute(
      { url: 'https://example.com/page' },
      createExecutionContext(),
    );
    expect(result).toContain('Redirect was blocked by policy.');
    expect(result).toContain('Original URL: https://example.com/page');
    expect(result).toContain('Redirect URL: https://elsewhere.example.org/x');
    expect(result).toContain(
      'Re-run webfetch with the redirect URL to continue.',
    );
  });

  test('cloudflare and status failures keep their thrown messages', async () => {
    globalThis.fetch = mock(
      async () =>
        new Response('challenge', {
          status: 403,
          headers: { 'cf-mitigated': 'challenge' },
        }),
    ) as typeof fetch;
    await expect(
      createWebfetchTool({ client: {} } as any).execute(
        { url: 'https://example.com/page' },
        createExecutionContext(),
      ),
    ).rejects.toThrow(
      'Request failed with status code: 403 (Cloudflare browser challenge; retrying will not help, try another source)',
    );

    globalThis.fetch = mock(
      async () => new Response('nope', { status: 404 }),
    ) as typeof fetch;
    await expect(
      createWebfetchTool({ client: {} } as any).execute(
        { url: 'https://example.com/missing' },
        createExecutionContext(),
      ),
    ).rejects.toThrow('Request failed with status code: 404');
  });

  test('llms.txt probing stays automatic and removed parameters are inert', async () => {
    const session = {
      create: mock(async () => ({ data: { id: 'should-not-happen' } })),
      prompt: mock(async () => ({ data: { parts: [] } })),
      delete: mock(async () => ({ data: true })),
    };
    globalThis.fetch = mock(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('/llms-full.txt') || url.endsWith('/llms.txt')) {
        return new Response('missing', { status: 404 });
      }
      return new Response(
        `<html><body><nav>Navigation only</nav><article><h1>Welcome</h1><p>${'Documentation content with useful details. '.repeat(30)}</p></article></body></html>`,
        { headers: { 'content-type': 'text/html' } },
      );
    }) as typeof fetch;
    const ctx = createExecutionContext();
    const result = await createWebfetchTool({ client: { session } } as any, {
      // Deleted options are still tolerated by the arg schema but do nothing.
    }).execute(
      {
        url: 'https://docs.example.com/page',
        prompt: 'summarize this',
        extract_main: false,
        prefer_llms_txt: 'always',
        include_metadata: false,
      } as never,
      ctx,
    );
    expect(result).toContain('Welcome');
    expect(result).not.toContain('Navigation only');
    expect(result).not.toContain('Required llms.txt content was unavailable.');
    // Removed parameters are inert: no secondary session is ever created.
    expect(session.create).not.toHaveBeenCalled();
  });

  test('ctx.metadata keeps carrying the UI dedup channel', async () => {
    globalThis.fetch = mock(
      async () =>
        new Response('body', { headers: { 'content-type': 'text/plain' } }),
    ) as typeof fetch;
    const ctx = createExecutionContext();
    await createWebfetchTool({ client: {} } as any).execute(
      { url: 'https://example.com/ui' },
      ctx,
    );
    expect(ctx.metadata).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: {
          url: 'https://example.com/ui',
          contentType: 'text/plain',
          truncated: false,
        },
      }),
    );
  });

  test('format html skips llms.txt probing and returns the raw page on docs hosts', async () => {
    globalThis.fetch = mock(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('/llms-full.txt') || url.endsWith('/llms.txt')) {
        return new Response('LLMSTOKEN', {
          headers: { 'content-type': 'text/plain' },
        });
      }
      return new Response(
        '<html><body><article>RAWPAGETOKEN</article></body></html>',
        { headers: { 'content-type': 'text/html' } },
      );
    }) as typeof fetch;
    const result = await createWebfetchTool({ client: {} } as any).execute(
      { url: 'https://docs.example.com/page', format: 'html' },
      createExecutionContext(),
    );
    expect(result).toContain('RAWPAGETOKEN');
    expect(result).not.toContain('LLMSTOKEN');
    expect(result).not.toContain('---\n');
  });

  test('an oversized binary with save_binary already on states the limit without an impossible retry hint', async () => {
    globalThis.fetch = mock(
      async () =>
        new Response(Uint8Array.of(137, 80, 78, 71), {
          headers: {
            'content-type': 'image/png',
            'content-length': String(10 * 1024 * 1024 + 1),
          },
        }),
    ) as typeof fetch;
    const result = await createWebfetchTool({ client: {} } as any).execute(
      { url: 'https://example.com/huge.png', save_binary: true },
      createExecutionContext(),
    );
    expect(typeof result).toBe('string');
    expect(result).toContain(
      'IMAGE content omitted because it exceeds the download limit (10485761 bytes).',
    );
    expect(result).not.toContain('Re-run with save_binary=true');
    expect(result).toContain('The active limit is 10485760 bytes');
  });
});
