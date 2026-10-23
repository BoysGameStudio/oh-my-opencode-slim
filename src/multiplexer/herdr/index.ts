/**
 * Herdr multiplexer implementation
 *
 * Splits panes for sub-agent sessions in Herdr.
 *
 * Herdr is an agent-aware terminal multiplexer (workspaces → tabs → panes).
 * Pane IDs use the format `w<workspace>:p<pane>`. The CLI outputs
 * newline-delimited JSON; `pane split` returns a `pane_info` result whose
 * `pane.pane_id` field is the new pane's ID.
 *
 * Environment detection: Herdr injects `HERDR_PANE_ID` into every pane it
 * manages; it is the client's anchor and is required for any pane command.
 */

import type { MultiplexerLayout } from '../../config/schema';
import { crossSpawn } from '../../utils/compat';
import { isRecord } from '../../utils/guards';
import { log } from '../../utils/logger';
import {
  buildViewCommand,
  findBinary,
  gracefulClosePane,
  normalizePathForShell,
  redactViewerSecretArgs,
} from '../shared';
import type { Multiplexer, PaneResult, PaneSpawnOptions } from '../types';
import {
  type EqualizeAgentPanesOptions,
  equalizeAgentPanes,
} from './layout-equalize';

type HerdrPaneDirection = 'right' | 'down';
type LayoutEqualizer = (opts: EqualizeAgentPanesOptions) => Promise<boolean>;

interface HerdrCliResponse {
  result?: {
    type?: string;
    pane?: { pane_id?: string };
  };
  error?: { code?: string; message?: string };
}

export class HerdrMultiplexer implements Multiplexer {
  readonly type = 'herdr' as const;

  private binaryPath: string | null = null;
  private hasChecked = false;
  private layout: MultiplexerLayout;
  private paneDirection: HerdrPaneDirection;
  private stackDirection: HerdrPaneDirection;
  private mainPaneSize: number;
  private agentAreaPaneId: string | null = null;
  private mainPaneId: string | null = null;
  private agentPaneIds = new Set<string>();
  private equalize: LayoutEqualizer;
  private equalizePanes: boolean;
  // ponytail: serialize spawnPane to prevent concurrent races on agentAreaPaneId
  private spawnMutex: Promise<unknown> = Promise.resolve();

  constructor(
    layout: MultiplexerLayout = 'main-vertical',
    mainPaneSize = 60,
    equalizer: LayoutEqualizer = equalizeAgentPanes,
    equalizePanes = true,
  ) {
    this.layout = layout;
    this.paneDirection = getPaneDirection(layout);
    this.stackDirection = getStackDirection(layout);
    this.mainPaneSize = mainPaneSize;
    this.equalize = equalizer;
    this.equalizePanes = equalizePanes;
  }

  async isAvailable(): Promise<boolean> {
    if (this.hasChecked) {
      return this.binaryPath !== null;
    }

    const configuredBinaryPath = process.env.HERDR_BIN_PATH;
    this.binaryPath =
      configuredBinaryPath && configuredBinaryPath.length > 0
        ? configuredBinaryPath
        : await findBinary('herdr');
    this.hasChecked = true;
    return this.binaryPath !== null;
  }

  isInsideSession(): boolean {
    return !!process.env.HERDR_PANE_ID;
  }

  async spawnPane(
    sessionId: string,
    description: string,
    serverUrl: string,
    directory: string,
    options?: PaneSpawnOptions,
  ): Promise<PaneResult> {
    // ponytail: serialize concurrent spawns to prevent races on agentAreaPaneId
    const prev = this.spawnMutex;
    let release!: () => void;
    this.spawnMutex = new Promise<void>((r) => (release = r));
    await prev;

    try {
      return await this.doSpawn(
        sessionId,
        description,
        serverUrl,
        directory,
        options,
      );
    } finally {
      release();
    }
  }

