/**
 * Swarm agent registry lifecycle (Phase 2).
 *
 * Owns one immutable RegistrySnapshot, swapped atomically so concurrent readers never see a
 * partially-updated state. Watcher events trigger a serialized rescan/reload (debounced inside
 * the watcher). Retains the last valid entry for a file that becomes temporarily invalid
 * (marked "degraded"), and removes entries for deleted files.
 *
 * Operations: initialScan, rescan, reloadAgent, removeAgent, getRegistrySnapshot,
 * getWatcherStatus, dispose. Never affects non-Swarm routing (this subsystem is not wired into
 * the gateway yet).
 */
import { statSync } from "node:fs";
import path from "node:path";
import type { ScannedAgent, AgentDirectoryDiagnostics } from "@ccr/core/swarm/agent-registry";
import {
  applyDuplicateDetection,
  isAcceptableAgentFile,
  loadAgentFile,
  scanAgentDirectories
} from "@ccr/core/swarm/agent-registry";
import type { SwarmProviderView } from "@ccr/core/swarm/contracts";
import { SwarmAgentWatcher, type WatcherStatus, type WatcherEventReason } from "@ccr/core/swarm/watcher";

export type RegistrySnapshot = {
  readonly swarmId: string;
  readonly agents: readonly ScannedAgent[];
  readonly bySlug: ReadonlyMap<string, ScannedAgent>;
  readonly byBodyHash: ReadonlyMap<string, readonly ScannedAgent[]>;
  readonly diagnostics: readonly AgentDirectoryDiagnostics[];
  readonly generation: number;
  readonly generatedAt: string;
};

export type SwarmRegistryOptions = {
  swarmId: string;
  agentDirectories: ReadonlyArray<string>;
  providers: ReadonlyArray<SwarmProviderView>;
  watch?: boolean;
  debounceMs?: number;
  now?: () => string;
};

const EMPTY_SNAPSHOT = (swarmId: string): RegistrySnapshot => ({
  swarmId,
  agents: Object.freeze([]) as readonly ScannedAgent[],
  bySlug: new Map<string, ScannedAgent>(),
  byBodyHash: new Map<string, readonly ScannedAgent[]>(),
  diagnostics: Object.freeze([]) as readonly AgentDirectoryDiagnostics[],
  generation: 0,
  generatedAt: ""
});

export class SwarmAgentRegistry {
  private snapshotValue: RegistrySnapshot;
  private readonly lastValidBySource = new Map<string, ScannedAgent>();
  private readonly agentDirectories: string[];
  private readonly swarmId: string;
  private readonly providers: ReadonlyArray<SwarmProviderView>;
  private readonly watch: boolean;
  private readonly debounceMs: number | undefined;
  private readonly now: () => string;
  private watcher?: SwarmAgentWatcher;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(options: SwarmRegistryOptions) {
    this.swarmId = options.swarmId;
    this.agentDirectories = [...options.agentDirectories];
    this.providers = options.providers;
    this.watch = options.watch ?? true;
    this.debounceMs = options.debounceMs;
    this.now = options.now ?? (() => new Date().toISOString());
    this.snapshotValue = EMPTY_SNAPSHOT(this.swarmId);
  }

  getRegistrySnapshot(): RegistrySnapshot {
    return this.snapshotValue;
  }

  getWatcherStatus(): WatcherStatus {
    return this.watcher?.status ?? "stopped";
  }

  /** Full scan + (optionally) start the watcher. Returns the first snapshot. */
  async initialScan(): Promise<RegistrySnapshot> {
    return this.serialize(() => this.doRescan(true));
  }

  /** Full rebuild (e.g. watcher fired, or roots changed). Atomic snapshot swap. */
  async rescan(): Promise<RegistrySnapshot> {
    return this.serialize(() => this.doRescan(false));
  }

  /** Reload a single file (add/change). Does NOT trigger a full directory rescan. */
  async reloadAgent(sourceFile: string): Promise<RegistrySnapshot> {
    return this.serialize(() => this.doReloadAgent(sourceFile));
  }

  /** Remove a single file's entry (delete). */
  async removeAgent(sourceFile: string): Promise<RegistrySnapshot> {
    return this.serialize(() => this.doRemoveAgent(sourceFile));
  }

  /** Stop the watcher and release resources. Safe to call multiple times. */
  async dispose(): Promise<void> {
    if (this.watcher) {
      await this.watcher.stop();
      this.watcher = undefined;
    }
  }

