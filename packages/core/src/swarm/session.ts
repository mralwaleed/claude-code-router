/**
 * Swarm Session authentication + lifecycle (Phase 3).
 *
 * Dedicated internal auth namespace — Swarm launch tokens are session credentials, NOT provider
 * API keys. They never appear in api_keys, provider config, or the API-key UI. Provider
 * credentials and Swarm session credentials are separate trust domains.
 *
 * Auth decision (fail-closed for swarm-attempted tokens):
 *   - swarm-prefixed token, hash matches an ACTIVE/REATTACHED session, within TTL + max-lifetime,
 *     binding ok   => authenticated (session attached)
 *   - swarm-prefixed token, unknown hash / EXPIRED / STOPPED / INVALID / binding-mismatch
 *                  => REJECT (fail-closed for that session; never authenticated as another swarm
 *                     or as ordinary routing — only non-swarm tokens fall back to ordinary CCR)
 *
 * Restart behaviour is deterministic: sessions are persisted (SwarmStore). On boot,
 * recoverSessionsOnBoot() expires any ACTIVE/REATTACHED session whose TTL/max-lifetime already
 * elapsed. A still-valid session whose last activity predates this process boot transitions to
 * REATTACHED on its first post-restart request. PID is captured for diagnostics only and is
 * NEVER an auth factor (so stale-PID reuse cannot grant access).
 */
import type { SwarmSession, SwarmSessionStatus } from "@ccr/core/swarm/contracts";
import type { SwarmStore } from "@ccr/core/swarm/store";
import { hashSwarmToken, isSwarmToken, swarmTokenHashesEqual } from "@ccr/core/swarm/token";

/** Idle TTL: a session expires if no request arrives for this long (default 12h). */
export const SWARM_SESSION_DEFAULT_TTL_MS = 12 * 60 * 60 * 1000;
/** Absolute max lifetime regardless of activity (clock-jump / staleness guard, default 7d). */
export const SWARM_SESSION_DEFAULT_MAX_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;

export type SwarmAuthRejectReason = "invalid" | "expired" | "stopped" | "binding-mismatch";
export type SwarmAuthOutcome = { ok: true; session: SwarmSession } | { ok: false; reason: SwarmAuthRejectReason };
export type BindingOutcome = { ok: true } | { ok: false; reason: "invalid" | "binding-mismatch" };

export class SwarmAuth {
  private readonly bootMs: number;
  private readonly now: () => number;

  constructor(
    private readonly store: SwarmStore,
    options: { now?: () => number; bootMs?: number } = {}
  ) {
    this.now = options.now ?? (() => Date.now());
    this.bootMs = options.bootMs ?? this.now();
  }

  /** Authenticate a presented raw token. Constant-time hash compare; fail-closed on any problem. */
  async authenticate(rawToken: string): Promise<SwarmAuthOutcome> {
    if (!isSwarmToken(rawToken)) {
      return { ok: false, reason: "invalid" };
    }
    const presentedHash = hashSwarmToken(rawToken);
    const session = await this.store.getSessionByTokenHash(presentedHash);
    if (!session) {
      return { ok: false, reason: "invalid" }; // unknown token -> fail-closed (not global routing)
    }
    // defense-in-depth constant-time confirmation
    if (!swarmTokenHashesEqual(session.authTokenHash, presentedHash)) {
      return { ok: false, reason: "invalid" };
    }

    const nowMs = this.now();
    const status = computeSessionStatus(session, nowMs);
    if (status === "expired") {
      await this.store.updateSessionStatus(session.id, "expired", new Date(nowMs).toISOString());
      return { ok: false, reason: "expired" };
    }
    if (status === "stopped" || status === "invalid") {
      return { ok: false, reason: status };
    }

    // status is active or reattached
    const lastSeenMs = Date.parse(session.lastSeenAt) || this.bootMs;
    const reattached = session.status !== "reattached" && lastSeenMs < this.bootMs;
    const effectiveStatus: SwarmSessionStatus = reattached ? "reattached" : status;
    const nowIso = new Date(nowMs).toISOString();
    if (reattached) {
      await this.store.updateSessionStatus(session.id, "reattached", session.endedAt);
    }
    await this.store.touchSession(session.id, nowIso);
    return { ok: true, session: { ...session, status: effectiveStatus, lastSeenAt: nowIso } };
  }

