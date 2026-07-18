/**
 * Sanitized Swarm API DTOs (Phase 5A) — the shapes the renderer/main IPC ever sees.
 *
 * SECURITY: these NEVER carry raw tokens, token hashes, provider API keys, full system prompts,
 * canonical agent bodies, or internal auth headers. Agent hashes are exposed only as a short
 * diagnostic prefix. Session records omit auth_token_hash.
 */
import type { SwarmAgent, SwarmAttribution, SwarmProfile, SwarmSession } from "@ccr/core/swarm/contracts";

export type SwarmProfileDto = SwarmProfile;

export type SwarmAgentDto = {
  id: string;
  swarmId: string;
  slug: string;
  displayName: string;
  sourceFile: string;
  providerOverrideId: string;
  modelOverride: string;
  enabled: boolean;
  capabilities: string[];
  /** Short diagnostic prefix of the body hash (first 8 chars). Never the full hash or body. */
  bodyHashPrefix: string;
  assignmentSource: SwarmAgent["assignmentSource"];
  validationStatus: SwarmAgent["validationStatus"];
  validationErrors: string[];
  lastLoadedAt: string;
  lastModifiedAt: string;
};

export type SwarmSessionDto = {
  id: string;
  swarmId: string;
  workspace: string;
  launchDirectory: string;
  processId: number | null;
  claudeSessionId: string;
  startedAt: string;
  lastSeenAt: string;
  endedAt: string;
  status: SwarmSession["status"];
  launcherType: SwarmSession["launcherType"];
};

export type SwarmAttributionDto = {
  requestId: string;
  swarmId: string;
  swarmSessionId: string;
  classification: string;
  agentId: string;
  candidateAgentIds: string[];
  routingReason: string;
  selectedProviderId: string;
  selectedModel: string;
  fallbackReason: string;
  createdAt: string;
};

export type SwarmDiagnosticsDto = {
  profileErrors: string[];
  profileWarnings: string[];
  agentErrors: SwarmAgentDto[];
  watcherStatus: string;
  registryGeneration: number;
  activeSessionCount: number;
  recentAttributions: SwarmAttributionDto[];
};

export function toAgentDto(agent: SwarmAgent): SwarmAgentDto {
  // NEVER include canonicalBody; expose only a short hash prefix.
  return {
    id: agent.id,
    swarmId: agent.swarmId,
    slug: agent.slug,
    displayName: agent.displayName,
    sourceFile: agent.sourceFile,
    providerOverrideId: agent.providerOverrideId,
    modelOverride: agent.modelOverride,
    enabled: agent.enabled,
    capabilities: agent.capabilities,
    bodyHashPrefix: agent.bodyHash ? agent.bodyHash.slice(0, 8) : "",
    assignmentSource: agent.assignmentSource,
    validationStatus: agent.validationStatus,
    validationErrors: agent.validationErrors,
    lastLoadedAt: agent.lastLoadedAt,
    lastModifiedAt: agent.lastModifiedAt
  };
}

export function toSessionDto(session: SwarmSession): SwarmSessionDto {
  // NEVER include auth_token_hash.
  return {
    id: session.id,
    swarmId: session.swarmId,
    workspace: session.workspace,
    launchDirectory: session.launchDirectory,
    processId: session.processId,
    claudeSessionId: session.claudeSessionId,
    startedAt: session.startedAt,
    lastSeenAt: session.lastSeenAt,
    endedAt: session.endedAt,
    status: session.status,
    launcherType: session.launcherType
  };
}

export function toAttributionDto(attribution: SwarmAttribution): SwarmAttributionDto {
  return {
    requestId: attribution.requestId,
    swarmId: attribution.swarmId,
    swarmSessionId: attribution.swarmSessionId,
    classification: attribution.classification,
    agentId: attribution.agentId,
    candidateAgentIds: attribution.candidateAgentIds,
    routingReason: attribution.routingReason,
    selectedProviderId: attribution.selectedProviderId,
    selectedModel: attribution.selectedModel,
    fallbackReason: attribution.fallbackReason,
    createdAt: attribution.createdAt
  };
}
