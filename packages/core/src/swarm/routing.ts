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
  const policy = profile.fallbackPolicy ?? "existing-ccr";

  const trySwarmDefault = (reason: string): Resolved | undefined =>
    resolveAssignmentWithReason(profile.defaultProviderId, profile.defaultModel, reason, providers) ??
    resolveAssignmentWithReason(profile.fallbackProviderId, profile.fallbackModel, reason, providers);

  // REJECT = Swarm owns but has no valid model → gateway returns a controlled 503.
  const reject = (): SwarmRoutingResult => ({ owns: true, reason: SWARM_ROUTING_REASON.assignmentInvalid });
  // DECLINE = hand off to existing CCR routing.
  const decline = (): SwarmRoutingResult => ({ owns: false, reason: SWARM_ROUTING_REASON.assignmentInvalid });
  // Unresolved policy resolution (after direct + default attempts fail)
  const unresolved = (): SwarmRoutingResult => (policy === "existing-ccr" ? decline() : reject());

  if (classification.kind === "agent") {
    const agent = agents.find((a) => a.id === classification.agentId);
    const direct = agent ? resolveAgentAssignment(agent, providers) : undefined;
    if (direct) return { owns: true, model: direct.model, providerId: direct.providerId, reason: direct.reason };
    // Direct invalid — fail-closed rejects immediately; others try swarm default
    if (policy === "fail-closed") return reject();
    const def = trySwarmDefault(SWARM_ROUTING_REASON.defaultUnknown);
    if (def) return { owns: true, model: def.model, providerId: def.providerId, reason: def.reason };
    return unresolved();
  }

  if (classification.kind === "leader") {
    const direct = resolveAssignmentWithReason(profile.leaderProviderId, profile.leaderModel, SWARM_ROUTING_REASON.leader, providers);
    if (direct) return { owns: true, model: direct.model, providerId: direct.providerId, reason: direct.reason };
    if (policy === "fail-closed") return reject();
    const def = trySwarmDefault(SWARM_ROUTING_REASON.defaultUnknown);
    if (def) return { owns: true, model: def.model, providerId: def.providerId, reason: def.reason };
    return unresolved();
  }

  // unknown / ambiguous: the swarm default IS the direct assignment
  const reason = classification.kind === "unknown" ? SWARM_ROUTING_REASON.defaultUnknown : SWARM_ROUTING_REASON.defaultAmbiguous;
  const def = trySwarmDefault(reason);
  if (def) return { owns: true, model: def.model, providerId: def.providerId, reason: def.reason };
  return unresolved();
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
