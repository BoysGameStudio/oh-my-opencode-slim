/**
 * Build identity — generated at build time by scripts/gen-build-info.ts
 * (first step of `bun run build`); do not edit by hand.
 *
 * Logging-only — never enters prompt payloads or transforms.
 */

export const BUILD_VERSION = '3.0.6-workbench.execute.1';
export const BUILD_TIME = '2026-10-28T12:18:48.762Z';

/** Plugin build identity for diagnostics logs. */
export function getBuildInfo(): { version: string; buildTime: string } {
  return { version: BUILD_VERSION, buildTime: BUILD_TIME };
}
