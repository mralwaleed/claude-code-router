/**
 * Swarm workspace path normalization + matching (Phase 2).
 *
 * LAUNCH-TIME ONLY. The gateway never does filesystem matching per request (Phase 3 correlates
 * via the authenticated Swarm Session). This module resolves which Swarm owns a given directory
 * when launching / auto-detecting.
 *
 * Guarantees:
 *   - expand `~` and `${VAR}` / `$VAR` environment variables
 *   - normalize separators, resolve absolute
 *   - resolve symlinks where safe (fall back to the resolved path if realpath fails)
 *   - keep configured vs resolved path distinct
 *   - PATH-BOUNDARY matching (never naive string prefix): `/project-a` never matches `/project-ab`
 *   - deepest matching root wins; equal-depth across DIFFERENT enabled swarms is ambiguous
 *   - disabled swarms do not participate
 *   - missing/inaccessible roots yield diagnostics, never crashes
 */
import { realpathSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const ENV_VAR_PATTERN = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g;

/** Expand a leading `~` and `${VAR}` / `$VAR` references against the given environment. */
export function expandPath(value: string, env: Record<string, string | undefined> = process.env): string {
  let trimmed = value.trim();
  if (trimmed === "~") {
    trimmed = os.homedir();
  } else if (trimmed.startsWith("~/")) {
    trimmed = path.join(os.homedir(), trimmed.slice(2));
  }
  trimmed = trimmed.replace(ENV_VAR_PATTERN, (match, braced, bare) => {
    const name = braced || bare;
    const replacement = env[name];
    return typeof replacement === "string" ? replacement : match;
  });
  return trimmed;
}

export type NormalizedPath = {
  /** Original configured string (e.g. `${HOME}/Projects/siyaj`). */
  configured: string;
  /** Expanded + absolute + separator-normalized. */
  resolved: string;
  /** realpath if resolvable; else undefined. */
  real: string | undefined;
  exists: boolean;
  accessible: boolean;
  inaccessibleReason: string | undefined;
};

/** Resolve, realpath, and stat a configured workspace path. Never throws. */
export function normalizeWorkspacePath(
  configured: string,
  env: Record<string, string | undefined> = process.env
): NormalizedPath {
  const resolved = path.resolve(expandPath(configured, env));
  let real: string | undefined;
  let exists = false;
  let accessible = false;
  let inaccessibleReason: string | undefined;
  try {
    const stats = statSync(resolved);
    exists = true;
    if (stats.isDirectory()) {
      accessible = true;
      try {
        real = realpathSync(resolved);
      } catch {
        real = resolved;
      }
    } else {
      inaccessibleReason = "configured workspace root is not a directory";
    }
  } catch (error) {
    exists = false;
    accessible = false;
    inaccessibleReason = error instanceof Error ? error.message : String(error);
  }
  return { configured, resolved, real, exists, accessible, inaccessibleReason };
}

/**
 * Path-boundary containment: `candidate` is `root` itself or a direct/indirect child of `root`.
 * Uses a separator boundary so `/project-a` does NOT match `/project-ab`.
 */
export function isWithinPath(candidate: string, root: string): boolean {
  if (candidate === root) {
    return true;
  }
  const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep;
  return candidate.startsWith(rootWithSep);
}

export type WorkspaceSwarmRoot = {
  swarmId: string;
  enabled: boolean;
  configuredRoot: string;
};

export type WorkspaceMatchResult =
  | { kind: "match"; swarmId: string; root: string; depth: number }
  | { kind: "ambiguous"; swarmIds: string[]; root: string; depth: number }
  | { kind: "none" };

function pathDepth(value: string): number {
  // count meaningful segments; resolves cross-platform separator differences after normalization
  const segments = value.split(path.sep).filter(Boolean);
  return segments.length;
}

/**
 * Find the Swarm that owns `candidatePath`. Disabled swarm roots and inaccessible roots do not
 * participate. Returns the deepest match; equal-depth matches across DIFFERENT enabled swarms
 * are reported as ambiguous (caller must not guess).
 */
export function matchWorkspace(
  candidatePath: string,
  roots: ReadonlyArray<WorkspaceSwarmRoot>,
  env: Record<string, string | undefined> = process.env
): WorkspaceMatchResult {
  const candidateResolved = path.resolve(expandPath(candidatePath, env));
  let candidateReal = candidateResolved;
  try {
    candidateReal = realpathSync(candidateResolved);
  } catch {
    candidateReal = candidateResolved;
  }

  const matches: Array<{ swarmId: string; root: string; depth: number }> = [];
  for (const root of roots) {
    if (!root.enabled) {
      continue;
    }
    const normalized = normalizeWorkspacePath(root.configuredRoot, env);
    if (!normalized.accessible) {
      continue;
    }
    const rootReal = normalized.real ?? normalized.resolved;
    const contained =
      isWithinPath(candidateReal, rootReal) || isWithinPath(candidateResolved, normalized.resolved);
    if (contained) {
      matches.push({ swarmId: root.swarmId, root: normalized.resolved, depth: pathDepth(rootReal) });
    }
  }

  if (matches.length === 0) {
    return { kind: "none" };
  }
  const maxDepth = Math.max(...matches.map((match) => match.depth));
  const deepest = matches.filter((match) => match.depth === maxDepth);
  if (deepest.length === 1) {
    return { kind: "match", ...deepest[0] };
  }
  const swarmIds = Array.from(new Set(deepest.map((match) => match.swarmId)));
  if (swarmIds.length === 1) {
    // Same swarm, multiple equally-deep roots: deterministic pick (configured order preserved).
    return { kind: "match", ...deepest[0] };
  }
  return { kind: "ambiguous", swarmIds, root: deepest[0].root, depth: maxDepth };
}

/** Normalize all roots of a swarm and return per-root status + aggregate diagnostics (for validation UI). */
export type WorkspaceRootDiagnostic = {
  configured: string;
  resolved: string;
  accessible: boolean;
  warning: string | undefined;
};

export function diagnoseWorkspaceRoots(
  roots: ReadonlyArray<WorkspaceSwarmRoot>,
  env: Record<string, string | undefined> = process.env
): WorkspaceRootDiagnostic[] {
  const out: WorkspaceRootDiagnostic[] = [];
  for (const root of roots) {
    if (!root.enabled) {
      continue;
    }
    const normalized = normalizeWorkspacePath(root.configuredRoot, env);
    let warning: string | undefined;
    if (!normalized.exists) {
      warning = `workspace root does not exist: ${normalized.resolved}`;
    } else if (!normalized.accessible) {
      warning = normalized.inaccessibleReason ?? `workspace root not accessible: ${normalized.resolved}`;
    }
    out.push({ configured: normalized.configured, resolved: normalized.resolved, accessible: normalized.accessible, warning });
  }
  return out;
}