  private startWatcher(): void {
    if (!this.watch || this.watcher || this.agentDirectories.length === 0) {
      return;
    }
    this.watcher = new SwarmAgentWatcher({
      directories: this.agentDirectories,
      debounceMs: this.debounceMs,
      onChange: (_reason: WatcherEventReason) => {
        // Any agent-file change (add/change/unlink/atomic-save) triggers a serialized rescan.
        // The watcher already debounces+coalesces bursts; reloads are cheap for small dirs.
        void this.rescan();
      }
    });
    this.watcher.start();
  }

  private doRescan(initial: boolean): RegistrySnapshot {
    const generation = this.snapshotValue.generation + 1;
    const now = this.now();
    const result = scanAgentDirectories(this.agentDirectories, this.swarmId, this.providers, { generation, now });
    const agents = this.applyRetainLastValid(result.agents, generation, now);
    this.snapshotValue = this.buildSnapshot(agents, result.diagnostics, generation, now);
    if (initial) {
      this.startWatcher();
    }
    return this.snapshotValue;
  }

  private doReloadAgent(sourceFile: string): RegistrySnapshot {
    const absolute = path.resolve(sourceFile);
    const generation = this.snapshotValue.generation + 1;
    const now = this.now();

    let next: ScannedAgent | undefined;
    try {
      const stats = statSync(absolute);
      if (stats.isFile() && isAcceptableAgentFile(path.basename(absolute))) {
        const loaded = loadAgentFile(absolute, this.swarmId, this.providers, generation, now);
        next = loaded.agent;
      }
    } catch {
      next = undefined; // file is gone -> treated as removal below
    }

    const remaining = this.snapshotValue.agents.filter((agent) => agent.sourceFile !== absolute);
    if (next) {
      remaining.push(next);
    }
    const withRetain = this.applyRetainLastValid(remaining, generation, now);
    const finalized = applyDuplicateDetection(withRetain);
    this.snapshotValue = this.buildSnapshot(finalized, this.snapshotValue.diagnostics, generation, now);
    return this.snapshotValue;
  }

  private doRemoveAgent(sourceFile: string): RegistrySnapshot {
    const absolute = path.resolve(sourceFile);
    const generation = this.snapshotValue.generation + 1;
    const now = this.now();
    const remaining = this.snapshotValue.agents.filter((agent) => agent.sourceFile !== absolute);
    const finalized = applyDuplicateDetection(remaining);
    this.lastValidBySource.delete(absolute);
    this.snapshotValue = this.buildSnapshot(finalized, this.snapshotValue.diagnostics, generation, now);
    return this.snapshotValue;
  }

  /**
   * Retain last valid entry for a file that is present-but-invalid, marking it "degraded".
   * Valid entries refresh the cache; deleted files are simply absent (handled by callers).
   */
  private applyRetainLastValid(agents: ScannedAgent[], generation: number, now: string): ScannedAgent[] {
    const result: ScannedAgent[] = [];
    for (const agent of agents) {
      if (agent.validationStatus === "ok") {
        this.lastValidBySource.set(agent.sourceFile, agent);
        result.push(agent);
        continue;
      }
      const lastValid = this.lastValidBySource.get(agent.sourceFile);
      if (lastValid) {
        result.push({
          ...lastValid,
          generation,
          lastLoadedAt: now,
          validationStatus: "degraded",
          validationErrors: [
            ...lastValid.validationErrors,
            `source currently invalid; retained last valid entry (errors: ${agent.validationErrors.join("; ")})`
          ]
        });
      } else {
        result.push(agent); // invalid with no prior valid -> keep blocked entry
      }
    }
    return result;
  }

  private buildSnapshot(
    agents: ScannedAgent[],
    diagnostics: ReadonlyArray<AgentDirectoryDiagnostics>,
    generation: number,
    now: string
  ): RegistrySnapshot {
    const bySlug = new Map<string, ScannedAgent>();
    const byBodyHash = new Map<string, ScannedAgent[]>();
    for (const agent of agents) {
      bySlug.set(agent.slug, agent);
      if (agent.bodyHash) {
        const list = byBodyHash.get(agent.bodyHash) ?? [];
        list.push(agent);
        byBodyHash.set(agent.bodyHash, list);
      }
    }
    const frozenDiagnostics = Object.freeze([...diagnostics]) as readonly AgentDirectoryDiagnostics[];
    return Object.freeze({
      swarmId: this.swarmId,
      agents: Object.freeze([...agents]) as readonly ScannedAgent[],
      bySlug,
      byBodyHash,
      diagnostics: frozenDiagnostics,
      generation,
      generatedAt: now
    }) as RegistrySnapshot;
  }

  /** Serialize state-mutating operations so concurrent triggers never interleave. */
  private serialize<T>(fn: () => T): Promise<T> {
    const run = this.chain.then(fn);
    this.chain = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }
}
