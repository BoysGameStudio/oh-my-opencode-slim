import path from 'node:path';
import type { ContextFile } from '../../utils';

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
        const pending = context.get(file.path);
        if (pending) {
          pending.lastReadAt = Math.max(pending.lastReadAt, file.lastReadAt);
        } else {
          context.set(file.path, {
            path: file.path,
            lastReadAt: file.lastReadAt,
          });
        }
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
