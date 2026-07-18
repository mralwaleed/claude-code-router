/**
 * Swarm routing resolution (Phase 4).
 *
 * Given a classification, resolves the Swarm assignment to a concrete {providerId, model, reason}
 * or DECLINES (owns=false) when no valid assignment exists — in which case the caller falls
 * through to existing CCR routing (markers/profile/default). A valid Swarm decision is never
 * overridden by legacy markers (markers apply only on decline).
 *
 * Assignment precedence within an agent: UI override > frontmatter. Frontmatter providerId
 * takes precedence over display provider name (handled by validation.resolveAssignment).
 * Unknown/ambiguous cascade to the swarm fallback assignment when the default is invalid.
 */
import type {
  SwarmAgent,
  SwarmProfile,
  SwarmProviderView,
  SwarmRoutingReason,
  SwarmSession
} from "@ccr/core/swarm/contracts";
import { SWARM_ROUTING_REASON } from "@ccr/core/swarm/contracts";
import type { RegistrySnapshot } from "@ccr/core/swarm/registry";
import { classifyRequest, type ClassificationDiagnostics } from "@ccr/core/swarm/classification";
import type { LeaderDetector } from "@ccr/core/swarm/contracts";
import { resolveAssignment } from "@ccr/core/swarm/validation";

export type SwarmRequestContext = {
  session: SwarmSession;
  profile: SwarmProfile;
  registry: RegistrySnapshot;
  providers: ReadonlyArray<SwarmProviderView>;
};

export type SwarmRoutingResult = {
  /** true when Swarm owns the request and produced a usable model. */
  owns: boolean;
  model?: string;
  providerId?: string;
  reason: SwarmRoutingReason | string;
};

type Resolved = { model: string; providerId: string; reason: string };

function resolveAgentAssignment(agent: SwarmAgent, providers: ReadonlyArray<SwarmProviderView>): Resolved | undefined {
  const r = resolveAssignment({ providerId: agent.providerOverrideId, model: agent.modelOverride }, providers);
  if (!r.ok) {
    return undefined;
  }
  const reason = agent.assignmentSource === "override" ? SWARM_ROUTING_REASON.agentUiOverride : SWARM_ROUTING_REASON.agentFrontmatter;
  return { model: r.model, providerId: r.providerId, reason };
}

function resolveAssignmentWithReason(
  providerId: string,
  model: string,
  reason: string,
  providers: ReadonlyArray<SwarmProviderView>
): Resolved | undefined {
  const r = resolveAssignment({ providerId, model }, providers);
  return r.ok ? { model: r.model, providerId: r.providerId, reason } : undefined;
}

export function resolveSwarmRouting(args: {
  diagnostics: ClassificationDiagnostics;
  profile: SwarmProfile;
  agents: ReadonlyArray<SwarmAgent>;
  providers: ReadonlyArray<SwarmProviderView>;
}): SwarmRoutingResult {
  const { diagnostics, profile, agents, providers } = args;
  const classification = diagnostics.classification;
  let resolved: Resolved | undefined;

  if (classification.kind === "agent") {
    const agent = agents.find((a) => a.id === classification.agentId);
    if (agent) {
      resolved = resolveAgentAssignment(agent, providers);
    }
  } else if (classification.kind === "leader") {
    resolved = resolveAssignmentWithReason(profile.leaderProviderId, profile.leaderModel, SWARM_ROUTING_REASON.leader, providers);
  } else if (classification.kind === "unknown") {
    resolved =
      resolveAssignmentWithReason(profile.defaultProviderId, profile.defaultModel, SWARM_ROUTING_REASON.defaultUnknown, providers) ??
      resolveAssignmentWithReason(profile.fallbackProviderId, profile.fallbackModel, SWARM_ROUTING_REASON.defaultUnknown, providers);
  } else {
    // ambiguous
    resolved =
      resolveAssignmentWithReason(profile.defaultProviderId, profile.defaultModel, SWARM_ROUTING_REASON.defaultAmbiguous, providers) ??
      resolveAssignmentWithReason(profile.fallbackProviderId, profile.fallbackModel, SWARM_ROUTING_REASON.defaultAmbiguous, providers);
  }

  if (resolved) {
    return { owns: true, model: resolved.model, providerId: resolved.providerId, reason: resolved.reason };
  }

  // Primary assignment unresolved — apply fallback policy
  const policy = profile.fallbackPolicy ?? "existing-ccr";

  if (policy === "swarm-default-required" && (classification.kind === "agent" || classification.kind === "leader")) {
    const fallbackToDefault = resolveAssignmentWithReason(profile.defaultProviderId, profile.defaultModel, SWARM_ROUTING_REASON.defaultUnknown, providers)
      ?? resolveAssignmentWithReason(profile.fallbackProviderId, profile.fallbackModel, SWARM_ROUTING_REASON.defaultUnknown, providers);
    if (fallbackToDefault) {
      return { owns: true, model: fallbackToDefault.model, providerId: fallbackToDefault.providerId, reason: fallbackToDefault.reason };
    }
  }

  if (policy === "fail-closed") {
    // No fallback to CCR; Swarm owns the request but has no valid model → controlled failure.
    return { owns: true, reason: SWARM_ROUTING_REASON.assignmentInvalid };
  }

  // existing-ccr (default): decline → existing CCR routing handles the request
  return { owns: false, reason: SWARM_ROUTING_REASON.assignmentInvalid };
}

/** Classify + route in one step (operates on one immutable registry snapshot). */
export function resolveSwarmRequest(args: {
  system: unknown;
  ctx: SwarmRequestContext;
  leaderDetector: LeaderDetector;
}): { diagnostics: ClassificationDiagnostics; routing: SwarmRoutingResult } {
  const diagnostics = classifyRequest({
    system: args.system,
    registry: args.ctx.registry,
    leaderDetector: args.leaderDetector
  });
  const routing = resolveSwarmRouting({
    diagnostics,
    profile: args.ctx.profile,
    agents: args.ctx.registry.agents,
    providers: args.ctx.providers
  });
  return { diagnostics, routing };
}
