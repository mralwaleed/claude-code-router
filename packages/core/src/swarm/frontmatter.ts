/**
 * Safe agent frontmatter parsing (Phase 2).
 *
 * Uses js-yaml v4 (`load` is safe by default — no `!!js/function` or other executable tags).
 * v1 accepts a small whitelist of flat fields. All other input is rejected or ignored.
 *
 * Rules:
 *   - frontmatter is optional (a file may be pure body)
 *   - field whitelist: name, description, provider, providerId, model, capabilities, enabled
 *   - enforce max field lengths + max capabilities count
 *   - reject non-string name/provider/providerId/model and non-boolean enabled
 *   - reject duplicate top-level YAML keys (manual pre-scan; js-yaml is last-wins)
 *   - providerId takes precedence over provider (both captured; caller resolves)
 *   - model without a resolvable provider is invalid (validated by the registry via validation.ts)
 *   - NEVER writes back to agent files
 */
import yaml from "js-yaml";

export const FRONTMATTER_MAX_NAME_LENGTH = 256;
export const FRONTMATTER_MAX_DESCRIPTION_LENGTH = 4096;
export const FRONTMATTER_MAX_PROVIDER_LENGTH = 256;
export const FRONTMATTER_MAX_MODEL_LENGTH = 256;
export const FRONTMATTER_MAX_CAPABILITY_LENGTH = 128;
export const FRONTMATTER_MAX_CAPABILITIES = 32;

export type AgentFrontmatter = {
  name?: string;
  description?: string;
  provider?: string;
  providerId?: string;
  model?: string;
  capabilities?: string[];
  enabled?: boolean;
};

export type ParsedAgentFile = {
  frontmatter: AgentFrontmatter;
  body: string;
  errors: string[];
};

const ACCEPTED_KEYS = new Set([
  "name",
  "description",
  "provider",
  "providerId",
  "model",
  "capabilities",
  "enabled"
]);

function splitFrontmatter(content: string): { yamlText: string | undefined; body: string } {
  // Accept a leading `---` line. Find the next line that is exactly `---` (or `...`).
  const lines = content.split(/\r?\n/);
  if (lines.length === 0 || lines[0].trim() !== "---") {
    return { yamlText: undefined, body: content };
  }
  let closeIndex = -1;
  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (line === "---" || line === "...") {
      closeIndex = i;
      break;
    }
  }
  if (closeIndex < 0) {
    // unclosed frontmatter — treat whole content as body, no frontmatter
    return { yamlText: undefined, body: content };
  }
  const yamlText = lines.slice(1, closeIndex).join("\n");
  const body = lines.slice(closeIndex + 1).join("\n");
  return { yamlText, body };
}

function findDuplicateKeys(yamlText: string): string[] {
  const seen = new Map<string, number>();
  for (const line of yamlText.split(/\r?\n/)) {
    const match = /^([A-Za-z_][A-Za-z0-9_-]*):/.exec(line);
    if (!match) {
      continue;
    }
    seen.set(match[1], (seen.get(match[1]) ?? 0) + 1);
  }
  return [...seen.entries()].filter(([, count]) => count > 1).map(([key]) => key);
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

/** Parse an agent file's full text into frontmatter + body, with validation. Never throws. */
export function parseAgentFile(content: string): ParsedAgentFile {
  const errors: string[] = [];
  const { yamlText, body } = splitFrontmatter(content);
  const frontmatter: AgentFrontmatter = {};

  if (yamlText !== undefined && yamlText.trim().length > 0) {
    const duplicates = findDuplicateKeys(yamlText);
    if (duplicates.length > 0) {
      errors.push(`duplicate frontmatter keys: ${duplicates.join(", ")}`);
    }
    let parsed: unknown;
    try {
      parsed = yaml.load(yamlText);
    } catch (error) {
      errors.push(`invalid YAML: ${error instanceof Error ? error.message : String(error)}`);
      return { frontmatter, body, errors };
    }
    if (parsed === null || parsed === undefined) {
      // empty frontmatter is fine
    } else if (typeof parsed !== "object" || Array.isArray(parsed)) {
      errors.push("frontmatter must be a YAML mapping (object)");
    } else {
      const record = parsed as Record<string, unknown>;
      for (const [key, value] of Object.entries(record)) {
        if (!ACCEPTED_KEYS.has(key)) {
          // unknown keys are ignored (not an error) — forward-compatible
          continue;
        }
        applyField(frontmatter, key, value, errors);
      }
    }
  }

  return { frontmatter, body, errors };
}

function applyField(target: AgentFrontmatter, key: string, value: unknown, errors: string[]): void {
  switch (key) {
    case "name":
      if (!isString(value)) {
        errors.push("frontmatter `name` must be a string");
        return;
      }
      if (value.length > FRONTMATTER_MAX_NAME_LENGTH) {
        errors.push(`frontmatter \`name\` exceeds ${FRONTMATTER_MAX_NAME_LENGTH} chars`);
        return;
      }
      target.name = value.trim();
      return;
    case "description":
      if (!isString(value)) {
        errors.push("frontmatter `description` must be a string");
        return;
      }
      if (value.length > FRONTMATTER_MAX_DESCRIPTION_LENGTH) {
        errors.push(`frontmatter \`description\` exceeds ${FRONTMATTER_MAX_DESCRIPTION_LENGTH} chars`);
        return;
      }
      target.description = value;
      return;
    case "provider":
    case "providerId":
      if (!isString(value)) {
        errors.push(`frontmatter \`${key}\` must be a string`);
        return;
      }
      if (value.length > FRONTMATTER_MAX_PROVIDER_LENGTH) {
        errors.push(`frontmatter \`${key}\` exceeds ${FRONTMATTER_MAX_PROVIDER_LENGTH} chars`);
        return;
      }
      target[key] = value.trim();
      return;
    case "model":
      if (!isString(value)) {
        errors.push("frontmatter `model` must be a string");
        return;
      }
      if (value.length > FRONTMATTER_MAX_MODEL_LENGTH) {
        errors.push(`frontmatter \`model\` exceeds ${FRONTMATTER_MAX_MODEL_LENGTH} chars`);
        return;
      }
      target.model = value.trim();
      return;
    case "enabled":
      if (typeof value !== "boolean") {
        errors.push("frontmatter `enabled` must be a boolean");
        return;
      }
      target.enabled = value;
      return;
    case "capabilities":
      if (!Array.isArray(value)) {
        errors.push("frontmatter `capabilities` must be an array");
        return;
      }
      if (value.length > FRONTMATTER_MAX_CAPABILITIES) {
        errors.push(`frontmatter \`capabilities\` exceeds ${FRONTMATTER_MAX_CAPABILITIES} entries`);
        return;
      }
      const capabilities: string[] = [];
      for (const item of value) {
        if (!isString(item)) {
          errors.push("frontmatter `capabilities` must contain only strings");
          return;
        }
        if (item.length > FRONTMATTER_MAX_CAPABILITY_LENGTH) {
          errors.push(`frontmatter capability exceeds ${FRONTMATTER_MAX_CAPABILITY_LENGTH} chars`);
          return;
        }
        capabilities.push(item);
      }
      target.capabilities = capabilities;
      return;
  }
}

/** Derive a stable agent slug: frontmatter `name` if present, else the filename stem (without .md). */
export function deriveAgentSlug(frontmatterName: string | undefined, fileName: string): string {
  const fallback = fileName.replace(/\.md$/i, "");
  const raw = (frontmatterName ?? fallback).trim();
  const slug = raw
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || fallback.toLowerCase();
}
