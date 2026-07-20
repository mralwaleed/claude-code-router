/**
 * Swarm attribution builder (Phase 4).
 *
 * Builds the persisted SwarmAttribution record from the classification diagnostics + routing
 * result. Never includes the raw token, full system prompt, canonical body, secret headers, or
 * provider credentials — only identifiers, labels, and the selected provider/model.
 */
import type { SwarmAttribution, SwarmSession } from "@ccr/core/swarm/contracts";
import type { ClassificationDiagnostics } from "@ccr/core/swarm/classification";
import type { SwarmRoutingResult } from "@ccr/core/swarm/routing";

export function buildSwarmAttribution(args: {
  requestId: string;
  session: SwarmSession;
  diagnostics: ClassificationDiagnostics;
  routing: SwarmRoutingResult;
  now: string;
}): SwarmAttribution {
  const classification = args.diagnostics.classification;
  const label = classification.kind === "agent" ? "exact" : classification.kind;
  return {
    requestId: args.requestId,
    swarmId: args.session.swarmId,
    swarmSessionId: args.session.id,
    claudeSessionId: args.session.claudeSessionId,
    classification: label,
    agentId: classification.kind === "agent" ? classification.agentId : "",
    candidateAgentIds: [...args.diagnostics.candidateAgentIds],
    attributionMethod:
      classification.kind === "agent"
        ? "exact-body-containment"
        : classification.kind === "leader"
          ? "leader-detector"
          : "swarm-default",
    attributionConfidence: label,
    detectorVersion: classification.kind === "leader" ? classification.detectorVersion : "",
    matchedLeaderAnchors: [...args.diagnostics.matchedLeaderAnchors],
    registryGeneration: args.diagnostics.registryGeneration,
    routingReason: args.routing.reason,
    selectedProviderId: args.routing.providerId ?? "",
    selectedModel: args.routing.model ?? "",
    fallbackReason: args.routing.owns ? "" : args.routing.reason,
    createdAt: args.now
  };
}
