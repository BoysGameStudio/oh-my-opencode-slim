import { describe, expect, test } from 'bun:test';
import {
  createAgents,
  projectAgentRuntimeState,
  resolvePrimaryModelValue,
} from '../agents';
import type { ModelEntry } from '../config/schema';
import { RuntimeConfig } from './runtime';

describe('model array resolution', () => {
  describe('resolvePrimaryModelValue', () => {
    test('extracts first model from object model array', () => {
      const modelArray: ModelEntry[] = [
        { id: 'opencode/big-pickle', variant: 'high' },
        { id: 'iflowcn/qwen3-235b-a22b-thinking-2507', variant: 'high' },
      ];

      expect(resolvePrimaryModelValue(modelArray)).toBe('opencode/big-pickle');
    });

    test('extracts first model from string array', () => {
      const modelArray = [
        'github-copilot/claude-opus-4.6',
        'zai-coding-plan/glm-5',
      ];

      expect(resolvePrimaryModelValue(modelArray)).toBe(
        'github-copilot/claude-opus-4.6',
      );
    });

    test('preserves direct string model value', () => {
      expect(resolvePrimaryModelValue('openai/gpt-5')).toBe('openai/gpt-5');
    });

    test('returns undefined for empty array or non-model values', () => {
      expect(resolvePrimaryModelValue([])).toBeUndefined();
      expect(resolvePrimaryModelValue(null)).toBeUndefined();
      expect(resolvePrimaryModelValue(undefined)).toBeUndefined();
      expect(resolvePrimaryModelValue(123)).toBeUndefined();
    });
  });

  describe('projectAgentRuntimeState array-primary pass', () => {
    test('resolves first model and variant from configured fallback chain', () => {
      const runtime = RuntimeConfig.createDetached(
        '/tmp/test-model-resolution-1',
        {
          agents: {
            oracle: {
              model: [
                { id: 'opencode/big-pickle', variant: 'high' },
                {
                  id: 'iflowcn/qwen3-235b-a22b-thinking-2507',
                  variant: 'high',
                },
              ],
            },
          },
        } as unknown as Parameters<typeof RuntimeConfig.createDetached>[1],
      );

      const agentDefs = createAgents(runtime);
      const agentConfigs: Record<string, Record<string, unknown>> = {
        oracle: {},
      };

      const { profiles, projection } = projectAgentRuntimeState({
        runtime,
        agentDefs,
        agentConfigs,
      });

      expect(agentConfigs.oracle.model).toBe('opencode/big-pickle');
      expect(agentConfigs.oracle.variant).toBe('high');
      expect(profiles.oracle.sidebarModel).toBe('opencode/big-pickle');
      expect(profiles.oracle.sidebarVariant).toBe('high');
      expect(projection.agentModels.oracle).toBe('opencode/big-pickle');
      expect(projection.agentVariants.oracle).toBe('high');
    });

    test('preserves user-selected host model over fallback chain', () => {
      const runtime = RuntimeConfig.createDetached(
        '/tmp/test-model-resolution-2',
        {
          agents: {
            oracle: {
              model: [
                { id: 'fallback/first', variant: 'high' },
                { id: 'fallback/second', variant: 'high' },
              ],
            },
          },
        } as unknown as Parameters<typeof RuntimeConfig.createDetached>[1],
      );

      const agentDefs = createAgents(runtime);
      const agentConfigs: Record<string, Record<string, unknown>> = {
        oracle: { model: 'user-chosen/pinned-model', variant: 'custom' },
      };

      const { profiles, projection } = projectAgentRuntimeState({
        runtime,
        agentDefs,
        agentConfigs,
      });

      expect(agentConfigs.oracle.model).toBe('user-chosen/pinned-model');
      expect(agentConfigs.oracle.variant).toBe('custom');
      expect(profiles.oracle.sidebarModel).toBe('user-chosen/pinned-model');
      expect(projection.agentModels.oracle).toBe('user-chosen/pinned-model');
    });
  });
});
