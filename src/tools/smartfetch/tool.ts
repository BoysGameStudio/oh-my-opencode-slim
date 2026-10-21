import os from 'node:os';
import path from 'node:path';
import {
  type PluginInput,
  type ToolDefinition,
  tool,
} from '@opencode-ai/plugin';
import { detectInlineImageMime } from '../../utils/image-signatures';
import { buildBinaryResultMessage, saveBinary } from './binary';
import { buildCacheKey, CACHE, conditionalHeaders, lookup } from './cache';
import {
  DEFAULT_TIMEOUT_SECONDS,
  MAX_BINARY_DOWNLOAD_BYTES,
  MAX_LLMS_PROBE_TIMEOUT_MS,
  MAX_RESPONSE_BYTES,
  MAX_TIMEOUT_SECONDS,
  WEBFETCH_DESCRIPTION,
} from './constants';
import {
  ACCEPT_BY_FORMAT,
  buildPermissionPatterns,
  decodeBody,
  discard,
  extractHeaderMetadata,
  fetchWithUpgradeFallback,
  getBinaryKind,
  isBinaryContentType,
  isCloudflareChallenge,
  isDocsLikeUrl,
  isGenericBinaryMime,
  isHtmlLikeContentType,
  looksLikeHtmlText,
  looksLikeTextBody,
  normalizeUrl,
  probeLlmsText,
  readBodyLimited,
  runWithScopedTimeout,
} from './network';
import type { CachedFetch, SmartfetchOptions } from './types';
import {
  buildRedirectResultMessage,
  cleanFetchedMarkdown,
  cleanFetchedText,
  detectQualitySignals,
  extractFromHtml,
  extractHeadingsFromMarkdown,
  frontmatter,
  inferCanonicalUrlFromText,
  renderMessageForFormat,
  trimBlankRuns,
  wordCount,
} from './utils';

const z = tool.schema;
const ARGS = {
  url: z.httpUrl(),
  format: z.enum(['text', 'markdown', 'html']).default('markdown'),
  timeout: z
    .number()
    .positive()
    .max(MAX_TIMEOUT_SECONDS)
    .optional()
    .describe('Timeout in seconds, max 120.'),
  save_binary: z
    .boolean()
    .default(false)
    .describe(
      'Save binary payload to disk when it fits within the active download limit.',
    ),
};

function pickContent(
  fetchResult: CachedFetch,
  format: 'text' | 'markdown' | 'html',
) {
  const content =
    format === 'html'
      ? fetchResult.sourceKind === 'html'
        ? fetchResult.extractedMain
          ? fetchResult.html
          : fetchResult.rawContent
        : renderMessageForFormat(
            fetchResult.text || fetchResult.rawContent,
            format,
          )
      : format === 'text'
        ? cleanFetchedText(fetchResult.text)
        : cleanFetchedMarkdown(fetchResult.markdown);
  if (!fetchResult.truncated) return content;
  return format === 'html'
    ? `${content}\n<!-- [..content truncated..] -->`
    : `${content}\n\n[..content truncated..]`;
}

/**
 * Minimal conditional status header: only keys that change the caller's
 * next decision survive (title, final_url when it differs from the
 * requested URL, truncated, non-empty quality signals). Everything else
 * lives in `ctx.metadata` for the UI channel.
 */
function statusHeader(meta: Record<string, unknown>): string {
  const entries = Object.entries(meta).filter(
    ([, value]) =>
      value !== undefined && !(Array.isArray(value) && value.length === 0),
  );
  if (entries.length === 0) return '';
  return frontmatter(Object.fromEntries(entries));
}

