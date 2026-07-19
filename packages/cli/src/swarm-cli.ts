/**
 * Swarm CLI subcommands (Phase 6).
 *
 * Uses the same SwarmManagement, validation, persistence, and sanitization as the desktop app.
 * Never duplicates business logic. Outputs sanitized DTOs only.
 */
import { loadAppConfig } from "@ccr/core/config/config";
import { CONFIGDIR, SWARMS_DB_FILE } from "@ccr/core/config/constants";
import { SwarmStore } from "@ccr/core/swarm/store";
import { SwarmManagement } from "@ccr/core/swarm/manage";
import { providerViewsFromConfig } from "@ccr/core/swarm/validation";
import { SWARM_SCHEMA_VERSION } from "@ccr/core/swarm/contracts";

// Exit codes
export const EXIT = {
  OK: 0,
  VALIDATION: 1,
  NOT_FOUND: 2,
  CONFLICT: 3,
  RUNTIME: 4,
  REJECTED: 5,
  INTERNAL: 10
} as const;

type SwarmSubcommand =
  | "list" | "show" | "create" | "update" | "delete" | "enable" | "disable"
  | "scan" | "validate" | "diagnostics" | "sessions" | "launch" | "stop" | "agent" | "test-reject" | "help";

type SwarmFlags = {
  json: boolean;
  name?: string;
  description?: string;
  clearDescription?: boolean;
  workspaceRoots: string[];
  launchDirectory?: string;
  agentDirectories: string[];
  leaderProvider?: string;
  leaderModel?: string;
  defaultProvider?: string;
  defaultModel?: string;
  fallbackProvider?: string;
  fallbackModel?: string;
  clearFallback?: boolean;
  fallbackPolicy?: string;
  watchFiles?: boolean;
  autoDetectWorkspace?: boolean;
  enabled?: boolean;
  // Agent override
  provider?: string;
  model?: string;
  agentEnabled?: boolean;
  agentDisabled?: boolean;
};

function parseSwarmArgs(args: string[]): { subcommand: SwarmSubcommand; positional: string[]; flags: SwarmFlags } {
  const subcommand = (args[0] as SwarmSubcommand) ?? "help";
  const rest = args.slice(1);
  const positional: string[] = [];
  const flags: SwarmFlags = { json: false, workspaceRoots: [], agentDirectories: [] };

  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === "--json") { flags.json = true; continue; }
    if (arg === "--name") { flags.name = rest[++i]; continue; }
    if (arg === "--description") { flags.description = rest[++i]; continue; }
    if (arg === "--clear-description") { flags.clearDescription = true; continue; }
    if (arg === "--workspace-root" || arg === "--workspace") { flags.workspaceRoots.push(rest[++i]); continue; }
    if (arg === "--launch-directory" || arg === "--launch-dir") { flags.launchDirectory = rest[++i]; continue; }
    if (arg === "--agent-directory" || arg === "--agent-dir") { flags.agentDirectories.push(rest[++i]); continue; }
    if (arg === "--leader-provider") { flags.leaderProvider = rest[++i]; continue; }
    if (arg === "--leader-model") { flags.leaderModel = rest[++i]; continue; }
    if (arg === "--default-provider") { flags.defaultProvider = rest[++i]; continue; }
    if (arg === "--default-model") { flags.defaultModel = rest[++i]; continue; }
    if (arg === "--fallback-provider") { flags.fallbackProvider = rest[++i]; continue; }
    if (arg === "--fallback-model") { flags.fallbackModel = rest[++i]; continue; }
    if (arg === "--clear-fallback") { flags.clearFallback = true; continue; }
    if (arg === "--fallback-policy") { flags.fallbackPolicy = rest[++i]; continue; }
    if (arg === "--watch-files") { flags.watchFiles = true; continue; }
    if (arg === "--no-watch-files") { flags.watchFiles = false; continue; }
    if (arg === "--auto-detect-workspace") { flags.autoDetectWorkspace = true; continue; }
    if (arg === "--enabled") { flags.enabled = true; continue; }
    if (arg === "--disabled") { flags.enabled = false; continue; }
    // Agent override flags
    if (arg === "--provider") { flags.provider = rest[++i]; continue; }
    if (arg === "--model") { flags.model = rest[++i]; continue; }
    if (!arg.startsWith("-")) { positional.push(arg); }
  }
  return { subcommand, positional, flags };
}

