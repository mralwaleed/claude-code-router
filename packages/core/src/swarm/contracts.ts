/**
 * Swarm domain contracts (Phase 1).
 *
 * Pure types + frozen constants only. No routing, attribution, scanning, or I/O here.
 * The attribution/classification/leader-detector behaviour is frozen as contracts now
 * and implemented in later phases:
 *   - canonicalization ......... Phase 1 (swarm/canonicalize.ts)
 *   - agent registry / scan ..... Phase 2
 *   - leader detector anchors ... Phase 4
 *   - classification order ...... Phase 4
 */

/** Swarm persistence schema version (swarms.sqlite). Bump + add a migration in store.ts on change. */
export const SWARM_SCHEMA_VERSION = 1;

/** v1 supports exact-only attribution. Fuzzy/probabilistic matching is intentionally excluded. */
export type SwarmRoutingMode = "exact";

export type SwarmProfile = {
  id: string;
  schemaVersion: number;
  name: string;
  description: string;
  enabled: boolean;
  /** Absolute workspace roots owned by this swarm (path-boundary matched at launch time). */
  workspaceRoots: string[];
  /** CWD the launched Claude Code runs in. */
  launchDirectory: string;
  /** Project CLAUDE.md (kept for reference; NOT used for leader fingerprinting — see leader-detector). */
  mainInstructionFile: string;
  /** Directories scanned for agent definition files. */
  agentDirectories: string[];
  leaderProviderId: string;
  leaderModel: string;
  defaultProviderId: string;
  defaultModel: string;
  fallbackProviderId: string;
  fallbackModel: string;
  routingMode: SwarmRoutingMode;
  autoDetectWorkspace: boolean;
  watchFiles: boolean;
  createdAt: string;
  updatedAt: string;
};

export type SwarmAssignmentSource = "override" | "frontmatter" | "leader" | "default";

export type SwarmAgentValidationStatus =
  | "ok"
  | "degraded"
  | "invalid"
  | "collides"
  | "under-distinctive";

export type SwarmAgent = {
  id: string;
  swarmId: string;
  slug: string;
  displayName: string;
  /** Absolute source file path. */
  sourceFile: string;
  /** Stable provider id (resolved from override); empty if unresolved. */
  providerOverrideId: string;
  modelOverride: string;
  enabled: boolean;
  capabilities: string[];
  /**
   * Body fingerprint: sha256 of the canonical FULL agent body (whitespace-collapsed).
   * Used for storage, indexing, equality, and collision detection. Attribution is NOT a
   * hash comparison — it is canonical-body CONTAINMENT in the canonical system (see below).
   */
  bodyHash: string;
  /**
   * Stored diagnostic index: sha256 of a canonical distinctive-section prefix. NOT used for
   * v1 attribution (v1 is exact full-body containment only); kept for future use/diagnostics.
   */
  distinctiveHash: string;
  assignmentSource: SwarmAssignmentSource;
  validationStatus: SwarmAgentValidationStatus;
  validationErrors: string[];
  lastLoadedAt: string;
  lastModifiedAt: string;
};

/**
 * Persisted Swarm session lifecycle states. Persisted so restart behaviour is deterministic.
 * Accepting (request is swarm-routed): "active", "reattached".
 * Not accepting (fail-closed for that session): "stopped", "expired", "invalid".
 *   - active     : minted, accepting requests
 *   - reattached : survived a gateway/desktop restart (first post-restart request confirmed)
 *   - stopped    : explicitly revoked by the user/UI/CLI
 *   - expired    : TTL idle or absolute max-lifetime exceeded
 *   - invalid    : corrupt / unknown / binding-mismatch
 */
export type SwarmSessionStatus = "active" | "reattached" | "stopped" | "expired" | "invalid";
export type SwarmLauncherType = "desktop" | "cli" | "detect";

export type SwarmSession = {
  /** Public session uuid; safe to surface in logs/UI. NOT the auth token. */
  id: string;
  swarmId: string;
  /** sha256 hex of the raw auth token. The raw token is never persisted. */
  authTokenHash: string;
  workspace: string;
  launchDirectory: string;
  processId: number | null;
  /** Bound Claude Code session id (from metadata.user_id), once observed. */
  claudeSessionId: string;
  startedAt: string;
  lastSeenAt: string;
  endedAt: string;
  status: SwarmSessionStatus;
  launcherType: SwarmLauncherType;
  ttlMs: number;
};