  private async doSpawn(
    sessionId: string,
    description: string,
    serverUrl: string,
    directory: string,
    options?: PaneSpawnOptions,
  ): Promise<PaneResult> {
    // The parent pane is required: without HERDR_PANE_ID the anchor is
    // unknowable, so no herdr command may be issued (no `--current` fallback).
    const parentPaneId = process.env.HERDR_PANE_ID?.trim();
    if (!parentPaneId) {
      log('[herdr] spawnPane: HERDR_PANE_ID is not set; cannot resolve target');
      return { success: false, error: 'not_found' };
    }

    const herdr = await this.getBinary();
    if (!herdr) {
      log('[herdr] spawnPane: herdr binary not found');
      return { success: false, error: 'unavailable' };
    }

    try {
      // Normalize Windows backslashes→/ so sh -lc (MSYS2) doesn't
      // corrupt --cwd (issue #568).
      const attachDir = normalizePathForShell(directory);

      // v2 remote hosts: the viewer must authenticate with
      // OPENCODE_PASSWORD. Inject it at split time through herdr's native
      // `--env` mechanism so it never reaches the `pane run` command text
      // (which herdr types into the pane's shell).
      const viewerSecretArgs =
        options?.viewerFlavor === 'v2-remote' &&
        options.viewerPassword !== undefined
          ? ['--env', `OPENCODE_PASSWORD=${options.viewerPassword}`]
          : [];

      let paneId: string | null = null;
      let lastRawOutput = '';

      if (this.isMainLayout() && this.agentAreaPaneId) {
        const result = await this.runSplit(
          this.agentAreaPaneId,
          this.stackDirection,
          attachDir,
          false,
          viewerSecretArgs,
        );
        paneId = result.paneId;
        if (!paneId) {
          log('[herdr] agent area split failed, falling back to parent', {
            agentAreaPaneId: this.agentAreaPaneId,
          });
          this.agentAreaPaneId = null;
        }
      }

      // A split from the parent creates the agent area, so only this split is
      // sized by main_pane_size; siblings inside the area keep herdr's 50/50
      // default. even-*/tiled never create an agent area, so they carry none.
      const sized = this.isMainLayout() && this.agentAreaPaneId == null;
      if (!paneId) {
        const result = await this.runSplit(
          parentPaneId,
          this.paneDirection,
          attachDir,
          sized,
          viewerSecretArgs,
        );
        paneId = result.paneId;
        lastRawOutput = result.rawOutput;
        if (paneId) {
          this.mainPaneId = parentPaneId;
        }
      }

      if (!paneId) {
        log('[herdr] spawnPane: could not parse pane_id from output', {
          stdout: lastRawOutput,
        });
        return { success: false, error: 'hard' };
      }

      // 2. Rename the pane for visibility. `pane rename` writes the `label`
      // field (evidence 1.4); the description is the FR-8 metadata and must
      // survive intact, so it is never truncated.
      await crossSpawn([herdr, 'pane', 'rename', paneId, description], {
        stdout: 'ignore',
        stderr: 'ignore',
      }).exited;

      // 3. Run opencode attach in the new pane
      const opencodeCmd = buildViewCommand(
        sessionId,
        serverUrl,
        attachDir,
        options,
      );

      const runProc = crossSpawn([herdr, 'pane', 'run', paneId, opencodeCmd], {
        stdout: 'pipe',
        stderr: 'pipe',
      });

      const runExitCode = await runProc.exited;
      if (runExitCode !== 0) {
        const runStderr = await runProc.stderr();
        const runStdout = await runProc.stdout();
        log('[herdr] spawnPane: run failed', {
          command: opencodeCmd,
          exitCode: runExitCode,
          stdout: runStdout.trim(),
          stderr: runStderr.trim(),
        });
        // ponytail: split succeeded but attach failed; close the orphaned pane
        // so it does not linger in the agent area. Session manager gets no
        // paneId on failure, so we must clean it up here.
        try {
          await this.closePane(paneId);
        } catch (closeErr) {
          log('[herdr] spawnPane: failed to close orphaned pane', {
            paneId,
            error: String(closeErr),
          });
        }
        return { success: false, error: 'hard' };
      }

      // 4. Track agent area pane ID only after successful attach
      if (this.isMainLayout() && !this.agentAreaPaneId) {
        this.agentAreaPaneId = paneId;
      }
      this.agentPaneIds.add(paneId);

      // 5. Even out the agent area only; the main pane keeps its share.
      await this.equalizeAgentArea();

      log('[herdr] spawnPane: SUCCESS', { paneId });
      return { success: true, paneId };
    } catch (err) {
      log('[herdr] spawnPane: exception', { error: String(err) });
      return { success: false, error: 'hard' };
    }
  }

