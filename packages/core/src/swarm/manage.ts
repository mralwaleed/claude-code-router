/**
 * Swarm management service (Phase 5A) — the main-process orchestrator the IPC handlers call.
 *
 * Bridges the UI to the swarm modules (store, registry, session, launch). All outputs are
 * SANITIZED DTOs (api.ts): never raw tokens, token hashes, provider keys, canonical bodies, or
 * full system prompts. Launch validates first and cleans up partial state on failure (no orphan
 * ACTIVE sessions).
 *
 * PID handling: the launched process id is captured best-effort (it may be the terminal-opener
 * pid on macOS) and is informational only — auth is always by token hash, never PID.
 */
import { spawn } from "node:child_process";
import { existsSync, writeFileSync, chmodSync } from "node:fs";
import path from "node:path";
import type { SwarmProfile, SwarmProviderView } from "@ccr/core/swarm/contracts";
import { SWARM_SCHEMA_VERSION } from "@ccr/core/swarm/contracts";
import { SwarmStore } from "@ccr/core/swarm/store";
import { SwarmAgentRegistry } from "@ccr/core/swarm/registry";
import { providerViewsFromConfig, validateSwarmProfile } from "@ccr/core/swarm/validation";
import { createSwarmSession, buildSwarmLaunchRuntime, stopSwarmSession } from "@ccr/core/swarm/launch";
import {
  toAgentDto,
  toAttributionDto,
  toSessionDto,
  type SwarmAgentDto,
  type SwarmAttributionDto,
  type SwarmDiagnosticsDto,
  type SwarmProfileDto,
  type SwarmSessionDto
} from "@ccr/core/swarm/api";

export type SwarmProfileInput = Omit<SwarmProfile, "id" | "schemaVersion" | "createdAt" | "updatedAt"> & {
  id?: string;
};

export class SwarmManagement {
  private readonly registries = new Map<string, SwarmAgentRegistry>();
  private readonly launchedRuntimeDirs = new Map<string, string>(); // sessionId -> tempConfigDir

  constructor(
    private readonly store: SwarmStore,
    private readonly configDir: string,
    private readonly gatewayEndpoint: string,
    private readonly providers: ReadonlyArray<SwarmProviderView> = [],
    private readonly now: () => string = () => new Date().toISOString(),
    private readonly watch: boolean = true
  ) {}

  // ---- Profiles ----

  async listProfiles(): Promise<SwarmProfileDto[]> {
    return this.store.listProfiles();
  }

  async getProfile(id: string): Promise<SwarmProfileDto | undefined> {
    return this.store.getProfile(id);
  }

  async createProfile(input: SwarmProfileInput): Promise<SwarmProfile> {
    const now = this.now();
    const profile: SwarmProfile = {
      ...input,
      id: input.id || `swarm_${randomId()}`,
      schemaVersion: SWARM_SCHEMA_VERSION,
      createdAt: now,
      updatedAt: now
    };
    await this.store.upsertProfile(profile);
    return profile;
  }

  async updateProfile(id: string, input: SwarmProfileInput): Promise<SwarmProfile | undefined> {
    const existing = await this.store.getProfile(id);
    if (!existing) {
      return undefined;
    }
    const updated: SwarmProfile = {
      ...existing,
      ...input,
      id,
      schemaVersion: SWARM_SCHEMA_VERSION,
      createdAt: existing.createdAt,
      updatedAt: this.now()
    };
    await this.store.upsertProfile(updated);
    // invalidate cached registry (directories/assignments may have changed)
    const reg = this.registries.get(id);
    if (reg) {
      await reg.dispose();
      this.registries.delete(id);
    }
    return updated;
  }

  async deleteProfile(id: string): Promise<{ ok: boolean; error?: string }> {
    const sessions = await this.store.listActiveSessions();
    const active = sessions.filter((s) => s.swarmId === id);
    if (active.length > 0) {
      return { ok: false, error: "Stop all active sessions before deleting this Swarm." };
    }
    await this.store.deleteProfile(id);
    const reg = this.registries.get(id);
    if (reg) {
      await reg.dispose();
      this.registries.delete(id);
    }
    return { ok: true };
  }

