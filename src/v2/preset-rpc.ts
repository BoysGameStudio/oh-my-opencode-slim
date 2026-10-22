import { Rpc } from '@opencode/plugin/rpc';
import { z } from 'zod';

const state = z.object({
  sessionID: z.string(),
  status: z.enum(['bound', 'unbound']),
  presetName: z.string().nullable(),
  affects: z.literal('future-children-only'),
});

/** Shared server/TUI contract. Call context.client.rpc(sessionPresetRpc).
 * Neither method writes config or changes the session's native model. */
export const sessionPresetRpc = Rpc.define({
  id: 'oh-my-opencode-slim.session-preset.v1',
  methods: {
    read: {
      input: z.object({ sessionID: z.string().min(1) }).strict(),
      output: state,
    },
    apply: {
      input: z
        .object({ sessionID: z.string().min(1), presetName: z.string().min(1) })
        .strict(),
      output: state,
    },
  },
  events: {},
});

export type { SessionPresetState } from './session-presets';
