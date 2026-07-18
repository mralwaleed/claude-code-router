/**
 * FROZEN canonicalization contract for Swarm attribution (Phase 1).
 *
 * The SAME function is used for all four purposes (requirement: one canonicalization):
 *   - stored agent-body fingerprints
 *   - incoming request system content
 *   - exact containment checks
 *   - duplicate collision checks
 *
 * Contract (do not change behaviour without bumping a version + migrating tests):
 *   1. Extract text: a plain string is used as-is; a content-block array is joined by a
 *      deterministic "\n" boundary, taking `block.text` of each block in original order.
 *   2. Remove ONLY recognized CCR routing markers (non-greedy, across newlines):
 *        <CCR-AGENT-MODEL>…</CCR-AGENT-MODEL>
 *        <CCR-SUBAGENT-MODEL>…</CCR-SUBAGENT-MODEL>
 *        <CCR-AGENT>…</CCR-AGENT>
 *   3. Normalize CRLF / CR -> LF.
 *   4. Unicode-normalize using NFC.
 *   5. Replace EVERY consecutive Unicode whitespace run with exactly one ASCII space
 *      (spaces, tabs, newlines, NBSP, etc. all collapse to a single " "). This is robust to
 *      harmless whitespace differences inside and between lines.
 *   6. Trim leading/trailing whitespace.
 *
 * Explicitly NOT performed (frozen):
 *   - lowercasing
 *   - removing punctuation
 *   - removing arbitrary prompt text
 *   - reordering content
 *   - semantic / synonym transforms
 *
 * Validated against real Claude Code 2.1.179 captures (see tests/fixtures/swarm/README.md):
 * canonical-body containment in canonical-system holds with this contract.
 */
import { createHash } from "node:crypto";

const ROUTING_MARKERS: ReadonlyArray<{ readonly open: string; readonly close: string }> = [
  { open: "<CCR-AGENT-MODEL>", close: "</CCR-AGENT-MODEL>" },
  { open: "<CCR-SUBAGENT-MODEL>", close: "</CCR-SUBAGENT-MODEL>" },
  { open: "<CCR-AGENT>", close: "</CCR-AGENT>" }
];

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Extract text from a system prompt value.
 * - string               -> itself
 * - array of blocks      -> `block.text` of each block joined by "\n" (original order)
 * - anything else        -> ""
 */
export function extractSystemText(system: unknown): string {
  if (typeof system === "string") {
    return system;
  }
  if (!Array.isArray(system)) {
    return "";
  }
  const parts: string[] = [];
  for (const block of system) {
    if (typeof block === "string") {
      parts.push(block);
      continue;
    }
    if (block && typeof block === "object" && "text" in block) {
      const text = (block as { text?: unknown }).text;
      if (typeof text === "string") {
        parts.push(text);
      }
    }
  }
  return parts.join("\n");
}

/** Apply the frozen canonicalization pipeline to already-extracted text. */
export function canonicalizeText(input: string): string {
  let text = input;
  // (2) remove only recognized CCR routing markers
  for (const marker of ROUTING_MARKERS) {
    const re = new RegExp(`${escapeRegExp(marker.open)}[\\s\\S]*?${escapeRegExp(marker.close)}`, "g");
    text = text.replace(re, "");
  }
  // (3) CRLF / CR -> LF
  text = text.replace(/\r\n?/g, "\n");
  // (4) Unicode NFC
  text = text.normalize("NFC");
  // (5) collapse every consecutive Unicode whitespace run to exactly one ASCII space
  text = text.replace(/\s+/g, " ");
  // (6) trim
  return text.trim();
}

/** Extract + canonicalize a system prompt value (string or content-block array). */
export function canonicalizeSystem(system: unknown): string {
  return canonicalizeText(extractSystemText(system));
}

/**
 * Distinctive section: a stable prefix of the canonical body anchored at the first markdown
 * heading if present (else the start). Computed over an already-canonicalized (whitespace-
 * collapsed) body. This is a STORED diagnostic/secondary index only — v1 attribution uses
 * exact full-body containment, not the distinctive section.
 */
export function extractDistinctiveSection(canonicalBody: string, options?: { maxLength?: number }): string {
  const maxLength = options?.maxLength ?? 400;
  const headingIndex = canonicalBody.search(/#{1,6}\s/);
  const start = headingIndex >= 0 ? headingIndex : 0;
  return canonicalBody.slice(start, start + maxLength).trim();
}

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

