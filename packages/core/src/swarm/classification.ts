/**
 * Deterministic request classification (Phase 4).
 *
 * Exact order, evaluated AFTER a Swarm Session is authenticated and BEFORE any model marker is
 * consulted:
 *   1. canonicalize system content
 *   2. exact canonical-body containment against enabled agents with a non-empty body ≥ MIN length
 *      - exactly one contained  => AGENT (exact body containment)
 *      - more than one          => AMBIGUOUS (record all candidate ids; never guess)
 *      - none                   => evaluate the versioned leader detector
 *        - detector confirms    => LEADER
 *        - else                 => UNKNOWN
 *
 * No fuzzy matching, no embeddings, no edit distance, no distinctiveHash, no filename/order
 * guesses. Markers are not consulted before classification completes.
 */
import { canonicalizeSystem } from "@ccr/core/swarm/canonicalize";
import type { AgentClassification, LeaderDetector } from "@ccr/core/swarm/contracts";

/**
 * Minimum canonical-body length for an agent to be a containment candidate.
 * Justification from Phase 0 evidence: real Claude Code agent bodies are large (the captured
 * planner body is ~6.9k chars; all SIYAJ agents are >1k). 64 is far below any real agent body
 * but high enough that a trivial/stub agent file (e.g. "ok") cannot accidentally be contained in
 * an unrelated system prompt and cause a false AGENT attribution.
 */
export const MIN_CANONICAL_BODY_LENGTH = 64;

/** Minimal agent shape classification needs (decoupled from the full registry snapshot). */
export type ClassifiableAgent = {
  id: string;
  enabled: boolean;
  validationStatus: string;
  canonicalBody: string;
};

/** Minimal registry shape classification operates on (one immutable snapshot per request). */
export type ClassificationRegistry = {
  agents: ReadonlyArray<ClassifiableAgent>;
  generation: number;
};

export type ClassificationDiagnostics = {
  classification: AgentClassification;
  candidateAgentIds: string[];
  matchedLeaderAnchors: string[];
  registryGeneration: number;
};

export function classifyRequest(args: {
  system: unknown;
  registry: ClassificationRegistry;
  leaderDetector: LeaderDetector;
}): ClassificationDiagnostics {
  const canonical = canonicalizeSystem(args.system);
  const candidateAgentIds: string[] = [];
  for (const agent of args.registry.agents) {
    if (!agent.enabled) {
      continue;
    }
    if (!agent.canonicalBody || agent.canonicalBody.length < MIN_CANONICAL_BODY_LENGTH) {
      continue;
    }
    if (canonical.includes(agent.canonicalBody)) {
      candidateAgentIds.push(agent.id);
    }
  }
  candidateAgentIds.sort();

  if (candidateAgentIds.length === 1) {
    return {
      classification: { kind: "agent", agentId: candidateAgentIds[0], confidence: "exact", method: "exact-body-containment" },
      candidateAgentIds,
      matchedLeaderAnchors: [],
      registryGeneration: args.registry.generation
    };
  }
  if (candidateAgentIds.length > 1) {
    return {
      classification: { kind: "ambiguous", candidateAgentIds: [...candidateAgentIds] },
      candidateAgentIds: [...candidateAgentIds],
      matchedLeaderAnchors: [],
      registryGeneration: args.registry.generation
    };
  }

  const leader = args.leaderDetector.evaluate(canonical);
  if (leader.matched) {
    return {
      classification: { kind: "leader", detectorVersion: leader.version },
      candidateAgentIds: [],
      matchedLeaderAnchors: [...leader.matchedAnchors],
      registryGeneration: args.registry.generation
    };
  }
  return {
    classification: { kind: "unknown" },
    candidateAgentIds: [],
    matchedLeaderAnchors: [...leader.matchedAnchors],
    registryGeneration: args.registry.generation
  };
}
