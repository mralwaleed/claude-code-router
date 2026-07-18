/**
 * Swarm agent registry scanning (Phase 2).
 *
 * v1 scanning is NON-RECURSIVE: only `*.md` files directly inside each configured agent
 * directory are scanned (the SIYAJ layout is flat: `.claude/agents/*.md`). Recursion can be
 * added later as an explicit per-directory contract.
 *
 * For each accepted file: parse frontmatter (safe), compute the canonical body + bodyHash +
 * distinctiveHash, capture mtime/size/generation, and run duplicate (slug / source / body)
 * detection. Per-agent validation errors are retained. Never throws.
 */
import { readdirSync, readFileSync, statSync, type Dirent } from "node:fs";
import path from "node:path";
import type { SwarmAgent, SwarmAgentValidationStatus, SwarmProviderView } from "@ccr/core/swarm/contracts";
import { canonicalizeText, extractDistinctiveSection, sha256Hex } from "@ccr/core/swarm/canonicalize";
import { deriveAgentSlug, parseAgentFile } from "@ccr/core/swarm/frontmatter";
import { applyCollisionStatus, detectFingerprintCollisions, resolveAssignment } from "@ccr/core/swarm/validation";

export const AGENT_MAX_FILE_SIZE = 256 * 1024;

export type ScannedAgent = SwarmAgent & {
  /** Canonical body (whitespace-collapsed). In-memory only; not persisted by default. */
  canonicalBody: string;
  fileSize: number;
  generation: number;
};

export type AgentDirectoryDiagnostics = {
  directory: string;
  accessible: boolean;
  warning?: string;
};

export type AgentScanResult = {
  agents: ScannedAgent[];
  diagnostics: AgentDirectoryDiagnostics[];
};

/** Accept `*.md`, reject hidden / editor-swap / backup / temp files. */
export function isAcceptableAgentFile(fileName: string): boolean {
  if (!fileName.toLowerCase().endsWith(".md")) {
    return false;
  }
  if (fileName.startsWith(".")) {
    return false;
  }
  if (fileName.endsWith("~")) {
    return false;
  }
  if (/\.(swp|swo|bak|tmp)$/i.test(fileName)) {
    return false;
  }
  if (/^#.*#$/.test(fileName)) {
    return false; // editor lock files
  }
  return true;
}

function shortHash(value: string): string {
  return sha256Hex(value).slice(0, 8);
}

export function loadAgentFile(
  absoluteFile: string,
  swarmId: string,
  providers: ReadonlyArray<SwarmProviderView>,
  generation: number,
  now: string
): { agent: ScannedAgent | undefined; readError: string | undefined } {
  let stats;
  try {
    stats = statSync(absoluteFile);
  } catch (error) {
    return { agent: undefined, readError: error instanceof Error ? error.message : String(error) };
  }
  if (!stats.isFile()) {
    return { agent: undefined, readError: "not a regular file" };
  }
  if (stats.size > AGENT_MAX_FILE_SIZE) {
    return { agent: undefined, readError: `file exceeds ${AGENT_MAX_FILE_SIZE} bytes` };
  }

  let content: string;
  try {
    content = readFileSync(absoluteFile, "utf8");
  } catch (error) {
    return { agent: undefined, readError: error instanceof Error ? error.message : String(error) };
  }

  const parsed = parseAgentFile(content);
  const fileName = path.basename(absoluteFile);
  const slug = deriveAgentSlug(parsed.frontmatter.name, fileName);
  const canonicalBody = canonicalizeText(parsed.body);
  const bodyHash = sha256Hex(canonicalBody);
  const distinctiveHash = sha256Hex(extractDistinctiveSection(canonicalBody));

  const errors: string[] = [...parsed.errors];

  // Resolve frontmatter provider/model (providerId takes precedence over provider display name).
  const providerId = parsed.frontmatter.providerId?.trim();
  const providerName = parsed.frontmatter.provider?.trim();
  const model = parsed.frontmatter.model?.trim();
  let resolvedProviderId = "";
  let resolvedModel = "";
  let hasModel = Boolean(model);
  if (providerId || providerName || model) {
    const resolved = resolveAssignment({ providerId, providerName, model }, providers);
    if (providerId || providerName) {
      if (!resolved.providerId) {
        errors.push(`frontmatter provider could not be resolved${providerId ? ` (id="${providerId}")` : ""}${providerName ? ` (name="${providerName}")` : ""}`);
      } else {
        resolvedProviderId = resolved.providerId;
      }
    }
    if (hasModel) {
      if (!resolved.providerId || !resolved.ok) {
        errors.push("frontmatter model has no resolvable provider");
      } else {
        resolvedModel = model as string;
      }
    }
  }

  const validationStatus: SwarmAgentValidationStatus = errors.length === 0 ? "ok" : "invalid";

  const agent: ScannedAgent = {
    id: `${swarmId}:${slug}`,
    swarmId,
    slug,
    displayName: parsed.frontmatter.name?.trim() || slug,
    sourceFile: absoluteFile,
    providerOverrideId: resolvedProviderId,
    modelOverride: resolvedModel,
    enabled: parsed.frontmatter.enabled ?? true,
    capabilities: parsed.frontmatter.capabilities ?? [],
    bodyHash,
    distinctiveHash,
    canonicalBody,
    assignmentSource: "frontmatter",
    validationStatus,
    validationErrors: errors,
    lastLoadedAt: now,
    lastModifiedAt: stats.mtime.toISOString(),
    fileSize: stats.size,
    generation
  };
  return { agent, readError: undefined };
}