  /**
   * Bind the Claude Code session id (from metadata.user_id) to a Swarm session exactly once.
   * Once bound, a different id is refused (binding-mismatch -> caller fail-closes).
   */
  async bindClaudeSession(sessionId: string, claudeSessionId: string | undefined): Promise<BindingOutcome> {
    if (!claudeSessionId) {
      return { ok: true }; // nothing to bind yet (body may lack metadata on some calls)
    }
    const session = await this.store.getSessionById(sessionId);
    if (!session) {
      return { ok: false, reason: "invalid" };
    }
    const bound = await this.store.bindClaudeSession(sessionId, claudeSessionId);
    return bound ? { ok: true } : { ok: false, reason: "binding-mismatch" };
  }
}

/**
 * Compute the effective status of a session at nowMs. Pure (no I/O).
 *  - stopped/invalid are terminal
 *  - idle > ttlMs  OR  age > maxLifetimeMs  => expired
 *  - otherwise active (or reattached if already reattached)
 */
export function computeSessionStatus(session: SwarmSession, nowMs: number): SwarmSessionStatus {
  if (session.status === "stopped" || session.status === "invalid") {
    return session.status;
  }
  const lastSeenMs = Date.parse(session.lastSeenAt) || nowMs;
  const startedMs = Date.parse(session.startedAt) || nowMs;
  const ttlMs = session.ttlMs || SWARM_SESSION_DEFAULT_TTL_MS;
  const maxLifetimeMs = Math.max(ttlMs, SWARM_SESSION_DEFAULT_MAX_LIFETIME_MS);
  if (nowMs - startedMs > maxLifetimeMs) {
    return "expired"; // absolute cap (guards against backward clock jumps extending a session)
  }
  if (nowMs - lastSeenMs > ttlMs) {
    return "expired"; // idle expiry
  }
  return session.status === "reattached" ? "reattached" : "active";
}

/**
 * Deterministic restart recovery: expire any ACTIVE/REATTACHED session whose TTL or max-lifetime
 * already elapsed while the gateway was down. Called once on boot. Returns the count expired.
 */
export async function recoverSessionsOnBoot(store: SwarmStore, nowMs: number = Date.now()): Promise<number> {
  const sessions = await store.listSessions();
  let expired = 0;
  for (const session of sessions) {
    if (session.status !== "active" && session.status !== "reattached") {
      continue;
    }
    if (computeSessionStatus(session, nowMs) === "expired") {
      await store.updateSessionStatus(session.id, "expired", new Date(nowMs).toISOString());
      expired += 1;
    }
  }
  return expired;
}

type HeaderValue = string | string[] | undefined;

function readHeaderString(value: HeaderValue): string | undefined {
  if (Array.isArray(value)) {
    return value[0]?.trim() || undefined;
  }
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/**
 * Extract the Claude Code session id for binding. Prefers the explicit session header; falls
 * back to `metadata.user_id` ("acct_session_<id>"). Returns undefined if not present.
 */
export function extractClaudeSessionId(
  body: Record<string, unknown> | undefined,
  headers: Record<string, HeaderValue>
): string | undefined {
  const fromHeader = readHeaderString(headers["x-claude-code-session-id"]) || readHeaderString(headers["x-claude-session-id"]);
  if (fromHeader) {
    return fromHeader;
  }
  const metadata = body?.metadata;
  if (metadata && typeof metadata === "object" && typeof (metadata as { user_id?: unknown }).user_id === "string") {
    const userId = (metadata as { user_id: string }).user_id;
    const parts = userId.split("_session_");
    if (parts.length > 1) {
      return parts[parts.length - 1];
    }
  }
  return undefined;
}
