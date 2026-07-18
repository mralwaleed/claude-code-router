/**
 * Swarm Session launcher integration (Phase 3).
 *
 * A Swarm launch does NOT create an Agent ProfileConfig row and does NOT touch the user's global
 * ~/.claude/settings.json. It derives an EPHEMERAL runtime config directly from the Swarm Profile:
 * a per-session temp CLAUDE_CONFIG_DIR whose settings.json points Claude Code's apiKeyHelper at a
 * small helper script that echoes the raw Swarm token. The launched Claude Code authenticates to
 * CCR with that token; CCR resolves it to the Swarm Session (dedicated auth namespace).
 *
 * Raw-token handling: the raw token lives ONLY in (a) the ephemeral helper script (mode 0700,
 * inside the per-session temp dir) and (b) the spawned process env. Both are deleted on session
 * stop. The raw token is never written to the DB, logs, exports, or diagnostics (only its sha256
 * hash is persisted).
 *
 * Routing: no ANTHROPIC_MODEL is asserted in env — CCR decides routing from the Swarm Profile.
 *
 * PID: captured for diagnostics/lifecycle hints ONLY, never an auth factor.
 */
import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { SwarmLauncherType, SwarmSession } from "@ccr/core/swarm/contracts";
import type { SwarmStore } from "@ccr/core/swarm/store";
import { SWARM_SESSION_DEFAULT_TTL_MS } from "@ccr/core/swarm/session";
import { mintSwarmToken } from "@ccr/core/swarm/token";

const privateDirMode = 0o700;
const privateFileMode = 0o600;
const executableFileMode = 0o700;

export type CreateSwarmSessionParams = {
  swarmId: string;
  workspace: string;
  launchDirectory: string;
  launcherType?: SwarmLauncherType;
  ttlMs?: number;
  processId?: number | null;
};

export type CreatedSwarmSession = {
  /** Raw token — pass to buildSwarmLaunchRuntime; never persist/log/export. */
  rawToken: string;
  session: SwarmSession;
};

/** Mint a token, persist its hash + session record, return the raw token to the launcher. */
export async function createSwarmSession(
  store: SwarmStore,
  params: CreateSwarmSessionParams
): Promise<CreatedSwarmSession> {
  const { rawToken, tokenHash } = mintSwarmToken();
  const id = `swrm_${randomBytes(12).toString("base64url")}`;
  const now = new Date().toISOString();
  const session: SwarmSession = {
    id,
    swarmId: params.swarmId,
    authTokenHash: tokenHash,
    workspace: params.workspace,
    launchDirectory: params.launchDirectory,
    processId: params.processId ?? null,
    claudeSessionId: "",
    startedAt: now,
    lastSeenAt: now,
    endedAt: "",
    status: "active",
    launcherType: params.launcherType ?? "desktop",
    ttlMs: params.ttlMs ?? SWARM_SESSION_DEFAULT_TTL_MS
  };
  await store.upsertSession(session);
  return { rawToken, session };
}

/** Stop (revoke) a session and delete its ephemeral runtime dir. */
export async function stopSwarmSession(store: SwarmStore, sessionId: string, runtimeDir?: string): Promise<void> {
  await store.updateSessionStatus(sessionId, "stopped", new Date().toISOString());
  if (runtimeDir) {
    disposeSwarmLaunchRuntime(runtimeDir);
  }
}

export type SwarmLaunchRuntime = {
  /** Per-session temp CLAUDE_CONFIG_DIR (under the CCR config dir). Deleted on stop. */
  tempConfigDir: string;
  settingsFile: string;
  helperFile: string;
  env: Record<string, string>;
};

/**
 * Build the ephemeral runtime config for a launched Claude Code process.
 * Writes ONLY under `<configDir>/swarm-runtime/<sessionId>` — never touches global settings.
 */
export function buildSwarmLaunchRuntime(args: {
  session: SwarmSession;
  rawToken: string;
  gatewayEndpoint: string;
  configDir: string;
}): SwarmLaunchRuntime {
  const tempConfigDir = path.join(args.configDir, "swarm-runtime", args.session.id);
  mkdirSync(tempConfigDir, { mode: privateDirMode, recursive: true });

  const helperFile = path.join(tempConfigDir, process.platform === "win32" ? "ccr-swarm-token-helper.cmd" : "ccr-swarm-token-helper.sh");
  const settingsFile = path.join(tempConfigDir, "settings.json");

  const helperScript = buildTokenHelperScript(args.rawToken);
  writeFileSync(helperFile, helperScript, { mode: executableFileMode });
  chmodSync(helperFile, executableFileMode);

  // Minimal settings: point Claude Code at the token helper. NO model is asserted — CCR routes.
  const settings = {
    env: {} as Record<string, string>,
    apiKeyHelper: process.platform === "win32" ? `"${helperFile}"` : helperFile
  };
  writeFileSync(settingsFile, JSON.stringify(settings), { mode: privateFileMode });
  chmodSync(settingsFile, privateFileMode);

  const env: Record<string, string> = {
    ANTHROPIC_BASE_URL: args.gatewayEndpoint,
    ANTHROPIC_API_BASE_URL: args.gatewayEndpoint,
    CLAUDE_AGENT_API_BASE_URL: args.gatewayEndpoint,
    CLAUDE_CONFIG_DIR: tempConfigDir,
    // Informative only; routing is decided by CCR from the resolved Swarm Session, not these.
    CCR_SWARM_SESSION_ID: args.session.id,
    CCR_SWARM_ID: args.session.swarmId
  };
  return { tempConfigDir, settingsFile, helperFile, env };
}

/** Delete the ephemeral runtime dir (raw-token helper + temp settings). */
export function disposeSwarmLaunchRuntime(tempConfigDir: string): void {
  try {
    rmSync(tempConfigDir, { recursive: true, force: true });
  } catch {
    // best-effort
  }
}

/**
 * The token helper script echoes the raw token when Claude Code calls it.
 * (Mirrors CCR's existing apiKeyHelper pattern; the token never enters env that CCR logs.)
 */
function buildTokenHelperScript(rawToken: string): string {
  if (process.platform === "win32") {
    return [`@echo off`, `echo ${rawToken}`].join("\r\n");
  }
  return [`#!/bin/sh`, `printf '%s' "${rawToken.replace(/["\\]/g, "\\$&")}"`].join("\n");
}