  async setEnabled(id: string, enabled: boolean): Promise<void> {
    const profile = await this.store.getProfile(id);
    if (!profile) {
      return;
    }
    await this.store.upsertProfile({ ...profile, enabled, updatedAt: this.now() });
  }

  // ---- Registry / validation ----

  async getRegistry(id: string): Promise<SwarmAgentDto[]> {
    const snap = await this.getRegistrySnapshot(id);
    return snap.agents.map(toAgentDto);
  }

  async rescan(id: string): Promise<SwarmAgentDto[]> {
    const reg = await this.getOrCreateRegistry(id);
    if (!reg) {
      return [];
    }
    await reg.rescan();
    return reg.getRegistrySnapshot().agents.map(toAgentDto);
  }

  async validate(id: string): Promise<{ ok: boolean; errors: string[]; warnings: string[] }> {
    const profile = await this.store.getProfile(id);
    if (!profile) {
      return { ok: false, errors: ["Swarm not found"], warnings: [] };
    }
    return validateSwarmProfile(profile, this.providers);
  }

  private async getOrCreateRegistry(id: string): Promise<SwarmAgentRegistry | undefined> {
    const existing = this.registries.get(id);
    if (existing) {
      return existing;
    }
    const profile = await this.store.getProfile(id);
    if (!profile) {
      return undefined;
    }
    const reg = new SwarmAgentRegistry({
      swarmId: id,
      agentDirectories: profile.agentDirectories,
      providers: this.providers,
      watch: this.watch,
      agentOverrides: profile.agentOverrides
    });
    await reg.initialScan();
    this.registries.set(id, reg);
    return reg;
  }

  private async getRegistrySnapshot(id: string) {
    const reg = await this.getOrCreateRegistry(id);
    return reg ? reg.getRegistrySnapshot() : { agents: [] as ReadonlyArray<any>, generation: 0 };
  }

  // ---- Launch / stop ----

  async launch(id: string): Promise<{ ok: boolean; session?: SwarmSessionDto; error?: string }> {
    const profile = await this.store.getProfile(id);
    if (!profile) {
      return { ok: false, error: "Swarm not found" };
    }
    if (!profile.enabled) {
      return { ok: false, error: "Swarm is disabled" };
    }
    const validation = validateSwarmProfile(profile, this.providers);
    if (!validation.ok) {
      return { ok: false, error: `Launch blocked: ${validation.errors.join("; ")}` };
    }
    if (!profile.launchDirectory || !existsSync(profile.launchDirectory)) {
      return { ok: false, error: "Launch directory does not exist" };
    }

    const created = await createSwarmSession(this.store, {
      swarmId: id,
      workspace: profile.workspaceRoots[0] ?? "",
      launchDirectory: profile.launchDirectory
    });
    const runtime = buildSwarmLaunchRuntime({
      session: created.session,
      rawToken: created.rawToken,
      gatewayEndpoint: this.gatewayEndpoint,
      configDir: this.configDir
    });
    this.launchedRuntimeDirs.set(created.session.id, runtime.tempConfigDir);

    // write a launcher script that carries the env into an interactive shell
    const launchScript = path.join(runtime.tempConfigDir, "launch-claude.sh");
    const envExports = Object.entries(runtime.env).map(([k, v]) => `export ${k}=${shellQuote(v)}`).join("\n");
    writeFileSync(launchScript, `#!/bin/sh\n${envExports}\ncd ${shellQuote(profile.launchDirectory)}\nexec claude\n`, { mode: 0o700 });
    chmodSync(launchScript, 0o700);

    try {
      const child =
        process.platform === "darwin"
          ? spawn("open", ["-a", "Terminal.app", launchScript], { detached: true, stdio: "ignore" })
          : spawn("sh", [launchScript], { cwd: profile.launchDirectory, detached: true, stdio: "ignore" });
      child.unref();
      const pid = child.pid ?? null;
      const stored = await this.store.getSessionById(created.session.id);
      if (stored) {
        await this.store.upsertSession({ ...stored, processId: pid });
      }
      const session = await this.store.getSessionById(created.session.id);
      return { ok: true, session: session ? toSessionDto(session) : undefined };
    } catch (error) {
      await this.cleanupSession(created.session.id);
      return { ok: false, error: `Failed to launch Claude Code: ${error instanceof Error ? error.message : String(error)}` };
    }
  }

