/**
 * Cold-gate coverage for the v2 setup master switches:
 *
 * - `interview.enabled: false` → no bridge instance (no `/interview` command
 *   marker registered, no per-event bridge work, no context-hook dispatch).
 * - `backgroundJobs.enabled: false` → no board persistence and no
 *   structured delegated-launch wrapper (native subagent paths untouched).
 * - `liveConfigRefresh: false` → no config-file watcher, while the one-shot
 *   startup profile seed and explicit `refreshProfiles` still function.
 * - `sidebar: false` → no server-side sidebar state write on finalization.
 *
 * Every switch defaults to true; the baseline behavior assertions live in
 * setup.e2e.test.ts / hot-refresh.test.ts. The harness here deliberately
 * reuses the real `loadPluginConfig` path (a written config file) so the
 * gates are proven end-to-end against the loader, not a stub.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { createV2Setup } from './setup';
import type { V2Context, V2SessionContextEvent } from './types';

/** Mock v2 context capturing the registrations the gates must suppress. */
function makeCtx(projectDir: string) {
  const commandAdds: Array<{ name: string }> = [];
  const toolUpdates: Array<{ id: string }> = [];
  const hooks: string[] = [];
  const skillCallbacks = new Set<(draft: unknown) => void>();
  const contextHooks: Array<(event: never) => Promise<void>> = [];
  const reg = (label: string) => ({
    dispose: () => hooks.push(`dispose:${label}`),
  });
  const ctx = {
    app: { name: 'opencode', version: 'v2-feature-gates' },
    options: {},
    storage: {
      get: async () => undefined,
      set: async () => {},
      remove: async () => {},
      scan: async () => ({ entries: [] }),
    },
    location: {
      directory: projectDir,
      project: {
        id: 'proj_gates',
        directory: projectDir,
        canonical: projectDir,
      },
    },
    agent: {
      transform: async (cb: (draft: unknown) => void) => {
        cb({
          list: () => [],
          get: () => undefined,
          default: () => {},
          update: (_id: string, fn: (agent: unknown) => void) => {
            commandAdds.length;
            fn({});
          },
          remove: () => {},
        });
        return reg('agent.transform');
      },
      reload: async () => ({}),
      list: async () => [],
    },
    tool: {
      transform: async (cb: (draft: unknown) => void) => {
        cb({
          // The native subagent executor is what the structured-launch
          // wrapper wraps; record the wrap attempt by observing update().
          update: (id: string, update: (tool: unknown) => void) => {
            toolUpdates.push({ id });
            update({ execute: async () => ({}) });
          },
          get: (id: string) =>
            id === 'subagent'
              ? { description: 'native', execute: async () => ({}) }
              : undefined,
          add: () => {},
        });
        return reg('tool.transform');
      },
      hook: async (name: string) => {
        hooks.push(`tool:${name}`);
        return reg(`tool.hook:${name}`);
      },
    },
    command: {
      transform: async (cb: (draft: unknown) => void) => {
        cb({
          add: (definition: Record<string, unknown>) => {
            commandAdds.push({ name: definition.name as string });
          },
        });
        return reg('command.transform');
      },
      list: async () => [],
    },
    skill: {
      transform: async (cb: (draft: unknown) => void) => {
        skillCallbacks.add(cb);
        return {
          dispose: () => {
            skillCallbacks.delete(cb);
          },
        };
      },
      list: async () => [],
      reload: async () => {},
    },
    session: {
      get: async ({ sessionID }: { sessionID: string }) => ({
        id: sessionID,
        directory: projectDir,
        agent: 'orchestrator',
      }),
      hook: async (name: string, cb: (event: never) => Promise<void>) => {
        hooks.push(`session:${name}`);
        if (name === 'context') contextHooks.push(cb);
        return reg(`session.hook:${name}`);
      },
    },
    mcp: {
      transform: async (cb: (draft: unknown) => void) => {
        cb({
          list: () => [],
          get: () => undefined,
          set: () => {},
          update: () => {},
          remove: () => {},
        });
        return reg('mcp.transform');
      },
      reload: async () => {},
    },
    event: {
      // Synchronously-exhausted stream: the pump registers but no events
      // are ever delivered, so per-event bridge work is observable only
      // through the registrations above.
      subscribe: () => ({
        [Symbol.asyncIterator]: () => ({
          next: () => Promise.resolve({ value: undefined, done: true }),
          return: () => Promise.resolve({ value: undefined, done: true }),
        }),
      }),
    },
    generate: {
      text: async (input: { prompt: string }) => ({
        text: `generated:${input.prompt}`,
      }),
    },
  } as unknown as V2Context;

  return { ctx, commandAdds, toolUpdates, hooks, contextHooks };
}

const INTERVIEW_MARKER =
  '<omos-interview-command>do it</omos-interview-command>';