  /**
   * FR-8 sweep capability: every pane herdr knows about, with its `label`
   * (the field `pane rename` writes). Titles that are not plugin metadata are
   * ignored by the sweep.
   */
  async listPanesWithTitles(): Promise<
    Array<{ paneId: string; title: string }>
  > {
    const herdr = await this.getBinary();
    if (!herdr) return [];

    try {
      const proc = crossSpawn([herdr, 'pane', 'list'], {
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const [exitCode, stdout] = await Promise.all([
        proc.exited,
        proc.stdout(),
      ]);
      if (exitCode !== 0) return [];

      const panes: Array<{ paneId: string; title: string }> = [];
      for (const line of stdout.split('\n')) {
        const candidate = line.trim();
        if (!candidate) continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(candidate);
        } catch {
          continue; // progress/diagnostic line
        }
        const result = isRecord(parsed) ? parsed.result : undefined;
        const entries =
          isRecord(result) && Array.isArray(result.panes) ? result.panes : [];
        for (const entry of entries) {
          if (!isRecord(entry)) continue;
          const paneId = entry.pane_id;
          if (typeof paneId !== 'string' || paneId.length === 0) continue;
          panes.push({
            paneId,
            title: typeof entry.label === 'string' ? entry.label : '',
          });
        }
      }
      return panes;
    } catch {
      return [];
    }
  }

  async closePane(paneId: string): Promise<boolean> {
    const herdr = await this.getBinary();
    const closed = await gracefulClosePane(herdr, paneId, {
      ctrlC: ['pane', 'send-keys', paneId, 'ctrl+c'],
      close: ['pane', 'close', paneId],
      acceptExitCode1: true,
      emptyPaneReturnsTrue: true,
    });
    if (!closed) return false;

    if (paneId === this.agentAreaPaneId) {
      this.agentAreaPaneId = null;
    }
    // Only panes this client spawned live in this set; a sweep-closed
    // leftover must not trigger a rebalance of somebody else's layout.
    const wasAgentPane = this.agentPaneIds.delete(paneId);
    if (wasAgentPane) {
      await this.equalizeAgentArea();
    }
    return true;
  }

  async applyLayout(
    layout: MultiplexerLayout,
    mainPaneSize: number,
  ): Promise<void> {
    // ponytail: herdr has no rebalancing API; a layout *switch* starts fresh
    // from the parent pane, but re-applying the same layout must keep the
    // agent-area anchor so later children stack inside it (below for
    // main-vertical, to the right for main-horizontal).
    if (this.layout !== layout) {
      this.agentAreaPaneId = null;
    }
    this.layout = layout;
    this.paneDirection = getPaneDirection(layout);
    this.stackDirection = getStackDirection(layout);
    this.mainPaneSize = mainPaneSize;
  }

  private isMainLayout(): boolean {
    return this.layout === 'main-vertical' || this.layout === 'main-horizontal';
  }

  private async runSplit(
    target: string,
    direction: HerdrPaneDirection,
    directory: string,
    sized: boolean,
    viewerSecretArgs: string[] = [],
  ): Promise<{ paneId: string | null; rawOutput: string }> {
    const herdr = await this.getBinary();
    if (!herdr) return { paneId: null, rawOutput: '' };

    const splitArgs = [
      herdr,
      'pane',
      'split',
      target,
      '--direction',
      direction,
      '--cwd',
      directory,
      '--no-focus',
      ...(sized ? ['--ratio', String(agentPaneRatio(this.mainPaneSize))] : []),
      ...viewerSecretArgs,
    ];

    log('[herdr] spawnPane: splitting pane', {
      args: redactViewerSecretArgs(splitArgs),
    });

    const splitProc = crossSpawn(splitArgs, {
      stdout: 'pipe',
      stderr: 'pipe',
    });

    const splitExitCode = await splitProc.exited;
    const splitStdout = await splitProc.stdout();
    const splitStderr = await splitProc.stderr();

    if (splitExitCode !== 0) {
      log('[herdr] spawnPane: split failed', {
        exitCode: splitExitCode,
        stderr: splitStderr.trim(),
      });
      return { paneId: null, rawOutput: splitStdout.trim() };
    }

    return { paneId: parsePaneId(splitStdout), rawOutput: splitStdout.trim() };
  }

  /**
   * Best-effort re-equalization of the agent panes. It never changes the
   * spawn/close result: missing context is skipped silently and any failure
   * is logged only. `multiplexer.equalize_panes: false` disables the step
   * before any environment or socket access.
   */
  private async equalizeAgentArea(): Promise<void> {
    if (!this.equalizePanes) return;

    const mainPaneId = this.mainPaneId;
    const tabId = process.env.HERDR_TAB_ID?.trim();
    const socketPath = process.env.HERDR_SOCKET_PATH?.trim();
    if (!mainPaneId || !tabId || !socketPath) return;

    try {
      await this.equalize({ socketPath, tabId, mainPaneId });
    } catch (error) {
      log('[herdr] equalizeAgentPanes: unexpected failure', {
        error: String(error),
      });
    }
  }

  private async getBinary(): Promise<string | null> {
    await this.isAvailable();
    return this.binaryPath;
  }
}

/**
 * Parse the pane_id from a herdr CLI JSON response.
 *
 * Herdr outputs newline-delimited JSON like:
 * {"id":"cli:pane:split","result":{"type":"pane_info","pane":{"pane_id":"w1:p2",...}}}
 */
function parsePaneId(stdout: string): string | null {
  const trimmed = stdout.trim();
  if (!trimmed) return null;

  for (const line of trimmed.split('\n')) {
    const candidate = line.trim();
    if (!candidate) continue;
    try {
      const response = JSON.parse(candidate) as HerdrCliResponse;
      const paneId = response.result?.pane?.pane_id;
      if (paneId) return paneId;
    } catch {
      // Not a JSON line (e.g. progress/diagnostic); skip and keep scanning.
    }
  }

  log('[herdr] parsePaneId: no pane_id found in output', { stdout: trimmed });
  return null;
}

function getPaneDirection(layout: MultiplexerLayout): HerdrPaneDirection {
  switch (layout) {
    case 'main-horizontal':
    case 'even-vertical':
      return 'down';
    case 'main-vertical':
    case 'even-horizontal':
    case 'tiled':
      return 'right';
  }
}

/**
 * Direction later children stack inside the agent area. Only the `main-*`
 * layouts create one: below for `main-vertical`, to the right for
 * `main-horizontal` (mirroring the WezTerm agent row).
 */
function getStackDirection(layout: MultiplexerLayout): HerdrPaneDirection {
  return layout === 'main-vertical' ? 'down' : 'right';
}

/**
 * Herdr's `--ratio` is the fraction RETAINED BY THE ANCHOR pane: splitting an
 * anchor with `--ratio 0.8` leaves the anchor at 80% and gives the new pane
 * the remaining 20% (verified against herdr 0.2.x `pane layout` geometry).
 * `main_pane_size` describes that anchor (the main pane), so it maps directly.
 * Clamped to 0.2–0.8 so a hand-edited config can never make either side
 * unusable.
 */
function agentPaneRatio(mainPaneSize: number): number {
  return Math.max(0.2, Math.min(0.8, mainPaneSize / 100));
}
