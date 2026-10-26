import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  createPresetCommand,
  PRESET_COMMAND_DESCRIPTION,
  PRESET_COMMAND_NAME,
  presetCommandFeedback,
} from './preset-command';

let tempDir: string;
let previousConfigDir: string | undefined;
let previousXdgConfigHome: string | undefined;
let previousPresetEnv: string | undefined;

function userConfigPath(): string {
  return path.join(
    tempDir,
    'xdg-config',
    'opencode',
    'oh-my-opencode-slim.json',
  );
}

function writeUserConfig(config: Record<string, unknown>): void {
  fs.writeFileSync(userConfigPath(), JSON.stringify(config));
}

beforeEach(() => {
  previousConfigDir = process.env.OPENCODE_CONFIG_DIR;
  previousXdgConfigHome = process.env.XDG_CONFIG_HOME;
  previousPresetEnv = process.env.OH_MY_OPENCODE_SLIM_PRESET;
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omos-preset-command-'));
  process.env.XDG_CONFIG_HOME = path.join(tempDir, 'xdg-config');
  delete process.env.OPENCODE_CONFIG_DIR;
  delete process.env.OH_MY_OPENCODE_SLIM_PRESET;
  fs.mkdirSync(path.dirname(userConfigPath()), { recursive: true });
  writeUserConfig({});
});

afterEach(() => {
  if (previousConfigDir === undefined) delete process.env.OPENCODE_CONFIG_DIR;
  else process.env.OPENCODE_CONFIG_DIR = previousConfigDir;
  if (previousXdgConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = previousXdgConfigHome;
  if (previousPresetEnv === undefined)
    delete process.env.OH_MY_OPENCODE_SLIM_PRESET;
  else process.env.OH_MY_OPENCODE_SLIM_PRESET = previousPresetEnv;
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('presetCommandFeedback', () => {
  test('no arguments lists user and project presets with the active one', () => {
    writeUserConfig({
      preset: 'fast',
      presets: { fast: { fixer: { model: 'test/fast' } } },
    });
    const project = path.join(tempDir, 'project');
    fs.mkdirSync(path.join(project, '.opencode'), { recursive: true });
    fs.writeFileSync(
      path.join(project, '.opencode', 'oh-my-opencode-slim.json'),
      JSON.stringify({ presets: { deep: { fixer: { model: 'test/deep' } } } }),
    );

    const message = presetCommandFeedback({
      directory: project,
      arguments: '  ',
    });

    expect(message).toContain('Available presets: deep, fast.');
    expect(message).toContain('Active preset: fast.');
    expect(message).toContain('Run /preset <name> to apply one.');
  });

  test('no presets configured points at the config file', () => {
    expect(presetCommandFeedback({ directory: tempDir, arguments: '' })).toBe(
      'No presets configured. Define presets in oh-my-opencode-slim.jsonc.',
    );
  });

  test('a valid name persists it and reports the next conversation/reload', () => {
    writeUserConfig({
      presets: { fast: { fixer: { model: 'test/fast' } } },
    });

    const message = presetCommandFeedback({
      directory: tempDir,
      arguments: ' fast ',
    });

    expect(message).toContain(
      'Applied preset "fast". It takes effect on the next conversation or reload.',
    );
    expect(message).toContain('fixer');
    expect(JSON.parse(fs.readFileSync(userConfigPath(), 'utf-8')).preset).toBe(
      'fast',
    );
  });

  test('an unknown name reports the error with the valid options', () => {
    writeUserConfig({
      presets: { fast: { fixer: { model: 'test/fast' } } },
    });

    const message = presetCommandFeedback({
      directory: tempDir,
      arguments: 'missing',
    });

    expect(message).toContain('Preset "missing" not found.');
    expect(message).toContain('Available presets: fast');
  });
});

describe('createPresetCommand', () => {
  test('exposes the server command identity', () => {
    const command = createPresetCommand(tempDir);
    expect(command.name).toBe(PRESET_COMMAND_NAME);
    expect(command.description).toBe(PRESET_COMMAND_DESCRIPTION);
  });

  test('rejects with the feedback instead of starting a turn', async () => {
    writeUserConfig({
      presets: { fast: { fixer: { model: 'test/fast' } } },
    });

    await expect(
      createPresetCommand(tempDir).execute({
        sessionID: 'ses_preset',
        prompt: { text: 'fast' },
      }),
    ).rejects.toThrow(
      'Applied preset "fast". It takes effect on the next conversation or reload.',
    );
  });
});