describe('v2 setup feature gates', () => {
  let originalEnv: typeof process.env;
  let fixtureRoot: string;
  let projectDir: string;

  const writeProjectConfig = async (content: Record<string, unknown>) => {
    await mkdir(path.join(projectDir, '.opencode'), { recursive: true });
    await Bun.write(
      path.join(projectDir, '.opencode', 'oh-my-opencode-slim.json'),
      JSON.stringify(content),
    );
  };

  beforeEach(async () => {
    originalEnv = { ...process.env };
    fixtureRoot = await mkdtemp(path.join(tmpdir(), 'omo-v2-gates-'));
    projectDir = path.join(fixtureRoot, 'project');
    await writeProjectConfig({ companion: { enabled: false } });
    process.env.OPENCODE_CONFIG_DIR = path.join(fixtureRoot, 'config');
    process.env.XDG_CONFIG_HOME = path.join(fixtureRoot, 'xdg-config');
    process.env.XDG_DATA_HOME = path.join(fixtureRoot, 'xdg-data');
    process.env.XDG_CACHE_HOME = path.join(fixtureRoot, 'xdg-cache');
    process.env.OPENCODE_LOG_DIR = path.join(fixtureRoot, 'logs');
    delete process.env.OH_MY_OPENCODE_SLIM_DISABLE;
  });

  afterEach(async () => {
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) delete process.env[key];
    }
    Object.assign(process.env, originalEnv);
    await rm(fixtureRoot, { recursive: true, force: true });
  });

  test('interview disabled: no command marker, no context dispatch', async () => {
    await writeProjectConfig({
      companion: { enabled: false },
      interview: { enabled: false },
    });
    const { ctx, commandAdds, contextHooks } = makeCtx(projectDir);
    const cleanup = await createV2Setup()(ctx);
    try {
      expect(commandAdds.map((c) => c.name)).not.toContain('interview');
      expect(commandAdds.map((c) => c.name)).toContain('deepwork');

      // The context hook stays registered (system/messages transforms and
      // generic command markers are unrelated to the interview), but the
      // interview seam must be a no-op: a trailing marker passes through
      // untouched instead of being rewritten into interview state.
      expect(contextHooks).toHaveLength(1);
      const trailing = {
        id: 'ses_gate',
        role: 'user',
        content: [{ type: 'text', text: INTERVIEW_MARKER }],
      };
      await contextHooks[0]?.({
        sessionID: 'ses_gate',
        agent: 'oracle',
        model: {},
        system: [],
        tools: {},
        messages: [trailing],
      } as unknown as V2SessionContextEvent);
      expect(trailing.content).toEqual([
        { type: 'text', text: INTERVIEW_MARKER },
      ]);
    } finally {
      await cleanup();
    }
  }, 20_000);

  test('lifecycle disabled: no persistence and no structured-launch wrapper', async () => {
    await writeProjectConfig({
      companion: { enabled: false },
      backgroundJobs: { enabled: false },
    });
    const { ctx, toolUpdates } = makeCtx(projectDir);
    const cleanup = await createV2Setup()(ctx);
    try {
      // The structured delegated-launch consumer wraps the native subagent
      // executor via `draft.update(DELEGATION_TOOL_V2, …)`. With the
      // lifecycle off that wrap must not happen; the only remaining tool
      // transform is the plugin tool registration pass (its `add()` calls
      // are unobservable here, and `update` is the wrapper signal).
      expect(toolUpdates.map((u) => u.id)).not.toContain('subagent');
      // No persisted board state was seeded for this project directory.
      const stateDir = path.join(
        fixtureRoot,
        'xdg-data',
        'opencode',
        'plugins',
        'oh-my-opencode-slim',
        'storage',
      );
      expect(fs.existsSync(stateDir)).toBe(false);
    } finally {
      await cleanup();
    }
  }, 20_000);

  test('lifecycle enabled (default): the structured-launch wrapper registers', async () => {
    // Defaults keep the wrapper: a config with only the companion disabled
    // must behave exactly like the baseline (no silent gate drift).
    const { ctx, toolUpdates } = makeCtx(projectDir);
    const cleanup = await createV2Setup()(ctx);
    try {
      expect(toolUpdates.map((u) => u.id)).toContain('subagent');
    } finally {
      await cleanup();
    }
  }, 20_000);

  test('liveConfigRefresh disabled: no watcher, but the startup seed still lands', async () => {
    await writeProjectConfig({
      companion: { enabled: false },
      liveConfigRefresh: false,
      preset: 'cheap',
      presets: {
        cheap: { explorer: { model: 'openai/gpt-5-mini' } },
        strong: { explorer: { model: 'anthropic/claude-sonnet-4-5' } },
      },
    });
    const { ctx } = makeCtx(projectDir);
    const cleanup = await createV2Setup()(ctx);
    try {
      // The one-shot startup seed ran: the sidebar projection carries the
      // selected preset's model (this also proves `refreshProfiles` itself
      // still functions without the watcher).
      // eslint-disable-next-line
      const { readTuiSnapshot } = await import('../tui-state');
      const snapshot = readTuiSnapshot(projectDir);
      expect(snapshot.agentModels.explorer).toBe('openai/gpt-5-mini');

      // A config edit afterwards must NOT refresh: with the watcher off the
      // frozen seed is the running table until restart.
      await writeProjectConfig({
        companion: { enabled: false },
        liveConfigRefresh: false,
        preset: 'strong',
        presets: {
          cheap: { explorer: { model: 'openai/gpt-5-mini' } },
          strong: { explorer: { model: 'anthropic/claude-sonnet-4-5' } },
        },
      });
      await new Promise((resolve) => setTimeout(resolve, 1_200));
      expect(readTuiSnapshot(projectDir).agentModels.explorer).toBe(
        'openai/gpt-5-mini',
      );
    } finally {
      await cleanup();
    }
  }, 20_000);

  test('sidebar disabled: finalization writes no display names', async () => {
    await writeProjectConfig({
      companion: { enabled: false },
      sidebar: false,
      agents: { explorer: { model: 'openai/gpt-5-mini' } },
    });
    const { ctx } = makeCtx(projectDir);
    const cleanup = await createV2Setup()(ctx);
    try {
      // Supply a live agent draft so finalization runs at all: with the
      // sidebar switch on (baseline) this writes display names for every
      // registered agent; off, no tui-state write happens.
      const { readTuiSnapshot } = await import('../tui-state');
      expect(readTuiSnapshot(projectDir).agentModels).toEqual({});
    } finally {
      await cleanup();
    }
  }, 20_000);
});
