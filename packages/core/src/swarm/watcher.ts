/**
 * Scoped Swarm agent-file watcher (Phase 2).
 *
 * Built on Node's `fs.watch` (no native addon dependency — avoids fsevents/ABI/bundling issues
 * under Electron). ONE watcher per Swarm registry (never one per request). One `fs.watch` per
 * configured directory.
 *
 * Behaviour:
 *   - add / change / delete agent file -> reload (debounced + coalesced)
 *   - atomic-save (temp + rename) -> 'rename' event -> reload
 *   - burst writes -> debounced (DEBOUNCE_MS) into one reload
 *   - directory removed -> watcher errors -> status "degraded"; a gentle retry re-watches when
 *     the directory reappears ("directory restored -> recover")
 *   - watcher error -> "degraded" + onError reported
 *   - stop()/dispose() -> "stopped", all native watchers closed
 *
 * DEBOUNCE_MS = 150ms. Editors emit multi-event bursts on save (write + stat, sometimes several
 * rename events for atomic save); 150ms coalesces these into a single reload while keeping
 * latency imperceptible. RETRY_MS = 2000ms for directory-restore recovery.
 */
import { statSync, watch, type FSWatcher } from "node:fs";
import { isAcceptableAgentFile } from "@ccr/core/swarm/agent-registry";

export const SWARM_WATCHER_DEBOUNCE_MS = 150;
export const SWARM_WATCHER_RETRY_MS = 2000;

export type WatcherStatus = "active" | "degraded" | "stopped";

export type WatcherEventReason = "add" | "change" | "unlink";

export type SwarmAgentWatcherOptions = {
  directories: string[];
  debounceMs?: number;
  onChange: (reason: WatcherEventReason) => void;
  onError?: (message: string) => void;
};

type DirWatch = { directory: string; watcher: FSWatcher | undefined; closed: boolean };

export class SwarmAgentWatcher {
  private dirWatches: DirWatch[] = [];
  private statusValue: WatcherStatus = "stopped";
  private debounceTimer?: ReturnType<typeof setTimeout>;
  private pendingReason?: WatcherEventReason;
  private retryTimer?: ReturnType<typeof setTimeout>;
  private stopped = false;
  private readonly directories: string[];
  private readonly debounceMs: number;
  private readonly onChange: (reason: WatcherEventReason) => void;
  private readonly onError: (message: string) => void;

  constructor(options: SwarmAgentWatcherOptions) {
    this.directories = [...options.directories];
    this.debounceMs = options.debounceMs ?? SWARM_WATCHER_DEBOUNCE_MS;
    this.onChange = options.onChange;
    this.onError = options.onError ?? ((message) => console.warn(`[swarm-watcher] ${message}`));
  }

  get status(): WatcherStatus {
    return this.statusValue;
  }

  start(): void {
    if (this.dirWatches.length > 0 || this.stopped) {
      return;
    }
    for (const directory of this.directories) {
      this.dirWatches.push({ directory, watcher: this.watchDirectory(directory), closed: false });
    }
    this.statusValue = this.dirWatches.some((dw) => dw.watcher) ? "active" : "degraded";
  }

  private watchDirectory(directory: string): FSWatcher | undefined {
    try {
      const watcher = watch(directory, { persistent: true, recursive: false }, (eventType, filename) => {
        if (!filename || !isAcceptableAgentFile(filename)) {
          return;
        }
        // Distinguish removal from add/change by presence after the event.
        let present = false;
        try {
          statSync(`${directory}/${filename}`);
          present = true;
        } catch {
          present = false;
        }
        const reason: WatcherEventReason = present ? (eventType === "rename" ? "add" : "change") : "unlink";
        this.schedule(reason);
      });
      watcher.on("error", (error) => {
        this.onError(error instanceof Error ? error.message : String(error));
        this.markDegradedAndRetry();
      });
      return watcher;
    } catch (error) {
      this.onError(`cannot watch ${directory}: ${error instanceof Error ? error.message : String(error)}`);
      this.markDegradedAndRetry();
      return undefined;
    }
  }

  private markDegradedAndRetry(): void {
    if (this.stopped) {
      return;
    }
    this.statusValue = "degraded";
    if (this.retryTimer) {
      return;
    }
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      if (this.stopped) {
        return;
      }
      // Re-watch any directory whose watcher is gone; recover if at least one is alive.
      for (const dw of this.dirWatches) {
        if (!dw.watcher || dw.closed) {
          dw.watcher = this.watchDirectory(dw.directory);
          dw.closed = false;
        }
      }
      if (this.dirWatches.some((dw) => dw.watcher && !dw.closed)) {
        this.statusValue = "active";
      } else {
        this.markDegradedAndRetry(); // try again later
      }
    }, SWARM_WATCHER_RETRY_MS);
  }

  private schedule(reason: WatcherEventReason): void {
    if (!this.pendingReason || reason === "unlink" || this.pendingReason !== "unlink") {
      // keep the most recent non-trivial reason; 'unlink' wins ties
      this.pendingReason = reason;
    }
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = setTimeout(() => {
      const pending = this.pendingReason;
      this.pendingReason = undefined;
      this.debounceTimer = undefined;
      if (pending) {
        this.onChange(pending);
      }
    }, this.debounceMs);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = undefined;
      this.pendingReason = undefined;
    }
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = undefined;
    }
    for (const dw of this.dirWatches) {
      try {
        dw.watcher?.close();
      } catch {
        // best-effort
      }
      dw.closed = true;
    }
    this.dirWatches = [];
    this.statusValue = "stopped";
  }
}
