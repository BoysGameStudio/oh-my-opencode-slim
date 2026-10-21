import { describe, expect, test } from 'bun:test';
import {
  COUNCIL_COMPACTION_EXCEPTION,
  createCouncilAgent,
  ensureCouncilCompactionException,
  ensureCouncilSynthesisReinforcement,
} from './council';
import { createSynthesisOnlyPermission } from './permissions';

const COMPACTION_EXCEPTION =
  'if the host asks you to produce a session checkpoint or compaction summary in a specific template, follow that template exactly and do not use the council report format';

function councilPrompt(...args: Parameters<typeof createCouncilAgent>): string {
  const prompt = createCouncilAgent(...args).config.prompt;
  expect(prompt).toBeDefined();
  return prompt as string;
}

/** Assembly-layer chain: what agents/index.ts and registry.ts apply to the
 * FINAL effective council prompt (after resolvePrompt and host merge). */
function reinforced(prompt: string): string {
  return ensureCouncilCompactionException(
    ensureCouncilSynthesisReinforcement(prompt),
  );
}

describe('createCouncilAgent', () => {
  test('synthesis permission denies nested dispatch', () => {
    const permission = createCouncilAgent('provider/model').config
      .permission as Record<string, unknown>;
    expect(permission.task).toBe('deny');
  });

  // Policy-source drift guard: any future allow-entry addition at the
  // createSynthesisOnlyPermission() factory trips here before it can reach the
  // request level. task tools (task_status etc.) are denied by the '*' wildcard
  // at factory level; the per-tool control denies are injected centrally by
  // applyDefaultPermissions at assembled-agent level (pinned in
  // src/agents/index.test.ts), so we deliberately do NOT add a redundant
  // per-key entry to the factory map.
  test('synthesis-only permission factory is wildcard-deny with no allow entries', () => {
    const permission = createSynthesisOnlyPermission();
    expect(permission['*']).toBe('deny');
    expect(Object.values(permission).every((value) => value === 'deny')).toBe(
      true,
    );
  });

  test('harness assembly keeps the agent tool-less and its prompt untouched', () => {
    // Seat text arrives by host-side attachment (tool.execute.before
    // resolver); the synthesizer is fed purely from its context and carries
    // no tool menu in its prompt.
    const agent = createCouncilAgent('provider/model');
    const permission = agent.config.permission as Record<string, unknown>;
    expect(permission['*']).toBe('deny');
    expect((agent.config as { tools?: unknown }).tools).toBeUndefined();
    const prompt = councilPrompt('provider/model');
    expect(prompt).toContain(
      'You synthesize purely from the councillor responses provided in your context.',
    );
    expect(prompt).not.toContain('**Tools**:');
    expect(prompt).not.toContain('You have NO tools');
    expect(prompt).not.toContain('Do not read, glob, grep');
    expect(prompt).toContain(
      'synthesize them into a structured council report',
    );
    expect(prompt).toContain(
      'The orchestrator handles dispatch and provides the councillor results.',
    );
    expect(prompt).not.toContain('You do NOT dispatch');
    // Seat names, not model labels — the assembly headers use record.agent.
    expect(prompt).toContain(
      'the seat name, e.g. "alpha", not the model label',
    );
  });

  test('factory emits the base prompt without inline reinforcement', () => {
    const prompt = councilPrompt('test/model');
    expect(prompt).toContain('## Council Response');
    expect(prompt).toContain('## Per-Councillor Details');
    expect(prompt).toContain('## Council Summary');
    // Reinforcement is applied at the assembly layer, not in the factory.
    expect(prompt).not.toContain('You MUST follow the Synthesis Process');
  });
});

describe('ensureCouncilSynthesisReinforcement (assembly layer)', () => {
  test('default base already carries the report format and is not reinforced', () => {
    const base = councilPrompt('test/model');
    const prompt = reinforced(base);
    // Single-track: the base prompt's own Required Output Format satisfies
    // the check byte-identically — no pointer, no fallback appended.
    expect(prompt).toBe(base);
    expect(prompt).not.toContain('You MUST produce: ## Council Response');
    expect(prompt).not.toContain('You MUST follow the Synthesis Process');
    // The exception appears exactly once (the base prompt's own copy); the
    // deleted pointer used to be its second carrier.
    const occurrences = prompt.split(COMPACTION_EXCEPTION).length - 1;
    expect(occurrences).toBe(1);
  });

  test('custom prompt override retains the required report format', () => {
    // Simulate the real assembly path: resolvePrompt replaced the generated
    // content with an override that dropped the format sections.
    const prompt = reinforced('Custom council prompt with no format rules.');
    expect(prompt).toContain('You MUST produce: ## Council Response');
    expect(prompt).toContain('## Per-Councillor Details');
    expect(prompt).toContain('## Council Summary');
    expect(prompt).toContain(COMPACTION_EXCEPTION);
  });

  test('override carrying its own report format is left byte-identical', () => {
    const override = 'Custom prompt with its own ## Council Response section.';
    const prompt = reinforced(override);
    // No reinforcement: no fallback is appended, and no pointer exists.
    expect(prompt).toBe(`${override}\n\n${COUNCIL_COMPACTION_EXCEPTION}`);
    expect(prompt).not.toContain('You MUST produce: ## Council Response');
    expect(prompt).not.toContain('You MUST follow the Synthesis Process');
  });

  test('is idempotent', () => {
    const once = reinforced('Custom council prompt with no format rules.');
    const twice = reinforced(once);
    expect(once).toBe(twice);
    expect(once.split('You MUST produce: ## Council Response').length - 1).toBe(
      1,
    );
  });

  test('ensureCouncilCompactionException is idempotent', () => {
    const once = ensureCouncilCompactionException('custom council prompt');
    const twice = ensureCouncilCompactionException(once);
    expect(once).toBe(twice);
    expect(once.split(COUNCIL_COMPACTION_EXCEPTION).length - 1).toBe(1);
  });
});
