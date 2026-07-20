/**
 * Versioned Claude Code leader detector (Phase 4).
 *
 * Isolated behind the LeaderDetector interface so the anchor set can be revised when Claude
 * Code changes, without touching routing code. Anchors are derived from the REAL Claude Code
 * 2.1.179 main-session base prompt (Phase 0 capture) — NOT stored as one brittle literal.
 *
 * Contract: ALL mandatory anchors must be present (strict deterministic rule). A partial or
 * coincidental match returns false. Verified against the capture: every anchor is present in the
 * main session and ABSENT from all named-subagent system prompts, so a subagent is never
 * misclassified as leader. An agent-body containment match always wins BEFORE leader detection.
 */
import type { LeaderDetector, LeaderDetectorResult, LeaderDetectorVersion } from "@ccr/core/swarm/contracts";

export const LEADER_DETECTOR_VERSION: LeaderDetectorVersion = "ccr-leader-v1";

/**
 * Mandatory anchors. Each is long and distinctive. Matched against the canonical
 * (whitespace-collapsed) system content.
 */
const MANDATORY_ANCHORS: readonly string[] = [
  "You are an interactive agent that helps users with software engineering tasks",
  "Github-flavored markdown in a terminal",
  "Reference code as `file_path:line_number`"
];

export class ClaudeCodeLeaderDetector implements LeaderDetector {
  readonly version: LeaderDetectorVersion = LEADER_DETECTOR_VERSION;

  evaluate(canonicalSystem: string): LeaderDetectorResult {
    const matchedAnchors = MANDATORY_ANCHORS.filter((anchor) => canonicalSystem.includes(anchor));
    const matched = matchedAnchors.length === MANDATORY_ANCHORS.length;
    return { matched, version: this.version, matchedAnchors };
  }
}