export function createWebfetchTool(
  _pluginCtx: PluginInput,
  options: SmartfetchOptions = {},
): ToolDefinition {
  const binaryDir =
    options.binaryDir || path.join(os.tmpdir(), 'opencode-smartfetch');

  return tool({
    description: WEBFETCH_DESCRIPTION,
    args: ARGS,
    async execute(rawArgs, ctx) {
      const args = z.object(ARGS).parse(rawArgs);
      const normalized = normalizeUrl(args.url);
      const url = new URL(normalized.url);
      const cacheOptions = {
        format: args.format,
        save_binary: args.save_binary,
      };
      const cacheKey = buildCacheKey(args.url, cacheOptions);
      const llmsCacheKey = buildCacheKey(args.url, {
        ...cacheOptions,
        format: undefined,
      });
      // llms.txt is plain text, not the raw page: probing only makes sense
      // when the caller asked for extracted markdown/text output.
      const shouldProbeLlmsTxt = args.format !== 'html' && isDocsLikeUrl(url);
      const permissionPatterns = buildPermissionPatterns(
        normalized,
        shouldProbeLlmsTxt,
      );

      await ctx.ask({
        permission: 'webfetch',
        patterns: permissionPatterns,
        always: permissionPatterns,
        metadata: {
          url: normalized.url,
          requested_url: args.url,
          fallback_url: normalized.fallbackUrl,
          llms_probe_enabled: shouldProbeLlmsTxt,
          format: args.format,
        },
      });

      const timeoutMs = Math.min(
        (args.timeout ?? DEFAULT_TIMEOUT_SECONDS) * 1000,
        MAX_TIMEOUT_SECONDS * 1000,
      );
      return runWithScopedTimeout(ctx.abort, timeoutMs, async (signal) => {
        signal.throwIfAborted();
        const cachedLlms = shouldProbeLlmsTxt
          ? lookup(llmsCacheKey)
          : undefined;
        const cached = cachedLlms?.fresh ? cachedLlms : lookup(cacheKey);
        let fetchResult = cached.fresh ? cached.entry : undefined;
        if (!cached.fresh) {
          let llmsProbeError: string | undefined;

          if (shouldProbeLlmsTxt) {
            const fallbackOrigin = normalized.fallbackUrl
              ? new URL(normalized.fallbackUrl).origin
              : undefined;
            const probeTimeoutMs = Math.max(
              1,
              Math.min(MAX_LLMS_PROBE_TIMEOUT_MS, timeoutMs),
            );
            const llms = await runWithScopedTimeout(
              signal,
              probeTimeoutMs,
              (probeSignal) => probeLlmsText(url, probeSignal, fallbackOrigin),
            );
            if (llms && 'text' in llms) {
              const llmsHeaders = llms.headers || {};
              const text = trimBlankRuns(llms.text);
              fetchResult = {
                finalUrl: llms.url,
                statusCode: llms.statusCode,
                contentType: llmsHeaders.contentType || 'text/plain',
                charset: llmsHeaders.charset,
                etag: llmsHeaders.etag,
                lastModified: llmsHeaders.lastModified,
                contentLength: llmsHeaders.contentLength,
                filename: llmsHeaders.filename,
                canonicalUrl: inferCanonicalUrlFromText(text, llms.url),
                headings: extractHeadingsFromMarkdown(text),
                title: undefined,
                rawContent: text,
                markdown: text,
                text,
                html: text,
                extractedMain: false,
                usedLlmsTxt: true,
                sourceKind: 'llms_txt',
                upgradedToHttps: !!llms.upgradedToHttps,
                redirectChain: llms.redirectChain || [],
                truncated: !!llms.truncated,
                wordCount: wordCount(text),
                qualitySignals: detectQualitySignals({
                  text,
                  markdown: text,
                  rawContent: text,
                  wordCount: wordCount(text),
                  sourceKind: 'llms_txt',
                  extractedMain: false,
                }),
                decodedCharset: llms.decodedCharset,
                decodeFallback: llms.decodeFallback,
                decodeWarning: llms.decodeWarning,
              };
            } else if (llms?.error) {
              llmsProbeError = llms.error;
            }
          }

          if (!fetchResult) {
            const validators = cached.entry
              ? conditionalHeaders(cached.entry)
              : {};
            let { result, upgradedToHttps } = await fetchWithUpgradeFallback(
              normalized,
              signal,
              { Accept: ACCEPT_BY_FORMAT[args.format], ...validators },
            );
            if (
              !('blockedRedirect' in result) &&
              result.response.status === 304 &&
              cached.entry &&
              Object.keys(validators).length > 0
            ) {
              const notModified = result;
              await discard(notModified.response);
              if (notModified.finalUrl === cached.entry.finalUrl) {
                fetchResult = {
                  ...cached.entry,
                  etag:
                    notModified.response.headers.get('etag') ||
                    cached.entry.etag,
                  lastModified:
                    notModified.response.headers.get('last-modified') ||
                    cached.entry.lastModified,
                  redirectChain: notModified.redirectChain,
                  upgradedToHttps,
                };
              } else {
                // A redirect may now identify a different resource: fetch its body.
                ({ result, upgradedToHttps } = await fetchWithUpgradeFallback(
                  normalized,
                  signal,
                  { Accept: ACCEPT_BY_FORMAT[args.format] },
                ));
              }
            }
            if (!fetchResult) {
              if ('blockedRedirect' in result) {
                return renderMessageForFormat(
                  buildRedirectResultMessage(
                    args.url,
                    result.redirectUrl,
                    result.statusCode,
                  ),
                  args.format,
                );
              }

              const { response, finalUrl, redirectChain } = result;
              if (!response.ok) {
                await discard(response);
                throw new Error(
                  `Request failed with status code: ${response.status}${isCloudflareChallenge(response) ? ' (Cloudflare browser challenge; retrying will not help, try another source)' : ''}`,
                );
              }
              const headerMetadata = extractHeaderMetadata(
                response.headers,
                finalUrl,
              );
              const declaredType = headerMetadata.contentType || '';
              const explicitBinary = isBinaryContentType(declaredType);
              const genericBinaryMime = isGenericBinaryMime(declaredType);
              const binaryDownloadLimit = args.save_binary
                ? MAX_RESPONSE_BYTES
                : MAX_BINARY_DOWNLOAD_BYTES;
              const oversizedBinary =
                explicitBinary &&
                !genericBinaryMime &&
                typeof headerMetadata.contentLength === 'number' &&
                headerMetadata.contentLength > binaryDownloadLimit;
              let body = { data: new Uint8Array(), truncated: false };
              if (oversizedBinary) {
                await discard(response);
              } else {
                const readLimit =
                  explicitBinary && !genericBinaryMime
                    ? binaryDownloadLimit
                    : MAX_RESPONSE_BYTES;
                body = await readBodyLimited(response, readLimit);
              }
              const baseFetch = {
                finalUrl,
                statusCode: response.status,
                ...headerMetadata,
                redirectChain,
                upgradedToHttps,
                truncated: body.truncated,
                llmsProbeError,
              };
              const provisionalDecoded =
                !oversizedBinary &&
                (!declaredType ||
                  genericBinaryMime ||
                  /^text\//i.test(declaredType))
                  ? decodeBody(body.data, headerMetadata.charset, declaredType)
                  : undefined;
              const looksHtmlPayload = provisionalDecoded
                ? looksLikeHtmlText(provisionalDecoded.text)
                : false;
              const sniffedImage =
                !declaredType || genericBinaryMime
                  ? detectInlineImageMime(body.data)
                  : undefined;
              let contentType = declaredType;
              if (sniffedImage) {
                contentType = sniffedImage;
              } else if (!contentType) {
                contentType = looksLikeTextBody(body.data)
                  ? looksHtmlPayload
                    ? 'text/html'
                    : 'text/plain'
                  : 'application/octet-stream';
              } else if (
                (genericBinaryMime && looksLikeTextBody(body.data)) ||
                (/^text\/plain(?:;|$)/i.test(contentType) && looksHtmlPayload)
              ) {
                contentType = looksHtmlPayload ? 'text/html' : 'text/plain';
              }
              if (isBinaryContentType(contentType)) {
                const binaryTooLarge =
                  oversizedBinary ||
                  body.truncated ||
                  (typeof headerMetadata.contentLength === 'number' &&
                    headerMetadata.contentLength > binaryDownloadLimit);
                fetchResult = {
                  ...baseFetch,
                  contentType,
                  canonicalUrl: finalUrl,
                  binary: true,
                  binaryKind: getBinaryKind(contentType),
                  downloadLimitBytes: binaryDownloadLimit,
                  data: binaryTooLarge ? undefined : body.data,
                };
              } else {
                const decoded =
                  provisionalDecoded ||
                  decodeBody(body.data, headerMetadata.charset, contentType);
                const rawText = decoded.text;
                const isHtml = isHtmlLikeContentType(contentType);
                const extracted = isHtml
                  ? await extractFromHtml(
                      rawText,
                      finalUrl,
                      args.format !== 'html',
                    )
                  : (() => {
                      const cleaned = cleanFetchedText(rawText);
                      return {
                        title: undefined,
                        rawContent: cleaned,
                        html: cleaned,
                        text: cleaned,
                        markdown: cleaned,
                        extractedMain: false,
                        canonicalUrl: undefined,
                        headings: [],
                      };
                    })();
                const count = wordCount(extracted.text);
                const sourceKind = isHtml ? 'html' : 'text';
                fetchResult = {
                  ...baseFetch,
                  contentType,
                  canonicalUrl:
                    extracted.canonicalUrl ||
                    inferCanonicalUrlFromText(extracted.markdown, finalUrl) ||
                    finalUrl,
                  headings: extracted.headings?.length
                    ? extracted.headings
                    : extractHeadingsFromMarkdown(extracted.markdown),
                  title: extracted.title,
                  rawContent: extracted.rawContent,
                  markdown: extracted.markdown,
                  text: extracted.text,
                  html: extracted.html,
                  extractedMain: extracted.extractedMain,
                  usedLlmsTxt: false,
                  sourceKind,
                  wordCount: count,
                  qualitySignals: detectQualitySignals({
                    text: extracted.text,
                    markdown: extracted.markdown,
                    rawContent: extracted.rawContent,
                    wordCount: count,
                    sourceKind,
                    extractedMain: extracted.extractedMain,
                  }),
                  decodedCharset: decoded.decodedCharset,
                  decodeFallback: decoded.decodeFallback,
                  decodeWarning: decoded.decodeWarning,
                };
              }
            }
          }
        }
        if (!fetchResult) throw new Error('Fetch produced no result');
        if (!cached.fresh) {
          CACHE.set(
            'usedLlmsTxt' in fetchResult && fetchResult.usedLlmsTxt
              ? llmsCacheKey
              : cacheKey,
            fetchResult,
          );
        }

        ctx.metadata({
          title:
            ('binary' in fetchResult
              ? fetchResult.filename
              : fetchResult.title) || fetchResult.finalUrl,
          metadata: {
            url: fetchResult.finalUrl,
            contentType: fetchResult.contentType,
            truncated: fetchResult.truncated,
          },
        });

        if ('binary' in fetchResult) {
          if (fetchResult.data && args.save_binary) {
            const savedPath = await saveBinary(
              binaryDir,
              fetchResult.data,
              fetchResult.contentType,
              fetchResult.filename,
            );
            return buildBinaryResultMessage(fetchResult, savedPath);
          }
          const message = buildBinaryResultMessage(fetchResult);
          if (!args.save_binary) {
            return `${message} Re-run with save_binary=true to persist it.`;
          }
          // Saving is already on: repeating the request cannot succeed, so
          // state the active limit and point at a smaller source instead.
          return `${message} The active limit is ${MAX_RESPONSE_BYTES} bytes; fetch a smaller or more specific source.`;
        }

        const content = pickContent(fetchResult, args.format);
        const header = statusHeader({
          title: fetchResult.title,
          final_url:
            fetchResult.finalUrl !== url.toString()
              ? fetchResult.finalUrl
              : undefined,
          truncated: fetchResult.truncated || undefined,
          quality_signals: fetchResult.qualitySignals,
        });
        if (args.format === 'html') return content;
        return header ? `${header}${content}` : content;
      });
    },
  });
}