  async stopSession(sessionId: string): Promise<{ ok: boolean; error?: string }> {
    return this.cleanupSession(sessionId);
  }

  private async cleanupSession(sessionId: string): Promise<{ ok: boolean; error?: string }> {
    const runtimeDir = this.launchedRuntimeDirs.get(sessionId);
    await stopSwarmSession(this.store, sessionId, runtimeDir);
    this.launchedRuntimeDirs.delete(sessionId);
    return { ok: true };
  }

  // ---- Sessions / diagnostics ----

  async listSessions(swarmId: string): Promise<SwarmSessionDto[]> {
    const active = await this.store.listActiveSessions();
    const dtos = active.filter((s) => s.swarmId === swarmId).map(toSessionDto);
    // Attach routing activity count per session (lightweight indexed COUNT)
    for (const dto of dtos) {
      (dto as SwarmSessionDto & { routingActivityCount: number }).routingActivityCount =
        await this.store.countAttributionsBySession(dto.id);
    }
    return dtos;
  }

  // ---- Per-agent overrides ----

  async setAgentOverride(swarmId: string, slug: string, override: { providerId?: string; model?: string; enabled?: boolean }): Promise<void> {
    const profile = await this.store.getProfile(swarmId);
    if (!profile) return;
    const overrides = { ...profile.agentOverrides };
    overrides[slug] = { ...overrides[slug], ...override };
    await this.store.upsertProfile({ ...profile, agentOverrides: overrides, updatedAt: this.now() });
    await this.invalidateRegistry(swarmId);
  }

  async clearAgentOverride(swarmId: string, slug: string): Promise<void> {
    const profile = await this.store.getProfile(swarmId);
    if (!profile) return;
    const overrides = { ...profile.agentOverrides };
    delete overrides[slug];
    await this.store.upsertProfile({ ...profile, agentOverrides: overrides, updatedAt: this.now() });
    await this.invalidateRegistry(swarmId);
  }

  async setAgentEnabled(swarmId: string, slug: string, enabled: boolean): Promise<void> {
    await this.setAgentOverride(swarmId, slug, { enabled });
  }

  private async invalidateRegistry(swarmId: string): Promise<void> {
    const reg = this.registries.get(swarmId);
    if (reg) {
      await reg.dispose();
      this.registries.delete(swarmId);
    }
  }

  async diagnostics(id: string): Promise<SwarmDiagnosticsDto> {
    const profile = await this.store.getProfile(id);
    if (!profile) {
      return { profileErrors: ["Swarm not found"], profileWarnings: [], agentErrors: [], watcherStatus: "unavailable", registryGeneration: 0, activeSessionCount: 0, recentAttributions: [] };
    }
    const validation = validateSwarmProfile(profile, this.providers);
    const reg = this.registries.get(id);
    const snap = reg?.getRegistrySnapshot();
    const agents = (snap?.agents ?? []).map(toAgentDto);
    const agentErrors = agents.filter((a) => a.validationStatus !== "ok");
    const sessions = await this.store.listActiveSessions();
    const attributions = await this.recentAttributions(id, 10);
    return {
      profileErrors: validation.errors,
      profileWarnings: validation.warnings,
      agentErrors,
      watcherStatus: reg?.getWatcherStatus() ?? "stopped",
      registryGeneration: snap?.generation ?? 0,
      activeSessionCount: sessions.filter((s) => s.swarmId === id).length,
      recentAttributions: attributions
    };
  }

  async recentAttributions(swarmId: string, limit = 10): Promise<SwarmAttributionDto[]> {
    // attributions are stored per session; gather across this swarm's sessions
    const sessions = (await this.store.listSessions()).filter((s) => s.swarmId === swarmId);
    const all: SwarmAttributionDto[] = [];
    for (const session of sessions) {
      const list = await this.store.listAttributionsBySession(session.id, limit);
      all.push(...list.map(toAttributionDto));
    }
    return all.slice(0, limit);
  }
}

function randomId(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}

function shellQuote(value: string): string {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}