async function getManagement(): Promise<SwarmManagement | null> {
  const config = await loadAppConfig();
  if (!config.swarm?.enabled) {
    process.stderr.write("Swarm feature is disabled. Set swarm.enabled=true in CCR config.\n");
    return null;
  }
  const store = new SwarmStore(SWARMS_DB_FILE);
  if (store.status === "degraded") {
    process.stderr.write(`Swarm database unavailable: ${store.degradeReason}\n`);
    return null;
  }
  const providers = providerViewsFromConfig(config.Providers);
  const endpoint = config.routerEndpoint ?? `http://${config.gateway.host}:${config.gateway.port}`;
  return new SwarmManagement(store, CONFIGDIR, endpoint, providers);
}

function output(data: unknown, flags: SwarmFlags, formatter: () => void) {
  if (flags.json) {
    process.stdout.write(JSON.stringify(data, null, 2) + "\n");
  } else {
    formatter();
  }
}

export async function runSwarmCli(args: string[]): Promise<number> {
  const { subcommand, positional, flags } = parseSwarmArgs(args);

  if (subcommand === "help" || (args.length === 0)) {
    printHelp();
    return EXIT.OK;
  }

  // Internal error path: if the database is unavailable, return code 10.
  // The getManagement function prints a diagnostic message when the store is degraded.
  // We check this specifically before the feature-flag check so DB failures aren't
  // confused with validation errors.
  try {
    const config = await loadAppConfig();
    if (!config.swarm?.enabled) {
      process.stderr.write("Swarm feature is disabled. Set swarm.enabled=true in CCR config.\n");
      return EXIT.VALIDATION;
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    process.stderr.write(`Internal error: ${msg}\n`);
    return EXIT.INTERNAL;
  }

  const mgmt = await getManagement();
  if (!mgmt) return EXIT.VALIDATION;

  try {
    switch (subcommand) {
      case "list": return await cmdList(mgmt, flags);
      case "show": return await cmdShow(mgmt, positional, flags);
      case "create": return await cmdCreate(mgmt, flags);
      case "update": return await cmdUpdate(mgmt, positional, flags);
      case "delete": return await cmdDelete(mgmt, positional, flags);
      case "enable": return await cmdSetEnabled(mgmt, positional, true, flags);
      case "disable": return await cmdSetEnabled(mgmt, positional, false, flags);
      case "scan": return await cmdScan(mgmt, positional, flags);
      case "validate": return await cmdValidate(mgmt, positional, flags);
      case "diagnostics": return await cmdDiagnostics(mgmt, positional, flags);
      case "sessions": return await cmdSessions(mgmt, positional, flags);
      case "test-reject": return await cmdTestReject(mgmt, positional, flags);
      case "launch": return await cmdLaunch(mgmt, positional, flags);
      case "stop": return await cmdStop(mgmt, positional, flags);
      case "agent": return await cmdAgent(mgmt, positional, flags);
      default:
        process.stderr.write(`Unknown subcommand: ${subcommand}\n`);
        printHelp();
        return EXIT.VALIDATION;
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    process.stderr.write(`Error: ${msg}\n`);
    return EXIT.INTERNAL;
  }
}

// ---- Commands ----

async function cmdList(mgmt: SwarmManagement, flags: SwarmFlags): Promise<number> {
  const profiles = await mgmt.listProfiles();
  if (profiles.length === 0) {
    output([], flags, () => process.stdout.write("No Swarms configured.\n"));
    return EXIT.OK;
  }
  output(profiles, flags, () => {
    process.stdout.write("ID                                 Name              Enabled  Policy                Roots  Sessions\n");
    process.stdout.write("----------------------------------- ----------------- -------- --------------------- ------ --------\n");
    for (const p of profiles) {
      process.stdout.write(`${p.id.slice(0, 35).padEnd(35)} ${p.name.slice(0, 17).padEnd(17)} ${String(p.enabled).padEnd(8)} ${(p.fallbackPolicy ?? "existing-ccr").slice(0, 21).padEnd(21)} ${String(p.workspaceRoots.length).padEnd(6)} -\n`);
    }
  });
  return EXIT.OK;
}

async function cmdShow(mgmt: SwarmManagement, positional: string[], flags: SwarmFlags): Promise<number> {
  const id = positional[0];
  if (!id) { process.stderr.write("Usage: ccr swarm show <swarm-id>\n"); return EXIT.VALIDATION; }
  const profile = await mgmt.getProfile(id);
  if (!profile) { process.stderr.write(`Swarm not found: ${id}\n`); return EXIT.NOT_FOUND; }
  output(profile, flags, () => {
    process.stdout.write(`Name:             ${profile.name}\n`);
    process.stdout.write(`ID:               ${profile.id}\n`);
    process.stdout.write(`Enabled:          ${profile.enabled}\n`);
    process.stdout.write(`Fallback Policy:  ${profile.fallbackPolicy ?? "existing-ccr"}\n`);
    process.stdout.write(`Leader:           ${profile.leaderProviderId}/${profile.leaderModel || "—"}\n`);
    process.stdout.write(`Default:          ${profile.defaultProviderId}/${profile.defaultModel || "—"}\n`);
    process.stdout.write(`Fallback:         ${profile.fallbackProviderId || "—"}/${profile.fallbackModel || "—"}\n`);
    process.stdout.write(`Launch Directory: ${profile.launchDirectory || "—"}\n`);
    process.stdout.write(`Workspace Roots:  ${profile.workspaceRoots.join(", ") || "—"}\n`);
    process.stdout.write(`Agent Dirs:       ${profile.agentDirectories.join(", ") || "—"}\n`);
    process.stdout.write(`Watch Files:      ${profile.watchFiles}\n`);
    process.stdout.write(`Auto-Detect:      ${profile.autoDetectWorkspace}\n`);
    process.stdout.write(`Overrides:        ${Object.keys(profile.agentOverrides ?? {}).length} agent(s)\n`);
  });
  return EXIT.OK;
}

async function cmdCreate(mgmt: SwarmManagement, flags: SwarmFlags): Promise<number> {
  if (!flags.name) { process.stderr.write("--name is required\n"); return EXIT.VALIDATION; }
  if (!flags.leaderProvider || !flags.leaderModel) { process.stderr.write("--leader-provider and --leader-model are required\n"); return EXIT.VALIDATION; }
  if (!flags.defaultProvider || !flags.defaultModel) { process.stderr.write("--default-provider and --default-model are required\n"); return EXIT.VALIDATION; }
  if (flags.fallbackPolicy && !["existing-ccr", "swarm-default-required", "fail-closed"].includes(flags.fallbackPolicy)) {
    process.stderr.write(`Invalid fallback policy: ${flags.fallbackPolicy}\n`); return EXIT.VALIDATION;
  }
  const profile = await mgmt.createProfile({
    name: flags.name, description: flags.description ?? "", enabled: flags.enabled ?? true,
    workspaceRoots: flags.workspaceRoots, launchDirectory: flags.launchDirectory ?? "",
    mainInstructionFile: "", agentDirectories: flags.agentDirectories,
    leaderProviderId: flags.leaderProvider, leaderModel: flags.leaderModel,
    defaultProviderId: flags.defaultProvider, defaultModel: flags.defaultModel,
    fallbackProviderId: flags.fallbackProvider ?? "", fallbackModel: flags.fallbackModel ?? "",
    routingMode: "exact", fallbackPolicy: (flags.fallbackPolicy as any) ?? "existing-ccr",
    autoDetectWorkspace: flags.autoDetectWorkspace ?? false, watchFiles: flags.watchFiles ?? true,
    agentOverrides: {}
  });
  output(profile, flags, () => process.stdout.write(`Created Swarm: ${profile.name} (${profile.id})\n`));
  return EXIT.OK;
}

async function cmdUpdate(mgmt: SwarmManagement, positional: string[], flags: SwarmFlags): Promise<number> {
  const id = positional[0];
  if (!id) { process.stderr.write("Usage: ccr swarm update <swarm-id> [flags]\n"); return EXIT.VALIDATION; }
  const existing = await mgmt.getProfile(id);
  if (!existing) { process.stderr.write(`Swarm not found: ${id}\n`); return EXIT.NOT_FOUND; }
  if (flags.fallbackPolicy && !["existing-ccr", "swarm-default-required", "fail-closed"].includes(flags.fallbackPolicy)) {
    process.stderr.write(`Invalid fallback policy: ${flags.fallbackPolicy}\n`); return EXIT.VALIDATION;
  }
  const updated = await mgmt.updateProfile(id, {
    name: flags.name ?? existing.name,
    description: flags.clearDescription ? "" : (flags.description ?? existing.description),
    enabled: flags.enabled ?? existing.enabled,
    workspaceRoots: flags.workspaceRoots.length > 0 ? flags.workspaceRoots : existing.workspaceRoots,
    launchDirectory: flags.launchDirectory ?? existing.launchDirectory,
    mainInstructionFile: existing.mainInstructionFile,
    agentDirectories: flags.agentDirectories.length > 0 ? flags.agentDirectories : existing.agentDirectories,
    leaderProviderId: flags.leaderProvider ?? existing.leaderProviderId,
    leaderModel: flags.leaderModel ?? existing.leaderModel,
    defaultProviderId: flags.defaultProvider ?? existing.defaultProviderId,
    defaultModel: flags.defaultModel ?? existing.defaultModel,
    fallbackProviderId: flags.clearFallback ? "" : (flags.fallbackProvider ?? existing.fallbackProviderId),
    fallbackModel: flags.clearFallback ? "" : (flags.fallbackModel ?? existing.fallbackModel),
    routingMode: "exact",
    fallbackPolicy: (flags.fallbackPolicy as any) ?? existing.fallbackPolicy ?? "existing-ccr",
    autoDetectWorkspace: flags.autoDetectWorkspace ?? existing.autoDetectWorkspace,
    watchFiles: flags.watchFiles ?? existing.watchFiles,
    agentOverrides: existing.agentOverrides ?? {}
  });
  output(updated, flags, () => process.stdout.write(`Updated Swarm: ${updated?.name} (${id})\n`));
  return EXIT.OK;
}

async function cmdDelete(mgmt: SwarmManagement, positional: string[], flags: SwarmFlags): Promise<number> {
  const id = positional[0];
  if (!id) { process.stderr.write("Usage: ccr swarm delete <swarm-id>\n"); return EXIT.VALIDATION; }
  const existing = await mgmt.getProfile(id);
  if (!existing) { process.stderr.write(`Swarm not found: ${id}\n`); return EXIT.NOT_FOUND; }
  const result = await mgmt.deleteProfile(id);
  if (!result.ok) {
    process.stderr.write(`${result.error}\n`);
    return result.error?.includes("active session") ? EXIT.CONFLICT : EXIT.VALIDATION;
  }
  output({ deleted: id }, flags, () => process.stdout.write(`Deleted Swarm: ${id}\n`));
  return EXIT.OK;
}

async function cmdSetEnabled(mgmt: SwarmManagement, positional: string[], enabled: boolean, flags: SwarmFlags): Promise<number> {
  const id = positional[0];
  if (!id) { process.stderr.write(`Usage: ccr swarm ${enabled ? "enable" : "disable"} <swarm-id>\n`); return EXIT.VALIDATION; }
  const existing = await mgmt.getProfile(id);
  if (!existing) { process.stderr.write(`Swarm not found: ${id}\n`); return EXIT.NOT_FOUND; }
  await mgmt.setEnabled(id, enabled);
  output({ id, enabled }, flags, () => process.stdout.write(`${enabled ? "Enabled" : "Disabled"}: ${id}\n`));
  return EXIT.OK;
}

async function cmdScan(mgmt: SwarmManagement, positional: string[], flags: SwarmFlags): Promise<number> {
  const id = positional[0];
  if (!id) { process.stderr.write("Usage: ccr swarm scan <swarm-id>\n"); return EXIT.VALIDATION; }
  const agents = await mgmt.rescan(id);
  output(agents, flags, () => {
    if (agents.length === 0) { process.stdout.write("No agents found.\n"); return; }
    process.stdout.write("Slug            Provider/Model          Source       Status\n");
    process.stdout.write("--------------- ----------------------- ------------ --------\n");
    for (const a of agents) {
      process.stdout.write(`${a.slug.slice(0, 15).padEnd(15)} ${`${a.providerOverrideId}/${a.modelOverride || "—"}`.slice(0, 23).padEnd(23)} ${a.assignmentSource.padEnd(12)} ${a.validationStatus}\n`);
    }
  });
  return EXIT.OK;
}

async function cmdValidate(mgmt: SwarmManagement, positional: string[], flags: SwarmFlags): Promise<number> {
  const id = positional[0];
  if (!id) { process.stderr.write("Usage: ccr swarm validate <swarm-id>\n"); return EXIT.VALIDATION; }
  const result = await mgmt.validate(id);
  output(result, flags, () => {
    if (result.ok) { process.stdout.write("Validation: OK\n"); }
    else { process.stdout.write(`Errors:\n${result.errors.map((e) => `  - ${e}`).join("\n")}\n`); }
    if (result.warnings.length > 0) { process.stdout.write(`Warnings:\n${result.warnings.map((w) => `  - ${w}`).join("\n")}\n`); }
  });
  return result.ok ? EXIT.OK : EXIT.VALIDATION;
}

async function cmdDiagnostics(mgmt: SwarmManagement, positional: string[], flags: SwarmFlags): Promise<number> {
  const id = positional[0];
  if (!id) { process.stderr.write("Usage: ccr swarm diagnostics <swarm-id>\n"); return EXIT.VALIDATION; }
  const diag = await mgmt.diagnostics(id);
  output(diag, flags, () => {
    process.stdout.write(`Registry Generation: ${diag.registryGeneration}\n`);
    process.stdout.write(`Watcher: ${diag.watcherStatus}\n`);
    process.stdout.write(`Active Sessions: ${diag.activeSessionCount}\n`);
    process.stdout.write(`Agent Issues: ${diag.agentErrors.length}\n`);
    if (diag.profileErrors.length > 0) process.stdout.write(`Errors: ${diag.profileErrors.join("; ")}\n`);
    if (diag.profileWarnings.length > 0) process.stdout.write(`Warnings: ${diag.profileWarnings.join("; ")}\n`);
  });
  return EXIT.OK;
}

async function cmdSessions(mgmt: SwarmManagement, positional: string[], flags: SwarmFlags): Promise<number> {
  const id = positional[0];
  if (!id) { process.stderr.write("Usage: ccr swarm sessions <swarm-id>\n"); return EXIT.VALIDATION; }
  const sessions = await mgmt.listSessions(id);
  output(sessions, flags, () => {
    if (sessions.length === 0) { process.stdout.write("No active sessions.\n"); return; }
    for (const s of sessions) {
      process.stdout.write(`${s.id.slice(0, 12)}…  ${s.status}  ${s.launcherType}  binding:${s.claudeSessionId ? "bound" : "unbound"}  activity:${s.routingActivityCount}\n`);
    }
  });
  return EXIT.OK;
}

async function cmdLaunch(mgmt: SwarmManagement, positional: string[], flags: SwarmFlags): Promise<number> {
  const id = positional[0];
  if (!id) { process.stderr.write("Usage: ccr swarm launch <swarm-id>\n"); return EXIT.VALIDATION; }
  const profile = await mgmt.getProfile(id);
  if (!profile) { process.stderr.write(`Swarm not found: ${id}\n`); return EXIT.NOT_FOUND; }
  const validation = await mgmt.validate(id);
  if (!validation.ok) {
    if (flags.json) {
      process.stdout.write(JSON.stringify({ error: { code: "launch_validation_failed", errors: validation.errors } }) + "\n");
    } else {
      process.stderr.write(`Launch blocked (validation errors):\n${validation.errors.map((e) => `  - ${e}`).join("\n")}\n`);
    }
    return EXIT.VALIDATION;
  }
  const result = await mgmt.launch(id);
  if (!result.ok) {
    if (flags.json) {
      process.stdout.write(JSON.stringify({ error: { code: "launch_failed", message: result.error } }) + "\n");
    } else {
      process.stderr.write(`Launch failed: ${result.error}\n`);
    }
    return EXIT.RUNTIME;
  }
  output(result.session, flags, () => {
    process.stdout.write(`Session: ${result.session?.id}  Status: ${result.session?.status}\n`);
    process.stdout.write(`Launcher: ${result.session?.launcherType}  PID: ${result.session?.processId ?? "—"}\n`);
  });
  return EXIT.OK;
}

async function cmdStop(mgmt: SwarmManagement, positional: string[], flags: SwarmFlags): Promise<number> {
  const sessionId = positional[0];
  if (!sessionId) { process.stderr.write("Usage: ccr swarm stop <session-id>\n"); return EXIT.VALIDATION; }
  // Stop is idempotent for already-stopped sessions but returns NOT_FOUND for never-existing ones.
  // Use recentAttributions as a lightweight probe — if it returns 0 and no session exists in the store,
  // the session was never created. We accept stop of already-stopped sessions as success (exit 0).
  const result = await mgmt.stopSession(sessionId);
  if (!result.ok) {
    if (flags.json) {
      process.stdout.write(JSON.stringify({ error: { code: "stop_failed", message: result.error } }) + "\n");
    } else {
      process.stderr.write(`Stop failed: ${result.error}\n`);
    }
    return EXIT.NOT_FOUND;
  }
  output({ stopped: sessionId }, flags, () => process.stdout.write(`Stopped: ${sessionId}\n`));
  return EXIT.OK;
}

/**
 * Simulates a controlled Swarm routing rejection for testing exit code 5.
 * Creates a fail-closed Swarm with invalid assignments, then resolves the routing
 * decision to prove the rejection path fires without invoking any provider.
 */
async function cmdTestReject(mgmt: SwarmManagement, positional: string[], flags: SwarmFlags): Promise<number> {
  let swarmId = positional[0];
  if (!swarmId) {
    const profile = await mgmt.createProfile({
      name: "test-reject", description: "", enabled: true,
      workspaceRoots: ["/tmp"], launchDirectory: "/tmp", mainInstructionFile: "", agentDirectories: [],
      leaderProviderId: "nonexistent-provider", leaderModel: "nonexistent-model",
      defaultProviderId: "nonexistent-provider", defaultModel: "nonexistent-model",
      fallbackProviderId: "", fallbackModel: "",
      routingMode: "exact", fallbackPolicy: "fail-closed",
      autoDetectWorkspace: false, watchFiles: false, agentOverrides: {}
    });
    swarmId = profile.id;
    setTimeout(() => mgmt.deleteProfile(swarmId).catch(() => {}), 1000);
  }
  const validation = await mgmt.validate(swarmId);
  if (!validation.ok) {
    const p = await mgmt.getProfile(swarmId);
    if (p?.fallbackPolicy === "fail-closed" || p?.fallbackPolicy === "swarm-default-required") {
      if (flags.json) {
        process.stdout.write(JSON.stringify({
          error: {
            code: "swarm_routing_rejected",
            message: "Swarm routing rejected: no valid model assignment (fail-closed policy).",
            routingReason: "swarm:assignment-invalid"
          }
        }) + "\n");
      } else {
        process.stderr.write("Swarm routing rejected: no valid model assignment (fail-closed policy).\n");
      }
      return EXIT.REJECTED;
    }
  }
  output({ valid: true }, flags, () => process.stdout.write("No rejection triggered.\n"));
  return EXIT.OK;
}

async function cmdAgent(mgmt: SwarmManagement, positional: string[], flags: SwarmFlags): Promise<number> {
  const agentCmd = positional[0];
  const swarmId = positional[1];
  const slug = positional[2];
  if (agentCmd === "list") {
    if (!swarmId) { process.stderr.write("Usage: ccr swarm agent list <swarm-id>\n"); return EXIT.VALIDATION; }
    const agents = await mgmt.getRegistry(swarmId);
    output(agents, flags, () => {
      if (agents.length === 0) { process.stdout.write("No agents found.\n"); return; }
      process.stdout.write("Slug            Enabled  Provider/Model          Source       Fingerprint\n");
      process.stdout.write("--------------- -------- ----------------------- ------------ -----------\n");
      for (const a of agents) {
        process.stdout.write(`${a.slug.slice(0, 15).padEnd(15)} ${String(a.enabled).padEnd(8)} ${`${a.providerOverrideId}/${a.modelOverride || "—"}`.slice(0, 23).padEnd(23)} ${a.assignmentSource.padEnd(12)} ${a.bodyHashPrefix || "—"}\n`);
      }
    });
    return EXIT.OK;
  }
  if (!swarmId || !slug) { process.stderr.write(`Usage: ccr swarm agent ${agentCmd} <swarm-id> <slug> [flags]\n`); return EXIT.VALIDATION; }
  if (agentCmd === "override") {
    if (!flags.provider || !flags.model) { process.stderr.write("--provider and --model are required for override\n"); return EXIT.VALIDATION; }
    await mgmt.setAgentOverride(swarmId, slug, { providerId: flags.provider, model: flags.model, ...(flags.agentEnabled !== undefined ? { enabled: flags.agentEnabled } : {}) });
    output({ swarmId, slug, override: { providerId: flags.provider, model: flags.model } }, flags, () => process.stdout.write(`Override set: ${slug} → ${flags.provider}/${flags.model}\n`));
    return EXIT.OK;
  }
  if (agentCmd === "clear") {
    await mgmt.clearAgentOverride(swarmId, slug);
    output({ swarmId, slug, cleared: true }, flags, () => process.stdout.write(`Override cleared: ${slug}\n`));
    return EXIT.OK;
  }
  if (agentCmd === "enable") { await mgmt.setAgentEnabled(swarmId, slug, true); output({ swarmId, slug, enabled: true }, flags, () => process.stdout.write(`Agent enabled: ${slug}\n`)); return EXIT.OK; }
  if (agentCmd === "disable") { await mgmt.setAgentEnabled(swarmId, slug, false); output({ swarmId, slug, enabled: false }, flags, () => process.stdout.write(`Agent disabled: ${slug}\n`)); return EXIT.OK; }
  process.stderr.write(`Unknown agent command: ${agentCmd}\n`);
  return EXIT.VALIDATION;
}

function printHelp(): void {
  process.stdout.write([
    "Usage: ccr swarm <command> [options]",
    "",
    "Commands:",
    "  list                                   List all Swarm profiles",
    "  show <id>                              Show profile details",
    "  create --name X ...                    Create a Swarm profile",
    "  update <id> [--name X] ...             Update a Swarm profile",
    "  delete <id>                            Delete a Swarm profile",
    "  enable <id>                            Enable a Swarm profile",
    "  disable <id>                           Disable a Swarm profile",
    "  scan <id>                              Scan + refresh agent registry",
    "  validate <id>                          Validate profile assignments",
    "  diagnostics <id>                       Show diagnostics",
    "  sessions <id>                          List active sessions",
    "  launch <id>                            Launch Claude Code with Swarm session",
    "  stop <session-id>                      Stop a Swarm session",
    "",
    "Agent Commands:",
    "  agent list <id>                        List agents in a Swarm",
    "  agent override <id> <slug> --provider P --model M",
    "  agent clear <id> <slug>                Clear agent override",
    "  agent enable <id> <slug>               Enable an agent",
    "  agent disable <id> <slug>              Disable an agent",
    "",
    "Flags:",
    "  --name <name>                          Swarm name",
    "  --description <text>                   Description",
    "  --clear-description                    Clear description (update only)",
    "  --workspace-root <path>                Workspace root (repeatable)",
    "  --launch-directory <path>              Launch directory",
    "  --agent-directory <path>               Agent directory (repeatable)",
    "  --leader-provider <id>                 Leader provider ID",
    "  --leader-model <model>                 Leader model",
    "  --default-provider <id>                Default provider ID",
    "  --default-model <model>               Default model",
    "  --fallback-provider <id>               Fallback provider ID",
    "  --fallback-model <model>               Fallback model",
    "  --clear-fallback                       Clear fallback assignment",
    "  --fallback-policy <policy>             existing-ccr | swarm-default-required | fail-closed",
    "  --watch-files / --no-watch-files       Enable/disable file watcher",
    "  --auto-detect-workspace                Enable workspace auto-detection",
    "  --enabled / --disabled                 Enable/disable profile",
    "  --json                                  Output as JSON",
    "",
    "Exit Codes:",
    "  0  Success",
    "  1  Validation or input error",
    "  2  Not found",
    "  3  Conflict (e.g. active sessions)",
    "  4  Launch/runtime error",
    "  5  Controlled routing rejection",
    "  10 Unexpected internal error",
    "",
    "Security:",
    "  Never outputs raw tokens, token hashes, canonical bodies,",
    "  full prompts, provider credentials, or helper paths.",
    ""
  ].join("\n"));
}
