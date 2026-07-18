import assert from "node:assert/strict";
import test from "node:test";
import { ClaudeCodeLeaderDetector, LEADER_DETECTOR_VERSION } from "../../packages/core/src/swarm/leader-detector.ts";

const detector = new ClaudeCodeLeaderDetector();
const A1 = "You are an interactive agent that helps users with software engineering tasks";
const A2 = "Github-flavored markdown in a terminal";
const A3 = "Reference code as `file_path:line_number`";

function sys(...parts) {
  return parts.join(" \n\n "); // mixed whitespace; detector matches against canonical (collapsed) text
}

test("detector version is exposed for diagnostics", () => {
  assert.equal(detector.version, LEADER_DETECTOR_VERSION);
  assert.equal(LEADER_DETECTOR_VERSION, "ccr-leader-v1");
});

test("all mandatory anchors present => LEADER", () => {
  const r = detector.evaluate(sys(A1, A2, A3, "plus surrounding base prompt filler"));
  assert.equal(r.matched, true);
  assert.equal(r.matchedAnchors.length, 3);
});

test("partial anchors (2 of 3) => not leader", () => {
  assert.equal(detector.evaluate(sys(A1, A2, "filler")).matched, false);
  assert.equal(detector.evaluate(sys(A1, "filler")).matched, false);
});

test("a single leader-like phrase inside a subagent prompt => not leader", () => {
  // a subagent body that coincidentally contains one anchor phrase must not be classified leader
  assert.equal(detector.evaluate(sys("# Worker\n", A1, "\nimplements tasks")).matched, false);
});

test("no anchors => not leader", () => {
  assert.equal(detector.evaluate(sys("# Worker\nimplements tasks carefully")).matched, false);
});
