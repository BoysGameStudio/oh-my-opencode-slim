/**
 * Appends the reminder to exactly one orchestrator user message: the first
 * eligible one in the session view. The anchor is fixed, so its rendered bytes
 * never change between requests — that turn-invariance protects the provider
 * prefix cache. #790 bought the same invariant by re-appending to every message
 * (O(N) copies); a fixed anchor buys it with O(1). The anchor only moves when
 * the host rewrites the prefix (compaction / trim / fork), which already
 * invalidates the cache, so re-anchoring costs nothing (aside from the first
 * injection when the gate opens on an existing view, which appends into what
 * was previously the cached prefix — same as the pre-change behavior).
 * Supersedes #790's mechanism; preserves #790's invariant.
 *
 * Do NOT make this tail-only: a reminder pinned to the newest message rewrites
 * the previous anchor's bytes every turn and pays full input price every turn,
 * because a moving reminder is always new content and never survives long
 * enough to be cache-read.
 */
import { PHASE_REMINDER } from '../../config/constants';
import { isInternalInitiatorPart } from '../../utils';
import {
  appendTaggedSyntheticPart,
  isTaggedPart,
} from '../cache-safe-injection';
import {
  findLatestUserMessage,
  isUserMessageWithParts,
  type MessagePart,
} from '../types';

export { PHASE_REMINDER };

export const PHASE_REMINDER_METADATA_KEY = 'oh-my-opencode-slim.phaseReminder';

export function hasPhaseReminder(part: MessagePart): boolean {
  return isTaggedPart(part, PHASE_REMINDER_METADATA_KEY);
}

interface PhaseReminderOptions {
  shouldInject?: (sessionID: string) => boolean;
}

/**
 * Creates the experimental.chat.messages.transform hook for phase reminder injection.
 * This hook runs right before sending to API, so it doesn't affect UI display.
 * Only injects for the orchestrator agent.
 */
export function createPhaseReminderHook(options: PhaseReminderOptions = {}) {
  return {
    'experimental.chat.messages.transform': async (
      _input: Record<string, never>,
      output: { messages?: unknown },
    ): Promise<void> => {
      const messages = Array.isArray(output.messages) ? output.messages : [];

      const lastUserMessage = findLatestUserMessage(messages);
      if (!lastUserMessage) {
        return;
      }

      const { agent, sessionID } = lastUserMessage.info;
      if (
        agent !== 'orchestrator' ||
        !sessionID ||
        (options.shouldInject && !options.shouldInject(sessionID))
      ) {
        return;
      }

      // Append as a separate part instead of mutating user-authored text;
      // the reminder stays out of the UI display and history (issue #448).
      for (const message of messages) {
        if (
          !isUserMessageWithParts(message) ||
          message.info.agent !== 'orchestrator' ||
          message.info.sessionID !== sessionID
        ) {
          continue;
        }

        const textPart = message.parts.find(
          (part) => part.type === 'text' && part.text !== undefined,
        );
        if (!textPart || isInternalInitiatorPart(textPart)) {
          continue;
        }

        // Anchor on the first eligible message and stop. A later anchor would
        // rewrite already-cached bytes every turn (see the module docblock).
        if (!message.parts.some(hasPhaseReminder)) {
          appendTaggedSyntheticPart(message, {
            text: PHASE_REMINDER,
            metadataKey: PHASE_REMINDER_METADATA_KEY,
          });
        }
        break;
      }
    },
  };
}
