/**
 * Server-side `/preset` for non-TUI clients (issue #1474).
 *
 * Apply-only: create/edit/delete stay in the TUI preset manager. The switch
 * persists the preset name to the user config; the running session keeps its
 * existing agent models, so the result says it applies on the next
 * conversation or reload.
 *
 * A preset switch is a config mutation, not a turn. v2 has no display-only
 * message channel — a synthetic inbox item is delivered into the model context
 * on the next turn — so the result travels through the command error channel
 * the client already renders. Nothing runs and nothing enters the context.
 */
import { loadPluginConfig } from '../config/loader';
import {
  getAllConfiguredPresets,
  switchPresetOnDisk,
} from '../tools/preset-switch';
import type { V2CommandDefinition } from './types';

export const PRESET_COMMAND_NAME = 'preset';
export const PRESET_COMMAND_DESCRIPTION =
  'List or apply a preset (applies on the next conversation or reload)';

export interface PresetCommandFeedbackInput {
  directory: string;
  arguments: string;
  hostFlavor?: string;
}

/** User-facing result of one `/preset` invocation. Never throws. */
export function presetCommandFeedback({
  directory,
  arguments: rawArguments,
  hostFlavor = 'v2',
}: PresetCommandFeedbackInput): string {
  const config = loadPluginConfig(directory, { silent: true, hostFlavor });
  const requested = rawArguments.trim();

  if (!requested) {
    const names = [
      ...new Set([
        ...Object.keys(getAllConfiguredPresets(directory, hostFlavor)),
        ...Object.keys(config.presets ?? {}),
      ]),
    ].sort((a, b) => a.localeCompare(b));
    if (names.length === 0) {
      return 'No presets configured. Define presets in oh-my-opencode-slim.jsonc.';
    }
    const active = config.preset ? ` Active preset: ${config.preset}.` : '';
    return `Available presets: ${names.join(', ')}.${active} Run /preset <name> to apply one.`;
  }

  const result = switchPresetOnDisk(directory, requested, config, {
    hostFlavor,
  });
  if (!result.ok) return result.message;
  const summary =
    result.summary.length > 0 ? ` ${result.summary.join('; ')}` : '';
  return `Applied preset "${result.presetName}". It takes effect on the next conversation or reload.${summary}`;
}

/**
 * The v2 command definition. `execute` deliberately rejects with its feedback:
 * it is the only surface a non-TUI client renders without creating a message
 * or waking a turn.
 */
export function createPresetCommand(directory: string): V2CommandDefinition {
  return {
    name: PRESET_COMMAND_NAME,
    description: PRESET_COMMAND_DESCRIPTION,
    execute: async (input) => {
      throw new Error(
        presetCommandFeedback({
          directory,
          arguments: input?.prompt?.text ?? '',
        }),
      );
    },
  };
}
