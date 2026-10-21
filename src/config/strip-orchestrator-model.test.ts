import { describe, expect, test } from 'bun:test';
import { createAgents, projectAgentRuntimeState } from '../agents';
import { RuntimeConfig } from './runtime';
import { applyOrchestratorModelConfig } from './strip-orchestrator-model';

describe('applyOrchestratorModelConfig', () => {
  test('preserves a runtime /model selection by removing configured model and variant', () => {
    const agents = {
      orchestrator: { model: 'openai/gpt-5', variant: 'high' },
    };

    applyOrchestratorModelConfig({
      agents,
      enabled: true,
      presets: undefined,
      configPreset: undefined,
      runtimePreset: null,
    });

    expect(agents.orchestrator).toEqual({});
  });

  test('retains model and variant when disabled or a selected preset sets a model', () => {
    const disabled = {
      orchestrator: { model: 'openai/gpt-5', variant: 'high' },
    };
    const presetOverride = {
      orchestrator: { model: 'openai/gpt-5', variant: 'high' },
    };

    applyOrchestratorModelConfig({
      agents: disabled,
      enabled: false,
      presets: undefined,
      configPreset: undefined,
      runtimePreset: null,
    });
    applyOrchestratorModelConfig({
      agents: presetOverride,
      enabled: true,
      presets: {
        file: { orchestrator: { model: 'anthropic/claude-sonnet-4' } },
      },
      configPreset: 'file',
      runtimePreset: null,
    });

    expect(disabled.orchestrator).toEqual({
      model: 'openai/gpt-5',
      variant: 'high',
    });
    expect(presetOverride.orchestrator).toEqual({
      model: 'openai/gpt-5',
      variant: 'high',
    });
  });

  test('uses the runtime preset before the file preset after /preset changes', () => {
    const agents = {
      orchestrator: { model: 'openai/gpt-5', variant: 'high' },
    };

    applyOrchestratorModelConfig({
      agents,
      enabled: true,
      presets: {
        file: { orchestrator: { model: 'anthropic/claude-sonnet-4' } },
        runtime: { explorer: { model: 'openai/gpt-5-mini' } },
      },
      configPreset: 'file',
      runtimePreset: 'runtime',
    });

    expect(agents.orchestrator).toEqual({});
  });

  test('skips stripping when the active runtime preset sets the orchestrator model', () => {
    const agents = {
      orchestrator: { model: 'openai/gpt-5', variant: 'high' },
    };

    applyOrchestratorModelConfig({
      agents,
      enabled: true,
      presets: {
        file: { explorer: { model: 'openai/gpt-5-mini' } },
        runtime: { orchestrator: { model: 'anthropic/claude-sonnet-4' } },
      },
      configPreset: 'file',
      runtimePreset: 'runtime',
    });

    expect(agents.orchestrator).toEqual({
      model: 'openai/gpt-5',
      variant: 'high',
    });
  });

  test('leaves a primitive orchestrator config unchanged', () => {
    const agents: Record<string, unknown> = { orchestrator: 'invalid' };

    applyOrchestratorModelConfig({
      agents,
      enabled: true,
      presets: undefined,
      configPreset: undefined,
      runtimePreset: null,
    });

    expect(agents.orchestrator).toBe('invalid');
  });

  test('allows TUI state to capture the configured model and variant before stripping', () => {
    const runtime = RuntimeConfig.createDetached(
      '/tmp/test-strip-orchestrator',
      {
        stripOrchestratorModel: true,
      } as unknown as Parameters<typeof RuntimeConfig.createDetached>[1],
    );

    const agentDefs = createAgents(runtime);
    const agentConfigs: Record<string, Record<string, unknown>> = {
      orchestrator: { model: 'openai/gpt-5', variant: 'high' },
    };

    const { projection } = projectAgentRuntimeState({
      runtime,
      agentDefs,
      agentConfigs,
    });

    expect(projection.agentModels.orchestrator).toBe('openai/gpt-5');
    expect(projection.agentVariants.orchestrator).toBe('high');
    expect(agentConfigs.orchestrator).toEqual({});
  });
});
