/**
 * #1582: host-config declarations that opt built-in subagents out of the
 * v2 runtime removal. Exact-name matching; the plugin's own `explorer` is
 * never a target.
 */
import { describe, expect, test } from 'bun:test';
import { resolveDeclaredBuiltinAgents } from './setup';

describe('resolveDeclaredBuiltinAgents', () => {
  test('declared via the v2 agents key opts out', () => {
    expect([
      ...resolveDeclaredBuiltinAgents({
        agents: { general: { model: 'x/y' } },
      }),
    ]).toEqual(['general']);
  });

  test('declared via the legacy agent key opts out', () => {
    expect([
      ...resolveDeclaredBuiltinAgents({ agent: { explore: { model: 'x/y' } } }),
    ]).toEqual(['explore']);
  });

  test('explicit disabled:false still counts as declared', () => {
    expect([
      ...resolveDeclaredBuiltinAgents({
        agents: { general: { disabled: false } },
      }),
    ]).toEqual(['general']);
  });

  test('self-disabling entries do not protect the built-in', () => {
    expect([
      ...resolveDeclaredBuiltinAgents({
        agents: { general: { disabled: true } },
        agent: { explore: { disable: true } },
      }),
    ]).toEqual([]);
  });

  test('non-record declared values do not protect the built-in', () => {
    expect([
      ...resolveDeclaredBuiltinAgents({ agents: { general: 'x' } }),
    ]).toEqual([]);
  });

  test('undeclared built-ins stay removable', () => {
    expect(resolveDeclaredBuiltinAgents({}).size).toBe(0);
    expect(
      resolveDeclaredBuiltinAgents({ agents: { explorer: {} } }).size,
    ).toBe(0);
  });
});
