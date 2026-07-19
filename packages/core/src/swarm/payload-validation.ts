/**
 * Strict payload validation for Swarm mutations (Phase 5A.4).
 *
 * Rejects prototype-pollution keys, null bytes, oversized strings, type mismatches,
 * and unsafe slug characters. All persisted agentOverrides use a null-prototype map
 * so inherited properties (__proto__, constructor) cannot inject dangerous keys.
 */

const DANGEROUS_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const MAX_ID_LENGTH = 128;
const MAX_PROVIDER_LENGTH = 256;
const MAX_MODEL_LENGTH = 256;
const SLUG_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function hasNullByte(value: string): boolean {
  return value.includes("\0");
}

/** Validate a Swarm ID (alphanumeric + _ -, non-empty, ≤128 chars, no null bytes). */
export function validateSwarmId(id: unknown): string | undefined {
  if (typeof id !== "string" || id.length === 0 || id.length > MAX_ID_LENGTH) return undefined;
  if (hasNullByte(id) || !/^[A-Za-z0-9_-]+$/.test(id)) return undefined;
  return id;
}

/** Validate an agent slug (alphanumeric + . _ -, non-empty, no dangerous keys). */
export function validateAgentSlug(slug: unknown): string | undefined {
  if (typeof slug !== "string" || slug.length === 0 || slug.length > MAX_ID_LENGTH) return undefined;
  if (hasNullByte(slug) || !SLUG_PATTERN.test(slug)) return undefined;
  if (DANGEROUS_KEYS.has(slug)) return undefined; // reject __proto__, constructor, prototype
  return slug;
}

/** Validate a provider ID (non-empty string, ≤256 chars, no null bytes, not a dangerous key). */
export function validateProviderId(providerId: unknown): string | undefined {
  if (typeof providerId !== "string" || providerId.trim().length === 0 || providerId.length > MAX_PROVIDER_LENGTH) return undefined;
  if (hasNullByte(providerId) || DANGEROUS_KEYS.has(providerId)) return undefined;
  return providerId.trim();
}

/** Validate a model name. */
export function validateModelName(model: unknown): string | undefined {
  if (typeof model !== "string" || model.trim().length === 0 || model.length > MAX_MODEL_LENGTH) return undefined;
  if (hasNullByte(model)) return undefined;
  return model.trim();
}

/** Validate the fallback policy enum. */
export function validateFallbackPolicy(policy: unknown): "existing-ccr" | "swarm-default-required" | "fail-closed" | undefined {
  if (policy === "existing-ccr" || policy === "swarm-default-required" || policy === "fail-closed") return policy;
  return undefined;
}

export type OverrideInput = { providerId?: string; model?: string; enabled?: boolean };

/** Sanitize and validate an agent override payload into a safe shape. */
export function validateOverridePayload(input: unknown): OverrideInput | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
  const obj = input as Record<string, unknown>;
  const result: OverrideInput = {};
  if (obj.providerId !== undefined) {
    const pid = validateProviderId(obj.providerId);
    if (pid === undefined) return undefined;
    result.providerId = pid;
  }
  if (obj.model !== undefined) {
    const m = validateModelName(obj.model);
    if (m === undefined) return undefined;
    result.model = m;
  }
  if (obj.enabled !== undefined) {
    if (typeof obj.enabled !== "boolean") return undefined;
    result.enabled = obj.enabled;
  }
  // reject unknown fields
  for (const key of Object.keys(obj)) {
    if (!["providerId", "model", "enabled"].includes(key)) return undefined;
  }
  return result;
}

/**
 * Sanitize an agentOverrides map into a null-prototype safe map.
 * Rejects dangerous keys (__proto__, constructor, prototype) and validates slug keys.
 */
export function sanitizeOverrideMap(input: unknown): Record<string, OverrideInput> {
  const safe = Object.create(null) as Record<string, OverrideInput>;
  if (!input || typeof input !== "object" || Array.isArray(input)) return safe;
  for (const key of Object.keys(input as object)) {
    if (DANGEROUS_KEYS.has(key)) continue; // silently drop dangerous keys
    const slug = validateAgentSlug(key);
    if (!slug) continue;
    const value = (input as Record<string, unknown>)[key];
    const validated = validateOverridePayload(value);
    if (validated) {
      safe[slug] = validated;
    }
  }
  return safe;
}
