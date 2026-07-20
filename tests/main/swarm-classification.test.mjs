import assert from "node:assert/strict";
import test from "node:test";
import { canonicalizeText } from "../../packages/core/src/swarm/canonicalize.ts";
import { classifyRequest, MIN_CANONICAL_BODY_LENGTH } from "../../packages/core/src/swarm/classification.ts";
import { ClaudeCodeLeaderDetector } from "../../packages/core/src/swarm/leader-detector.ts";

const leaderDetector = new ClaudeCodeLeaderDetector();

function agent(id, body, opts = {}) {
  return {
    id,
    enabled: opts.enabled ?? true,
    validationStatus: opts.status ?? "ok",
    canonicalBody: canonicalizeText(body)
  };
}

const PLANNER = "# SIYAJ Planner\n\n## Mission\nYou are the planning and architecture gate. Discover the next gap and produce one task.";
const WORKER = "# SIYAJ Worker\n\n## Mission\nImplement exactly one READY task. Smallest safe change satisfying acceptance criteria.";
const REVIEWER = "# SIYAJ Reviewer\n\n## Mission\nIndependently determine whether the change improves the system and is safe to proceed.";
const LEADER_SYS =
  "You are an interactive agent that helps users with software engineering tasks. " +
  "Output is Github-flavored markdown in a terminal. Reference code as `file_path:line_number`. " +
  "Plus the rest of the base prompt.";

function classify(system, agents) {
  return classifyRequest({ system, registry: { agents, generation: 7 }, leaderDetector });
}

test("exact planner / worker / reviewer containment", () => {
  const agents = [agent("planner", PLANNER), agent("worker", WORKER), agent("reviewer", REVIEWER)];
  assert.equal(classify(PLANNER, agents).classification.kind, "agent");
  assert.equal(classify(WORKER, agents).classification.kind, "agent");
  assert.equal(classify(REVIEWER, agents).classification.kind, "agent");
  assert.equal(classify(PLANNER, agents).classification.agentId, "planner");
  assert.equal(classify(WORKER, agents).classification.agentId, "worker");
});

test("appended context after the agent body still matches exactly", () => {
  const agents = [agent("worker", WORKER)];
  const sys = `You are a Claude agent.\n\n${WORKER}\n\n<env>\nworking directory: /tmp\n</env>`;
  const d = classify(sys, agents);
  assert.equal(d.classification.kind, "agent");
  assert.equal(d.classification.agentId, "worker");
});

test("string and array system forms classify identically", () => {
  const agents = [agent("worker", WORKER)];
  const fromString = classify(WORKER, agents).classification;
  const fromArray = classify([{ type: "text", text: WORKER }], agents).classification;
  assert.deepEqual(fromString, fromArray);
});

test("two agents with identical body => AMBIGUOUS (no guess, all candidates recorded)", () => {
  const shared = "# Shared Agent\n\n## Mission\nThis body is shared between two agents for the collision test.";
  const agents = [agent("a", shared), agent("b", shared)];
  const d = classify(shared, agents);
  assert.equal(d.classification.kind, "ambiguous");
  assert.deepEqual(d.classification.candidateAgentIds.sort(), ["a", "b"]);
});

test("no agent body and no leader anchors => UNKNOWN", () => {
  const agents = [agent("worker", WORKER)];
  const d = classify("Research an unrelated topic and reply concisely.", agents);
  assert.equal(d.classification.kind, "unknown");
});

test("leader base prompt with no agent body => LEADER", () => {
  const agents = [agent("worker", WORKER)];
  const d = classify(LEADER_SYS, agents);
  assert.equal(d.classification.kind, "leader");
  assert.ok(d.classification.detectorVersion);
  assert.equal(d.matchedLeaderAnchors.length, 3);
});

test("agent containment wins over leader anchors", () => {
  const leaderAgent = agent("leader-as-agent", `${WORKER}\n${LEADER_SYS}`);
  const agents = [leaderAgent];
  const d = classify(`${WORKER}\n${LEADER_SYS}`, agents);
  assert.equal(d.classification.kind, "agent");
  assert.equal(d.classification.agentId, "leader-as-agent");
});

test("agents below MIN_CANONICAL_BODY_LENGTH are not candidates", () => {
  const tiny = agent("tiny", "ok");
  const agents = [tiny];
  assert.equal(tiny.canonicalBody.length < MIN_CANONICAL_BODY_LENGTH, true);
  const d = classify("ok", agents);
  assert.notEqual(d.classification.kind, "agent");
});

test("disabled agents are not candidates", () => {
  const agents = [agent("worker", WORKER, { enabled: false })];
  const d = classify(WORKER, agents);
  assert.equal(d.classification.kind, "unknown");
});

test("registry generation is recorded in diagnostics", () => {
  const agents = [agent("worker", WORKER)];
  assert.equal(classify(WORKER, agents).registryGeneration, 7);
});
