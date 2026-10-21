import { statSync } from 'node:fs';
import path from 'node:path';
import type { ContextFile } from '../../utils';
import { log } from '../../utils/logger';

interface PendingContextFile {
  path: string;
  lastReadAt: number;
}

export function createTaskContextTracker() {
  const contextByTask = new Map<string, Map<string, PendingContextFile>>();
  const pendingManagedTaskIds = new Set<string>();

  return {
    pendingManagedTaskIds,

    addContext(taskId: string, files: ContextFile[]) {
      if (files.length === 0) return;
      let context = contextByTask.get(taskId);
      if (!context) {
        context = new Map();
        contextByTask.set(taskId, context);
      }
      for (const file of files) {
        const pending = context.get(file.path) ?? {
          path: file.path,
          lastReadAt: file.lastReadAt,
        };
        pending.lastReadAt = Math.max(pending.lastReadAt, file.lastReadAt);
        context.set(file.path, pending);
      }
    },

    prune(backgroundJobBoard: { taskIDs(): Set<string> }) {
      const remembered = backgroundJobBoard.taskIDs();
      for (const taskId of contextByTask.keys()) {
        if (!pendingManagedTaskIds.has(taskId) && !remembered.has(taskId)) {
          contextByTask.delete(taskId);
        }
      }
    },

    clearSession(sessionId: string) {
      contextByTask.delete(sessionId);
      pendingManagedTaskIds.delete(sessionId);
    },

    contextFilesForPrompt(taskId: string): ContextFile[] {
      const context = contextByTask.get(taskId);
      if (!context) return [];
      return [...context.values()].map((file) => ({
        path: file.path,
        lastReadAt: file.lastReadAt,
      }));
    },
  };
}

/**
 * Drop read-context entries whose path no longer resolves to a regular
 * file on disk (deleted, renamed, unreadable). The read-context list is
 * path-only, so existence is the whole check: a sync `stat` per entry,
 * never a content read, so validation cannot stall the session on large
 * files.
 */
export function filterStaleContextFiles(
  directory: string,
  files: ContextFile[],
): ContextFile[] {
  const kept: ContextFile[] = [];
  for (const file of files) {
    const resolved = path.isAbsolute(file.path)
      ? file.path
      : path.join(directory, file.path);
    try {
      if (!statSync(resolved).isFile()) {
        log('[task-session-manager] dropped stale read context', {
          path: file.path,
          reason: 'not-a-file',
        });
        continue;
      }
    } catch {
      log('[task-session-manager] dropped stale read context', {
        path: file.path,
        reason: 'missing',
      });
      continue;
    }
    kept.push(file);
  }
  return kept;
}

export function extractReadFiles(
  root: string,
  output: { output: unknown; metadata?: unknown },
): ContextFile[] {
  if (typeof output.output !== 'string') return [];

  const extractPath = /<path>([^<]+)<\/path>/.exec(output.output)?.[1];
  if (!extractPath) return [];

  const relative = path.relative(root, extractPath);
  const normalized =
    !relative || relative.startsWith('..') || path.isAbsolute(relative)
      ? extractPath
      : relative;

  return [
    {
      path: normalized,
      lastReadAt: Date.now(),
    },
  ];
}
