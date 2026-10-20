/// <reference types="bun-types" />

import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { enableCompanionConfig, runCompanionCommand } from './companion';

describe('enableCompanionConfig', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'companion-cli-test-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('enables companion and keeps existing settings', () => {
    const configPath = join(tmpDir, 'oh-my-opencode-slim.json');
    writeFileSync(
      configPath,
      JSON.stringify({
        preset: 'openai',
        companion: { enabled: false, position: 'top-left' },
      }),
    );

    expect(enableCompanionConfig(configPath).success).toBe(true);

    const saved = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(saved.preset).toBe('openai');
    expect(saved.companion).toEqual({ enabled: true, position: 'top-left' });
  });

  test('preserves comments in jsonc configs', () => {
    const configPath = join(tmpDir, 'oh-my-opencode-slim.jsonc');
    writeFileSync(
      configPath,
      '{\n  // keep this comment\n  "preset": "openai"\n}\n',
    );

    expect(enableCompanionConfig(configPath).success).toBe(true);

    const savedText = readFileSync(configPath, 'utf-8');
    expect(savedText).toContain('// keep this comment');
    expect(savedText).toContain('"companion"');
  });
});

describe('runCompanionCommand', () => {
  let tmpDir: string;
  const originalConfigDir = process.env.OPENCODE_CONFIG_DIR;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'companion-cli-test-'));
    process.env.OPENCODE_CONFIG_DIR = tmpDir;
    spyOn(console, 'log').mockImplementation(() => {});
    spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    if (originalConfigDir === undefined) delete process.env.OPENCODE_CONFIG_DIR;
    else process.env.OPENCODE_CONFIG_DIR = originalConfigDir;
    rmSync(tmpDir, { recursive: true, force: true });
    (console.log as ReturnType<typeof spyOn>).mockRestore();
    (console.error as ReturnType<typeof spyOn>).mockRestore();
  });

  test('requires the plugin config to exist first', async () => {
    expect(await runCompanionCommand(['install', '--dry-run'])).toBe(1);
    expect(existsSync(join(tmpDir, 'oh-my-opencode-slim.json'))).toBe(false);
  });

  test('dry run leaves the config untouched', async () => {
    const configPath = join(tmpDir, 'oh-my-opencode-slim.json');
    writeFileSync(configPath, '{"preset":"openai"}');

    const code = await runCompanionCommand(['install', '--dry-run']);

    // Unsupported platforms fail before the dry-run step; both leave the file.
    expect([0, 1]).toContain(code);
    expect(readFileSync(configPath, 'utf-8')).toBe('{"preset":"openai"}');
  });

  test('rejects unknown subcommands and options', async () => {
    expect(await runCompanionCommand(['remove'])).toBe(1);
    expect(await runCompanionCommand(['install', '--force'])).toBe(1);
  });
});
