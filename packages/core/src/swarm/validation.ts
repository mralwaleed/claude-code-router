/**
 * Swarm validation foundations (Phase 1).
 *
 * Pure functions. No I/O. These underpin:
 *  - provider/model resolution by STABLE id (display names are import candidates only),
 *  - SwarmProfile validation (leader/default/fallback assignments must resolve),
 *  - duplicate canonical-body fingerprint (collision) detection — requirement 5.
 *
 * Frontmatter provider/model text is NEVER trusted for routing: it is an import candidate
 * that must resolve to a stable provider id + model membership before it can override.
 */
import type { SwarmAgent, SwarmProfile, SwarmProviderView } from "@ccr/core/swarm/contracts";

/** Build provider views from a minimal provider shape (decouples validation from AppConfig). */
export function providerViewsFromConfig(
  providers: Array<{ id?: string; name: string; models: readonly string[] }>
): SwarmProviderView[] {
  return providers.map((provider) => ({
    id: (provider.id ?? provider.name).trim(),
    name: provider.name.trim(),
    models: provider.models.map((model) => model)
  }));
}

export type ResolvedAssignment = {
  ok: boolean;
  /** Stable provider id when ok; best-effort otherwise. */
  providerId: string;
  model: string;
  errors: string[];
};

/**
 * Resolve an assignment to a stable {providerId, model}, validating model membership.
 * Accepts either a providerId or a display providerName (import candidate). Never throws.
 */
export function resolveAssignment(
  assignment: { providerId?: string; providerName?: string; model?: string },
  providers: readonly SwarmProviderView[]
): ResolvedAssignment {
  const errors: string[] = [];
  const model = (assignment.model ?? "").trim();
  if (!model) {
    errors.push("model is empty");
  }
  const wantedId = (assignment.providerId ?? "").trim().toLowerCase();
  const wantedName = (assignment.providerName ?? "").trim().toLowerCase();

  let matched: SwarmProviderView | undefined;
  if (wantedId) {
    matched = providers.find((p) => p.id.toLowerCase() === wantedId);
  }
  if (!matched && wantedName) {
    matched = providers.find((p) => p.name.toLowerCase() === wantedName || p.id.toLowerCase() === wantedName);
  }
  if (!matched) {
    errors.push(
      `provider not found${wantedId ? ` (id="${wantedId}")` : ""}${wantedName ? ` (name="${wantedName}")` : ""}`
    );
  }
  if (matched && model && !matched.models.includes(model)) {
    errors.push(`model "${model}" is not registered under provider "${matched.name}"`);
  }
  return {
    ok: errors.length === 0,
    providerId: matched?.id ?? "",
    model,
    errors
  };
}

export type SwarmProfileValidation = {
  ok: boolean;
  errors: string[];
  warnings: string[];
};

/**
 * Validate a SwarmProfile's routing assignments against the known providers.
 * Leader and default MUST resolve (hard requirement for launch). Fallback is optional but
 * validated when declared.
 */
export function validateSwarmProfile(
  profile: SwarmProfile,
  providers: readonly SwarmProviderView[]
): SwarmProfileValidation {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!profile.name.trim()) {
    errors.push("swarm name is empty");
  }
  if (!profile.workspaceRoots.some((root) => root.trim())) {
    errors.push("at least one workspace root is required");
  }
  if (!profile.launchDirectory.trim()) {
    warnings.push("launch directory is empty; launch may fail");
  }

  const leader = resolveAssignment(
    { providerId: profile.leaderProviderId, model: profile.leaderModel },
    providers
  );
  if (!leader.ok) {
    errors.push(`leader assignment invalid: ${leader.errors.join("; ")}`);
  }
  const def = resolveAssignment(
    { providerId: profile.defaultProviderId, model: profile.defaultModel },
    providers
  );
  if (!def.ok) {
    errors.push(`default assignment invalid: ${def.errors.join("; ")}`);
  }
  if (profile.fallbackModel.trim() || profile.fallbackProviderId.trim()) {
    const fb = resolveAssignment(
      { providerId: profile.fallbackProviderId, model: profile.fallbackModel },
      providers
    );
    if (!fb.ok) {
      warnings.push(`fallback assignment invalid: ${fb.errors.join("; ")}`);
    }
  }

  return { ok: errors.length === 0, errors, warnings };
}

export type FingerprintCollision = {
  bodyHash: string;
  agentIds: string[];
};

/**
 * Detect agents that share an identical canonical full-body fingerprint.
 * Two enabled agents with the same body are genuinely indistinguishable to exact attribution
 * and must not be allowed to route nondeterministically. (requirement 5)
 */
export function detectFingerprintCollisions(
  agents: ReadonlyArray<{ id: string; bodyHash: string; enabled: boolean }>
): FingerprintCollision[] {
  const byHash = new Map<string, string[]>();
  for (const agent of agents) {
    if (!agent.enabled) {
      continue;
    }
    const hash = agent.bodyHash.trim();
    if (!hash) {
      continue;
    }
    const list = byHash.get(hash) ?? [];
    list.push(agent.id);
    byHash.set(hash, list);
  }
  const collisions: FingerprintCollision[] = [];
  for (const [hash, agentIds] of byHash) {
    if (agentIds.length > 1) {
      collisions.push({ bodyHash: hash, agentIds });
    }
  }
  return collisions;
}

/**
 * Apply collision results to a set of agents: mark colliding agents' validationStatus as
 * "collides" with a descriptive error. Returns a new array (does not mutate input). Generic so
 * it preserves extension fields (e.g. ScannedAgent.canonicalBody).
 */
export function applyCollisionStatus<T extends SwarmAgent>(
  agents: readonly T[],
  collisions: readonly FingerprintCollision[]
): T[] {
  const collidingIds = new Set(collisions.flatMap((collision) => collision.agentIds));
  return agents.map((agent) => {
    if (!collidingIds.has(agent.id)) {
      return agent;
    }
    const match = collisions.find((collision) => collision.agentIds.includes(agent.id));
    return {
      ...agent,
      validationStatus: "collides",
      validationErrors: [
        ...agent.validationErrors,
        `identical canonical body shared with: ${match?.agentIds.filter((id) => id !== agent.id).join(", ")}`
      ]
    } as T;
  });
}
