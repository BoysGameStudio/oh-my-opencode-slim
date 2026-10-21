import { afterEach, describe, expect, mock, test } from 'bun:test';
import { buildCacheKey, CACHE } from './cache';
import { createWebfetchTool } from './tool';

function createExecutionContext() {
  return {
    ask: mock(async () => undefined),
    metadata: mock(() => undefined),
    abort: new AbortController().signal,
    directory: '/tmp/smartfetch-test',
  } as any;
}

const cacheOptions = { format: 'markdown' as const, save_binary: false };

async function expireCached(key: string) {
  const entry = CACHE.get(key);
  if (!entry) throw new Error(`Missing cache entry: ${key}`);
  CACHE.set(key, entry, { ttl: 1 });
  await Bun.sleep(12);
}

describe('smartfetch/tool', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    CACHE.clear();
    mock.restore();
  });

  test('normalizes omitted arguments before probing, extracting and rendering metadata', async () => {
    const visited: string[] = [];
    globalThis.fetch = mock(async (input: string | URL | Request) => {
      const url = String(input);
      visited.push(url);
      if (url.endsWith('/llms-full.txt') || url.endsWith('/llms.txt')) {
        return new Response('missing', { status: 404 });
      }
      return new Response(
        `<html><head><title>Docs</title></head><body><nav>Navigation only</nav><article><h1>Welcome</h1><p>${'Documentation content with useful details. '.repeat(30)}</p></article></body></html>`,
        { headers: { 'content-type': 'text/html' } },
      );
    }) as typeof fetch;
    const result = await createWebfetchTool({ client: {} } as any).execute(
      { url: 'https://docs.example.com/page' },
      createExecutionContext(),
    );
    expect(result).toContain('title: "Docs"');
    expect(result).toContain('Welcome');
    expect(result).not.toContain('Navigation only');
    expect(result).not.toContain('final_url:');
    expect(visited).toEqual([
      'https://docs.example.com/llms-full.txt',
      'https://docs.example.com/llms.txt',
      'https://docs.example.com/page',
    ]);
  });

  test('negotiates markdown separately from HTML and treats markdown as text', async () => {
    const accepts: string[] = [];
    globalThis.fetch = mock(
      async (_url: string | URL | Request, init?: RequestInit) => {
        const accept = new Headers(init?.headers).get('Accept') || '';
        accepts.push(accept);
        return new Response(
          accept.startsWith('text/markdown')
            ? '# Markdown heading'
            : '<h1>HTML heading</h1>',
          {
            headers: {
              'content-type': accept.startsWith('text/markdown')
                ? 'text/markdown'
                : 'text/html',
            },
          },
        );
      },
    ) as typeof fetch;
    const webfetch = createWebfetchTool({ client: {} } as any);
    const args = { url: 'https://example.com/article' };
    const markdown = await webfetch.execute(
      { ...args, format: 'markdown' },
      createExecutionContext(),
    );
    const html = await webfetch.execute(
      { ...args, format: 'html' },
      createExecutionContext(),
    );
    expect(markdown).toContain('# Markdown heading');
    expect(html).toContain('HTML heading');
    expect(html).not.toContain('---\n');
    expect(accepts).toHaveLength(2);
    expect(accepts[0]).toStartWith('text/markdown');
    expect(accepts[1]).toStartWith('text/html');
  });

  test('llms.txt retains its own Accept header under every extracted format', async () => {
    const accepts: string[] = [];
    globalThis.fetch = mock(
      async (_url: string | URL | Request, init?: RequestInit) => {
        accepts.push(new Headers(init?.headers).get('Accept') || '');
        return new Response('# Docs', {
          headers: { 'content-type': 'text/plain' },
        });
      },
    ) as typeof fetch;
    const webfetch = createWebfetchTool({ client: {} } as any);
    for (const format of ['markdown', 'text'] as const) {
      CACHE.clear();
      expect(
        await webfetch.execute(
          { url: 'https://docs.example.com/page', format },
          createExecutionContext(),
        ),
      ).toContain('# Docs');
    }
    expect(accepts).toEqual(
      Array(2).fill('text/plain, text/markdown;q=0.9, */*;q=0.1'),
    );
  });

  test('one llms.txt probe serves markdown and text; html fetches the raw page', async () => {
    const requests: Array<[string, string | null]> = [];
    globalThis.fetch = mock(
      async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        requests.push([url, new Headers(init?.headers).get('Accept')]);
        if (
          url !== 'https://docs.example.com/llms-full.txt' &&
          url !== 'https://docs.example.com/page'
        ) {
          throw new Error(`Unexpected URL: ${url}`);
        }
        if (url.endsWith('/page')) {
          return new Response('<html><body>RAWPAGE</body></html>', {
            headers: { 'content-type': 'text/html' },
          });
        }
        return new Response('# Shared llms docs', {
          headers: { 'content-type': 'text/plain' },
        });
      },
    ) as typeof fetch;
    const webfetch = createWebfetchTool({ client: {} } as any);
    const markdown = await webfetch.execute(
      { url: 'https://docs.example.com/page' },
      createExecutionContext(),
    );
    const text = await webfetch.execute(
      { url: 'https://docs.example.com/page', format: 'text' },
      createExecutionContext(),
    );
    const html = await webfetch.execute(
      { url: 'https://docs.example.com/page', format: 'html' },
      createExecutionContext(),
    );
    expect(markdown).toContain('# Shared llms docs');
    expect(text).toContain('# Shared llms docs');
    expect(html).toContain('RAWPAGE');
    expect(html).not.toContain('# Shared llms docs');
    expect(requests.map(([url]) => url)).toEqual([
      'https://docs.example.com/llms-full.txt',
      'https://docs.example.com/page',
    ]);
    expect(CACHE.size).toBe(2);
  });

  test('no-llms docs pages keep per-format Accept and representations', async () => {
    const pageAccepts: string[] = [];
    globalThis.fetch = mock(
      async (input: string | URL | Request, init?: RequestInit) => {
        if (
          String(input).endsWith('/llms-full.txt') ||
          String(input).endsWith('/llms.txt')
        ) {
          return new Response('missing', { status: 404 });
        }
        const accept = new Headers(init?.headers).get('Accept') || '';
        pageAccepts.push(accept);
        return accept.startsWith('text/markdown')
          ? new Response('# Negotiated markdown', {
              headers: { 'content-type': 'text/markdown' },
            })
          : new Response('<html><body><h1>HTML version</h1></body></html>', {
              headers: { 'content-type': 'text/html' },
            });
      },
    ) as typeof fetch;
    const webfetch = createWebfetchTool({ client: {} } as any);
    const args = { url: 'https://docs.example.com/page' };
    const markdown = await webfetch.execute(
      { ...args, format: 'markdown' },
      createExecutionContext(),
    );
    const html = await webfetch.execute(
      { ...args, format: 'html' },
      createExecutionContext(),
    );
    expect(markdown).toContain('# Negotiated markdown');
    expect(html).toContain('HTML version');
    expect(html).not.toContain('Negotiated markdown');
    expect(pageAccepts).toHaveLength(2);
    expect(pageAccepts[0]).toStartWith('text/markdown');
    expect(pageAccepts[1]).toStartWith('text/html;q=1.0');
  });

  test('a Cloudflare challenge reports 403 and points to another source', async () => {
    const fetchMock = mock(
      async () =>
        new Response('challenge', {
          status: 403,
          headers: { 'cf-mitigated': 'challenge' },
        }),
    );
    globalThis.fetch = fetchMock as typeof fetch;
    await expect(
      createWebfetchTool({ client: {} } as any).execute(
        { url: 'https://example.com/page' },
        createExecutionContext(),
      ),
    ).rejects.toThrow(
      'Request failed with status code: 403 (Cloudflare browser challenge; retrying will not help, try another source)',
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('rejects a pre-aborted request after permission without network I/O', async () => {
    const controller = new AbortController();
    controller.abort(new Error('pre-aborted'));
    const fetchMock = mock(async () => new Response('unreachable'));
    globalThis.fetch = fetchMock as typeof fetch;
    const ctx = { ...createExecutionContext(), abort: controller.signal };
    const webfetch = createWebfetchTool({ client: {} } as any);
    await expect(
      webfetch.execute({ url: 'https://example.com/page' }, ctx),
    ).rejects.toThrow('pre-aborted');
    expect(ctx.ask).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('rejects 304 when no validators were sent', async () => {
    const fetchMock = mock(
      async (_url: string | URL | Request, init?: RequestInit) => {
        expect(new Headers(init?.headers).has('If-None-Match')).toBe(false);
        return new Response(null, { status: 304 });
      },
    );
    globalThis.fetch = fetchMock as typeof fetch;
    const webfetch = createWebfetchTool({ client: {} } as any);
    await expect(
      webfetch.execute(
        { url: 'https://example.com/page' },
        createExecutionContext(),
      ),
    ).rejects.toThrow('Request failed with status code: 304');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('revalidates stale ETag and Last-Modified with 304 and refreshes TTL', async () => {
    const fetchMock = mock(
      async (_url: string | URL | Request, init?: RequestInit) => {
        if (fetchMock.mock.calls.length === 1)
          return new Response('first body', {
            headers: {
              'content-type': 'text/plain',
              etag: '"first"',
              'last-modified': 'Tue, 01 Jan 2030 00:00:00 GMT',
            },
          });
        const headers = new Headers(init?.headers);
        expect(headers.get('If-None-Match')).toBe('"first"');
        expect(headers.get('If-Modified-Since')).toBe(
          'Tue, 01 Jan 2030 00:00:00 GMT',
        );
        return new Response(null, {
          status: 304,
          headers: { etag: '"renewed"' },
        });
      },
    );
    globalThis.fetch = fetchMock as typeof fetch;
    const webfetch = createWebfetchTool({ client: {} } as any);
    const args = { url: 'https://example.com/page' };
    const invoke = () => webfetch.execute(args, createExecutionContext());
    expect(await invoke()).toContain('first body');
    const key = buildCacheKey(args.url, cacheOptions);
    await expireCached(key);
    expect(await invoke()).toContain('first body');
    expect(await invoke()).toContain('first body');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test('revalidation 200 replaces cached content and the validator', async () => {
    const seen: Array<string | null> = [];
    globalThis.fetch = mock(
      async (_url: string | URL | Request, init?: RequestInit) => {
        seen.push(new Headers(init?.headers).get('If-None-Match'));
        return new Response(seen.length === 1 ? 'old body' : 'new body', {
          headers: {
            'content-type': 'text/plain',
            etag: seen.length === 1 ? '"old"' : '"new"',
          },
        });
      },
    ) as typeof fetch;
    const webfetch = createWebfetchTool({ client: {} } as any);
    const args = { url: 'https://example.com/replace' };
    const key = buildCacheKey(args.url, cacheOptions);
    const invoke = () => webfetch.execute(args, createExecutionContext());
    await invoke();
    await expireCached(key);
    expect(await invoke()).toContain('new body');
    await expireCached(key);
    await invoke();
    expect(seen).toEqual([null, '"old"', '"new"']);
  });

  test('failed revalidation keeps stale validators for the next attempt (R1)', async () => {
    const seen: Array<string | null> = [];
    const fetchMock = mock(
      async (_url: string | URL | Request, init?: RequestInit) => {
        seen.push(new Headers(init?.headers).get('If-None-Match'));
        if (seen.length === 1) {
          return new Response('original body', {
            headers: { 'content-type': 'text/plain', etag: '"original"' },
          });
        }
        if (seen.length === 2) throw new Error('offline during revalidation');
        return new Response(null, { status: 304 });
      },
    );
    globalThis.fetch = fetchMock as typeof fetch;
    const webfetch = createWebfetchTool({ client: {} } as any);
    const args = { url: 'https://example.com/retry-revalidation' };
    await webfetch.execute(args, createExecutionContext());
    const key = buildCacheKey(args.url, cacheOptions);
    await expireCached(key);
    await expect(
      webfetch.execute(args, createExecutionContext()),
    ).rejects.toThrow('offline during revalidation');
    const retried = await webfetch.execute(args, createExecutionContext());
    expect(seen).toEqual([null, '"original"', '"original"']);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(retried).toContain('original body');
  });

  test('stale entry without validators rejects an unsolicited 304 (R2)', async () => {
    const fetchMock = mock(async () =>
      fetchMock.mock.calls.length === 1
        ? new Response('original body', {
            headers: { 'content-type': 'text/plain' },
          })
        : new Response(null, { status: 304 }),
    );
    globalThis.fetch = fetchMock as typeof fetch;
    const webfetch = createWebfetchTool({ client: {} } as any);
    const args = { url: 'https://example.com/no-validators-304' };
    await webfetch.execute(args, createExecutionContext());
    const key = buildCacheKey(args.url, cacheOptions);
    await expireCached(key);
    await expect(
      webfetch.execute(args, createExecutionContext()),
    ).rejects.toThrow('Request failed with status code: 304');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test('304 after a changed redirect target triggers a fresh unconditional request', async () => {
    const seen: Array<[string, string | null]> = [];
    globalThis.fetch = mock(
      async (url: string | URL | Request, init?: RequestInit) => {
        const validator = new Headers(init?.headers).get('If-None-Match');
        seen.push([String(url), validator]);
        if (String(url).endsWith('/page'))
          return new Response(null, {
            status: 302,
            headers: { location: seen.length < 3 ? '/old' : '/new' },
          });
        if (seen.length === 2)
          return new Response('old body', {
            headers: { 'content-type': 'text/plain', etag: '"old"' },
          });
        if (seen.length === 4) return new Response(null, { status: 304 });
        return new Response('new body', {
          headers: { 'content-type': 'text/plain', etag: '"new"' },
        });
      },
    ) as typeof fetch;
    const webfetch = createWebfetchTool({ client: {} } as any);
    const args = { url: 'https://example.com/page' };
    await webfetch.execute(args, createExecutionContext());
    const key = buildCacheKey(args.url, cacheOptions);
    await expireCached(key);
    const updated = await webfetch.execute(args, createExecutionContext());
    expect(updated).toContain('new body');
    expect(updated).toContain('final_url: "https://example.com/new"');
    expect(seen).toEqual([
      ['https://example.com/page', null],
      ['https://example.com/old', null],
      ['https://example.com/page', '"old"'],
      ['https://example.com/new', '"old"'],
      ['https://example.com/page', null],
      ['https://example.com/new', null],
    ]);
  });

  test('stale pages without validators fetch unconditionally and never serve stale after a network error', async () => {
    const validators: Array<string | null> = [];
    let fail = false;
    globalThis.fetch = mock(
      async (_url: string | URL | Request, init?: RequestInit) => {
        validators.push(new Headers(init?.headers).get('If-None-Match'));
        if (fail) throw new Error('offline');
        return new Response('updated body', {
          headers: { 'content-type': 'text/plain' },
        });
      },
    ) as typeof fetch;
    const webfetch = createWebfetchTool({ client: {} } as any);
    const args = { url: 'https://example.com/no-etag' };
    const key = buildCacheKey(args.url, cacheOptions);
    await webfetch.execute(args, createExecutionContext());
    await expireCached(key);
    expect(await webfetch.execute(args, createExecutionContext())).toContain(
      'updated body',
    );
    expect(validators).toEqual([null, null]);
    await expireCached(key);
    fail = true;
    await expect(
      webfetch.execute(args, createExecutionContext()),
    ).rejects.toThrow('offline');
  });

  test('stale llms.txt entries are re-probed without conditionals', async () => {
    const calls: Array<[string, string | null]> = [];
    globalThis.fetch = mock(
      async (url: string | URL | Request, init?: RequestInit) => {
        calls.push([
          String(url),
          new Headers(init?.headers).get('If-None-Match'),
        ]);
        return new Response('# Fresh docs', {
          headers: { 'content-type': 'text/plain', etag: '"llms"' },
        });
      },
    ) as typeof fetch;
    const webfetch = createWebfetchTool({ client: {} } as any);
    const args = { url: 'https://docs.example.com/page' };
    await webfetch.execute(args, createExecutionContext());
    const key = buildCacheKey(args.url, {
      ...cacheOptions,
      format: undefined,
    });
    await expireCached(key);
    const result = await webfetch.execute(args, createExecutionContext());
    expect(result).toContain('# Fresh docs');
    expect(calls).toEqual([
      ['https://docs.example.com/llms-full.txt', null],
      ['https://docs.example.com/llms-full.txt', null],
    ]);
  });

  test('a failed stale llms.txt probe falls back to the page without its ETag (R3)', async () => {
    const calls: Array<[string, string | null]> = [];
    let probeAvailable = true;
    globalThis.fetch = mock(
      async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        calls.push([url, new Headers(init?.headers).get('If-None-Match')]);
        if (url.endsWith('/llms-full.txt')) {
          return probeAvailable
            ? new Response('# Old llms docs', {
                headers: { 'content-type': 'text/plain', etag: '"llms-only"' },
              })
            : new Response('not found', { status: 404 });
        }
        if (url.endsWith('/llms.txt')) {
          return new Response('not found', { status: 404 });
        }
        return new Response('fresh page body', {
          headers: { 'content-type': 'text/plain' },
        });
      },
    ) as typeof fetch;
    const webfetch = createWebfetchTool({ client: {} } as any);
    const args = { url: 'https://docs.example.com/reprobe' };
    expect(await webfetch.execute(args, createExecutionContext())).toContain(
      '# Old llms docs',
    );
    const key = buildCacheKey(args.url, {
      ...cacheOptions,
      format: undefined,
    });
    await expireCached(key);
    probeAvailable = false;
    const fallback = await webfetch.execute(args, createExecutionContext());
    expect(fallback).toContain('fresh page body');
    expect(calls).toEqual([
      ['https://docs.example.com/llms-full.txt', null],
      ['https://docs.example.com/llms-full.txt', null],
      ['https://docs.example.com/llms.txt', null],
      ['https://docs.example.com/reprobe', null],
    ]);
  });

  test('same document with different fragments issues a single request', async () => {
    CACHE.clear();

    const fetchMock = mock(async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input.toString();

      if (url === 'https://example.com/docs') {
        return new Response('document body', {
          status: 200,
          headers: { 'content-type': 'text/plain' },
        });
      }

      throw new Error(`Unexpected fetch URL: ${url}`);
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const webfetch = createWebfetchTool({ client: {} } as any);

    const firstResult = await webfetch.execute(
      { url: 'https://example.com/docs#sec1' },
      createExecutionContext(),
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(firstResult).toContain('document body');

    const secondResult = await webfetch.execute(
      { url: 'https://example.com/docs#sec2' },
      createExecutionContext(),
    );

    // The fragment-stripped cache key collides with the first request, so
    // the second fetch is served from cache without hitting the network.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(secondResult).toContain('document body');
  });

  test('fetches and cleans a 1 MiB U+2028 page in under one second', async () => {
    const page = `${'\u2028'.repeat(Math.floor((1024 * 1024) / 3))}![`;
    globalThis.fetch = mock(
      async () =>
        new Response(page, {
          headers: { 'content-type': 'text/plain; charset=utf-8' },
        }),
    ) as unknown as typeof fetch;
    const webfetch = createWebfetchTool({ client: {} } as any);
    const started = performance.now();
    const result = await webfetch.execute(
      { url: 'https://example.com/large', format: 'text' },
      createExecutionContext(),
    );
    // The tiny word count trips very_short_content, so the result carries
    // the conditional status header ahead of the cleaned body.
    expect(result.endsWith('![')).toBe(true);
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  test('a credentialed response never serves the cached body of another request', async () => {
    const fetchMock = mock(async (input: string | URL | Request) => {
      const url = String(input);
      return new Response(
        `<html><head><title>T</title></head><body>${url.includes('user:pass@') ? 'private account' : 'public page'}</body></html>`,
        { headers: { 'content-type': 'text/html' } },
      );
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const webfetch = createWebfetchTool({ client: {} } as any);
    const fetchPage = (url: string) =>
      webfetch.execute({ url }, createExecutionContext());
    const privateResult = await fetchPage(
      'https://user:pass@example.com/private',
    );
    const publicResult = await fetchPage('https://example.com/private');
    expect(privateResult).toContain('private account');
    expect(publicResult).toContain('public page');
    expect(publicResult).not.toContain('private account');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