export function applyDuplicateDetection(agents: ScannedAgent[]): ScannedAgent[] {
  // duplicate slug
  const bySlug = new Map<string, ScannedAgent[]>();
  for (const agent of agents) {
    const list = bySlug.get(agent.slug) ?? [];
    list.push(agent);
    bySlug.set(agent.slug, list);
  }
  for (const [, group] of bySlug) {
    if (group.length > 1) {
      for (const agent of group) {
        if (!agent.validationErrors.includes(`duplicate slug "${agent.slug}"`)) {
          agent.validationErrors.push(`duplicate slug "${agent.slug}"`);
        }
        if (agent.validationStatus === "ok") {
          agent.validationStatus = "invalid";
        }
      }
    }
  }
  // duplicate canonical body (collision)
  const collisions = detectFingerprintCollisions(agents);
  const collided = applyCollisionStatus(agents, collisions);
  return collided;
}

/** Scan a single non-recursive agent directory. */
export function scanAgentDirectory(
  directory: string,
  swarmId: string,
  providers: ReadonlyArray<SwarmProviderView>,
  options?: { generation?: number; now?: string }
): { agents: ScannedAgent[]; diagnostics: AgentDirectoryDiagnostics } {
  const generation = options?.generation ?? 1;
  const now = options?.now ?? new Date().toISOString();
  const diagnostics: AgentDirectoryDiagnostics = { directory, accessible: false };

  let entries: Dirent[];
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch (error) {
    diagnostics.warning = error instanceof Error ? error.message : String(error);
    return { agents: [], diagnostics };
  }
  diagnostics.accessible = true;

  const agents: ScannedAgent[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) {
      continue; // non-recursive: skip directories
    }
    if (!isAcceptableAgentFile(entry.name)) {
      continue;
    }
    const absoluteFile = path.resolve(directory, entry.name);
    const { agent, readError } = loadAgentFile(absoluteFile, swarmId, providers, generation, now);
    if (readError && !agent) {
      // Retain a degraded entry so the file is visible + blocked, not silently dropped.
      const slug = deriveAgentSlug(undefined, entry.name);
      agents.push({
        id: `${swarmId}:${slug}`,
        swarmId,
        slug,
        displayName: entry.name.replace(/\.md$/i, ""),
        sourceFile: absoluteFile,
        providerOverrideId: "",
        modelOverride: "",
        enabled: false,
        capabilities: [],
        bodyHash: "",
        distinctiveHash: "",
        canonicalBody: "",
        assignmentSource: "frontmatter",
        validationStatus: "invalid",
        validationErrors: [`unreadable file: ${readError}`],
        lastLoadedAt: now,
        lastModifiedAt: "",
        fileSize: 0,
        generation
      });
    } else if (agent) {
      agents.push(agent);
    }
  }

  agents.sort((a, b) => (a.slug === b.slug ? a.sourceFile.localeCompare(b.sourceFile) : a.slug.localeCompare(b.slug)));
  const finalized = applyDuplicateDetection(agents);
  return { agents: finalized, diagnostics };
}

/** Scan all configured agent directories for a swarm and run cross-directory duplicate detection. */
export function scanAgentDirectories(
  directories: ReadonlyArray<string>,
  swarmId: string,
  providers: ReadonlyArray<SwarmProviderView>,
  options?: { generation?: number; now?: string }
): AgentScanResult {
  const generation = options?.generation ?? 1;
  const now = options?.now ?? new Date().toISOString();
  const agents: ScannedAgent[] = [];
  const diagnostics: AgentDirectoryDiagnostics[] = [];

  // duplicate source file (same resolved path configured twice)
  const seenSources = new Set<string>();

  for (const directory of directories) {
    const result = scanAgentDirectory(directory, swarmId, providers, { generation, now });
    diagnostics.push(result.diagnostics);
    for (const agent of result.agents) {
      if (seenSources.has(agent.sourceFile)) {
        agent.validationErrors.push(`duplicate source file "${agent.sourceFile}"`);
        if (agent.validationStatus === "ok") {
          agent.validationStatus = "invalid";
        }
      } else {
        seenSources.add(agent.sourceFile);
      }
      agents.push(agent);
    }
  }

  const finalized = applyDuplicateDetection(agents);
  return { agents: finalized, diagnostics };
}
