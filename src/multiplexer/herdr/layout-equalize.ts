/**
 * Herdr agent-area equalization
 *
 * Herdr splits a tab into a binary layout tree. A split's `ratio` is the
 * share taken by its FIRST child, and `layout.set_split_ratio` rewrites one
 * node addressed by an array of child choices (false = first, true = second).
 *
 * After a spawn or an agent-pane close, only the AGENT panes are equalized:
 * every split node whose subtree does not contain the main pane is set to
 * `span(first) / (span(first) + span(second))`. `span` counts the panes a
 * subtree occupies ALONG the split's axis; a perpendicular split does not
 * divide that axis, so the larger side wins. Splits that contain the main
 * pane are never rewritten, which keeps the main pane at its
 * `main_pane_size` share.
 *
 * The socket protocol is one request per connection: write one
 * `{"id","method","params"}\n` line, read one line back, close.
 */

import { createConnection } from 'node:net';
import { isRecord } from '../../utils/guards';
import { log } from '../../utils/logger';

export type HerdrSplitDirection = 'down' | 'right';

export interface HerdrLayoutPane {
  type: 'pane';
  pane_id: string;
}

export interface HerdrLayoutSplit {
  type: 'split';
  direction: HerdrSplitDirection;
  ratio: number;
  first: HerdrLayoutNode;
  second: HerdrLayoutNode;
}

export type HerdrLayoutNode = HerdrLayoutPane | HerdrLayoutSplit;

export interface SplitRatioUpdate {
  /** Child choices from the root: false = first, true = second. */
  path: boolean[];
  ratio: number;
}

export interface EqualizeAgentPanesOptions {
  socketPath: string;
  tabId: string;
  mainPaneId: string;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 2000;

/** Number of panes a subtree occupies along `axis`. */
export function paneSpan(
  node: HerdrLayoutNode,
  axis: HerdrSplitDirection,
): number {
  if (node.type === 'pane') return 1;
  const first = paneSpan(node.first, axis);
  const second = paneSpan(node.second, axis);
  return node.direction === axis ? first + second : Math.max(first, second);
}

function containsPane(node: HerdrLayoutNode, paneId: string): boolean {
  if (node.type === 'pane') return node.pane_id === paneId;
  return containsPane(node.first, paneId) || containsPane(node.second, paneId);
}

/**
 * Split-ratio updates that equalize every agent-only subtree. The split that
 * bounds the main pane is skipped (recursed into, never rewritten).
 */
export function equalizeUpdates(
  root: HerdrLayoutNode,
  mainPaneId: string,
): SplitRatioUpdate[] {
  const updates: SplitRatioUpdate[] = [];

  const walk = (node: HerdrLayoutNode, path: boolean[]): void => {
    if (node.type !== 'split') return;

    if (!containsPane(node, mainPaneId)) {
      const first = paneSpan(node.first, node.direction);
      const second = paneSpan(node.second, node.direction);
      updates.push({ path, ratio: first / (first + second) });
      walk(node.first, [...path, false]);
      walk(node.second, [...path, true]);
      return;
    }

    walk(node.first, [...path, false]);
    walk(node.second, [...path, true]);
  };

  walk(root, []);
  return updates;
}

function isLayoutNode(value: unknown): value is HerdrLayoutNode {
  if (!isRecord(value)) return false;
  if (value.type === 'pane') return typeof value.pane_id === 'string';
  if (value.type !== 'split') return false;
  if (value.direction !== 'down' && value.direction !== 'right') return false;
  return (
    typeof value.ratio === 'number' &&
    isLayoutNode(value.first) &&
    isLayoutNode(value.second)
  );
}

function describeHerdrError(error: unknown): string {
  if (isRecord(error) && typeof error.message === 'string') {
    return error.message;
  }
  return String(error);
}

/** One request per socket connection; resolves with the response `result`. */
function sendHerdrRequest(
  socketPath: string,
  method: string,
  params: Record<string, unknown>,
  timeoutMs: number,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let buffer = '';
    let settled = false;

    const settle = (error: Error | null, result?: unknown): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) reject(error);
      else resolve(result);
    };

    socket.setEncoding('utf8');
    socket.setTimeout(timeoutMs);
    socket.on('timeout', () =>
      settle(new Error(`${method}: timed out after ${timeoutMs}ms`)),
    );
    socket.on('error', (error) => settle(error));
    socket.on('close', () =>
      settle(new Error(`${method}: connection closed before response`)),
    );
    socket.on('connect', () => {
      socket.write(
        `${JSON.stringify({ id: `omosc:${method}`, method, params })}\n`,
      );
    });
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      const newline = buffer.indexOf('\n');
      if (newline === -1) return;

      const line = buffer.slice(0, newline).trim();
      let response: unknown;
      try {
        response = JSON.parse(line);
      } catch (error) {
        settle(new Error(`${method}: invalid JSON (${String(error)})`));
        return;
      }

      if (!isRecord(response)) {
        settle(new Error(`${method}: malformed response`));
        return;
      }
      if ('error' in response) {
        settle(new Error(`${method}: ${describeHerdrError(response.error)}`));
        return;
      }
      settle(null, response.result);
    });
  });
}

/**
 * Equalize the agent panes of `tabId`, leaving the main pane's share alone.
 * Best-effort: every failure is logged and reported as `false`, never thrown.
 */
export async function equalizeAgentPanes(
  opts: EqualizeAgentPanesOptions,
): Promise<boolean> {
  const { socketPath, tabId, mainPaneId } = opts;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  try {
    const exported = await sendHerdrRequest(
      socketPath,
      'layout.export',
      { tab_id: tabId },
      timeoutMs,
    );
    const layout = isRecord(exported) ? exported.layout : undefined;
    if (!isRecord(layout) || !isLayoutNode(layout.root)) {
      log('[herdr] equalizeAgentPanes: unusable layout export', { tabId });
      return false;
    }

    if (layout.zoomed === true) {
      log('[herdr] equalizeAgentPanes: skipped (tab is zoomed)', { tabId });
      return true;
    }

    const updates = equalizeUpdates(layout.root, mainPaneId);
    for (const update of updates) {
      await sendHerdrRequest(
        socketPath,
        'layout.set_split_ratio',
        { tab_id: tabId, path: update.path, ratio: update.ratio },
        timeoutMs,
      );
    }

    if (updates.length > 0) {
      log('[herdr] equalizeAgentPanes: applied', {
        tabId,
        splits: updates.length,
      });
    }
    return true;
  } catch (error) {
    log('[herdr] equalizeAgentPanes: failed', {
      tabId,
      error: describeHerdrError(error),
    });
    return false;
  }
}