/**
 * Attribution confidence. v1 is exact-only:
 * - "exact"     : exactly one registered agent body matched (canonical containment)
 * - "ambiguous" : more than one agent matched — do NOT guess
 * - "leader"    : no agent matched AND the versioned leader detector matched
 * - "unknown"   : no agent matched AND leader detector did not confirm
 * There is deliberately no "high"/fuzzy tier.
 */
export type AttributionConfidence = "exact" | "ambiguous" | "unknown" | "leader";

export type AttributionMethod = "exact-body-containment" | "leader-detector" | "swarm-default";

export const SWARM_ROUTING_REASON = {
  agentOverride: "swarm:agent-override",
  agentFrontmatter: "swarm:agent-frontmatter",
  leader: "swarm:leader",
  leaderUnconfirmed: "swarm:leader-unconfirmed",
  default: "swarm:default",
  unknownFallback: "swarm:unknown-agent-fallback",
  ambiguousFallback: "swarm:ambiguous-agent-fallback"
} as const;
export type SwarmRoutingReason = (typeof SWARM_ROUTING_REASON)[keyof typeof SWARM_ROUTING_REASON];

export type SwarmAttribution = {
  requestId: string;
  swarmSessionId: string;
  swarmId: string;
  /** Matched agent id; empty for leader/unknown. */
  agentId: string;
  confidence: AttributionConfidence;
  method: AttributionMethod;
  /** Leader detector version when confidence is "leader"; "" otherwise. Recorded in logs. */
  detectorVersion: string;
  routingReason: string;
  fallbackReason: string;
  /** All matching candidate agent ids (populated for ambiguous; logged in diagnostics). */
  candidateAgentIds: string[];
  createdAt: string;
};

/**
 * Frozen classification contract (Phase 4 implements the deterministic order):
 * 1. canonicalize the request's system blocks
 * 2. exact registered-agent-body CONTAINMENT (canonical agent body is a substring of the
 *    canonical system content — NOT a hash match; bodyHash is only a fast pre-filter/index):
 *    - exactly one agent body contained => agent (exact body containment)
 *    - more than one agent body contained => ambiguous (do not guess; record all candidate ids)
 *    - none contained => evaluate the versioned leader detector
 *      - detector confirms => leader
 *      - else => unknown
 * Duplicate canonical agent bodies (same bodyHash) are a validation error surfaced before
 * launch; they never produce nondeterministic routing.
 */
export type AgentClassification =
  | { kind: "agent"; agentId: string; confidence: "exact"; method: "exact-body-containment" }
  | { kind: "ambiguous"; candidateAgentIds: string[] }
  | { kind: "leader"; detectorVersion: string }
  | { kind: "unknown" };

// ---- Leader detector (impl + real anchors land in Phase 4; interface frozen now) ----

export type LeaderDetectorVersion = string;

/** A single stable anchor. `mandatory` anchors must ALL match; optional anchors add corroboration. */
export type LeaderDetectorAnchor = {
  id: string;
  /** Canonical substring to locate. Kept short + stable. */
  pattern: string;
  mandatory: boolean;
};

export type LeaderDetectorResult =
  | { matched: true; version: LeaderDetectorVersion; matchedAnchors: string[] }
  | { matched: false; version: LeaderDetectorVersion; matchedAnchors: string[] };

/**
 * Versioned, multi-anchor leader detector. Isolated behind this interface so the anchor
 * set can be revised when Claude Code changes, without touching routing code.
 * Contract: ALL mandatory anchors must match (strict deterministic rule); a partial or
 * coincidental anchor match must NOT classify as leader.
 */
export interface LeaderDetector {
  readonly version: LeaderDetectorVersion;
  evaluate(canonicalSystem: string): LeaderDetectorResult;
}

// ---- Runtime / feature flag ----

// SwarmRuntimeConfig lives in contracts/app.ts (config-contracts home). It is re-exported
// here for swarm consumers via `@ccr/core/contracts/app`.

/** Minimal provider view used by validation (decouples validation from full AppConfig). */
export type SwarmProviderView = {
  id: string;
  name: string;
  models: string[];
};
